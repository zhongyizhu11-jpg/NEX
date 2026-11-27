/*
  延迟好坏只有这一套刻度（2.3.559）：规则卡的延迟标签、链路卡、转发组、延迟评级文字都用它。
  以前三处各写一套（规则卡 150 / 300，链路卡 60 / 150 / 220，评级文字 60 毫秒起就琥珀），同一个 120 ms 在规则卡上绿、链路卡上琥珀。
    < 60 ms   优秀  绿
    < 150 ms  良好  绿
    < 300 ms  一般  琥珀
    ≥ 300 ms  较差  红
*/
export type LatencyTone = "healthy" | "ok" | "warn" | "down";

export function latencyLevel(latencyMs: number | null | undefined): { label: string; tone: LatencyTone } | null {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) return null;
  if (latencyMs < 60) return { label: "优秀", tone: "healthy" };
  if (latencyMs < 150) return { label: "良好", tone: "ok" };
  if (latencyMs < 300) return { label: "一般", tone: "warn" };
  return { label: "较差", tone: "down" };
}

/** 规则卡延迟标签的 data-tone（ok / warn / down） */
export function latencyTagTone(latencyMs: number): "ok" | "warn" | "down" {
  const tone = latencyLevel(latencyMs)?.tone ?? "down";
  return tone === "healthy" ? "ok" : tone;
}
