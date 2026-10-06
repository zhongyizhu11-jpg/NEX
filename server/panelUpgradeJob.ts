import fs from "fs";
import path from "path";
import { formatUpgradeDuration } from "../shared/upgradeDuration";

export { formatUpgradeDuration };

/*
  面板升级任务的状态原来只在内存里。升级脚本最后一步 systemctl restart 把面板连同脚本一起杀掉，
  任务就没了；重启后的新面板对「刚才在升级」一无所知，客户端只能一直画着断线前那个「74%」，
  在 iOS 上锁一下屏回来更是什么都不动。

  所以任务落到 SQLite 旁边的一个 JSON 文件里，每次变化都写；启动时读回来，对着当前版本判断：
  目标版本 == 当前版本 → 升级成功、面板已经重启；不等且已经过去很久 → 升级没生效。
*/

export type UpgradeJobStatus = "idle" | "running" | "success" | "error" | "waiting_assets";

export type UpgradeJob = {
  status: UpgradeJobStatus;
  mode: "upgrade" | "rollback" | null;
  startedAt: string | null;
  finishedAt: string | null;
  targetVersion: string | null;
  logs: string[];
  error: string | null;
  /** 面板已经带着目标版本重启过（从持久化状态恢复时判出来的），客户端看到它就该刷新页面。 */
  restarted?: boolean;
  restartedAt?: string | null;
};

export const UPGRADE_JOB_STATE_FILE = "panel-upgrade-job.json";
export const UPGRADE_JOB_MAX_LOG_LINES = 300;
/** 重启回来版本还没变，超过这么久就当作升级没生效。 */
export const UPGRADE_JOB_STALE_MS = 15 * 60 * 1000;
/** 重启成功后没有客户端来确认，这么久之后自动清掉，免得一直占着侧栏。 */
export const UPGRADE_JOB_RESTARTED_TTL_MS = 30 * 60 * 1000;

/** 安装脚本的下载进度行；2.3.414 之前的脚本打的前缀是 `[ForwardX]`，升级时跑的可能还是旧脚本，所以两种都认。 */
const DOWNLOAD_PROGRESS_LINE = /^\[(?:NEX|ForwardX)\] progress download /;

export function idleUpgradeJob(): UpgradeJob {
  return {
    status: "idle",
    mode: null,
    startedAt: null,
    finishedAt: null,
    targetVersion: null,
    logs: [],
    error: null,
    restarted: false,
    restartedAt: null,
  };
}

/**
 * 往日志里追加一行。下载进度每秒一行，几分钟就把前面的「step N/M」标记挤出 300 行的窗口，
 * 客户端就不知道走到哪一步了；所以连续的进度行只保留最新一条。
 */
export function appendUpgradeJobLog(logs: string[], line: string) {
  const text = line.trimEnd();
  if (!text) return logs;
  if (DOWNLOAD_PROGRESS_LINE.test(text) && logs.length > 0 && DOWNLOAD_PROGRESS_LINE.test(logs[logs.length - 1])) {
    logs[logs.length - 1] = text;
    return logs;
  }
  logs.push(text);
  if (logs.length > UPGRADE_JOB_MAX_LOG_LINES) {
    logs.splice(0, logs.length - UPGRADE_JOB_MAX_LOG_LINES);
  }
  return logs;
}

export function upgradeJobElapsedMs(job: UpgradeJob | null | undefined, now = Date.now()) {
  const startedAt = job?.startedAt ? new Date(job.startedAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) return null;
  const endText = job?.restartedAt || job?.finishedAt;
  const endAt = endText ? new Date(endText).getTime() : NaN;
  return Math.max(0, (Number.isFinite(endAt) ? endAt : now) - startedAt);
}

function normalizeVersionText(value: string | null | undefined) {
  return String(value || "").trim().replace(/^v/i, "");
}

function parseTime(value: string | null | undefined) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function isUpgradeJobShape(value: unknown): value is UpgradeJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return typeof job.status === "string" && Array.isArray(job.logs);
}

export type ReconcileOptions = {
  currentVersion: string;
  now?: number;
  /** 升级没生效时附在日志后面的手动命令提示。 */
  manualHintLines?: string[];
};

/**
 * 面板启动时对持久化下来的任务做判断。纯函数，方便测。
 */
export function reconcileRestoredUpgradeJob(saved: unknown, options: ReconcileOptions): UpgradeJob {
  if (!isUpgradeJobShape(saved)) return idleUpgradeJob();
  const now = options.now ?? Date.now();
  const currentVersion = normalizeVersionText(options.currentVersion);
  const job: UpgradeJob = {
    ...idleUpgradeJob(),
    ...saved,
    logs: saved.logs.filter((line) => typeof line === "string").slice(-UPGRADE_JOB_MAX_LOG_LINES),
  };
  if (job.status === "idle") return idleUpgradeJob();

  const target = normalizeVersionText(job.targetVersion);
  const startedAt = parseTime(job.startedAt) ?? parseTime(job.finishedAt) ?? now;
  const age = now - startedAt;
  const operationText = job.mode === "rollback" ? "回退" : "升级";

  if (job.restarted) {
    // 上一次启动已经判过「重启成功」，但没有客户端来确认就又重启了一次（或确认没写下来）。
    const restartedAt = parseTime(job.restartedAt) ?? startedAt;
    if (now - restartedAt > UPGRADE_JOB_RESTARTED_TTL_MS) return idleUpgradeJob();
    return job;
  }

  if (target && target === currentVersion) {
    const restartedAt = new Date(now).toISOString();
    const elapsed = upgradeJobElapsedMs({ ...job, restartedAt }, now);
    appendUpgradeJobLog(job.logs, `[NEX] Panel restarted on v${currentVersion}`);
    if (elapsed !== null) {
      appendUpgradeJobLog(job.logs, `[NEX] ${operationText}用时 ${formatUpgradeDuration(elapsed)}`);
    }
    return {
      ...job,
      status: "success",
      error: null,
      finishedAt: job.finishedAt || restartedAt,
      restarted: true,
      restartedAt,
    };
  }

  if (job.status === "running" || job.status === "success") {
    if (age <= UPGRADE_JOB_STALE_MS) {
      // 面板重启了但版本没变：可能是脚本还没跑完、或者这次重启和升级无关。先按「还在跑」等一等。
      appendUpgradeJobLog(job.logs, `[NEX] Panel restarted on v${currentVersion} while the ${job.mode || "upgrade"} to ${target || "?"} is still pending`);
      return { ...job, status: "running", restarted: false, restartedAt: null };
    }
    const reason = `面板重启后版本仍是 v${currentVersion}，${operationText}没有生效。请在服务器上手动执行一键脚本。`;
    appendUpgradeJobLog(job.logs, `[NEX] ${reason}`);
    for (const line of options.manualHintLines || []) appendUpgradeJobLog(job.logs, line);
    return {
      ...job,
      status: "error",
      error: reason,
      finishedAt: job.finishedAt || new Date(now).toISOString(),
      restarted: false,
      restartedAt: null,
    };
  }

  // error / waiting_assets：只在刚发生不久时保留，老的没必要在重启后还挂着。
  const finishedAt = parseTime(job.finishedAt) ?? startedAt;
  if (now - finishedAt > UPGRADE_JOB_STALE_MS) return idleUpgradeJob();
  return job;
}

/**
 * 状态文件放在 SQLite 旁边（本地安装是 $APP_DIR/data，Docker 是 /data 卷），重启和换容器都还在；
 * 那个目录不能写就退到 cwd/data。
 */
export function resolveUpgradeJobStatePath(env: { sqlitePath?: string } = {}, cwd = process.cwd()) {
  const candidates: string[] = [];
  const sqlitePath = String(env.sqlitePath || "").trim();
  if (sqlitePath) candidates.push(path.dirname(sqlitePath));
  candidates.push(path.resolve(cwd, "data"));
  for (const directory of candidates) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.W_OK);
      return path.join(directory, UPGRADE_JOB_STATE_FILE);
    } catch {
      // 下一个候选。
    }
  }
  return path.join(candidates[candidates.length - 1], UPGRADE_JOB_STATE_FILE);
}

export type UpgradeJobStore = {
  filePath: string;
  load(): unknown;
  /** 记下要写的内容；immediate 时同步写盘，否则合并到几百毫秒后写一次（脚本输出很密）。 */
  save(job: UpgradeJob, options?: { immediate?: boolean }): void;
  flush(): void;
  clear(): void;
};

export function createUpgradeJobStore(filePath: string, debounceMs = 250): UpgradeJobStore {
  let pending: UpgradeJob | null = null;
  let timer: NodeJS.Timeout | null = null;

  const writeNow = (job: UpgradeJob) => {
    // 先写临时文件再 rename，重启时正好写到一半也不会读到半个 JSON。
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (error: any) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      console.warn(`[Upgrade] Failed to persist upgrade job state to ${filePath}: ${error?.message || error}`);
    }
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      const job = pending;
      pending = null;
      writeNow(job);
    }
  };

  return {
    filePath,
    load() {
      try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (error: any) {
        console.warn(`[Upgrade] Ignoring unreadable upgrade job state at ${filePath}: ${error?.message || error}`);
        return null;
      }
    },
    save(job, options) {
      // 快照一份：调用方之后还会继续往 logs 里追加。
      pending = { ...job, logs: [...job.logs] };
      if (options?.immediate) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, debounceMs);
        timer.unref?.();
      }
    },
    flush,
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    },
  };
}

/** 这些行之后面板马上就会被杀掉，必须同步落盘。 */
export function isUpgradeLogFlushPoint(line: string) {
  return /restarting panel service|systemctl restart|compose .*up -d|docker compose up/i.test(line);
}
