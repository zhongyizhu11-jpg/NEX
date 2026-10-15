import { ArrowDown, ArrowDownUp, ArrowUp, Cpu, HardDrive, MemoryStick } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";
import { formatAgo } from "@shared/dashboardAttention";
import type { HostVitals } from "./useHostVitals";

/*
  「云母」主题下主机卡的卡身，照 bluesmkun/openlat 的 NodeCard 排（2026-10-15 用户要求「细节完全按照仓库的弄」）：

    名字                                  [● 在线 已运行 3 天]      ← 状态胶囊在右上（openlat 的 StatusPill）
    地区 · 系统 · IP
    ⌂ CPU            18%    ▭ 内存            42%                ← 2×2 四格读数（openlat 的 Meter）：
    ━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━━━━━━━━━━                       标签在左、百分比在右、凹槽里一段渐变粗条、
    已运行 3 天             2.90 / 6.00 GB                            底下一行小字
    ⊟ 硬盘            36%    ⇅ 流量            21%
    ━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━━━━━━━━━━
    39.6 / 106 GB           105 / 500 GB
    连接        80 / 60     转发      14 条 · 3 条线路             ← openlat 的「连接 / 续费」两列
    [↓ 下行   2.6 MB/s]     [↑ 上行   1.4 MB/s]                   ← 两条凹陷轨道，箭头下行蓝、上行琥珀

  离线的机器照 openlat 一样铺满同样的格子（读数「—」、轨道「—」），卡高和在线的一致。
  样式全在 theme-mica.css 里（.fx-mica-*），别的主题不渲染这个组件。
*/

const pctText = (value: number | null, online: boolean) => {
  if (!online || value === null) return "—";
  const v = Math.max(0, Math.min(100, value));
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
};
const pair = (used: number | null, total: number | null) => {
  if (used === null || total === null) return total === null ? "—" : formatBytes(total);
  return `${formatBytes(used)} / ${formatBytes(total)}`;
};
const speed = (value: number | null) => (value === null ? "—" : `${formatBytes(value)}/s`);

function Meter({
  icon: Icon,
  label,
  percent,
  online,
  tone,
  foot,
}: {
  icon: typeof Cpu;
  label: string;
  percent: number | null;
  online: boolean;
  tone: "cpu" | "mem" | "disk" | "net";
  foot: string;
}) {
  const filled = !online || percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const danger = online && percent !== null && filled >= 90;
  return (
    <div className="fx-mica-meter">
      <div className="fx-mica-meter-head">
        <span className="fx-mica-meter-label"><Icon aria-hidden="true" /><span>{label}</span></span>
        <b data-danger={danger ? "" : undefined}>{pctText(percent, online)}</b>
      </div>
      <div className="fx-mica-bar" data-tone={danger ? "danger" : tone}>
        <span style={{ width: `${filled}%` }} />
      </div>
      <div className="fx-mica-meter-foot">{foot}</div>
    </div>
  );
}

/** 右上角的状态胶囊：在线绿、离线红、没接入灰；在线的点带呼吸光晕（openlat 的 .pulse-ok） */
export function MicaStatusPill({ host, vitals, now }: { host: any; vitals: HostVitals; now: number }) {
  let tone: "ok" | "danger" | "muted" = "muted";
  let text = "未接入";
  if (vitals.isOnline) {
    tone = "ok";
    text = vitals.uptimeText && vitals.uptimeText !== "—" ? `在线 ${vitals.uptimeText}` : "在线";
  } else if (vitals.health !== "unknown") {
    tone = "danger";
    const seen = host?.lastHeartbeat ? new Date(host.lastHeartbeat).getTime() : NaN;
    const ago = Number.isFinite(seen) && seen > 0 ? formatAgo(now - seen).replace(/前$/, "") : "";
    text = ago ? `离线 ${ago}` : "离线";
  }
  return (
    <span className="fx-mica-pill" data-tone={tone}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

export function MicaHostBody({ host, vitals }: { host: any; vitals: HostVitals }) {
  const online = vitals.isOnline;
  const ruleCount = Number(host?.ruleCount);
  const tunnelCount = Number(host?.tunnelCount);
  const rules = Number.isFinite(ruleCount) ? ruleCount : 0;
  const tunnels = Number.isFinite(tunnelCount) ? tunnelCount : 0;
  const links = !online && rules > 0
    ? `${rules} 条受影响`
    : rules === 0 && tunnels === 0
      ? "还没有"
      : [rules > 0 ? `${rules} 条` : null, tunnels > 0 ? `${tunnels} 条线路` : null].filter(Boolean).join(" · ");
  const connections = online && vitals.tcpConnections !== null
    ? `${vitals.tcpConnections} / ${vitals.udpConnections ?? "—"}`
    : "—";
  const trafficFoot = vitals.trafficLimit > 0
    ? `${formatBytes(vitals.usedBytes)} / ${formatBytes(vitals.trafficLimit)}`
    : `${formatBytes(vitals.usedBytes)} / ∞`;

  return (
    <div className="fx-mica-body">
      <div className="fx-mica-meters">
        <Meter icon={Cpu} tone="cpu" label="CPU" percent={vitals.cpuPercent} online={online} foot={online ? `${vitals.uptimeLabel} ${vitals.uptimeText}` : "—"} />
        <Meter icon={MemoryStick} tone="mem" label="内存" percent={vitals.memoryPercent} online={online} foot={pair(online ? vitals.memoryUsed : null, vitals.memoryTotal)} />
        <Meter icon={HardDrive} tone="disk" label="硬盘" percent={vitals.diskPercent} online={online} foot={pair(online ? vitals.diskUsed : null, vitals.diskTotal)} />
        <Meter icon={ArrowDownUp} tone="net" label="流量" percent={vitals.trafficPercent} online={online || vitals.trafficPercent !== null} foot={trafficFoot} />
      </div>
      <dl className="fx-mica-dl">
        <div><dt>连接</dt><dd title="TCP / UDP 连接数">{connections}</dd></div>
        <div><dt>转发</dt><dd>{links}</dd></div>
      </dl>
      <div className="fx-mica-tracks">
        <div className="fx-mica-track">
          <span className="fx-mica-track-label"><ArrowDown aria-hidden="true" data-dir="down" />下行</span>
          <b>{online ? speed(vitals.speedIn) : "—"}</b>
        </div>
        <div className="fx-mica-track">
          <span className="fx-mica-track-label"><ArrowUp aria-hidden="true" data-dir="up" />上行</span>
          <b>{online ? speed(vitals.speedOut) : "—"}</b>
        </div>
      </div>
    </div>
  );
}
