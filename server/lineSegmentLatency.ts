import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
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
      probes.push({
        fromHostId: from,
        fromName: nameOf(from),
        toHostId: null,
        toName: "落地",
        viaTunnel: false,
        target: dest && dest.ip && dest.port > 0 ? { ip: dest.ip, port: dest.port, method: "tcp" } : null,
        issue: dest && dest.ip && dest.port > 0 ? null : "落地地址还没填",
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
