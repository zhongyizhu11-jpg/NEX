/*
  一键网络调优的 Agent 扩展模块，名字 "nettune"，Go 端是 agent/ext_nettune.go（Agent 2.2.250 起）。
  参数表和「达标」的判断在 shared/netTune.ts。

  面板只在内存里记两样，每台主机一份：
    - pending：管理员点了「检查」或「一键调优」，还没收到结果的那一轮。每轮扩展通道都把它作为
      指令发下去，直到 Agent 报回同一个 id 的 done；3 分钟没回就算超时（Agent 不在线、版本太旧）。
    - latest / lastApply：最近一次结果、最近一次调优的结果（改了哪些、哪些没改成）。
  不进库：这是随手查一下、调一下的工具，面板重启后再点一次「检查」就行。
*/
import { randomUUID } from "node:crypto";

import { normalizeNetTuneResult, type NetTuneResult } from "../../shared/netTune";
import { registerAgentExtModule, wakeAgentExt, type AgentExtHost } from "./agentExt";

export const NETTUNE_PENDING_TIMEOUT_MS = 3 * 60_000;

export type NetTunePending = { id: string; apply: boolean; requestedAt: number };

type HostState = {
  pending: NetTunePending | null;
  /** 上一轮超时的那次（界面上提示「Agent 没有回应」）。 */
  timedOut: NetTunePending | null;
  latest: NetTuneResult | null;
  lastApply: NetTuneResult | null;
};

const states = new Map<number, HostState>();

function stateOf(hostId: number): HostState {
  let state = states.get(hostId);
  if (!state) {
    state = { pending: null, timedOut: null, latest: null, lastApply: null };
    states.set(hostId, state);
  }
  return state;
}

function expirePending(state: HostState, now: number) {
  if (state.pending && now - state.pending.requestedAt > NETTUNE_PENDING_TIMEOUT_MS) {
    state.timedOut = state.pending;
    state.pending = null;
  }
}

/** 点「检查」或「一键调优」。同一台主机已经有一轮在等时直接返回那一轮（不叠加）。 */
export function requestNetTuneRun(hostId: number, apply: boolean, now = Date.now()): NetTunePending {
  const state = stateOf(hostId);
  expirePending(state, now);
  if (state.pending) {
    // 在等「检查」时又点了「调优」：调优优先（调优完也会读一遍值）。
    if (apply && !state.pending.apply) state.pending = { id: randomUUID().replace(/-/g, ""), apply: true, requestedAt: now };
    return state.pending;
  }
  state.pending = { id: randomUUID().replace(/-/g, ""), apply, requestedAt: now };
  state.timedOut = null;
  void wakeAgentExt(hostId, apply ? "nettune-apply" : "nettune-check");
  return state.pending;
}

export function netTuneStatus(hostId: number, now = Date.now()) {
  const state = stateOf(hostId);
  expirePending(state, now);
  return {
    pending: state.pending,
    timedOut: state.timedOut,
    latest: state.latest,
    lastApply: state.lastApply,
  };
}

function directiveFor(host: AgentExtHost, now = Date.now()) {
  const state = states.get(Number(host.id));
  if (!state) return undefined;
  expirePending(state, now);
  if (!state.pending) return undefined;
  return { runs: [{ id: state.pending.id, apply: state.pending.apply }] };
}

export function ingestNetTuneReport(host: AgentExtHost, report: unknown) {
  const state = states.get(Number(host.id));
  if (!state?.pending || !report || typeof report !== "object") return;
  const results = Array.isArray((report as { results?: unknown }).results) ? (report as { results: unknown[] }).results : [];
  for (const raw of results.slice(0, 16)) {
    const result = normalizeNetTuneResult(raw);
    if (!result || result.id !== state.pending.id || result.status !== "done") continue;
    state.latest = result;
    if (result.apply) state.lastApply = result;
    state.pending = null;
    state.timedOut = null;
    break;
  }
}

registerAgentExtModule({
  name: "nettune",
  directive: (host) => directiveFor(host),
  ingest: ingestNetTuneReport,
  // 有一轮在等时 5 秒来一次，结果马上就能看到；平时不催。
  intervalSeconds: (host) => (states.get(Number(host.id))?.pending ? 5 : undefined),
});

/** 本地开发面板（server/devPanel.ts）放一份演示结果；线上不会调用。 */
export function seedNetTuneDemoResult(hostId: number, result: NetTuneResult) {
  const state = stateOf(hostId);
  state.latest = result;
  if (result.apply) state.lastApply = result;
}

/** 只给测试用。 */
export function resetNetTuneStateForTest() {
  states.clear();
}

export const __test = { directiveFor };
