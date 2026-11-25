/**
 * 「订阅内容」的几段分类，从服务端的 preview 结果里一次挑出来。
 *
 * 页面顶上的概览条（客户端线路 / 待处理）和「订阅内容」弹窗要的是同一份分类 ——
 * 弹窗现在懒加载、单独一个模块，分类逻辑放在这里两边共用，而不是各切一遍。
 * 纯函数：没有 React，测试直接喂对象。
 */

type Reasoned = { reason: string };

type PreviewLike<N, S extends Reasoned, W extends Reasoned> = {
  nodes: N[];
  skipped: S[];
  warnings: W[];
} | null | undefined;

const EMPTY: never[] = [];

export type ProxyPreviewSummary<N, S, W> = {
  nodes: N[];
  /** 直连条目（kind === "direct"）。 */
  directNodes: N[];
  /** 中转条目。 */
  relayNodes: N[];
  /** 被用户关掉的转发：一键恢复。 */
  hiddenRules: S[];
  /** 差一个落地节点的转发：选一个就能进来。 */
  unboundRules: S[];
  /** 其他进不了订阅的（原因各异，要去改转发或模板）。 */
  otherSkipped: S[];
  /** 绑定已经对不上的转发。 */
  driftedRules: W[];
  /** 没开直连、也没有任何转发指向的节点：客户端里根本没有它。 */
  unusedNodes: W[];
  /** 机器的 Agent 从没连上过的节点。 */
  hostOfflineNodes: W[];
  /** 要用户动手的事加起来。 */
  pendingCount: number;
  pendingSubtitle: string;
};

export function summarizeProxyPreview<N extends { kind?: string }, S extends Reasoned, W extends Reasoned>(
  preview: PreviewLike<N, S, W>,
): ProxyPreviewSummary<N, S, W> {
  const nodes: N[] = preview?.nodes ?? EMPTY;
  const skipped: S[] = preview?.skipped ?? EMPTY;
  const warnings: W[] = preview?.warnings ?? EMPTY;
  const directNodes = nodes.filter((node) => node.kind === "direct");
  const relayNodes = nodes.filter((node) => node.kind !== "direct");
  // 只有「已隐藏」需要一键恢复，其他原因要用户自己去改转发或模板。
  const hiddenRules = skipped.filter((item) => item.reason === "hidden");
  const unboundRules = skipped.filter((item) => item.reason === "unbound");
  const otherSkipped = skipped.filter((item) => item.reason !== "hidden" && item.reason !== "unbound");
  const driftedRules = warnings.filter((item) => item.reason === "target-mismatch");
  const unusedNodes = warnings.filter((item) => item.reason === "node-unused");
  const hostOfflineNodes = warnings.filter((item) => item.reason === "host-never-online");
  /*
    「待处理」那张卡上的数字：这一页所有要你动手的事加起来。
    几件事分别躺在弹窗的几段里，各自都不显眼。合成一个数摆到最上面，才回答得了
    「我现在有没有东西要管」—— 进这一页时脑子里其实只有这一个问题。
  */
  const pendingCount = unboundRules.length + driftedRules.length + unusedNodes.length + hostOfflineNodes.length;
  const pendingSubtitle = pendingCount === 0
    ? "都对上了"
    : [
      unboundRules.length > 0 ? `${unboundRules.length} 条差节点` : "",
      driftedRules.length > 0 ? `${driftedRules.length} 条指向已变` : "",
      unusedNodes.length > 0 ? `${unusedNodes.length} 个没进订阅` : "",
      hostOfflineNodes.length > 0 ? `${hostOfflineNodes.length} 个机器没连上` : "",
    ].filter(Boolean).join(" · ");
  return {
    nodes,
    directNodes,
    relayNodes,
    hiddenRules,
    unboundRules,
    otherSkipped,
    driftedRules,
    unusedNodes,
    hostOfflineNodes,
    pendingCount,
    pendingSubtitle,
  };
}
