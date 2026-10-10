import crypto from "crypto";
import { isSelfTestMeta, type SelfTestMeta } from "../shared/agentDtos";
import { linkProbeMethodForRule, normalizeLinkProbeMethod } from "../shared/latencyProbe";
import { ENV } from "./env";

export const AGENT_PLUGIN_TASK_VERSION = "2.2.151";
export const AGENT_PANEL_MIGRATION_VERSION = "2.2.153";

// 版本比较的唯一一份在 shared/version.ts。这里保持再导出，是因为服务端十几处
// 都从 agentRouteUtils 拿 isAgentVersionAtLeast，没必要为了搬家改一圈 import。
export { normalizeVersion, compareVersions, isAgentVersionAtLeast, isAgentVersionBehind } from "../shared/version";
import { compareVersions, normalizeVersion } from "../shared/version";
import { fxpRuntimeNeedsUpgrade } from "../shared/fxpRuntime";

export function isAgentUpgradeTargetSatisfied(
  version: string | null | undefined,
  target: string | null | undefined,
  currentSupportedVersion?: string | null,
) {
  if (!version || !target) return false;
  const normalizedVersion = normalizeVersion(version);
  const normalizedTarget = normalizeVersion(target);
  if (!normalizedVersion || !normalizedTarget) return false;
  if (currentSupportedVersion && compareVersions(normalizedTarget, currentSupportedVersion) < 0) {
    return normalizedVersion === normalizedTarget;
  }
  return compareVersions(normalizedVersion, normalizedTarget) >= 0;
}

/**
 * 一键升级算不算完成：Agent 到了目标版本，并且（升到当前版本时）FXP 也不再需要重装。
 *
 * 以前只看 Agent 版本。升级脚本下载 FXP 失败时留着旧 FXP，Agent 却已经是新版本 ——
 * 面板第一个心跳就把升级请求清掉，再也不会重跑安装脚本；已经是最新 Agent、只是 FXP
 * 旧了的主机，点「升级」也会在下发前就被当成完成。回滚到旧版本时只看 Agent 版本：
 * 旧版本的安装包里本来就是旧 FXP。
 */
export function isAgentUpgradeCompleted(
  host: { agentVersion?: string | null; fxpVersion?: string | null },
  target: string | null | undefined,
  currentSupportedVersion?: string | null,
) {
  if (!isAgentUpgradeTargetSatisfied(host.agentVersion, target, currentSupportedVersion)) return false;
  if (currentSupportedVersion && compareVersions(normalizeVersion(target), currentSupportedVersion) < 0) return true;
  return !fxpRuntimeNeedsUpgrade(host);
}

/**
 * 这台主机现在点「升级」是不是白跑：Agent 已经不低于目标版本，并且（目标是当前版本时）
 * FXP 也不需要重装。FXP 旧了的主机即使 Agent 已是最新，也要能一键重跑安装脚本。
 */
export function isHostAgentUpgradeUnnecessary(
  host: { agentVersion?: string | null; fxpVersion?: string | null },
  target: string | null | undefined,
  currentSupportedVersion?: string | null,
) {
  if (!host.agentVersion || !target || compareVersions(host.agentVersion, target) < 0) return false;
  if (currentSupportedVersion && compareVersions(normalizeVersion(target), currentSupportedVersion) < 0) return true;
  return !fxpRuntimeNeedsUpgrade(host);
}

/**
 * 主机上报的 fxpVersion：x.y.z 或 legacy / legacy-v2 / missing，其它一律丢掉（回空串，调用方
 * 就保留库里的值）。unknown 是 Agent 这一次没问出来（超时之类），不该盖掉上次问到的版本。
 */
export function normalizeReportedFxpVersion(value: unknown) {
  const text = String(value ?? "").trim().replace(/^v/i, "").toLowerCase();
  if (/^\d{1,5}\.\d{1,5}\.\d{1,6}$/.test(text)) return text;
  if (text === "legacy" || text === "legacy-v2" || text === "missing") return text;
  return "";
}

export function hasAgentVersionChanged(
  previousVersion: string | null | undefined,
  reportedVersion: string | null | undefined,
) {
  const reported = normalizeVersion(reportedVersion);
  if (!reported) return false;
  return reported !== normalizeVersion(previousVersion);
}

const warnedTunnelSecretFallbacks = new Set<number>();

export function tunnelSecretSeed(tunnel: any) {
  if (tunnel?.secret) return String(tunnel.secret);
  /*
    以前这里用「隧道 id + 入口/出口主机 id」做 sha256 —— 这几个数谁都猜得到，等于隧道
    密钥公开。旧版本留下的空 secret 现在启动时就补成随机值（dbSchema 的 backfill），
    这里只兜住补完之后仍然出现的空值：改用面板私有密钥做 HMAC，外人算不出来，并记一条警告。
  */
  const id = Number(tunnel?.id || 0);
  if (!warnedTunnelSecretFallbacks.has(id)) {
    if (warnedTunnelSecretFallbacks.size > 4096) warnedTunnelSecretFallbacks.clear();
    warnedTunnelSecretFallbacks.add(id);
    console.warn(`[Tunnel] tunnel=${id} has no secret; using a panel-keyed fallback. Restart the panel to backfill a random secret.`);
  }
  return crypto
    .createHmac("sha256", ENV.cookieSecret)
    .update(`forwardx-tunnel-fallback:v2:${tunnel?.id}:${tunnel?.entryHostId}:${tunnel?.exitHostId}`)
    .digest("hex");
}

export function parseSelfTestMeta(message: unknown): SelfTestMeta | null {
  if (typeof message !== "string" || !message.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(message);
    return isSelfTestMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function agentInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function buildTunnelAgentSelfTestPayload(test: { id?: unknown }, meta: SelfTestMeta | null) {
  if (meta?.kind !== "tunnel" && meta?.kind !== "tunnel-hop") return null;
  return {
    testId: agentInteger(test?.id),
    kind: meta.kind,
    tunnelId: agentInteger(meta.tunnelId),
    ruleId: 0,
    forwardType: "gost-tunnel",
    protocol: "tcp",
    sourcePort: 0,
    targetIp: meta.targetIp,
    targetPort: agentInteger(meta.targetPort),
    wireGuardPeerId: meta.wireGuardPeerId,
  };
}

export function buildForwardChainAgentSelfTestPayload(
  test: { id?: unknown; ruleId?: unknown },
  meta: SelfTestMeta | null,
) {
  if (meta?.kind !== "forward-chain") return null;
  const method = normalizeLinkProbeMethod(meta.method);
  return {
    testId: agentInteger(test?.id),
    kind: meta.runtimeDependent === false ? "forward-chain-target" : "forward-chain",
    groupId: agentInteger(meta.groupId),
    ruleId: agentInteger(test?.ruleId),
    forwardType: "forward-chain",
    protocol: method,
    method,
    sourcePort: agentInteger(meta.entrySourcePort),
    targetIp: meta.targetIp || meta.entryIp,
    targetPort: agentInteger(meta.targetPort || meta.entrySourcePort),
  };
}

export function buildMetaAgentSelfTestPayload(
  test: { id?: unknown; ruleId?: unknown },
  meta: SelfTestMeta | null,
) {
  const tunnelPayload = buildTunnelAgentSelfTestPayload(test, meta);
  if (tunnelPayload) return tunnelPayload;

  if (meta?.kind === "forward-via-tunnel" || meta?.kind === "forward-via-tunnel-entry") {
    const entryProbe = meta.kind === "forward-via-tunnel-entry";
    const method = normalizeLinkProbeMethod(meta.method);
    return {
      testId: agentInteger(test?.id),
      // 隧道规则的这一步是出口主机直接连目标，不经过隧道运行时，和转发链最后一段一样不用等运行时就绪。
      // 用 Agent 不认识的 kind 下发：Agent 按普通目标测一次（1.5 秒），不再为不通的目标重试满 20 秒。
      // 入口端口那一步走的是运行时，仍按原 kind。
      kind: entryProbe ? meta.kind : "forward-via-tunnel-target",
      tunnelId: agentInteger(meta.tunnelId),
      ruleId: agentInteger(test?.ruleId),
      forwardType: "gost-tunnel",
      protocol: method,
      method,
      sourcePort: entryProbe ? agentInteger(meta.entrySourcePort) : 0,
      targetIp: entryProbe ? meta.entryIp : meta.targetIp,
      targetPort: entryProbe ? agentInteger(meta.entrySourcePort) : agentInteger(meta.targetPort),
    };
  }

  return buildForwardChainAgentSelfTestPayload(test, meta);
}

export function buildRuleAgentSelfTestPayload(
  test: { id?: unknown; ruleId?: unknown },
  rule: any,
  targetIp = rule?.targetIp,
) {
  const method = linkProbeMethodForRule(rule);
  return {
    testId: agentInteger(test?.id),
    ruleId: agentInteger(rule?.id ?? test?.ruleId),
    forwardType: String(rule?.forwardType || ""),
    protocol: method,
    method,
    sourcePort: agentInteger(rule?.sourcePort),
    targetIp: String(targetIp || ""),
    targetPort: agentInteger(rule?.targetPort),
  };
}
