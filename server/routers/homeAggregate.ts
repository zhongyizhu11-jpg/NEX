import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { agentPrivateIpv4 } from "../agentPrivateAddress";
import { appendPanelLog } from "../_core/panelLogger";
import { hostsRouter } from "./hosts";
import { tunnelsRouter } from "./tunnels";
import { rulesRouter } from "./rules";
import {
  HOME_AGGREGATE_MAX_RELAYS,
  HOME_AGGREGATE_MIN_RELAYS,
  planHomeAggregate,
  type HomeAggregateHost,
  type HomeAggregateNode,
} from "../../shared/homeAggregate";

/*
  trpc.homeAggregate.* —— 链路管理 › 隧道 ›「家庭叠加」：家里一台 Linux 当入口，几台前置一起送，
  落地机拼回来（shared/homeAggregate.ts）。一步建好：主机入口 IP、NEX 隧道（单连接叠加）、规则。

  建隧道、建规则直接调原来那两个接口（createCaller），校验、端口分配、下发都和手动建一样；
  规则没建成就把刚建的隧道删掉，不留半套。只给管理员：家里那台、前置、落地都是自己的机器。
*/

type HostRow = { id: unknown; name?: unknown; ip?: unknown; entryIp?: unknown; hostType?: unknown; lineBandwidthMbps?: unknown; agentVersion?: unknown };

function hostOf(row: HostRow): HomeAggregateHost {
  return {
    id: Number(row.id),
    name: String(row.name || `主机 ${row.id}`),
    entryIp: String(row.entryIp || "").trim() || null,
    detectedPrivateIpv4: agentPrivateIpv4(row.id),
  };
}

/** 落地节点在哪台主机上：面板入站生成的按入站的主机；导入的按地址对主机 IP / 入口 IP。 */
async function landingNodes(userId: number, hosts: HostRow[]): Promise<HomeAggregateNode[]> {
  const nodes = (await db.getProxyNodesForSubscription(userId)) as any[];
  const q = quoteDbIdentifier;
  const inboundIds = [...new Set(nodes.map((node) => Number(node.inboundId || 0)).filter((id) => id > 0))];
  const inboundHost = new Map<number, number>();
  if (inboundIds.length > 0) {
    const rows = await queryRaw<any>(
      `SELECT ${q("id")}, ${q("hostId")} FROM ${q("proxy_inbounds")} WHERE ${q("id")} IN (${inboundIds.map(() => "?").join(", ")})`,
      inboundIds,
    );
    for (const row of rows) inboundHost.set(Number(row.id), Number(row.hostId) || 0);
  }
  const hostByAddress = new Map<string, number>();
  for (const host of hosts) {
    for (const value of [host.ip, host.entryIp]) {
      for (const part of String(value || "").split(",")) {
        const address = part.trim().toLowerCase();
        if (address && !hostByAddress.has(address)) hostByAddress.set(address, Number(host.id));
      }
    }
  }
  return nodes
    .filter((node) => node.isEnabled !== false && !node.sharedFrom)
    .map((node) => ({
      id: Number(node.id),
      name: String(node.name || `节点 ${node.id}`),
      address: String(node.address || "").trim(),
      port: Number(node.port) || 0,
      hostId: inboundHost.get(Number(node.inboundId || 0)) || hostByAddress.get(String(node.address || "").trim().toLowerCase()) || 0,
    }));
}

async function agentHosts(): Promise<HostRow[]> {
  // 家里那台、前置、落地都得装着 Agent（slave）；面板本机不算。
  return ((await db.getHosts()) as HostRow[]).filter((host) => String(host.hostType || "slave") !== "master");
}

export const homeAggregateRouter = router({
  options: adminProcedure.query(async ({ ctx }) => {
    const hosts = await agentHosts();
    const nodes = await landingNodes(ctx.user.id, hosts);
    const hostName = new Map(hosts.map((host) => [Number(host.id), String(host.name || "")]));
    return {
      minRelays: HOME_AGGREGATE_MIN_RELAYS,
      maxRelays: HOME_AGGREGATE_MAX_RELAYS,
      hosts: hosts.map((host) => ({
        ...hostOf(host),
        lineBandwidthMbps: Number(host.lineBandwidthMbps) || 0,
        agentVersion: String(host.agentVersion || ""),
      })),
      nodes: nodes.map((node) => ({ ...node, hostName: node.hostId > 0 ? hostName.get(node.hostId) || `主机 ${node.hostId}` : null })),
    };
  }),

  create: adminProcedure
    .input(z.object({
      homeHostId: z.number().int().positive(),
      relayHostIds: z.array(z.number().int().positive()).min(HOME_AGGREGATE_MIN_RELAYS).max(HOME_AGGREGATE_MAX_RELAYS),
      proxyNodeId: z.number().int().positive(),
      name: z.string().trim().max(128).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const hosts = await agentHosts();
      const byId = new Map(hosts.map((host) => [Number(host.id), host]));
      const nodes = await landingNodes(ctx.user.id, hosts);
      const homeRow = byId.get(input.homeHostId);
      const planned = planHomeAggregate({
        home: homeRow ? hostOf(homeRow) : undefined,
        relays: input.relayHostIds.map((id) => {
          const row = byId.get(id);
          return row ? hostOf(row) : undefined;
        }),
        node: nodes.find((node) => node.id === input.proxyNodeId),
        name: input.name,
      });
      if (!planned.ok) throw new Error(planned.error);
      const { plan } = planned;

      const tunnel: any = await tunnelsRouter.createCaller(ctx).create(plan.tunnel as any);
      const tunnelId = Number(tunnel?.id || 0);
      if (!(tunnelId > 0)) throw new Error("隧道没建成");
      try {
        const rule: any = await rulesRouter.createCaller(ctx).create({ ...plan.rule, tunnelId } as any);
        // 订阅里的节点地址就是家里那台的入口 IP：没填就填上内网 IP（隧道、规则都建成了才动主机）。
        // 走主机设置那个接口：订阅节点地址、专属域名记录这些跟着入口地址变的都会一起刷新。
        if (plan.homeEntryIp) await hostsRouter.createCaller(ctx).update({ id: input.homeHostId, entryIp: plan.homeEntryIp });
        appendPanelLog("info", `[HomeAggregate] created tunnel=${tunnelId} rule=${rule?.id ?? "?"} home=${input.homeHostId} relays=${input.relayHostIds.join(",")} node=${input.proxyNodeId}`);
        return {
          tunnelId,
          ruleId: Number(rule?.id || 0),
          sourcePort: Number(rule?.sourcePort || 0),
          subscriptionAddress: plan.subscriptionAddress,
          entryIpFilled: plan.homeEntryIp,
        };
      } catch (error) {
        await tunnelsRouter.createCaller(ctx).delete({ id: tunnelId, confirmRules: true }).catch((cleanupError) => {
          appendPanelLog("warn", `[HomeAggregate] rollback tunnel=${tunnelId} failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        });
        throw error;
      }
    }),
});
