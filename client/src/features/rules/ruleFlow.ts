import type { NetworkEdgeSpec, NetworkNodeSpec } from "@/components/network/NetworkPath";
import { rollUpNetworkHealth, type NetworkHealth } from "@shared/networkHealth";

/**
 * 一条转发规则的「流」。
 *
 * ── 为什么不是所有规则都画成竖排的 Flow ──
 *
 * V2 的规划里规则卡是这样的：
 *
 *   42.194.198.67:22222
 *           ↓
 *      Po0 ━━━ Jinx
 *           ↓
 *   217.116.172.44:22222
 *
 * 但直连规则的入口和目标之间**什么都没有**。给它画五行去说
 * 「A 转到 B」，而一行 `A ⧉ → B` 已经说完了 —— 多出来的四行不携带信息，
 * 只是在重复箭头。
 *
 * 所以版式跟着数据走：
 *
 *   直连           一行：入口 ⧉ → 目标
 *   隧道/链/组      竖排 Flow：入口 → 经过谁 → 目标
 *
 * 后者的中间那一段正是它和直连的唯一区别，也是这条规则最要紧的信息；
 * 一行的写法根本放不下它。
 *
 * 这不是折中，是同一条原则的两个结果：**版式要让最重要的那件事最显眼**。
 * 直连里最重要的是两个地址，隧道里最重要的是中间经过哪儿。
 */

export type RuleFlowLayout = "inline" | "flow";

/** 规则的四种形态，和 Rules 页的分类一致 */
export type RuleCategory = "local" | "tunnel" | "chain" | "group";

const FLOW_CATEGORIES = new Set(["tunnel", "chain", "group"]);

export function decideRuleFlowLayout(category: RuleCategory | string | null | undefined): RuleFlowLayout {
  /*
    白名单而不是「不是 local 就是 flow」。

    后者在认不出分类时会落到 flow，而 Flow 版式的全部价值在中间那一段 ——
    没有跳点的 Flow 就是一个上下两行加一个箭头，比一行更糟。默认值要选
    那个在任何输入下都不会更差的，那是 inline。
  */
  return FLOW_CATEGORIES.has(String(category || "")) ? "flow" : "inline";
}

export type RuleFlowInput = {
  /** 入口地址（已格式化好，含端口） */
  entry: string;
  /** 目标地址（已格式化好，含端口） */
  target: string;
  /**
   * 中间经过的节点名。直连为空。
   * 隧道是它的跳点，转发链是链上的主机，转发组是组名。
   */
  hops?: readonly string[];
  /** 经过什么转发实现：NEX V2 / GOST TLS / realm… */
  via?: string;
  latencyMs?: number | null;
  /** 整条规则的健康状态 */
  health?: NetworkHealth;
};

export type RuleFlow = {
  nodes: NetworkNodeSpec[];
  edges: NetworkEdgeSpec[];
  title: string;
};

/**
 * 构造竖排 Flow 的节点。
 *
 * 入口和目标带注脚说明它们是什么 —— 这里和链路卡不一样：链路卡上一整行都是
 * 主机名，位置足以区分；而这里第一个和最后一个是**地址**、中间是**主机名**，
 * 两种东西混在一列里，不标一下会读成「三台机器」。
 */
export function buildRuleFlow(input: RuleFlowInput): RuleFlow {
  const health = input.health || "unknown";
  const entry = String(input.entry || "").trim();
  const target = String(input.target || "").trim();
  const hops = (input.hops || []).map((hop) => String(hop || "").trim()).filter(Boolean);

  const nodes: NetworkNodeSpec[] = [];
  if (entry) nodes.push({ id: "flow-entry", name: entry, sublabel: "入口", health });
  hops.forEach((hop, index) => {
    nodes.push({ id: `flow-hop-${index}`, name: hop, health });
  });
  if (target) nodes.push({ id: "flow-target", name: target, sublabel: "目标", health });

  /*
    中间那一段标 via 和延迟 —— 和链路卡同一个道理：每段都标会被读成分段延迟，
    而实测的是端到端。

    段的状态取两端节点里更该被注意的那个，不是整条一个颜色：线不携带独立的
    探测数据，它能说的只有「它连的那两个点怎么样」。
  */
  const middle = nodes.length >= 2 ? Math.max(0, Math.floor((nodes.length - 1) / 2)) : 0;
  const edges: NetworkEdgeSpec[] = nodes.slice(1).map((_, index) => {
    const edgeHealth = rollUpNetworkHealth([nodes[index].health, nodes[index + 1].health]);
    if (index !== middle) return { health: edgeHealth };
    return {
      health: edgeHealth,
      via: input.via || undefined,
      latencyMs: typeof input.latencyMs === "number" ? input.latencyMs : undefined,
    };
  });

  const title = [
    [entry, ...hops, target].filter(Boolean).join(" → "),
    input.via || "",
    typeof input.latencyMs === "number" ? `${input.latencyMs} ms` : "",
  ]
    .filter(Boolean)
    .join("；");

  return { nodes, edges, title };
}

/**
 * 规则的运行状态 → 状态词汇表。
 *
 * 面板里规则状态本来就有四档（running / pending / error / disabled），
 * 和六档词汇表的对应是一一的，只有 pending 那一档需要想一下：
 *
 * **pending 是 unknown，不是 degraded。** 「等待 Agent 确认」说的是还没有
 * 结论，不是「有结论，结论是不太好」。画成琥珀会让人去查一个并不存在的问题。
 */
/**
 * 规则状态点的颜色：卡片、深空主题的行、表格三处都用这一个（2.3.558）。只要是通的就是绿点（用户：「只要是通的状态点都是
 * 绿色，指定的出口不通只是走势线颜色不一样就行」）—— resolveForwardRuleVisualStatus 的 confirmed 橙色（指定的出口连不上、
 * 已切到别的出口，或者在用的出口刚坏、正在切）流量是通的：绿点，提醒交给卡片的色调（走势线，见 Rules.tsx deriveRuleView）。
 * 以前四处各按 state 算：2.3.556 只改了色调那一处，点是灰的（用户面板 2026-11-27：hkt/2 走势线琥珀、点灰）。
 */
export function ruleVisualHealth(visual: { state?: string | null; confirmed?: boolean } | null | undefined): NetworkHealth {
  const health = ruleVisualStateToHealth(visual?.state);
  return visual?.confirmed && health === "unknown" ? "healthy" : health;
}

export function ruleVisualStateToHealth(state: string | null | undefined): NetworkHealth {
  switch (String(state || "").toLowerCase()) {
    case "running":
      return "healthy";
    case "error":
      return "down";
    case "disabled":
      return "standby";
    case "pending":
      return "unknown";
    default:
      return "unknown";
  }
}
