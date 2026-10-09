import { Activity, Coins, Download, Gauge, Pencil, RotateCcw, Trash2 } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";
import { EntityActions, type EntityAction } from "@/components/entity/EntityActions";
import {
  EntityBody,
  EntityCard,
  EntityHeader,
  EntityTag,
} from "@/components/entity/EntityCard";
import { StatusDot } from "@/components/network/StatusDot";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatAgo } from "@shared/dashboardAttention";
import { formatCpuPercent, isAgentUpgradeTimedOut } from "./hostDisplay";
import { hostPrimaryAddressLines, hostRegionText } from "./hostDisplay";
import { HostOsAvatar, hostOsOf } from "./HostOsBadge";
import { deriveHostVitals, type HostVitals } from "./useHostVitals";

/**
 * 主机列表里的那张卡 —— Summary 态。
 *
 * **列表负责看状态，详情负责看数据。**
 *
 * 上一版的 HostCard 在列表里同时放了：状态、名称、Agent 版本、IP、地区、计费、
 * CPU、RAM、Disk、延迟、当前流量、累计流量、系统累计、运行时间、到期时间、
 * 五个操作按钮 —— 一台机器 260～420px，二十台就是二十屏。
 *
 * 这张卡只留支撑「要不要点进去」这个决定所需的东西（照 2026-09-27 定稿的效果图）：
 *
 *   [U]  ● HK entry 01 (Debian 12)                ···   发行版图标、状态点、名字、系统标签；右上角 ···
 *        Hong Kong · 192.0.2.21 · Agent 2.2.199        一行注脚：地区 · IP · Agent 版本（可升级就标一句）
 *        CPU 18% | 内存 42% | 磁盘 36%                  三个规格格，标签在上数字在下
 *        ↓ 8.42 MB/s · ↑ 11.6 MB/s      6 条转发 · 2 条线路经过
 *
 * 其余全部进详情。
 *
 * 离线的机器不整卡变灰：状态点变红，规格格整行不画（离线时那三个数是三天前的化石），
 * 底下那行写「离线 30 分钟 · 离线前 ↓ …」和受影响的转发数。IP、地区保持满对比度 ——
 * 机器出问题的时候，恰恰最需要看清这几项。
 */

export type HostSummaryCardProps = {
  host: any;
  /** 列表页批量查回来的 metrics。不传则这张卡不显示占用条（不会自己发请求） */
  metrics?: any[] | null;
  traffic?: { bytesIn?: number | null; bytesOut?: number | null } | null;
  canUpgrade: boolean;
  /** 这台的 Agent 比面板带的版本旧（由列表页比出来）：注脚里标一句「可升级」 */
  upgradeAvailable?: boolean;
  resetTrafficPending?: boolean;
  onOpenDetail: (host: any) => void;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  onResetTraffic?: (host: any) => void;
  onCorrectTraffic?: (host: any) => void;
  onEditBilling?: (host: any) => void;
  onViewProbeLatency?: (host: any) => void;
};

/** 操作项的组装单独拆出来，详情页要用同一套 —— 两处给出不同的菜单是 bug 不是特性。 */
export function buildHostActions(
  props: Pick<
    HostSummaryCardProps,
    | "host"
    | "canUpgrade"
    | "resetTrafficPending"
    | "onEdit"
    | "onUpgrade"
    | "onResetTraffic"
    | "onCorrectTraffic"
    | "onEditBilling"
    | "onViewProbeLatency"
  > & { onConfirmDelete: () => void },
): { primary: EntityAction[]; menu: EntityAction[] } {
  const { host } = props;
  const isOnline = !!host?.isOnline;
  // 服务端没给这个字段时按「能管」算：管理员那一侧本来就都能管。
  const manageable = host?.manageable !== false;
  const upgradeTimedOut = isAgentUpgradeTimedOut(host);

  const primary: EntityAction[] = [];
  if (props.onViewProbeLatency) {
    primary.push({
      key: "probe",
      label: "诊断",
      icon: <Activity className="h-4 w-4" />,
      onSelect: () => props.onViewProbeLatency?.(host),
    });
  }
  /*
    编辑排在诊断后面而不是前面：诊断是「这台怎么了」，编辑是「改它」。
    列表上更常问前者 —— 真要改配置的人已经知道自己要点进哪一台了。
  */
  if (manageable) {
    primary.push({
      key: "edit",
      label: "编辑",
      icon: <Pencil className="h-4 w-4" />,
      onSelect: () => props.onEdit(host),
    });
  }

  const menu: EntityAction[] = [];
  if (props.onResetTraffic) {
    menu.push({
      key: "reset",
      label: props.resetTrafficPending ? "正在重置流量" : "重置流量统计",
      icon: <RotateCcw className="h-4 w-4" />,
      disabled: props.resetTrafficPending,
      onSelect: () => props.onResetTraffic?.(host),
    });
  }
  if (props.onCorrectTraffic) {
    menu.push({
      key: "correct",
      label: "用量修正",
      icon: <Gauge className="h-4 w-4" />,
      onSelect: () => props.onCorrectTraffic?.(host),
    });
  }
  if (props.onEditBilling) {
    menu.push({
      key: "billing",
      label: "按量计费",
      icon: <Coins className="h-4 w-4" />,
      onSelect: () => props.onEditBilling?.(host),
    });
  }
  /*
    升不了的人干脆别给这一项 —— 渲染出来再 disabled，对租户就是一个永远灰着的
    菜单项，因为下发升级本来就是管理员专属接口。
  */
  if (props.canUpgrade) {
    menu.push({
      key: "upgrade",
      label: "升级 Agent",
      icon: <Download className="h-4 w-4" />,
      disabled: !isOnline,
      onSelect: () => props.onUpgrade(host),
    });
  }
  /*
    不是自己的机器就不给删除入口。管理员授权他使用的机器，服务端按
    `userId === 自己` 挡着；留着按钮点下去只会吃一句「无权操作此主机」——
    那不是提示，是绊脚石。
  */
  if (manageable) {
    menu.push({
      key: "delete",
      label: "删除主机",
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      onSelect: props.onConfirmDelete,
    });
  }

  return { primary, menu };
}

/**
 * 资源一行三个规格格。格子的样子照 kfchost 套餐卡里的规格格：比卡深一点的灰底、
 * 12px 圆角，标签在上、数字在下，不带图标（「CPU」「内存」「磁盘」三个词自己就认得出）。
 *
 * 格子底部一根 3px 细条（2026-10-08 用户要的），颜色跟数字走：正常主色渐变、≥70% 琥珀、
 * ≥90% 红。条是绝对定位贴在格子底部的，格子和卡片的高度一点不变（见 workspace.css
 * 的 .fx-host-spec-bar）。条长用 transform: scaleX 而不是 width，数值刷新时只走合成层。
 * 数字不知道（— 或还没上报）就不画条。
 *
 * 只在线时画：离线的机器那三个数是最后一次上报的化石，画出来像是此刻的占用。
 */
function SpecBlock({ label, value, percent, tone, muted }: { label: string; value: string; percent: number | null; tone?: "warn" | "down"; muted?: boolean }) {
  const ratio = percent === null || muted ? null : Math.max(0, Math.min(100, percent)) / 100;
  return (
    <span className="fx-host-spec">
      <i>{label}</i>
      <b data-tone={tone} data-muted={muted ? "" : undefined}>{value}</b>
      {ratio === null ? null : (
        <span className="fx-host-spec-bar" aria-hidden="true">
          <span data-tone={tone} style={{ transform: `scaleX(${ratio})` }} />
        </span>
      )}
    </span>
  );
}

function usageTone(value: number | null): "warn" | "down" | undefined {
  if (value === null) return undefined;
  if (value >= 90) return "down";
  if (value >= 70) return "warn";
  return undefined;
}

function hostCardTone(health: HostVitals["health"]): "ok" | "warn" | "down" | "off" {
  if (health === "down") return "down";
  if (health === "degraded" || health === "switching") return "warn";
  if (health === "healthy") return "ok";
  return "off";
}

export function ResourceRow({ vitals }: { vitals: HostVitals }) {
  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);
  const unknown = vitals.cpuPercent === null;
  return (
    <div className="grid min-w-0 grid-cols-3 gap-2">
      <SpecBlock label="CPU" value={formatCpuPercent(vitals.cpuPercent, vitals.isOnline)} percent={vitals.cpuPercent} tone={usageTone(vitals.cpuPercent)} muted={unknown} />
      <SpecBlock label="内存" value={pct(vitals.memoryPercent)} percent={vitals.memoryPercent} tone={usageTone(vitals.memoryPercent)} muted={unknown} />
      <SpecBlock label="磁盘" value={pct(vitals.diskPercent)} percent={vitals.diskPercent} tone={usageTone(vitals.diskPercent)} muted={unknown} />
    </div>
  );
}

const speedText = (value: number | null) => (value === null ? "—" : `${formatBytes(value)}/s`);

/**
 * 底部一行：左边是此刻的速率（离线就是「离线多久 · 离线前的速率」），右边是这台机器
 * 上挂着几条转发、几条线路经过 —— 那是「这台机器重不重要」的答案，删机器、重启前先看它。
 * 服务端没给数（老版本）就不画右边。
 */
export function HostFootRow({ host, vitals, now }: { host: any; vitals: HostVitals; now: number }) {
  const ruleCount = Number(host?.ruleCount);
  const tunnelCount = Number(host?.tunnelCount);
  const hasCounts = Number.isFinite(ruleCount) || Number.isFinite(tunnelCount);
  const rules = Number.isFinite(ruleCount) ? ruleCount : 0;
  const tunnels = Number.isFinite(tunnelCount) ? tunnelCount : 0;

  let tone: "warn" | "down" | undefined;
  let left: string;
  if (vitals.isOnline) {
    left = `↓ ${speedText(vitals.speedIn)} · ↑ ${speedText(vitals.speedOut)}`;
  } else if (vitals.health === "unknown") {
    left = "还没上报过";
  } else {
    tone = "down";
    const seen = host?.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : NaN;
    const ago = Number.isFinite(seen) && seen > 0 ? formatAgo(now - seen).replace(/前$/, "") : "";
    // 离线前没在跑流量就不写「离线前 ↓ 0 B/s」—— 那是一句没有信息的红字。
    const lastIn = Number(vitals.speedIn || 0);
    const lastOut = Number(vitals.speedOut || 0);
    const before = lastIn > 0 ? ` · 离线前 ↓ ${speedText(vitals.speedIn)}` : lastOut > 0 ? ` · 离线前 ↑ ${speedText(vitals.speedOut)}` : "";
    left = `离线${ago ? ` ${ago}` : ""}${before}`;
  }

  let right: string | null = null;
  let rightMuted = false;
  if (hasCounts) {
    if (!vitals.isOnline && rules > 0) {
      right = `${rules} 条转发受影响`;
      rightMuted = true;
    } else if (rules === 0 && tunnels === 0) {
      right = "还没有转发";
      rightMuted = true;
    } else {
      right = [rules > 0 ? `${rules} 条转发` : null, tunnels > 0 ? `${tunnels} 条线路经过` : null].filter(Boolean).join(" · ");
    }
  }

  return (
    <div className="fx-host-foot" data-tone={tone}>
      <span>{left}</span>
      {right ? <span className="fx-host-foot-links" data-muted={rightMuted ? "" : undefined}>{right}</span> : null}
    </div>
  );
}

export default function HostSummaryCard(props: HostSummaryCardProps) {
  const { host, metrics, traffic } = props;
  const confirmDialog = useConfirmDialog();
  const vitals = deriveHostVitals(host, metrics, traffic);

  const name = String(host?.name || "-").trim() || "-";
  const os = hostOsOf(host);
  // 注脚里只写城市（「Tokyo」），没有城市才写国家：一行要放下地区、IP 和 Agent 版本。
  const region = String(host?.geoRegion || "").trim() || hostRegionText(host);
  const address = hostPrimaryAddressLines(host).map((row) => row.value).filter((value) => value && value !== "-")[0] || "";
  const agentVersion = String(host?.agentVersion ?? "").trim().replace(/^v/i, "");
  const now = Date.now();

  const confirmDelete = async () => {
    if (
      await confirmDialog({
        title: "删除主机",
        description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
        confirmText: "删除",
        tone: "destructive",
      })
    ) {
      props.onDelete(host.id);
    }
  };

  const { primary, menu } = buildHostActions({ ...props, onConfirmDelete: () => void confirmDelete() });

  return (
    <EntityCard
      interactive
      /*
        fx-card-face 让主机卡也吃设置里的「卡片风格」（彩色描边 / 状态光 / 渐变卡头 / 纯白），
        和规则卡同一套 CSS。颜色跟状态：在线主色、降级琥珀、掉线红、没上报过不着色。
      */
      className="fx-card-face fx-host-card"
      data-tone={hostCardTone(vitals.health)}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${name} 详情`}
      onClick={() => props.onOpenDetail(host)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpenDetail(host);
        }
      }}
    >
      <EntityHeader
        className="gap-3"
        health={vitals.health}
        leading={<HostOsAvatar os={os} />}
        /* 状态点在名字前面、靠左（用户定的）：一列卡片扫下来，左边一竖排点，红的那颗一眼就跳出来。 */
        title={
          <span className="inline-flex min-w-0 max-w-full items-center gap-2">
            <StatusDot health={vitals.health} size="large" label={vitals.isOnline ? "在线" : vitals.health === "unknown" ? "未上报" : "离线"} />
            <span className="truncate">{name}</span>
          </span>
        }
        /*
          系统标签挂在名字旁边（「Debian 12」），Agent 版本进下面那行注脚：名字才是主角，
          标签只有一枚就不会把名字挤成「Tokyo-II…」。
        */
        badges={os.label ? (
          <EntityTag className="max-w-[45%] font-medium text-muted-foreground">
            <span className="truncate" title={os.full}>{os.label}</span>
          </EntityTag>
        ) : null}
        subtitle={
          <>
            {[region, address].filter(Boolean).join(" · ")}
            {agentVersion ? (
              <>
                {region || address ? " · " : ""}
                Agent {agentVersion}
                {props.upgradeAvailable ? <span className="text-[var(--fx-warn-text)]"> 可升级</span> : null}
              </>
            ) : null}
          </>
        }
        trailing={
          /*
            右上角只有一个 ···（原来还在卡底再画一行「诊断 / 编辑 / ···」，每张卡为此多 60px）。
            在线不再另挂「在线」徽标 —— 名字前面的点已经说完了。
            它的点击不能冒泡成「打开详情」—— 点「删除」结果弹出详情页是最糟的那种意外，所以在这里截断。
          */
          <span className="-mr-1.5 -mt-1 inline-flex" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <EntityActions primary={primary} menu={menu} menuOnly menuLabel={`${name} 的更多操作`} />
          </span>
        }
      />

      {/*
        运行时间、系统累计、计费用量、到期时间全部进详情 —— 它们回答不了
        「要不要点进去」这个问题，而列表上的每一行都要为这个问题服务。
      */}
      <EntityBody tight>
        {vitals.isOnline ? <ResourceRow vitals={vitals} /> : null}
        <HostFootRow host={host} vitals={vitals} now={now} />
      </EntityBody>

    </EntityCard>
  );
}
