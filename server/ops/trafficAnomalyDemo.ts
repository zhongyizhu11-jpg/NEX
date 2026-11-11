/*
  开发面板（FORWARDX_DEV_PANEL=1）里流量异常的演示数据：一条正在生效的临时限速、几条异常 / 恢复事件，
  外加把设置打开，设置页、事件时间线、规则卡上才看得到样子。开发面板不跑定时任务，这些不会被撤掉。
*/
import { executeRaw, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { setSettings } from "../repositories/settingsRepository";
import { recordPanelEvent } from "./panelEvents";
import { loadAnomalyThrottles, saveAnomalyThrottle } from "./trafficAnomalyThrottles";
import { formatThrottleUntil } from "../../shared/trafficAnomaly";

const q = quoteDbIdentifier;

export async function seedTrafficAnomalyDemo(ruleIds: number[]) {
  await executeRaw(`DELETE FROM ${q("traffic_anomaly_throttles")}`);
  const ids = ruleIds.filter((id) => id > 0);
  if (ids.length === 0) return;
  const rows = await queryRaw<Record<string, unknown>>(
    `SELECT ${q("id")}, ${q("name")}, ${q("userId")}, ${q("hostId")}, ${q("rateLimitMbps")} FROM ${q("forward_rules")} WHERE ${q("id")} IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  // 挑没有手动限速（或手动限速比 60 松）的规则：手动更严时真实流程根本不会加临时限速，演示也别造这种。
  const ordered = ids.map((id) => rows.find((row) => Number(row.id) === id)).filter(Boolean) as Array<Record<string, unknown>>;
  const usable = ordered.filter((row) => !(Number(row.rateLimitMbps) > 0 && Number(row.rateLimitMbps) <= 60));
  const [first, second] = usable;
  if (!first) return;
  await setSettings({
    "ops.trafficAnomaly.enabled": "true",
    "ops.trafficAnomaly.sensitivity": "normal",
    "ops.trafficAnomaly.autoThrottle": "true",
    "ops.trafficAnomaly.throttleMinutes": "30",
  });
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const appliedAt = now - 6 * 60_000;
  const expiresAt = appliedAt + 30 * 60_000;
  await saveAnomalyThrottle({ ruleId: Number(first.id), mbps: 60, baselineMbps: 12, thresholdMbps: 60, appliedAt, expiresAt });
  await loadAnomalyThrottles(true);
  const name = String(first.name || `#${first.id}`);
  const common = { ruleId: Number(first.id), userId: Number(first.userId) || null, hostId: Number(first.hostId) || null };
  await recordPanelEvent({
    ...common,
    kind: "rule.ip_conn_surge",
    level: "warn",
    at: nowSec - 3 * 3600,
    message: `规则「${name}」上来源 IP 198.51.100.23 同时开着 1260 个连接，超过 800 个，已持续 10 分钟`,
    data: { scope: "ip", ip: "198.51.100.23", conns: 1260, threshold: 800, sustainMinutes: 10 },
  });
  await recordPanelEvent({
    ...common,
    kind: "rule.ip_conn_surge.recovered",
    level: "info",
    at: nowSec - 2 * 3600 - 40 * 60,
    message: `规则「${name}」上来源 IP 198.51.100.23 的连接数回落到 42 个（持续 22 分钟，最多 1410 个）`,
    data: { scope: "ip", ip: "198.51.100.23", conns: 42, peak: 1410, durationSeconds: 22 * 60 },
  });
  if (second) {
    await recordPanelEvent({
      ruleId: Number(second.id),
      userId: Number(second.userId) || null,
      hostId: Number(second.hostId) || null,
      kind: "rule.traffic_surge.recovered",
      level: "info",
      at: nowSec - 50 * 60,
      message: `规则「${String(second.name || `#${second.id}`)}」的流量回落到 8.2 Mbps（突增持续 25 分钟，最高 214 Mbps）`,
      data: { scope: "rule", valueMbps: 8.2, peakMbps: 214, durationSeconds: 25 * 60, throttleRevoked: false },
    });
  }
  await recordPanelEvent({
    ...common,
    kind: "rule.traffic_surge",
    level: "warn",
    at: Math.floor(appliedAt / 1000),
    message: `规则「${name}」的流量突增：现在 186 Mbps，平时约 12 Mbps，约 16 倍，已持续 10 分钟；已自动限速到 60 Mbps，${formatThrottleUntil(expiresAt)} 自动撤掉`,
    data: { scope: "rule", valueMbps: 186, baselineMbps: 12, thresholdMbps: 60, multiplier: 5, sustainMinutes: 10, throttle: { mbps: 60, until: expiresAt } },
  });
}
