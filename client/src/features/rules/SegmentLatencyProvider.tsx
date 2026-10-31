import { useEffect, useMemo, useState, type ReactNode } from "react";

import { trpc } from "@/lib/trpc";
import type { RouteStatus } from "./RouteGroupSheet";
import { SegmentLatencyContext, segmentKey, type SegmentLatencyHook, type SegmentTestResult } from "./segmentLatency";

type LatencyMap = Map<string, number | null>;

/** 面板里的那一份：打开就有数（最近一轮探测的每一段），点 ⚡ 测出来的盖掉它。 */
const useTrpcSegmentLatency: SegmentLatencyHook = ({ ruleId, entryHostId }) => {
  const routeStatus = trpc.rules.routeStatus.useQuery({ ruleId: Number(ruleId || 0) }, { enabled: Number(ruleId || 0) > 0, staleTime: 15_000, refetchOnWindowFocus: false });
  const probed = useMemo<LatencyMap>(() => {
    const map: LatencyMap = new Map();
    const data = routeStatus.data as RouteStatus | null | undefined;
    if (!data || !entryHostId) return map;
    for (const path of data.paths) {
      const stops: Array<number | "dest"> = [entryHostId, ...path.hops.map((hop) => Number(hop.hostId)), "dest"];
      stops.slice(1).forEach((to, index) => {
        const from = stops[index];
        const ms = index === 0 ? path.latencyMs : path.hops[index - 1]?.latencyMs;
        const key = segmentKey(Number(from), to);
        if (typeof ms === "number" && Number.isFinite(ms) && !map.has(key)) map.set(key, ms);
      });
    }
    return map;
  }, [routeStatus.data, entryHostId]);

  const [measured, setMeasured] = useState<LatencyMap>(new Map());
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const start = trpc.lineDiagnostics.segmentLatencyStart.useMutation();
  const status = trpc.lineDiagnostics.segmentLatencyStatus.useQuery({ runId: runId || "" }, {
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.done ? false : 1000),
  });
  useEffect(() => {
    const data = status.data;
    if (!data) return;
    setMeasured((previous) => {
      const next = new Map(previous);
      for (const segment of data.segments) {
        if (segment.status === "running" || segment.status === "pending") continue;
        next.set(segmentKey(segment.from.hostId, segment.to.hostId ?? "dest"), segment.latencyMs);
      }
      return next;
    });
    if (data.done) setTestingKey(null);
  }, [status.data]);

  const lastRun = useMemo<SegmentTestResult | null>(() => {
    const data = status.data;
    if (!data?.done) return null;
    return {
      totalMs: data.totalMs === null || data.totalMs === undefined ? null : Number(data.totalMs),
      viaTunnel: data.segments.some((segment) => !!segment.viaTunnel),
      errors: data.segments.filter((segment) => !!segment.error).map((segment) => ({ from: segment.from.name, to: segment.to.name, error: String(segment.error) })),
    };
  }, [status.data]);

  return {
    latencyOf: (key) => (measured.has(key) ? measured.get(key) : probed.get(key)),
    testingKey,
    lastRun,
    test: (lineKey, request) => {
      setTestingKey(lineKey);
      start.mutateAsync({ ruleId: ruleId || undefined, ...request }).then(
        (result) => setRunId(result.runId),
        () => setTestingKey(null),
      );
    },
  };
};

/** 用到线路编辑器的地方（线路详情 RouteLineInlineEditor、规则表单 RuleLineGroupField）套上它，每段才有毫秒、⚡ 才测得了。 */
export function SegmentLatencyProvider({ children }: { children: ReactNode }) {
  return <SegmentLatencyContext.Provider value={useTrpcSegmentLatency}>{children}</SegmentLatencyContext.Provider>;
}
