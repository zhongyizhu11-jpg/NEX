import type { NetworkEdgeSpec, NetworkNodeSpec } from "@/components/network/NetworkPath";
import { getTunnelHopIds, getTunnelExitNames, getTunnelLoadBalanceExitNames, tunnelHopHostName } from "@/lib/tunnelDisplay";
import type { NetworkHealth } from "@shared/networkHealth";

/**
 * 把一条隧道翻译成路径。
 *
 * 这是 Path 语言第一次用在生产页面上，也是整套 V2 想解决的那个问题的正面：
 *
 * 之前链路卡是这样的 ——
 *
 *   入口主机   Po0
 *   中继 1     Relay-HK
 *   出口主机   Jinx
 *
 * 每个节点都带一个说明它是什么的标签。但**位置本身已经说明了**：第一个就是
 * 入口，最后一个就是出口，中间的就是中继。「入口主机：」这几个字既没有增加
 * 信息，又占掉了半行宽度，还让三个节点读起来像三条并列的属性而不是一条链。
 *
 * 换成 Path 之后：
 *
 *   ● Po0 ───── ● Relay-HK ───── ● Jinx
 *     广东        NEX          香港
 *
 * 标签位置留给真正有信息量的东西：地区、经过谁、多少 ms。
 *
 * 唯一保留文字标签的是**入口组**和**负载均衡出口**：那两个不是「一个节点」，
 * 是「一组节点合起来当一个用」，不说清楚会被当成单台机器。
 */

export type TunnelPathContext = {
  hosts: any[] | undefined;
  /** 入口组（有的话）。它整体算路径上的一个节点 */
  entryGroup?: { id: number; name?: string; domain?: string } | null;
  /** 属于该入口组的成员主机 id —— 这些不再单独画成节点，已经被组代表了 */
  entryGroupMemberHostIds?: number[];
  /** 整条路径的健康状态。逐跳状态目前拿不到，所以整条同色 */
  health?: NetworkHealth;
  /** 链路延迟，标在中间那一段上 */
  latencyMs?: number | null;
  /** 经过什么转发实现（NEX V1/V2、GOST…） */
  via?: string;
  /**
   * 点「负载均衡」那个节点时调用（链路卡片用：弹窗列出是哪几台）。传了它，节点只写「负载均衡 ×3」，
   * 不再在底下列一串成员名 —— 那一行在手机上挤不下，点开看更清楚（2026-11 用户要求）。
   */
  onLoadBalanceClick?: () => void;
};

export type TunnelPath = {
  nodes: NetworkNodeSpec[];
  edges: NetworkEdgeSpec[];
  /** 鼠标悬停时的完整描述，窄屏截断时仍然读得到 */
  title: string;
};

function entryGroupLabel(group: TunnelPathContext["entryGroup"]): string {
  if (!group) return "";
  const name = String(group.name || "入口组").trim();
  const domain = String(group.domain || "").trim();
  return domain ? `${name} (${domain})` : name;
}

export function buildTunnelPath(tunnel: any, context: TunnelPathContext): TunnelPath {
  const { hosts, entryGroup } = context;
  const health = context.health || "unknown";
  const hopIds = getTunnelHopIds(tunnel);

  /*
    入口组的成员不再单独出现：组已经代表了它们。上一版是把组画成第一行、
    成员再各画一行，于是同一台机器在一条路径上出现两次。
  */
  const memberIds = new Set((context.entryGroupMemberHostIds || []).map((id) => Number(id)));
  const visibleHopIds = entryGroup ? hopIds.filter((id: number) => !memberIds.has(Number(id))) : hopIds;

  const nodes: NetworkNodeSpec[] = [];
  if (entryGroup) {
    nodes.push({
      id: `entry-group-${entryGroup.id}`,
      name: String(entryGroup.name || "入口组").trim(),
      // 入口组是一组机器合起来当一个入口用，不说清楚会被当成单台机器
      sublabel: String(entryGroup.domain || "").trim() || "入口组",
      health,
    });
  }
  visibleHopIds.forEach((hostId: number, index: number) => {
    nodes.push({
      id: `hop-${hostId}-${index}`,
      name: tunnelHopHostName(tunnel, hostId, hosts) || `主机 ${hostId}`,
      health,
    });
  });

  /*
    负载均衡的额外出口：同样是「一组当一个用」，接在最后一跳之后。
    不画成并列的分支是因为 PathBranch 需要每条分支各自的状态，而这里拿不到 ——
    画成分支会暗示「有一条在走、其余待命」，那是主备的语义，不是负载均衡的。
  */
  const extraExitNames = getTunnelLoadBalanceExitNames(tunnel, hosts);
  if (extraExitNames.length > 0) {
    const allExits = getTunnelExitNames(tunnel, hosts);
    nodes.push(context.onLoadBalanceClick
      ? {
        id: "load-balance-exits",
        name: "负载均衡",
        nameSuffix: `×${allExits.length}`,
        health,
        onActivate: context.onLoadBalanceClick,
        activateLabel: `负载均衡出口，共 ${allExits.length} 台，点开查看`,
      }
      : {
        id: "load-balance-exits",
        name: "负载均衡出口",
        sublabel: allExits.join(" / "),
        health,
      });
  }

  /*
    边只在「中间那一段」标注 via 和延迟。每段都标一遍的话，一条三跳的路径上
    会出现三个 8ms —— 看的人会以为那是三段各自的延迟，而实际测的是端到端。
  */
  const middle = nodes.length >= 2 ? Math.max(0, Math.floor((nodes.length - 1) / 2)) : 0;
  const edges: NetworkEdgeSpec[] = nodes.slice(1).map((_, index) => {
    const base: NetworkEdgeSpec = { health };
    if (index !== middle) return base;
    return {
      ...base,
      via: context.via || undefined,
      latencyMs: typeof context.latencyMs === "number" ? context.latencyMs : undefined,
    };
  });

  const title = [
    entryGroup ? `入口组：${entryGroupLabel(entryGroup)}` : "",
    nodes.map((node) => node.name).join(" → "),
    typeof context.latencyMs === "number" ? `延迟 ${context.latencyMs} ms` : "",
  ]
    .filter(Boolean)
    .join("；");

  return { nodes, edges, title };
}
