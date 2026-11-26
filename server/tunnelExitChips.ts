import { liveBalanceForTunnel } from "./balanceLive";
import { tunnelExitLatency } from "./ruleLatencyView";

/*
  链路卡上负载均衡那一格：每台出口一个小标签「名字 · 到出口 ms」，前面一个状态点（2.3.557 整改，用户：「隧道多出口负载均衡
  本身就是主要服务出口组的，加上到目标只是附加的一个选项」）。

  只说出口组这一层：入口到这台出口通不通、多快、入口现在分不分给它。到目标的事不在这里写 ——「附加：检查出口到目标」
  开着、并且某台因为连不上目标被摘掉时，状态点照实是红的（入口确实不分给它了），原因写在 reason 里，弹窗里再细说。

  数据都是内存里的（不查库）：
    ms     入口 → 这台出口的链路定时探测（和弹窗、诊断同一个数）
    state  入口实时上报（几条规则里只要有一条在用它就算在用）；没有实时上报时按出口机在不在线、探测通不通估
*/

/** active 入口在分给它 · ok 探测通（没有实时上报，分不分给它不知道）· standby 能用但入口现在不分给它 · down 不能用 · unknown 还没测到 */
export type TunnelExitChipState = "active" | "ok" | "standby" | "down" | "unknown";

export type TunnelExitChip = {
  hostId: number;
  /** 入口到这台出口（毫秒）；没测到 null */
  ms: number | null;
  state: TunnelExitChipState;
  /** down 的原因：exit = 入口连不上这台出口机 / 出口机离线；target = 附加检查判它连不上目标 */
  reason: "exit" | "target" | null;
  /** 新连接分给它的比例（0–1，各条规则平均；入口实时上报、这段时间有新连接时才有） */
  share: number | null;
};

export function tunnelExitChips(input: {
  tunnelId: number;
  /** 出口按真实顺序：主出口在前 */
  exitHostIds: readonly number[];
  /** 离线的出口机 */
  offlineHostIds?: ReadonlySet<number>;
  nowMs?: number;
}): TunnelExitChip[] {
  const nowMs = input.nowMs ?? Date.now();
  const ids = Array.from(new Set(input.exitHostIds.map(Number).filter((id) => id > 0)));
  const lives = liveBalanceForTunnel(input.tunnelId, nowMs);
  return ids.map((hostId) => {
    const leg = tunnelExitLatency(input.tunnelId, hostId, nowMs);
    const ms = leg ? Math.round(leg.ms) : null;
    if (input.offlineHostIds?.has(hostId)) return { hostId, ms: null, state: "down", reason: "exit", share: null };
    const reported = lives.flatMap((report) => report.exits.filter((exit) => Number(exit.hostId) === hostId));
    if (reported.length === 0) {
      // 没有实时上报：探测通就算能用（分不分给它不知道），没测到就是不知道
      return { hostId, ms, state: ms === null ? "unknown" : "ok", reason: null, share: null };
    }
    const shares = reported.map((exit) => exit.share).filter((share): share is number => typeof share === "number" && Number.isFinite(share));
    const share = shares.length > 0 ? shares.reduce((sum, value) => sum + value, 0) / reported.length : null;
    if (reported.some((exit) => exit.state === "active" || exit.state === "unstable")) return { hostId, ms, state: "active", reason: null, share };
    if (reported.some((exit) => exit.state === "standby")) return { hostId, ms, state: "standby", reason: null, share };
    // 每条规则都判它坏：说是哪一段（有一条是出口机本身连不上就算出口的问题）
    const reason = reported.some((exit) => exit.reason === "exit") ? "exit" : reported.some((exit) => exit.reason === "target") ? "target" : "exit";
    return { hostId, ms, state: "down", reason, share: null };
  });
}
