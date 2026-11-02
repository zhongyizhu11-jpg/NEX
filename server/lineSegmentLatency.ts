import dns from "node:dns";
import { isIP } from "node:net";

import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import { restrictedForwardTargetClass, restrictedForwardTargetLabel } from "./ruleTargetPolicy";
import { getHostEntryAddress } from "../shared/hostEntryAddress";
import { MAX_ROUTE_HOPS, type RouteEndpoint } from "../shared/routeGroup";

/*
  线路编辑框里的小闪电：这条线路此刻每一段多少毫秒（保存前就能测）。

  逐段从上一台机器测下一台：到中转是 ping 中转的入口地址（中继规则还没建，没有端口可连），到落地
  是 TCP 连落地的端口。每段一行 forward_tests（kind = line-segment），Agent 按普通目标测一次就报，
  不经任何转发运行时 —— 测的是「这两台机器之间」，和保存后中继探测的口径一样。
  隧道段测的是隧道两头机器之间的直连，标注出来；隧道内部的延迟在隧道自己的测试里看。
*/

export type LineSegmentDraft = {
  entryHostId: number;
  hops: number[];
  hopVia?: Array<number | null>;
  dest: RouteEndpoint | null;
  /** 落地这一段不测、直接报这句（比如目标被拦了）。 */
  destIssue?: string | null;
};

export type LineSegmentProbe = {
  fromHostId: number;
  fromName: string;
  toHostId: number | null;
  toName: string;
  viaTunnel: boolean;
  target: { ip: string; port: number; method: "tcp" | "ping" } | null;
  issue: string | null;
};

export async function planLineSegmentProbes(draft: LineSegmentDraft): Promise<LineSegmentProbe[]> {
  const hops = draft.hops.slice(0, MAX_ROUTE_HOPS);
  const nodes = [draft.entryHostId, ...hops];
  const hosts = await db.getHostsByIds(nodes) as any[];
  const byId = new Map(hosts.map((host) => [Number(host.id), host]));
  const nameOf = (hostId: number) => String(byId.get(hostId)?.name || "").trim() || `主机 ${hostId}`;
  const probes: LineSegmentProbe[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const from = nodes[index];
    const isLast = index === nodes.length - 1;
    if (isLast) {
      const dest = draft.dest;
      const filled = !!(dest && dest.ip && dest.port > 0);
      probes.push({
        fromHostId: from,
        fromName: nameOf(from),
        toHostId: null,
        toName: "落地",
        viaTunnel: false,
        target: filled && !draft.destIssue ? { ip: dest!.ip, port: dest!.port, method: "tcp" } : null,
        issue: draft.destIssue || (filled ? null : "落地地址还没填"),
      });
      break;
    }
    const to = nodes[index + 1];
    const address = byId.get(to) ? getHostEntryAddress(byId.get(to)) : "";
    probes.push({
      fromHostId: from,
      fromName: nameOf(from),
      toHostId: to,
      toName: nameOf(to),
      viaTunnel: !!draft.hopVia?.[index],
      target: address ? { ip: address, port: 0, method: "ping" } : null,
      issue: address ? null : `${nameOf(to)} 没有入口地址`,
    });
  }
  return probes;
}

/** 拨落地的是哪台：入口，或者最后一跳中转（和 planLineSegmentProbes 同一个口径）。 */
export function segmentDestDialHostId(draft: Pick<LineSegmentDraft, "entryHostId" | "hops">): number {
  const hops = draft.hops.slice(0, MAX_ROUTE_HOPS);
  return hops.length > 0 ? hops[hops.length - 1] : draft.entryHostId;
}

async function lookupAll(host: string): Promise<string[]> {
  const records = await dns.promises.lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * 「最后一台 → 落地」这一段，落地地址是用户随手填的。拨它的那台是别人的机器（共享主机）时，
 * 和规则同一把尺子（ruleTargetPolicy）：内网、环回、链路本地、云元数据这些不让测 ——
 * 不然普通用户能借别人的 Agent 去探内网端口。域名先在面板上解析，解析结果也要是公网，
 * 并且把测试钉在解析出来的那个地址上（不留给 Agent 再解析一次）。
 * 管理员、或者拨落地的就是他自己的机器：照旧。
 */
export async function vetSegmentDest(
  actor: { id: number; role: string },
  draft: Pick<LineSegmentDraft, "entryHostId" | "hops" | "dest">,
  resolve: (host: string) => Promise<string[]> = lookupAll,
): Promise<{ dest: RouteEndpoint | null; issue: string | null }> {
  const dest = draft.dest;
  if (actor.role === "admin" || !dest || !dest.ip || !(dest.port > 0)) return { dest, issue: null };
  const dialHostId = segmentDestDialHostId(draft);
  const [dialHost] = await db.getHostsByIds([dialHostId]) as any[];
  if (dialHost && Number(dialHost.userId) === Number(actor.id)) return { dest, issue: null };
  const blocked = (kind: string) => ({
    dest: null,
    issue: `落地地址是${restrictedForwardTargetLabel(kind)}，测它的主机不是你自己的，不能测`,
  });
  const literalKind = restrictedForwardTargetClass(dest.ip);
  if (literalKind) return blocked(literalKind);
  const host = String(dest.ip).trim().replace(/^\[(.*)\]$/, "$1");
  if (isIP(host)) return { dest, issue: null };
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) return { dest: null, issue: `落地地址 ${host} 解析不了` };
  for (const address of addresses) {
    const kind = restrictedForwardTargetClass(address);
    if (kind) return blocked(kind);
  }
  return { dest: { ...dest, ip: addresses[0] }, issue: null };
}

type Run = { ownerId: number; createdAt: number; probes: LineSegmentProbe[]; testIds: Array<number | null> };
const runs = new Map<string, Run>();
const RUN_TTL_MS = 10 * 60_000;

function sweep(now = Date.now()) {
  for (const [id, run] of runs) if (now - run.createdAt > RUN_TTL_MS) runs.delete(id);
}

export async function startLineSegmentLatency(actor: { id: number }, draft: LineSegmentDraft, ruleId = 0) {
  sweep();
  const probes = await planLineSegmentProbes(draft);
  const testIds: Array<number | null> = [];
  const touched = new Set<number>();
  for (const probe of probes) {
    if (!probe.target) {
      testIds.push(null);
      continue;
    }
    const id = await db.createForwardTest({
      ruleId: Math.max(0, Number(ruleId) || 0),
      hostId: probe.fromHostId,
      userId: actor.id,
      status: "pending",
      listenOk: false,
      targetReachable: false,
      forwardOk: false,
      message: JSON.stringify({ kind: "line-segment", targetIp: probe.target.ip, targetPort: probe.target.port, method: probe.target.method, hopLabel: `${probe.fromName} → ${probe.toName}` }),
    } as any);
    testIds.push(Number(id) || null);
    touched.add(probe.fromHostId);
  }
  for (const hostId of touched) pushAgentRefresh(hostId, "line-segment-latency", { urgent: true });
  const runId = `ls-${actor.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  runs.set(runId, { ownerId: actor.id, createdAt: Date.now(), probes, testIds });
  return runId;
}

export async function lineSegmentLatencyStatus(actor: { id: number; role: string }, runId: string) {
  const run = runs.get(String(runId));
  if (!run || (actor.role !== "admin" && run.ownerId !== actor.id)) return null;
  const segments = [];
  let pending = 0;
  for (let index = 0; index < run.probes.length; index += 1) {
    const probe = run.probes[index];
    const testId = run.testIds[index];
    const row = testId ? await db.getForwardTestById(testId) as any : null;
    const status = !testId ? "skipped" : !row ? "error" : row.status === "pending" || row.status === "running" ? "running" : row.status === "success" ? "done" : "error";
    if (status === "running") pending += 1;
    const timedOut = status === "running" && Date.now() - run.createdAt > 30_000;
    segments.push({
      from: { hostId: probe.fromHostId, name: probe.fromName },
      to: { hostId: probe.toHostId, name: probe.toName },
      viaTunnel: probe.viaTunnel,
      method: probe.target?.method ?? null,
      status: timedOut ? "error" : status,
      latencyMs: status === "done" && Number(row?.latencyMs) > 0 ? Number(row.latencyMs) : null,
      error: timedOut ? "30 秒内没有回结果（机器离线或 Agent 太旧）" : probe.issue || (status === "error" ? String(row?.message || "不通") : null),
    });
  }
  const total = segments.every((segment) => segment.latencyMs !== null) ? segments.reduce((sum, segment) => sum + Number(segment.latencyMs), 0) : null;
  return { runId, done: pending === 0 || Date.now() - run.createdAt > 30_000, segments, totalMs: total };
}
