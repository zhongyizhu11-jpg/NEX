import { formatBytes } from "@shared/formatBytes";
import { formatUpgradeDuration } from "@shared/upgradeDuration";

export { formatUpgradeDuration };

export const PANEL_UPGRADE_REFRESH_DELAY_SECONDS = 8;
export const PANEL_UPGRADE_REFRESH_DELAY_MS = PANEL_UPGRADE_REFRESH_DELAY_SECONDS * 1000;

/*
  面板升级/回退的进度。

  原来这段逻辑有**两份**：侧边栏一份（DashboardLayout 的 getLayoutUpgradeProgress），
  设置页一份（Settings 的 getUpgradeProgress）。两份已经漂了 ——
  设置页那份多认三条日志特征（`transferring context`、`Packages:`、`node_modules`），
  文案也各写各的。

  后果是能同时看见的：Docker 构建必然打出 `transferring context` 这行，
  那一刻侧边栏说「52%　下载或拉取资产」，设置页说「74%　安装并重启」，
  而你在设置页升级时侧边栏就在旁边。又是那句老毛病：A 变了，B 没跟上。

  现在合成一份。日志特征取两份的并集（设置页那份是超集，多的三条都是真实
  存在的构建输出），文案取更准的那一版。

  关于百分比：这不是假进度 —— 步骤都是从真实日志判出来的里程碑，percent 只是把里程碑映射成条宽。
  所以手册「不要假进度」这条不冲突：它反对的是拿定时器凭空爬的那种。

  2.3.398 起安装脚本自己报步骤：`[NEX] step N/M 标签`、`[NEX] progress download X/Y P%`。
  （2.3.414 之前脚本打的前缀是 `[ForwardX]`：升级到这版时跑的可能还是旧脚本，所以两种前缀都认。）
  有这些标记就按标记算 —— 下载那一步的条真的随字节数走，「依赖未变化」那一步立刻完成；
  没有（老脚本：这版升级时跑的还是上一版装好的脚本）就退回下面那套按日志特征猜里程碑的老办法。
  老办法的毛病正是这次要修的：「Downloading panel bundle」一行同时判完第 2、3 步，下载一开始就 74%，
  下载、解压、装依赖这几分钟条一动不动；第 4 步的特征本地脚本从来不打，92% 永远看不到。
*/

export type PanelUpgradeStep = { label: string; done: boolean; active: boolean };
export type PanelUpgradeProgress = {
  percent: number;
  label: string;
  steps: PanelUpgradeStep[];
  /** 标签下面那行小字：「12.3 MB / 49.0 MB · 已用 1 分 20 秒」；没什么可说的时候是 null。 */
  detail: string | null;
};
export type PanelUpgradeJob = {
  status?: string | null;
  mode?: string | null;
  logs?: unknown;
  startedAt?: string | null;
  finishedAt?: string | null;
  restarted?: boolean | null;
  restartedAt?: string | null;
} | null | undefined;

export type PanelUpgradeProgressContext = {
  /** 算「已用」的当前时间；不传就是 Date.now()。测试里传固定值。 */
  now?: number;
  /** 服务端算好的用时（重启后按重启时刻定格）；有就优先用它。 */
  elapsedMs?: number | null;
  /** 轮询失败（面板正在重启）：文案换成「等待恢复」，最后一步转圈，百分比不掉。 */
  disconnected?: boolean;
};

const STEP_MARKER = /^\[(?:NEX|ForwardX)\] step (\d+)\/(\d+) (.+?)\s*$/;
const DOWNLOAD_MARKER = /^\[(?:NEX|ForwardX)\] progress download (\d+)\/(\d+|-) (\d+|-)%\s*$/;
const SKIPPED_STEP = /跳过/;

const DEFAULT_STEP_LABELS: Record<number, string[]> = {
  5: ["检查发布资产", "下载面板包", "解压文件", "安装依赖", "重启面板"],
  4: ["检查镜像", "拉取镜像", "重建容器", "等待面板就绪"],
};

const MARKER_BASE_PERCENT = 10;
const MARKER_SPAN_PERCENT = 90;
export const PANEL_UPGRADE_RESTARTING_LABEL = "面板正在重启，等待恢复…";

type MarkerState = {
  total: number;
  labels: string[];
  /** 最后一次出现的 step N（1 起）。 */
  current: number;
  currentSkipped: boolean;
  download: { downloaded: number; total: number | null; percent: number | null } | null;
  /** 最后一条下载进度是在第几步打的（下载步结束后再出现的进度行不该动别的步）。 */
  downloadStep: number;
};

function parseMarkers(lines: string[]): MarkerState | null {
  let state: MarkerState | null = null;
  for (const line of lines) {
    const step = line.match(STEP_MARKER);
    if (step) {
      const index = Number(step[1]);
      const total = Number(step[2]);
      if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0 || index <= 0 || index > total) continue;
      if (!state || state.total !== total) {
        state = {
          total,
          labels: Array.from({ length: total }, (_, i) => DEFAULT_STEP_LABELS[total]?.[i] || `第 ${i + 1} 步`),
          current: 0,
          currentSkipped: false,
          download: null,
          downloadStep: 0,
        };
      }
      state.labels[index - 1] = step[3];
      // 步骤只前进不后退（脚本重试同一步时标记会再打一次，取最新的那条）。
      state.current = Math.max(state.current, index);
      state.currentSkipped = index === state.current && SKIPPED_STEP.test(step[3]);
      continue;
    }
    const download = line.match(DOWNLOAD_MARKER);
    if (download && state) {
      const downloaded = Number(download[1]);
      const total = download[2] === "-" ? null : Number(download[2]);
      const percent = download[3] === "-" ? null : Number(download[3]);
      state.download = {
        downloaded: Number.isFinite(downloaded) ? downloaded : 0,
        total: total !== null && Number.isFinite(total) && total > 0 ? total : null,
        percent: percent !== null && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      };
      state.downloadStep = state.current;
    }
  }
  return state && state.current > 0 ? state : null;
}

function stepStartPercent(index: number, total: number) {
  // 第 k 步（0 起）从 10 + k * (90 / M) 开始：5 步就是 10 / 28 / 46 / 64 / 82，成功 100。
  return MARKER_BASE_PERCENT + (index * MARKER_SPAN_PERCENT) / total;
}

function elapsedFromJob(job: PanelUpgradeJob, context: PanelUpgradeProgressContext) {
  if (typeof context.elapsedMs === "number" && Number.isFinite(context.elapsedMs)) return Math.max(0, context.elapsedMs);
  const startedAt = job?.startedAt ? new Date(job.startedAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) return null;
  const endText = job?.restartedAt || job?.finishedAt;
  const endAt = endText ? new Date(endText).getTime() : NaN;
  const now = Number.isFinite(endAt) ? endAt : (context.now ?? Date.now());
  return Math.max(0, now - startedAt);
}

function joinDetail(parts: Array<string | null | undefined>) {
  const text = parts.filter((part): part is string => !!part).join(" · ");
  return text || null;
}

function successProgress(actionLabel: string, job: PanelUpgradeJob, elapsedMs: number | null, labels: string[]): PanelUpgradeProgress {
  // 面板已经带着新版本回来了才说「用时」；脚本刚跑完、面板还没重启时只说等待。
  const restarted = !!job?.restarted;
  return {
    percent: 100,
    label: restarted && elapsedMs !== null
      ? `${actionLabel}完成，用时 ${formatUpgradeDuration(elapsedMs)}`
      : `${actionLabel}完成，正在等待面板恢复`,
    steps: labels.map((label) => ({ label, done: true, active: false })),
    detail: !restarted && elapsedMs !== null ? `用时 ${formatUpgradeDuration(elapsedMs)}` : null,
  };
}

function markerProgress(
  markers: MarkerState,
  status: string,
  actionLabel: string,
  disconnected: boolean,
  elapsedText: string | null,
): PanelUpgradeProgress {
  const total = markers.total;
  const currentIndex = markers.current - 1;
  // 「跳过」那一步立刻完成，条推到下一步的起点。
  const doneThrough = disconnected ? total - 1 : (markers.currentSkipped ? currentIndex + 1 : currentIndex);
  const activeIndex = Math.min(doneThrough, total - 1);
  let percent = doneThrough >= total ? MARKER_BASE_PERCENT + MARKER_SPAN_PERCENT : stepStartPercent(activeIndex, total);
  let detail: string | null = null;

  const download = markers.download;
  if (download && download.downloaded > 0 && markers.downloadStep === markers.current && !markers.currentSkipped && !disconnected) {
    if (download.percent !== null) {
      // 下载那一步的条随字节数走：从这一步的起点走到下一步的起点。
      percent = stepStartPercent(currentIndex, total) + (MARKER_SPAN_PERCENT / total) * (download.percent / 100);
    }
    detail = download.total
      ? `${formatBytes(download.downloaded)} / ${formatBytes(download.total)}`
      : `已下载 ${formatBytes(download.downloaded)}`;
  }

  const steps = markers.labels.map((label, index) => ({
    label,
    done: index < doneThrough,
    active: index === activeIndex && index >= doneThrough,
  }));

  if (status === "error") {
    return {
      percent: Math.round(percent),
      label: `${actionLabel}异常`,
      steps: steps.map((step) => ({ ...step, active: false })),
      detail: null,
    };
  }
  const label = disconnected
    ? PANEL_UPGRADE_RESTARTING_LABEL
    : (markers.currentSkipped ? markers.labels[currentIndex] : markers.labels[activeIndex]) || `正在${actionLabel}`;
  return {
    percent: Math.round(Math.min(MARKER_BASE_PERCENT + MARKER_SPAN_PERCENT, percent)),
    label,
    steps,
    detail: joinDetail([detail, elapsedText]),
  };
}

export function getPanelUpgradeProgress(job: PanelUpgradeJob, context: PanelUpgradeProgressContext = {}): PanelUpgradeProgress {
  const status = job?.status || "idle";
  const actionLabel = job?.mode === "rollback" ? "回退" : "升级";
  const lines = Array.isArray(job?.logs) ? job.logs.map((line) => String(line)) : [];
  const logs = lines.join("\n");
  const matched = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(logs));
  const elapsedMs = elapsedFromJob(job, context);
  const elapsedText = elapsedMs !== null ? `已用 ${formatUpgradeDuration(elapsedMs)}` : null;
  const disconnected = !!context.disconnected && status === "running";
  const markers = parseMarkers(lines);

  // 新脚本：按脚本自己报的步骤算。
  if (markers && status === "success") return successProgress(actionLabel, job, elapsedMs, markers.labels);
  if (markers && (status === "running" || status === "error")) {
    return markerProgress(markers, status, actionLabel, disconnected, elapsedText);
  }

  // 老脚本：按日志特征猜里程碑。
  const steps = [
    {
      label: `准备${actionLabel}`,
      done: status !== "idle" && matched([/开始升级/i, /开始回退/i, /Starting panel/i, /start/i]),
    },
    {
      label: "检查发布资产",
      done: matched([
        /Release assets/i,
        /not available yet/i,
        /still building/i,
        /发布资产/i,
        /构建完成/i,
        /Docker image/i,
        /panel bundle/i,
      ]),
    },
    {
      label: "下载或拉取资产",
      done: matched([
        /Downloading panel bundle/i,
        /Pulling image/i,
        /Downloaded newer image/i,
        /Image is up to date/i,
        /load metadata/i,
        /load build context/i,
        /transferring context/i,
        /pnpm install/i,
        /npm install/i,
        /Packages:/i,
        /node_modules/i,
        /downloaded/i,
        /Lockfile is up to date/i,
      ]),
    },
    {
      label: "安装并重启",
      done: matched([
        /Container .* (Creating|Created|Starting|Started)/i,
        /docker compose up/i,
        /systemctl restart/i,
        /已启动/i,
        /recreate/i,
      ]),
    },
  ];

  if (status === "success") return successProgress(actionLabel, job, elapsedMs, steps.map((step) => step.label));
  if (status === "waiting_assets") {
    return {
      percent: 34,
      label: "等待 GitHub Actions 构建发布资产",
      steps: steps.map((step, index) => ({ ...step, done: index === 0, active: index === 1 })),
      detail: null,
    };
  }

  const doneCount = steps.filter((step) => step.done).length;
  const activeIndex = disconnected ? steps.length - 1 : Math.min(doneCount, steps.length - 1);
  const withActive = steps.map((step, index) => ({
    ...step,
    done: disconnected ? index < steps.length - 1 : step.done,
    active: index === activeIndex && (disconnected || !step.done),
  }));

  if (status === "error") {
    return { percent: Math.max(10, doneCount * 22), label: `${actionLabel}异常`, steps: withActive, detail: null };
  }
  if (status === "running") {
    const percent = Math.min(92, Math.max(12, doneCount * 22 + 8));
    return {
      percent: disconnected ? Math.max(percent, 74) : percent,
      label: disconnected ? PANEL_UPGRADE_RESTARTING_LABEL : (steps[activeIndex]?.label || `正在${actionLabel}`),
      steps: withActive,
      detail: elapsedText,
    };
  }
  return { percent: 0, label: `等待${actionLabel}`, steps: steps.map((step) => ({ ...step, active: false })), detail: null };
}
