/*
  主机「内核快速转发」的面板侧逻辑：指令、Agent 上报解析、设置页状态。不依赖扩展通道本身，
  routers/hosts.ts 直接 import 也不会和 agentExt 绕成循环引用；注册在 flowOffloadAgent.ts。
*/
import { isAgentVersionAtLeast } from "../../shared/version";

/** 支持快速转发的最低 Agent 版本。 */
export const AGENT_FLOW_OFFLOAD_MIN_VERSION = "2.2.221";

export type FlowOffloadReport = {
  enabled: boolean;
  active: boolean;
  error: string;
  kernel: string;
  devices: string[];
  tcpPorts: number;
  udpPorts: number;
  flows: number;
  offloaded: number;
  overflows: number;
  at: number;
};

const reports = new Map<number, FlowOffloadReport>();

export function hostSupportsFlowOffload(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || ""), AGENT_FLOW_OFFLOAD_MIN_VERSION);
}

export function flowOffloadReportFor(hostId: number): FlowOffloadReport | undefined {
  return reports.get(Number(hostId));
}

function text(value: unknown, max = 300) {
  return String(value ?? "").slice(0, max);
}

function count(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function parseFlowOffloadReport(value: unknown, now = Date.now()): FlowOffloadReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as any;
  const accounting = report.accounting && typeof report.accounting === "object" ? report.accounting : {};
  return {
    enabled: !!report.enabled,
    active: !!report.active,
    error: text(report.error || accounting.error),
    kernel: text(report.kernel, 80),
    devices: Array.isArray(report.devices) ? report.devices.slice(0, 32).map((device: unknown) => text(device, 32)) : [],
    tcpPorts: count(report.tcpPorts),
    udpPorts: count(report.udpPorts),
    flows: count(accounting.flows),
    offloaded: count(accounting.offloaded),
    overflows: count(accounting.overflows),
    at: now,
  };
}

/** 超过这么久没上报，设置页当「等主机上报」，不把旧状态当实时的。 */
export const FLOW_OFFLOAD_REPORT_STALE_MS = 5 * 60_000;

/** 主机设置页的状态：开关关着是 null。 */
export function flowOffloadStatusView(host: any, now = Date.now()) {
  if (!host?.flowOffload) return null;
  if (!hostSupportsFlowOffload(host)) {
    return { state: "agent-old" as const, message: `主机 Agent 要升到 ${AGENT_FLOW_OFFLOAD_MIN_VERSION} 起才会生效`, offloaded: 0 };
  }
  const report = flowOffloadReportFor(Number(host.id));
  if (!report || now - report.at > FLOW_OFFLOAD_REPORT_STALE_MS) return { state: "pending" as const, message: "等主机上报", offloaded: 0 };
  if (report.active) return { state: "active" as const, message: report.error || "", offloaded: report.offloaded };
  return { state: "error" as const, message: report.error || "没有生效", offloaded: 0 };
}

export function flowOffloadDirectiveFor(host: { agentVersion?: string | null; flowOffload?: boolean | null } | null | undefined) {
  if (!hostSupportsFlowOffload(host)) return undefined;
  return { enabled: !!host?.flowOffload };
}

export function ingestFlowOffloadReport(host: { id?: unknown }, report: unknown, now = Date.now()) {
  const parsed = parseFlowOffloadReport(report, now);
  if (parsed) reports.set(Number(host.id), parsed);
}

export function resetFlowOffloadReportsForTest() {
  reports.clear();
}
