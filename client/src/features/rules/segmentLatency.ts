import { createContext, useContext } from "react";

/*
  线路编辑器里每段后面的毫秒从哪来（2.3.497）：编辑器自己不碰接口。面板里由 LineEditorShell 套上
  SegmentLatencyProvider（这条线路最近一轮探测 + 点 ⚡ 逐段测，server/lineSegmentLatency.ts）；
  单测里没有它，编辑器照样画出来，只是没有数。
*/

export type SegmentTestRequest = {
  entryHostId: number;
  hops: number[];
  hopVia: Array<number | null>;
  dest: { ip: string; port: number } | null;
};

export type SegmentLatency = {
  /** `from>to` 这一段的毫秒：点 ⚡ 测出来的优先，再是最近一轮探测；还不知道是 undefined，测了不通是 null。 */
  latencyOf: (key: string) => number | null | undefined;
  /** 正在逐段测的那条线路。 */
  testingKey: string | null;
  test: (lineKey: string, request: SegmentTestRequest) => void;
  /** 刚测完的那一次：整链约多少毫秒、有没有隧道段、哪几段出错；没测过或还在测是 null。 */
  lastRun: SegmentTestResult | null;
};

export type SegmentTestResult = {
  totalMs: number | null;
  viaTunnel: boolean;
  errors: Array<{ from: string; to: string; error: string }>;
};

export type SegmentLatencyHook = (input: { ruleId: number | null; entryHostId: number | null }) => SegmentLatency;

/** 一段的键：入口 / 中转的主机 id，到下一台主机或落地。 */
export const segmentKey = (from: number, to: number | "dest") => `${from}>${to}`;

const NO_LATENCY: SegmentLatency = { latencyOf: () => undefined, testingKey: null, test: () => {}, lastRun: null };
const useNoSegmentLatency: SegmentLatencyHook = () => NO_LATENCY;

export const SegmentLatencyContext = createContext<SegmentLatencyHook>(useNoSegmentLatency);

export function useSegmentLatency(input: { ruleId: number | null; entryHostId: number | null }): SegmentLatency {
  const useLatency = useContext(SegmentLatencyContext);
  return useLatency(input);
}
