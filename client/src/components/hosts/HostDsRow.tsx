import type { ReactNode } from "react";

import { formatBytes } from "@shared/formatBytes";
import { hostOsShortTag } from "@shared/hostOs";
import { hostTrafficExcluded } from "@shared/hostTrafficPolicy";
import { EntityActions } from "@/components/entity/EntityActions";
import { StatusDot } from "@/components/network/StatusDot";
import { formatCpuPercent, hostGeoTooltip, hostInMaintenance } from "./hostDisplay";
import {
  deriveHostSummaryView,
  hostOfflineAgo,
  hostTrafficFailoverTitle,
  useHostEntityActions,
  type HostSummaryCardProps,
} from "./HostSummaryCard";

/**
 * 「深空」主题的主机列表：一台机器一行（照 2026-11-06 定稿的效果图）。
 *
 *   手机（一行四截）：
 *     ● [UBU] HK entry 01                       可升级  ···
 *     Central · 192.0.2.21                          15 转发
 *     CPU 18% ▬▬   MEM 42% ▬▬   DSK 36% ▬▬
 *     ↓ 8.42 MB/s ↑ 11.6 MB/s
 *
 *   电脑（≥768px）是一张真表：状态 / 主机 / 系统 / 地区·地址 / CPU / 内存 / 磁盘 / 网速 / 转发 / 版本 / ···
 *
 * 同一份 DOM，两种排法全在 theme-deepspace.css 的 grid-template-areas 里。
 * 要画的数和 Summary 卡同一份推导（deriveHostSummaryView / useHostEntityActions），
 * 两种画法口径不会走岔。别的主题不渲染这个组件。
 */

type Props = HostSummaryCardProps & {
  /** 拖动排序的把手（排序模式下才有） */
  dragHandle?: ReactNode;
  className?: string;
};

function usageTone(value: number | null): "warn" | "down" | undefined {
  if (value === null) return undefined;
  if (value >= 85) return "down";
  if (value >= 70) return "warn";
  return undefined;
}

function Gauge({ area, label, value, text }: { area: string; label: string; value: number | null; text: string }) {
  const tone = usageTone(value);
  return (
    <span className="fx-ds-host-gauge" data-area={area} title={`${label} ${text}`}>
      <i>{label}</i>
      <b data-tone={tone}>{text}</b>
      <span className="fx-ds-host-bar" aria-hidden="true">
        {value === null ? null : <span data-tone={tone} style={{ transform: `scaleX(${Math.max(0, Math.min(100, value)) / 100})` }} />}
      </span>
    </span>
  );
}

const rate = (value: number | null) => (value === null ? "—" : `${formatBytes(value)}/s`);

export function HostDsRow(props: Props) {
  const { host, metrics, traffic } = props;
  const { vitals, name, os, region, address, agentVersion } = deriveHostSummaryView(host, metrics, traffic);
  const { primary, menu } = useHostEntityActions(props);
  const now = Date.now();

  const offline = !vitals.isOnline;
  const neverReported = offline && vitals.health === "unknown";
  const cpu = offline ? null : vitals.cpuPercent;
  const memory = offline ? null : vitals.memoryPercent;
  const disk = offline ? null : vitals.diskPercent;
  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);
  const osTag = hostOsShortTag(os);
  const ruleCount = Number(host?.ruleCount);
  const tunnelCount = Number(host?.tunnelCount);
  const rules = Number.isFinite(ruleCount) ? ruleCount : null;
  const routeTitle = [
    rules !== null ? `${rules} 条转发` : null,
    Number.isFinite(tunnelCount) && tunnelCount > 0 ? `${tunnelCount} 条线路经过` : null,
  ].filter(Boolean).join(" · ");
  const ago = offline && !neverReported ? hostOfflineAgo(host, now) : "";
  const maintenance = hostInMaintenance(host);
  const trafficExcluded = hostTrafficExcluded(host);
  const upgrade = !!agentVersion && !!props.upgradeAvailable;
  const open = () => props.onOpenDetail(host);

  return (
    <div
      className={["fx-ds-host", props.className].filter(Boolean).join(" ")}
      data-offline={offline && !neverReported ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${name} 详情`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <span className="fx-ds-host-dot">
        <StatusDot health={vitals.health} label={vitals.isOnline ? "在线" : neverReported ? "未上报" : "离线"} />
      </span>
      <span className="fx-ds-host-os" title={os.full || undefined}>{osTag || "—"}</span>
      <span className="fx-ds-host-name">{name}</span>
      <span className="fx-ds-host-addr" title={hostGeoTooltip(host) || undefined}>
        {[region, address].filter(Boolean).join(" · ") || "—"}
      </span>
      <span className="fx-ds-host-gauges">
        <Gauge area="cpu" label="CPU" value={cpu} text={cpu === null ? "—" : formatCpuPercent(cpu, vitals.isOnline)} />
        <Gauge area="mem" label="MEM" value={memory} text={pct(memory)} />
        <Gauge area="dsk" label="DSK" value={disk} text={pct(disk)} />
      </span>
      <span className="fx-ds-host-rate" title={vitals.speedLabel}>
        {offline ? "↓ — ↑ —" : `↓ ${rate(vitals.speedIn)} ↑ ${rate(vitals.speedOut)}`}
      </span>
      <span className="fx-ds-host-rules" title={routeTitle || undefined} data-muted={rules === 0 || rules === null ? "" : undefined}>
        {rules === null ? "—" : <><b>{rules}</b><i> 转发</i></>}
      </span>
      <span className="fx-ds-host-ver">
        {offline ? (
          <span className="fx-ds-host-tag" data-tone="down">{neverReported ? "未上报" : `离线${ago ? ` ${ago}` : ""}`}</span>
        ) : null}
        {maintenance ? (
          <span className="fx-ds-host-tag" data-tone="warn" title={host?.maintenanceNote ? `维护中：${host.maintenanceNote}` : "维护中：不参与线路和组的调度"}>维护中</span>
        ) : null}
        {trafficExcluded ? (
          <span className="fx-ds-host-tag" data-tone="warn" title={hostTrafficFailoverTitle(host)}>组调度暂停</span>
        ) : null}
        {upgrade && !offline ? <span className="fx-ds-host-tag" data-tone="warn" title={`Agent v${agentVersion}`}>可升级</span> : null}
        {!offline && !upgrade && !maintenance && !trafficExcluded ? (
          <span className="fx-ds-host-version">{agentVersion || "—"}</span>
        ) : null}
      </span>
      {/* 操作的点击不能冒泡成「打开详情」：点「删除」弹出详情页是最糟的那种意外 */}
      <span className="fx-ds-host-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        {props.dragHandle}
        <EntityActions primary={primary} menu={menu} menuOnly menuLabel={`${name} 的更多操作`} />
      </span>
    </div>
  );
}

/** 电脑上那张表的表头（手机上 CSS 藏掉）。列和 .fx-ds-host 的 grid 对齐。 */
export function HostDsTableHead() {
  return (
    <div className="fx-ds-host-head" aria-hidden="true">
      <span />
      <span>主机</span>
      <span>系统</span>
      <span>地区 · 地址</span>
      <span>CPU</span>
      <span>内存</span>
      <span>磁盘</span>
      <span>网速</span>
      <span>转发</span>
      <span>版本</span>
      <span />
    </div>
  );
}
