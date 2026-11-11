/*
  Mieru 落地的 Agent 扩展模块 "mita"（Go 端 agent/ext_mita.go）。

  指令：这台机器上全部启用中的 Mieru 入站合成的 mita 配置、钉死版本的 mita 从哪拿、哈希是多少
       （server/mitaRuntime.ts 的 buildMitaDirective）。一个都没有时发 enabled:false，Agent 只停它自己装的。
  上报：mita 跑没跑起来、每个端口听没听上、上次应用的是哪一版，以及每个用户的累计流量
       （记账在 server/mitaTraffic.ts）。

  Agent 低于 MIERU_AGENT_VERSION 时不下发：那些 Agent 没有这个模块，入站照常保存，列表上显示
  「需要升级 Agent」（server/routers/proxyInbounds.ts）。
*/
import { getEnabledProxyInboundsByHost, getEnabledProxyInboundsWithUsersByHost } from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { buildMitaHostPlan, isMieruAgentSupported } from "../../shared/mieruInbound";
import { APP_VERSION } from "../../shared/versions";
import {
  buildMitaDirective,
  parseMitaRuntimeReport,
  parseMitaTrafficReport,
  rememberMitaPlan,
  rememberMitaReport,
} from "../mitaRuntime";
import { applyMitaTrafficReport } from "../mitaTraffic";
import { registerAgentExtModule, type AgentExtHost } from "./agentExt";

const loggedSkips = new Set<string>();

/** 这台机器该收到什么。只有确实有 Mieru 入站时才去读用户表（扩展通道每台机器一分钟一轮）。 */
export async function mitaDirectiveForHost(host: AgentExtHost) {
  if (!isMieruAgentSupported(host.agentVersion)) return undefined;
  const hostId = Number(host.id);
  const rows = await getEnabledProxyInboundsByHost(hostId);
  const hasMieru = rows.some((row: { protocol?: unknown }) => String(row.protocol || "").toLowerCase() === "mieru");
  const entries = hasMieru
    ? (await getEnabledProxyInboundsWithUsersByHost(hostId)).filter((row) => row.protocol === "mieru")
    : [];
  const plan = buildMitaHostPlan(entries.map((row) => ({ id: row.id, inbound: row.inbound })));
  for (const item of plan.skipped) {
    const key = `${hostId}|${item.inboundId}|${item.inboundUserId || 0}|${item.reason}`;
    if (loggedSkips.has(key)) continue;
    if (loggedSkips.size > 4096) loggedSkips.clear();
    loggedSkips.add(key);
    appendPanelLog("warn", `[Mita] skip host=${hostId} inbound=${item.inboundId}${item.inboundUserId ? ` user=${item.inboundUserId}` : ""} reason=${item.reason}`);
  }
  const { getSingboxAccelerator } = await import("../agentHeartbeatRuntime");
  const directive = buildMitaDirective(plan, { appVersion: APP_VERSION, accelerator: await getSingboxAccelerator() });
  rememberMitaPlan(hostId, plan, directive.revision);
  return directive;
}

export async function ingestMitaReport(host: AgentExtHost, report: unknown) {
  const parsed = parseMitaRuntimeReport(report);
  if (parsed) rememberMitaReport(Number(host.id), parsed);
  const traffic = parseMitaTrafficReport(report);
  if (traffic) await applyMitaTrafficReport(Number(host.id), traffic);
}

registerAgentExtModule({
  name: "mita",
  directive: mitaDirectiveForHost,
  ingest: ingestMitaReport,
});
