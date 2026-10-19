/**
 * 「家庭叠加」：家里一台常开的 Linux（软路由、小主机、NAS）当入口，把一条连接拆到几台前置上一起送，
 * 在落地机上拼回来。手机、电脑在家里连这台机器的内网地址，单线程下载、测速也能用上几台前置的带宽之和。
 *
 * 能这么做是因为入口只往外拨，不用公网 IP、不用开端口：家里那台照常装 Agent 就行。
 * 面板里本来就能搭（NEX 隧道、中转选单连接叠加），只是要连着改主机、建隧道、建规则三处，
 * 每一处还有几个不能选错的地方。这里把它收成一步：
 *
 *   主机    入口 IP 没填时填上 Agent 报上来的内网 IP（订阅里的节点地址就是它）
 *   隧道    NEX v1，跳点 [家里, 前置…, 落地]，中转方式「单连接叠加」
 *   规则    挂在这条隧道上，目标填落地节点自己的地址和端口，不用专属域名
 *           → 订阅自动认出这个落地节点，生成「家里 → 落地」的节点
 *
 * 不开 UDP over TCP / mimic：叠加只拆 TCP，UDP 照常走单路。
 */

export const HOME_AGGREGATE_MIN_RELAYS = 2;
/** 和隧道跳点上限（MAX_TUNNEL_HOPS = 10）对齐：首尾各占一个。 */
export const HOME_AGGREGATE_MAX_RELAYS = 8;

export type HomeAggregateHost = {
  id: number;
  name: string;
  entryIp?: string | null;
  /** Agent 报上来的本机内网 IPv4，没有就是空。 */
  detectedPrivateIpv4?: string | null;
};

export type HomeAggregateNode = {
  id: number;
  name: string;
  address: string;
  port: number;
  /** 落地节点所在的主机；不在面板管理的主机上就是 0。 */
  hostId: number;
};

export type HomeAggregateInput = {
  home: HomeAggregateHost | undefined;
  relays: Array<HomeAggregateHost | undefined>;
  node: HomeAggregateNode | undefined;
  name?: string;
};

export type HomeAggregatePlan = {
  /** 要替家里那台填上的入口 IP；已经填了就是 null。 */
  homeEntryIp: string | null;
  /** 订阅里节点的地址：家里那台的入口 IP。 */
  subscriptionAddress: string;
  tunnel: {
    name: string;
    mode: "forwardx";
    forwardxVersion: "v1";
    relayMode: "aggregate";
    entryHostId: number;
    exitHostId: number;
    hopHostIds: number[];
  };
  rule: {
    name: string;
    hostId: number;
    forwardType: "gost";
    protocol: "both";
    sourcePort: 0;
    targetIp: string;
    targetPort: number;
    entryDomainEnabled: false;
  };
};

/** 按选好的东西排出要建的；有问题返回第一条问题（直接给人看的话）。 */
export function planHomeAggregate(input: HomeAggregateInput): { ok: true; plan: HomeAggregatePlan } | { ok: false; error: string } {
  const { home, node } = input;
  if (!home) return { ok: false, error: "先选家里那台机器" };
  if (!node) return { ok: false, error: "先选落地节点" };
  if (!(node.hostId > 0)) return { ok: false, error: `「${node.name}」不在面板管理的主机上，叠加要在落地机上拼回来，选一个面板里的落地` };
  if (input.relays.some((relay) => !relay)) return { ok: false, error: "有前置主机不存在了，重新选一下" };
  const relays = input.relays as HomeAggregateHost[];
  if (relays.length < HOME_AGGREGATE_MIN_RELAYS) return { ok: false, error: `至少选 ${HOME_AGGREGATE_MIN_RELAYS} 台前置，带宽才叠得起来` };
  if (relays.length > HOME_AGGREGATE_MAX_RELAYS) return { ok: false, error: `前置最多 ${HOME_AGGREGATE_MAX_RELAYS} 台` };
  const relayIds = relays.map((relay) => relay.id);
  if (new Set(relayIds).size !== relayIds.length) return { ok: false, error: "前置不能重复" };
  if (relayIds.includes(home.id)) return { ok: false, error: "家里那台不能同时当前置" };
  if (node.hostId === home.id) return { ok: false, error: "落地不能是家里那台" };
  if (relayIds.includes(node.hostId)) return { ok: false, error: "落地所在的主机不能同时当前置" };
  const targetIp = String(node.address || "").trim();
  const targetPort = Math.floor(Number(node.port) || 0);
  if (!targetIp || targetPort < 1 || targetPort > 65535) return { ok: false, error: `「${node.name}」没有地址或端口` };

  const currentEntryIp = String(home.entryIp || "").trim();
  const detected = String(home.detectedPrivateIpv4 || "").trim();
  const homeEntryIp = currentEntryIp ? null : detected || null;
  const subscriptionAddress = currentEntryIp || detected;
  if (!subscriptionAddress) {
    return { ok: false, error: `「${home.name}」还没报上内网 IP：等 Agent 上线一会儿，或者在主机设置里把入口 IP 填成它的内网地址` };
  }
  const name = String(input.name || "").trim().slice(0, 128) || `${home.name} 叠加 → ${node.name}`.slice(0, 128);
  return {
    ok: true,
    plan: {
      homeEntryIp,
      subscriptionAddress,
      tunnel: {
        name,
        mode: "forwardx",
        forwardxVersion: "v1",
        relayMode: "aggregate",
        entryHostId: home.id,
        exitHostId: node.hostId,
        hopHostIds: [home.id, ...relayIds, node.hostId],
      },
      rule: {
        name,
        hostId: home.id,
        forwardType: "gost",
        protocol: "both",
        sourcePort: 0,
        targetIp,
        targetPort,
        entryDomainEnabled: false,
      },
    },
  };
}
