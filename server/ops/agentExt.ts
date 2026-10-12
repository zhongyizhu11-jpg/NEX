/*
  Agent 扩展通道（Agent 2.2.216 起）。

  第五套主题那批要 Agent 配合的功能（地区规则、IP 封禁、在线 IP、安全巡检、Agent 中转、
  全部重启、导入现有配置）不去改那条已经很复杂的心跳，而是走一条独立的小通道：

    Agent 每隔 interval 秒 POST /api/agent/ext（和心跳同样的认证与加密），
    body = { modules: { <模块名>: <这一轮的上报> } }
    回复 = { interval, modules: { <模块名>: <给这台主机的指令> } }

  每个功能在 server/ops/<功能>Agent.ts 里 registerAgentExtModule 一次（agentExtModules.ts
  统一 import）。Go 端对应 agent/ext.go + agent/ext_<功能>.go，名字一一对应。

  面板这边有变化想让 Agent 立刻来取（例如刚封了一个 IP），调 wakeAgentExt(hostId)，
  它通过已有的 SSE 事件流发一个 agent-ext 事件，Agent 收到就提前跑一轮。
*/
import { isAgentVersionAtLeast } from "../../shared/version";
import { sendAgentEvent } from "../agentEvents";

/** 支持扩展通道的最低 Agent 版本。 */
export const AGENT_EXT_MIN_VERSION = "2.2.216";

export const AGENT_EXT_DEFAULT_INTERVAL_SECONDS = 60;
export const AGENT_EXT_MIN_INTERVAL_SECONDS = 5;

export type AgentExtHost = {
  id: number;
  name?: string | null;
  agentVersion?: string | null;
  [key: string]: unknown;
};

export type AgentExtModule = {
  /** 模块名，和 Go 端 registerExtModule 的名字一致，例如 "firewall"。 */
  name: string;
  /** 这台主机这一轮该收到的指令；返回 undefined 表示不下发。 */
  directive?: (host: AgentExtHost) => Promise<unknown> | unknown;
  /** 收 Agent 这一轮的上报。抛错只记日志，不影响别的模块。 */
  ingest?: (host: AgentExtHost, report: unknown) => Promise<void> | void;
  /** 希望 Agent 多久来一次（秒）。取所有模块里最小的一个；不给就是默认 60 秒。 */
  intervalSeconds?: (host: AgentExtHost) => number | undefined;
};

const modules = new Map<string, AgentExtModule>();

export function registerAgentExtModule(module: AgentExtModule) {
  const name = String(module.name || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`invalid agent ext module name: ${name}`);
  modules.set(name, { ...module, name });
}

export function listAgentExtModules(): AgentExtModule[] {
  return Array.from(modules.values());
}

export function hostSupportsAgentExt(host: { agentVersion?: string | null } | null | undefined) {
  return !!host && isAgentVersionAtLeast(String(host.agentVersion || ""), AGENT_EXT_MIN_VERSION);
}

/** 让这台主机的 Agent 立刻跑一轮扩展通道（没连着事件流时什么也不做，下一轮照常来取）。 */
export function wakeAgentExt(hostId: number, reason: string) {
  return sendAgentEvent(Number(hostId), "agent-ext", { reason, ts: Date.now() });
}

export type AgentExtResponse = {
  interval: number;
  modules: Record<string, unknown>;
};

export async function handleAgentExtRound(host: AgentExtHost, body: unknown): Promise<AgentExtResponse> {
  const reports = body && typeof body === "object" && (body as any).modules && typeof (body as any).modules === "object"
    ? (body as any).modules as Record<string, unknown>
    : {};
  for (const [name, report] of Object.entries(reports)) {
    const module = modules.get(name);
    if (!module?.ingest || report === undefined || report === null) continue;
    try {
      await module.ingest(host, report);
    } catch (error) {
      console.warn(`[AgentExt] host=${host.id} module=${name} ingest failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const directives: Record<string, unknown> = {};
  let interval = AGENT_EXT_DEFAULT_INTERVAL_SECONDS;
  for (const module of modules.values()) {
    try {
      const value = module.directive ? await module.directive(host) : undefined;
      if (value !== undefined) directives[module.name] = value;
      const wanted = module.intervalSeconds?.(host);
      if (Number.isFinite(wanted) && Number(wanted) > 0) interval = Math.min(interval, Number(wanted));
    } catch (error) {
      console.warn(`[AgentExt] host=${host.id} module=${module.name} directive failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    interval: Math.max(AGENT_EXT_MIN_INTERVAL_SECONDS, Math.floor(interval)),
    modules: directives,
  };
}
