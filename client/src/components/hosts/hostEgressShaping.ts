/**
 * 主机公网出口整形（forwardx-fxp/link_shaper.go 的 egress）在界面上的文字。
 *
 * 面板在 hosts.list 里给 egressShapingStatus（FXP 报上来的，关着的机器是 null）。
 * 卡片上只在真的在整形或出了状况时显示一行；编辑框里自动档下显示当前状态。
 */

export type HostEgressShapingMode = "auto" | "manual" | "off";

export type HostEgressShapingStatus = {
  mode?: string | null;
  state?: string | null;
  rateMbps?: number | null;
  learnedMbps?: number | null;
  lossPct?: number | null;
} | null | undefined;

export const HOST_EGRESS_MBPS_MAX = 1_000_000;

export function normalizeHostEgressShapingMode(value: unknown): HostEgressShapingMode {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "manual" || mode === "auto" ? mode : "off";
}

export function normalizeHostEgressMbpsInput(value: unknown) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(HOST_EGRESS_MBPS_MAX, parsed);
}

/** 编辑框里自动档下的状态一句话。 */
export function describeHostEgressShaping(status: HostEgressShapingStatus) {
  if (!status) return "暂无上报";
  const state = String(status.state || "");
  const learned = Number(status.learnedMbps || 0);
  const rate = Number(status.rateMbps || 0);
  if (state === "shaping" && learned > 0) return `整形中，学到的上限 ${learned} Mbit/s`;
  if (state === "shaping" && rate > 0) return `正在找限速点（${rate} Mbit/s）`;
  if (state === "paused") return "暂停（丢包不像限速器）";
  if (state === "watching") return "还没遇到限速，没整形";
  if (state === "off") return "关";
  return "暂无上报";
}

/** 卡片上的一行：只在整形中或出了状况时有字。 */
export function hostEgressShapingCardText(host: { egressShapingStatus?: HostEgressShapingStatus } | null | undefined) {
  const status = host?.egressShapingStatus;
  if (!status) return "";
  const state = String(status.state || "");
  const learned = Number(status.learnedMbps || 0);
  const rate = Number(status.rateMbps || 0);
  if (state === "shaping" && learned > 0) return `公网出口整形：${learned} Mbit/s`;
  if (state === "shaping" && rate > 0) return `公网出口整形：正在找限速点（${rate} Mbit/s）`;
  if (state === "paused") return "公网出口整形：暂停（不像限速器）";
  return "";
}
