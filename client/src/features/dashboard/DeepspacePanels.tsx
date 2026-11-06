import { useMemo } from "react";

import { useNetworkMapData } from "@/features/network/networkMapData";
import { useNetworkMapModelFromData, type NetworkMapModel } from "@/features/network/networkMapModel";
import {
  attentionHealth,
  describeAttentionRow,
  sortAttentionRows,
  summarizeHiddenAttention,
  type DashboardAttention,
} from "@shared/dashboardAttention";
import type { NetworkHealth } from "@shared/networkHealth";

import { attentionHref } from "./attentionLinks";

/*
  「深空」主题的总览只换了排法，数据一条没多取：
    - 事件：就是「需要关注」那几行，画成日志（时间 · 级别 · 一句话），点进去落的页和原来一样；
    - 地区：首页地图本来就取了主机和隧道，这里按城市归一归 —— 几台、在线几台、经过这里的线路平均延迟。
  这个文件只在选了深空时 lazy 进来，别的主题首屏一个字节都不多。
*/

/** 事件最多列几行；和「需要关注」同一个数（再多就该去各自的页面看全部） */
const EVENT_ROWS = 6;

type Level = { tag: "ERR" | "WARN" | "INFO"; tone: "down" | "warn" | "muted" };

function levelOf(health: NetworkHealth): Level {
  if (health === "down") return { tag: "ERR", tone: "down" };
  if (health === "degraded" || health === "switching") return { tag: "WARN", tone: "warn" };
  return { tag: "INFO", tone: "muted" };
}

function clock(at: number | null): string {
  if (!at) return "--:--";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function DeepspaceEvents({ attention, isAdmin, onOpen, now = Date.now() }: {
  attention: DashboardAttention | null | undefined;
  isAdmin: boolean;
  onOpen: (href: string) => void;
  now?: number;
}) {
  const sorted = attention ? sortAttentionRows(attention.rows) : [];
  const shown = sorted.slice(0, EVENT_ROWS);
  const footer = attention ? summarizeHiddenAttention(attention.totals, shown) : null;
  return (
    <section id="dashboard-attention" className="fx-ds-panel fx-ds-events" aria-label="事件">
      <header className="fx-ds-panel-head"><b>事件</b><span>{attention ? `${sorted.length} 条` : "读取中"}</span></header>
      {attention && shown.length === 0 ? (
        <div className="fx-ds-event" data-tone="ok">
          <span className="fx-ds-event-time">{clock(now)}</span>
          <span className="fx-ds-event-level">[OK]</span>
          <span className="fx-ds-event-text">全部正常，没有要处理的事</span>
        </div>
      ) : null}
      {shown.map((row) => {
        const { title, detail } = describeAttentionRow(row, now);
        const href = attentionHref(row, { isAdmin });
        const level = levelOf(attentionHealth(row.reason));
        const body = (
          <>
            <span className="fx-ds-event-time">{clock(row.at)}</span>
            <span className="fx-ds-event-level">[{level.tag}]</span>
            <span className="fx-ds-event-text"><b>{title}</b>{detail ? <span> · {detail}</span> : null}</span>
          </>
        );
        return href ? (
          <button key={`${row.reason}:${row.id}`} type="button" className="fx-ds-event" data-tone={level.tone} onClick={() => onOpen(href)}>{body}</button>
        ) : (
          <div key={`${row.reason}:${row.id}`} className="fx-ds-event" data-tone={level.tone}>{body}</div>
        );
      })}
      {footer ? <p className="fx-ds-panel-foot">{footer}</p> : null}
    </section>
  );
}

export type RegionRow = {
  key: string;
  code: string;
  city: string;
  hosts: Array<{ id: number; health: NetworkHealth }>;
  online: number;
  latencyMs: number | null;
  tone: "ok" | "warn" | "down";
};

/** 按城市把主机归一归：几台、在线几台、经过这里的线路平均延迟（拿不到就是 null） */
export function buildRegionRows(model: Pick<NetworkMapModel, "nodes" | "links">): RegionRow[] {
  const groups = new Map<string, RegionRow>();
  const regionOfHost = new Map<number, string>();
  for (const node of model.nodes) {
    const key = node.city || node.name;
    regionOfHost.set(node.id, key);
    const row = groups.get(key) ?? { key, code: node.countryCode || "··", city: key, hosts: [], online: 0, latencyMs: null, tone: "ok" as const };
    row.hosts.push({ id: node.id, health: node.health });
    if (node.isOnline) row.online += 1;
    groups.set(key, row);
  }
  const latencies = new Map<string, number[]>();
  for (const link of model.links) {
    const latency = Number(link.latencyMs);
    if (!Number.isFinite(latency) || latency <= 0) continue;
    const touched = new Set(link.path.map((id) => regionOfHost.get(id)).filter((key): key is string => !!key));
    for (const key of touched) latencies.set(key, [...(latencies.get(key) || []), latency]);
  }
  for (const row of groups.values()) {
    const values = latencies.get(row.key) || [];
    row.latencyMs = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    row.tone = row.online === 0 ? "down" : row.online < row.hosts.length ? "warn" : "ok";
  }
  return [...groups.values()].sort((a, b) => b.hosts.length - a.hosts.length || a.city.localeCompare(b.city, "zh-CN"));
}

const HOST_TONE: Record<NetworkHealth, string> = {
  healthy: "ok",
  degraded: "warn",
  switching: "warn",
  down: "down",
  standby: "muted",
  unknown: "muted",
};

export function DeepspaceRegions({ enabled }: { enabled: boolean }) {
  const data = useNetworkMapData(enabled);
  const model = useNetworkMapModelFromData(data);
  const rows = useMemo(() => buildRegionRows(model), [model]);
  if (!enabled || rows.length === 0) return null;
  return (
    <section className="fx-ds-panel fx-ds-regions" aria-label="地区">
      <header className="fx-ds-panel-head"><b>地区</b><span>主机 · 延迟 · 在线</span></header>
      {rows.map((row) => (
        <div key={row.key} className="fx-ds-region" data-tone={row.tone}>
          <span className="fx-ds-region-code">{row.code}</span>
          <span className="fx-ds-region-city">{row.city}</span>
          <span className="fx-ds-region-count">{row.hosts.length} 台</span>
          <span className="fx-ds-region-lat">{row.online === 0 ? "离线" : row.latencyMs === null ? "—" : `${row.latencyMs} ms`}</span>
          <span className="fx-ds-region-cells" aria-hidden="true">
            {row.hosts.map((host) => <i key={host.id} data-tone={HOST_TONE[host.health] || "muted"} />)}
          </span>
          <span className="fx-ds-region-online">{row.online}/{row.hosts.length}</span>
        </div>
      ))}
    </section>
  );
}

export default function DeepspacePanels({ attention, isAdmin, onOpen, mapEnabled }: {
  attention: DashboardAttention | null | undefined;
  isAdmin: boolean;
  onOpen: (href: string) => void;
  mapEnabled: boolean;
}) {
  return (
    <>
      <DeepspaceEvents attention={attention} isAdmin={isAdmin} onOpen={onOpen} />
      <DeepspaceRegions enabled={mapEnabled} />
    </>
  );
}
