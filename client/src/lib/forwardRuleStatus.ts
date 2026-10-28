import { isLinkProbeFresh } from "@shared/linkProbePolicy";
import { TRAFFIC_BILLING_BALANCE_BLOCK_REASON } from "@shared/const";
import { normalizeRuleLimitReason } from "@shared/ruleLimits";

export type ForwardRuleVisualState = "disabled" | "running" | "pending" | "error";

export type ForwardGroupConfigStatus = "available" | "pending" | "unavailable" | "error" | "disabled";

export type ForwardRuleVisualStatus = {
  state: ForwardRuleVisualState;
  title: string;
};

/**
 * Keep the last confirmed colour while a new status snapshot is still
 * pending. Explicit disabled/error/running results remain authoritative;
 * this helper only bridges the transient pending state seen while queries
 * reconnect after the rules page is revisited.
 */
export function preferLastKnownForwardRuleVisualStatus(
  current: ForwardRuleVisualStatus,
  lastKnown?: { state?: ForwardRuleVisualState; title?: string | null } | null,
): ForwardRuleVisualStatus {
  if (current.state !== "pending" || !lastKnown || lastKnown.state === "pending") return current;
  if (lastKnown.state !== "running" && lastKnown.state !== "error" && lastKnown.state !== "disabled") return current;
  const title = String(lastKnown.title || "").trim();
  return {
    state: lastKnown.state,
    title: title ? `${title}（上次状态，等待新的上报）` : "上次状态，等待新的上报",
  };
}

export function resolveForwardRuleVisualStatus(input: {
  ruleEnabled: boolean;
  ruleRunning?: boolean;
  resourceAccessAllowed?: boolean;
  groupEnabled: boolean;
  groupConfigStatus: ForwardGroupConfigStatus;
  runtimeStatus?: string | null;
  runningCount?: number;
  expectedCount?: number;
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  latestLatencyAt?: Date | string | number | null;
  /**
   * 这条规则经过的机器里掉线了的（入口、隧道的出口和中继、转发链的每一跳）。
   * 机器掉线是实时通道确认过的事实，比几分钟前那次探测成功、比入口机「我的监听还在」都硬：
   * 出口机没了，入口机照样报自己在运行，探测也没人去做，规则会一直绿着。
   */
  offlineHostNames?: readonly string[];
}, now = Date.now()): ForwardRuleVisualStatus {
  if (input.resourceAccessAllowed === false) {
    return { state: "error", title: "资源授权失效" };
  }
  if (!input.ruleEnabled || !input.groupEnabled || input.groupConfigStatus === "disabled") {
    return { state: "disabled", title: "规则已停用" };
  }
  const offline = (input.offlineHostNames || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (offline.length > 0) {
    return { state: "error", title: `主机离线：${offline.join(" / ")}` };
  }

  const runtimeStatus = String(input.runtimeStatus || "").toLowerCase();
  if (runtimeStatus === "disabled") {
    return { state: "disabled", title: "托管规则已停用" };
  }
  const probeIsRecent = isLinkProbeFresh(input.latestLatencyAt, now);
  if (probeIsRecent && input.latestLatencyIsTimeout) {
    return { state: "error", title: "最近一次端到端探测超时" };
  }
  if (input.groupConfigStatus === "error" || input.groupConfigStatus === "unavailable") {
    return { state: "error", title: "转发资源配置不可用" };
  }
  const hasLatency = input.latestLatencyMs !== null && input.latestLatencyMs !== undefined;
  const latencyMs = Number(input.latestLatencyMs);
  if (probeIsRecent && hasLatency && !input.latestLatencyIsTimeout && Number.isFinite(latencyMs) && latencyMs >= 0) {
    return { state: "running", title: `最近一次端到端探测可达（${Math.round(latencyMs)}ms）` };
  }

  const running = Math.max(0, Number(input.runningCount) || 0);
  const expected = Math.max(0, Number(input.expectedCount) || 0);
  if (runtimeStatus === "running") {
    return { state: "running", title: `全部 ${running || expected} 个托管监听均已确认运行` };
  }
  if (runtimeStatus === "degraded") {
    return { state: "pending", title: `已有 ${running} / ${expected} 个托管监听确认运行，其余状态待确认` };
  }
  if (runtimeStatus === "pending") {
    return { state: "pending", title: `等待 Agent 确认托管监听（${running} / ${expected}）` };
  }
  if (input.groupConfigStatus === "pending") {
    return { state: "pending", title: "等待转发资源完成检测" };
  }
  if (input.ruleRunning) return { state: "running", title: "Agent 已确认规则运行" };
  if (input.groupConfigStatus === "available") {
    return { state: "pending", title: "转发资源可用，等待 Agent 确认规则监听" };
  }
  return { state: "pending", title: "等待 Agent 上报运行状态" };
}

export type ForwardRuleStopReason = {
  /** 标签上的短字 */
  label: string;
  /** 悬停 / 卡片上的一句说明：为什么停、会不会自己回来 */
  detail: string;
  /** true = 原因消除后面板会自动恢复，不需要手动打开 */
  autoResume: boolean;
};

function truthy(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

/**
 * 规则为什么是停着的。
 *
 * 系统连带停的（隧道关了、转发资源停了、账户暂停）会在原因消除后自己恢复 ——
 * 卡片上写清楚，用户就不会去一条条手动打开。protocolBlockReason 另有一行
 * 原文展示，这里只给一个短标签。
 */
export function resolveForwardRuleStopReason(rule: {
  isEnabled?: unknown;
  disabledByTunnel?: unknown;
  disabledByGroup?: unknown;
  disabledByUser?: unknown;
  protocolBlockReason?: string | null;
  ruleLimitReason?: string | null;
} | null | undefined): ForwardRuleStopReason | null {
  if (!rule) return null;
  /*
    单条规则限额（shared/ruleLimits.ts）停的：规则自己的开关还开着，只是运行时按停用下发。
    管理员延期 / 放宽额度 / 重置用量后自动恢复，不用去动开关。
  */
  const limitReason = truthy(rule.isEnabled) ? normalizeRuleLimitReason(rule.ruleLimitReason) : null;
  if (limitReason === "expired") {
    return { label: "已到期", detail: "规则已到管理员设置的到期时间，延期后自动恢复", autoResume: true };
  }
  if (limitReason === "traffic_limit") {
    return { label: "额度用尽", detail: "规则流量额度已用尽，管理员放宽额度或重置统计后自动恢复", autoResume: true };
  }
  if (truthy(rule.isEnabled)) return null;
  if (truthy(rule.disabledByUser)) {
    return {
      label: "账户暂停",
      detail: "账户转发权限已暂停（到期、流量用尽、余额不足或账户停用），恢复后规则自动启用",
      autoResume: true,
    };
  }
  if (truthy(rule.disabledByTunnel)) {
    return { label: "隧道停用", detail: "所属隧道已关闭，隧道重新开启后规则自动恢复", autoResume: true };
  }
  if (truthy(rule.disabledByGroup)) {
    return { label: "资源停用", detail: "所属转发资源已停用，重新启用后规则自动恢复", autoResume: true };
  }
  const blockReason = String(rule.protocolBlockReason || "").trim();
  if (blockReason === TRAFFIC_BILLING_BALANCE_BLOCK_REASON) {
    // 余额回到正数（充值、管理员加余额）后面板会自动恢复这些规则，不用一条条手动打开。
    return { label: "余额不足", detail: blockReason, autoResume: true };
  }
  if (blockReason) {
    return { label: "已停用", detail: blockReason, autoResume: false };
  }
  return { label: "已停用", detail: "规则已手动关闭，打开开关即可恢复", autoResume: false };
}
