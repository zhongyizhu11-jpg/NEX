import { parseInboundRouting } from "../shared/inboundRouting";
import { matchProxyNodeForTarget } from "../shared/proxyNodeAutoBind";
import { getProxyInboundById } from "./repositories/proxyInboundRepository";
import { getProxyNodesForSubscription } from "./repositories/proxySubscriptionRepository";
import { getDb } from "./dbRuntime";
import { forwardRules } from "../drizzle/schema";
import { and, eq, ne } from "drizzle-orm";

/*
  「一个落地只许一处决定出口」：

    客户端 → 入口机（转发规则，可配「出口」走一台 SS 落地）→ 节点机（入站，可配「分流」走另一台落地）

  两处都配了，流量就多绕一跳，而且两个设置互相看不见。规则保存和入站保存时各查一遍：
    · 规则的目标是我的某个节点，节点的入站已经有分流落地 → 规则不能再配出口；
    · 入站要配分流落地，而有规则把这个入站派生的节点当目标且配了出口 → 不让存。
  说清楚另一处在哪、怎么改。
*/

function routingHasLanding(routingJson: unknown) {
  const routing = parseInboundRouting(routingJson);
  return !!routing?.routes.some((route) => route.target === "landing" || route.target === "auto_unlock");
}

/** 规则配了出口：它的目标节点那头不能已经有分流落地。 */
export async function assertRuleEgressNotDoubleLanding(input: { userId: number; targetIp: unknown; targetPort: unknown; egressType: unknown }) {
  if (!input.egressType || String(input.egressType) === "none") return;
  const nodes = await getProxyNodesForSubscription(Number(input.userId)) as any[];
  const matched = matchProxyNodeForTarget(
    nodes.map((node) => ({ id: Number(node.id), address: String(node.address || ""), port: Number(node.port || 0), isEnabled: node.isEnabled !== false, sharedFrom: !!node.sharedFrom })),
    input.targetIp,
    input.targetPort,
  );
  const inboundId = Number(nodes.find((node) => Number(node.id) === matched?.id)?.inboundId || 0);
  if (!matched || inboundId <= 0) return;
  const inbound = await getProxyInboundById(inboundId) as any;
  if (!inbound || !routingHasLanding(inbound.routingJson)) return;
  throw new Error(`目标是你的节点「${nodes.find((node) => Number(node.id) === matched.id)?.name || matched.id}」，它的入站「${inbound.name || inboundId}」已经配了分流落地；出口再走一台落地会多绕一跳。二选一：去掉这里的出口，或者到订阅管理把那个入站的分流去掉。`);
}

/** 入站要配分流落地：把它派生的节点当目标、又配了出口的规则，先得把出口去掉。 */
export async function assertInboundRoutingNotDoubleLanding(inboundId: number, routingJson: unknown) {
  if (!routingHasLanding(routingJson)) return;
  const db = await getDb();
  if (!db) return;
  const inbound = await getProxyInboundById(Number(inboundId)) as any;
  if (!inbound) return;
  const nodes = await getProxyNodesForSubscription(Number(inbound.userId)) as any[];
  const derived = nodes.filter((node) => Number(node.inboundId || 0) === Number(inboundId));
  if (derived.length === 0) return;
  const rules = (await db
    .select({ id: forwardRules.id, name: forwardRules.name, targetIp: forwardRules.targetIp, targetPort: forwardRules.targetPort, egressType: forwardRules.egressType })
    .from(forwardRules)
    .where(and(eq(forwardRules.pendingDelete, false), ne(forwardRules.egressType, "none")))) as any[];
  for (const rule of rules) {
    const hit = derived.find((node) => Number(node.port) === Number(rule.targetPort)
      && String(node.address || "").trim().toLowerCase() === String(rule.targetIp || "").trim().toLowerCase());
    if (hit) {
      throw new Error(`转发规则「${rule.name || rule.id}」把这个入站当目标，而且配了出口；这里再配分流落地会多绕一跳。先去那条规则把出口改成直接连接，再来配分流。`);
    }
  }
}
