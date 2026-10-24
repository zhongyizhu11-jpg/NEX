import { Gauge } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";

import {
  formatProxyNodeQuotaLabeled,
  formatProxyNodeQuotaUsedFirst,
  hasProxyNodeQuota,
  proxyNodeQuotaState,
} from "@shared/proxyNodeQuota";
import {
  HOST_TRAFFIC_MEASURE_MODE_LABELS,
  hostTrafficPercent,
  hostTrafficUsedBytes,
  normalizeHostTrafficMeasureMode,
} from "@shared/hostTrafficQuota";

/**
 * 节点行上的用量单元格。
 *
 * 抽出来共用是因为自建那一路也要用了 —— 而这两路要显示的东西**不完全一样**：
 * 粘贴节点只有它自己那一份额度；自建端口除了端口自己的量，还有它所在机器的机房额度。
 *
 * 两个数放一起必须写清楚各是什么。它们口径不同：
 *
 *   - 端口那个只数**面板经手的这一个端口**（Agent 的计数链装在监听端口上）。
 *   - 机器那个是**机房账单口径**（系统级网卡计数）—— 订阅里的直连条目、这台机器上
 *     跑的别的服务，全都在里面，所以它通常比端口那个大，而且大得没有规律。
 *
 * 不点破区别的话，人只会以为面板前后矛盾，然后两个数都不敢信。
 */

export const QUOTA_STATE_STYLES = {
  none: "text-muted-foreground",
  normal: "text-muted-foreground",
  warn: "text-[var(--fx-warn-text)]",
  exceeded: "text-[var(--fx-down-text)]",
} as const;

/** 端口 / 节点自己那一份额度。两张表用的是同一组列名。 */
export function nodeQuotaOf(node: any) {
  return {
    bandwidthMbps: Number(node?.bandwidthMbps || 0),
    trafficLimit: Number(node?.trafficLimit || 0),
    trafficUsed: Number(node?.trafficUsed || 0),
  };
}

/** 这台机器的机房额度，由 proxyInbounds.list 附在行上。 */
export type HostQuota = {
  name: string;
  trafficLimit: number;
  measureMode: string;
  bytesIn: number;
  bytesOut: number;
  /** Agent 报过没有。「还没有数」和「用了 0」是两回事。 */
  reported: boolean;
};

export function hostQuotaLine(hostQuota: HostQuota | null | undefined): string | null {
  if (!hostQuota) return null;
  // 既没设额度、又还没报过数 —— 没什么可说的，别占一行。
  if (hostQuota.trafficLimit <= 0 && !hostQuota.reported) return null;
  const mode = normalizeHostTrafficMeasureMode(hostQuota.measureMode);
  const used = hostTrafficUsedBytes(hostQuota, mode);
  const percent = hostTrafficPercent(used, hostQuota.trafficLimit);
  // 主机管理按 1024 进制存额度（1 GB = 1024³），这里也得按 1024 显示，否则「100 GB」会写成「107G」。
  const usedText = hostQuota.reported ? formatBytes(used) : "还没有数";
  const limitText = hostQuota.trafficLimit > 0 ? formatBytes(hostQuota.trafficLimit) : "不限";
  const tail = percent === null ? "" : `（${percent}%）`;
  return `整机已用 ${usedText} / ${limitText}${tail} · 机房口径 · ${HOST_TRAFFIC_MEASURE_MODE_LABELS[mode]}`;
}

/** 机器那一层到没到量。到量了行上要变色 —— 那才是会被停机的那个。 */
function hostQuotaState(hostQuota: HostQuota | null | undefined): "none" | "normal" | "warn" | "exceeded" {
  if (!hostQuota || hostQuota.trafficLimit <= 0 || !hostQuota.reported) return "none";
  const percent = hostTrafficPercent(
    hostTrafficUsedBytes(hostQuota, hostQuota.measureMode),
    hostQuota.trafficLimit,
  );
  if (percent === null) return "none";
  if (percent >= 100) return "exceeded";
  if (percent >= 80) return "warn";
  return "normal";
}

const STATE_RANK = { none: 0, normal: 1, warn: 2, exceeded: 3 } as const;

/**
 * 用量的开关：一个小图标，点一下才展开。
 *
 * 常驻显示试过两版都不行 —— 放第一行会把节点名挤没，放第二行会把 IP 端口截断。
 * 手机上那一行就这么宽，地址和用量只能二选一常驻，而地址是每次都要看的那个。
 *
 * 但图标本身带颜色：用到 80% 变黄、超额变红。不然把数字藏起来的代价就是
 * 「快超额了却要逐个点开才发现」，那比挤掉地址更糟。颜色取两层里更严重的那个 ——
 * 机器超了而端口没超，一样是要被停机。
 */
export function ProxyNodeQuotaToggle({
  node,
  hostQuota,
  expanded,
  onToggle,
}: {
  node: any;
  hostQuota?: HostQuota | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const quota = nodeQuotaOf(node);
  const hostLine = hostQuotaLine(hostQuota);
  if (!hasProxyNodeQuota(quota) && !hostLine) return null;
  const nodeState = proxyNodeQuotaState(quota);
  const hostState = hostQuotaState(hostQuota);
  const state = STATE_RANK[hostState] > STATE_RANK[nodeState] ? hostState : nodeState;
  const title = [
    hasProxyNodeQuota(quota) ? `这个端口：${formatProxyNodeQuotaLabeled(quota)}` : "",
    hostLine ? `这台机器：${hostLine}` : "",
    state === "exceeded" ? "（已超出总流量）" : state === "warn" ? "（接近总流量）" : "",
  ].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      className={`shrink-0 rounded p-1 transition-colors hover:bg-muted ${QUOTA_STATE_STYLES[state]}`}
      onClick={onToggle}
      aria-expanded={expanded}
      // 桌面端悬停就能看到，不必点开；手机上没有悬停，所以图标本身要能点。
      title={title}
    >
      <Gauge className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * 展开后的那一行（自建的是两行）。
 *
 * 带标签、且已用排最前 —— 手机上这一行会被截断，顺序决定了截掉的是哪一部分。
 * 详见 formatProxyNodeQuotaUsedFirst。
 */
export function ProxyNodeQuotaDetail({ node, hostQuota }: { node: any; hostQuota?: HostQuota | null }) {
  const quota = nodeQuotaOf(node);
  const hostLine = hostQuotaLine(hostQuota);
  return (
    <div className="space-y-0.5">
      {hasProxyNodeQuota(quota) ? (
        <p className={`truncate text-[11px] leading-tight ${QUOTA_STATE_STYLES[proxyNodeQuotaState(quota)]}`}>
          {/* 有机器那一行时才加前缀：只有一行的时候「本端口」是废话。 */}
          {hostLine ? "本端口 " : ""}{formatProxyNodeQuotaUsedFirst(quota)}
        </p>
      ) : null}
      {hostLine ? (
        <p className={`truncate text-[11px] leading-tight ${QUOTA_STATE_STYLES[hostQuotaState(hostQuota)]}`}>
          {hostLine}
        </p>
      ) : null}
    </div>
  );
}
