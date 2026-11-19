/*
  出口组编辑框里「分配方式」下面那一句的补充（按权重的比例、没填带宽的点名）。和下发时同一套算法
  （shared/loadBalance.ts 的 exitGroupWeights / exitGroupCapacities），这里写的就是实际分法。一句话，不写段落。
*/
import { hostBandwidthHintMbps } from "@shared/linkWeights";
import { exitGroupWeights, type BalanceStrategy } from "@shared/loadBalance";

type MemberLite = { hostId?: number | null; isEnabled?: boolean; aggregationWeight?: number | string | null };
type HostLite = { id?: unknown; name?: unknown; lineBandwidthMbps?: unknown; rateLimitMbps?: unknown; egressMbps?: unknown };

function enabledExits(members: readonly MemberLite[], hostById: ReadonlyMap<number, HostLite>) {
  return members
    .filter((member) => member.isEnabled !== false && Number(member.hostId || 0) > 0)
    .map((member) => ({ member, host: hostById.get(Number(member.hostId)) ?? null }));
}

const hostName = (host: HostLite | null, member: MemberLite) => String(host?.name || `主机 ${member.hostId}`);

/** 每台都手填了权重：份数和名字（「实际效果」那句话用）；没填全返回空对象。 */
export function exitManualWeights(members: readonly MemberLite[], hostById: ReadonlyMap<number, HostLite>) {
  const exits = enabledExits(members, hostById);
  const weights = exits.map(({ member }) => Math.floor(Number(member.aggregationWeight) || 0));
  if (exits.length < 2 || !weights.every((weight) => weight > 0)) return {};
  return { weights, memberNames: exits.map(({ host, member }) => hostName(host, member)) };
}

/** 分配方式那一句后面再补的一句；不用补返回 null。 */
export function exitStrategyNote(strategy: BalanceStrategy | null, members: readonly MemberLite[], hostById: ReadonlyMap<number, HostLite>): string | null {
  if (strategy !== "weighted" && strategy !== "least_load" && strategy !== "auto") return null;
  const exits = enabledExits(members, hostById);
  if (exits.length < 2) return strategy === "weighted" ? "至少要两台出口" : null;
  const bandwidths = exits.map(({ host }) => hostBandwidthHintMbps(host as never));
  const unknown = exits.filter((_, index) => bandwidths[index] <= 0).map(({ host, member }) => hostName(host, member));
  if (strategy !== "weighted") {
    return unknown.length > 0 ? `${unknown.join("、")} 没填线路带宽，按连接数算` : null;
  }
  const manual = exits.map(({ member }) => Math.floor(Number(member.aggregationWeight) || 0));
  if (manual.every((weight) => weight > 0)) return `现在按 ${manual.join(" : ")} 分`;
  if (manual.some((weight) => weight > 0)) return "有的出口没填权重，要全部填了才按填的分，现在按线路带宽";
  if (unknown.length > 0) return `${unknown.join("、")} 没填线路带宽，现在平均分`;
  const weights = exitGroupWeights("weighted", bandwidths);
  const sizes = bandwidths.map((value) => `${value}M`).join(" · ");
  return weights ? `按线路带宽 ${sizes} → ${weights.join(" : ")} 分` : `几台带宽一样（${sizes}），等于轮流`;
}
