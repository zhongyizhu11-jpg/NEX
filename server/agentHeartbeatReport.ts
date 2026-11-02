import crypto from "crypto";
import { normalizeAgentText } from "./agentInputValidation";

/*
  心跳的第一步：把 Agent 报上来的状态规整成面板内部用的形状（纯函数，不碰数据库和缓存）。
  从 server/agentHeartbeatRoute.ts 里原样搬出来，行为不变；多了 localState 的大小上限。
*/

export const AGENT_STATE_SECTION_NAMES = [
  "runningRules",
  "ruleLatencyProbes",
  "tunnelProbes",
  "forwardGroupProbes",
  "hostProbeServices",
  "guardRules",
  "dnsWatch",
  // 共享 TLS 入站（SNI 分流）的路由表，见 server/tlsInboundRuntime.ts。老 Agent 不认这个键，照样回签名也无妨。
  "sniInbounds",
] as const;
export const AGENT_STATE_SIGNATURE_SCHEMA = "v2";

export type AgentStateSectionName = typeof AGENT_STATE_SECTION_NAMES[number];
export type AgentStateSignatures = Partial<Record<AgentStateSectionName, string>>;
export type AgentLocalRuntimeRuleState = {
  port: number;
  ruleId: number;
  tunnelId?: number;
  forwardType: string;
  targetIp?: string;
  targetPort?: number;
  protocol?: string;
  transportVersion?: "v1" | "v2";
  ready?: boolean;
};
export type AgentLocalRuntimeTunnelState = {
  port: number;
  tunnelId: number;
  forwardType: string;
  transportVersion?: "v1" | "v2";
  wireGuardPlane?: "kernel" | "netstack";
  ready?: boolean;
};
// Agent 2.2.220 起单独上报每条跑着的 V2 隧道数据面（入口机上没有隧道监听端口，
// 以前只有出口通过 tunnels[] 报得出来）。
export type AgentLocalRuntimeWireGuardPlaneState = {
  tunnelId: number;
  plane: "kernel" | "netstack";
};
export type AgentLocalRuntimeServiceState = {
  name: string;
  active: boolean;
  hasWork: boolean;
  status?: string;
  message?: string;
  hooksReady?: boolean;
  connectionState?: string;
};
export type AgentLocalRuntimeState = {
  rules: AgentLocalRuntimeRuleState[];
  tunnels: AgentLocalRuntimeTunnelState[];
  services: AgentLocalRuntimeServiceState[];
  wireGuardPlanes?: AgentLocalRuntimeWireGuardPlaneState[];
};

export function canonicalizeStateSection(value: any): any {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const canonicalValue = canonicalizeStateSection(item);
        return { canonicalValue, sortKey: JSON.stringify(canonicalValue) };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ canonicalValue }) => canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc: Record<string, any>, key) => {
        const item = value[key];
        if (typeof item !== "undefined") acc[key] = canonicalizeStateSection(item);
        return acc;
      }, {});
  }
  return value;
}

export function stableStateSignature(value: any) {
  return crypto
    .createHash("sha256")
    .update(`${AGENT_STATE_SIGNATURE_SCHEMA}\n${JSON.stringify(canonicalizeStateSection(value))}`)
    .digest("hex");
}


export function normalizeAgentStateSignatures(input: any): AgentStateSignatures {
  if (!input || typeof input !== "object") return {};
  const output: AgentStateSignatures = {};
  for (const name of AGENT_STATE_SECTION_NAMES) {
    const value = String(input[name] || "").trim();
    if (/^[a-f0-9]{64}$/i.test(value)) output[name] = value.toLowerCase();
  }
  return output;
}

export function normalizeRuntimeStateSignature(input: any) {
  const value = String(input || "").trim();
  return /^[a-f0-9]{1,128}$/i.test(value) ? value.toLowerCase() : "";
}

export function normalizeMimicEnvironment(input: any) {
  if (!input || typeof input !== "object" || typeof input.available !== "boolean") return null;
  return {
    available: input.available === true,
    version: normalizeAgentText(input.version, 64) || null,
    status: normalizeAgentText(input.status, 64) || (input.available ? "ready" : "unknown"),
    message: normalizeAgentText(input.message, 512) || null,
  };
}

/*
  Agent 上报的 localState 每轮都会整份放进内存缓存（按主机一份）。数组长度和字符串长度都设上限，
  免得一个出错或被冒用的 Agent 报一份巨大的状态把面板内存撑满。上限远大于一台机器实际能跑的量
  （端口最多 65535 个），正常 Agent 碰不到；超出的部分直接丢掉。
*/
export const AGENT_LOCAL_STATE_LIMITS = {
  rules: 70_000,
  tunnels: 20_000,
  services: 256,
  wireGuardPlanes: 20_000,
  text: 256,
} as const;

function cappedArray(value: unknown, limit: number): any[] {
  return Array.isArray(value) ? (value.length > limit ? value.slice(0, limit) : value) : [];
}

function cappedText(value: unknown, limit: number = AGENT_LOCAL_STATE_LIMITS.text) {
  const text = String(value || "").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

export function normalizeAgentLocalRuntimeState(input: any): AgentLocalRuntimeState | null {
  if (!input || typeof input !== "object") return null;
  const rules = Array.isArray(input.rules)
    ? cappedArray(input.rules, AGENT_LOCAL_STATE_LIMITS.rules)
      .map((item: any) => ({
        port: Number(item?.port || 0),
        ruleId: Number(item?.ruleId || 0),
        tunnelId: Number(item?.tunnelId || 0) || undefined,
        forwardType: cappedText(item?.forwardType),
        targetIp: cappedText(item?.targetIp) || undefined,
        targetPort: Number(item?.targetPort || 0) || undefined,
        protocol: cappedText(item?.protocol, 16) || undefined,
        transportVersion: String(item?.transportVersion || "").trim().toLowerCase() === "v2"
          ? "v2" as const
          : String(item?.transportVersion || "").trim().toLowerCase() === "v1"
            ? "v1" as const
            : undefined,
        ready: item?.ready !== false,
      }))
      .filter((item: AgentLocalRuntimeRuleState) => item.port > 0)
    : [];
  const tunnels = Array.isArray(input.tunnels)
    ? cappedArray(input.tunnels, AGENT_LOCAL_STATE_LIMITS.tunnels)
      .map((item: any) => ({
        port: Number(item?.port || 0),
        tunnelId: Number(item?.tunnelId || 0),
        forwardType: cappedText(item?.forwardType),
        transportVersion: String(item?.transportVersion || "").trim().toLowerCase() === "v2"
          ? "v2" as const
          : String(item?.transportVersion || "").trim().toLowerCase() === "v1"
            ? "v1" as const
            : undefined,
        wireGuardPlane: (["kernel", "netstack"] as const).find((plane) => plane === String(item?.wireGuardPlane || "").trim().toLowerCase()),
        ready: item?.ready !== false,
      }))
      .filter((item: AgentLocalRuntimeTunnelState) => item.port > 0 && item.tunnelId > 0)
    : [];
  const services = Array.isArray(input.services)
    ? cappedArray(input.services, AGENT_LOCAL_STATE_LIMITS.services)
      .map((item: any) => ({
        name: cappedText(item?.name),
        active: item?.active === true,
        hasWork: item?.hasWork === true,
        status: normalizeAgentText(item?.status, 32) || undefined,
        message: normalizeAgentText(item?.message, 512) || undefined,
        hooksReady: typeof item?.hooksReady === "boolean" ? item.hooksReady : undefined,
        connectionState: normalizeAgentText(item?.connectionState, 32) || undefined,
      }))
      .filter((item: AgentLocalRuntimeServiceState) => !!item.name)
    : [];
  const wireGuardPlanes = Array.isArray(input.wireGuardPlanes)
    ? cappedArray(input.wireGuardPlanes, AGENT_LOCAL_STATE_LIMITS.wireGuardPlanes)
      .map((item: any) => ({
        tunnelId: Number(item?.tunnelId || 0),
        plane: (["kernel", "netstack"] as const).find((plane) => plane === String(item?.plane || "").trim().toLowerCase()),
      }))
      .filter((item: any): item is AgentLocalRuntimeWireGuardPlaneState => item.tunnelId > 0 && !!item.plane)
    : [];
  return { rules, tunnels, services, wireGuardPlanes };
}
