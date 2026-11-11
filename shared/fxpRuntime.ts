import { compareVersions, isAgentVersionAtLeast, isAgentVersionBehind, normalizeVersion } from "./version";
import { FXP_MIN_WIRE_VERSION, FXP_RUNTIME_VERSION } from "./versions";

/**
 * 主机上 forwardx-fxp 的状态，面板上判断「可升级」和隧道报警的唯一一把尺子。
 *
 * Agent 和 FXP 是两个二进制。升级脚本以前在 FXP 下载失败时只警告、留着旧 FXP 接着升
 * Agent：主机报上来的 Agent 版本是新的，面板看它一切正常，可 FXP 还停在握手 v2，
 * 和升级过的节点握不上（tcping 能通、真实流量超时）。现在 Agent 每次心跳都报
 * fxpVersion，取值见 agent/fxp_version.go：
 *   - x.y.z      forwardx-fxp -version 问出来的版本；
 *   - legacy     不认识 -version，但已经说握手 v3（2.2.121 ~ 2.2.123）：能用，该升级；
 *   - legacy-v2  不认识 -version，也不会握手 v3（早于 2.2.121）：握不上；
 *   - missing    没装 FXP；
 *   - unknown    Agent 这次没问出来。
 */

/**
 * 握手 v3（FXP 2.2.121）引入的一条报错文案，编进了 FXP 二进制。不认识 -version 的旧 FXP
 * 靠它区分「已经说 v3」和「只会 v2」。Agent（agent/fxp_version.go）和安装脚本各用一份，
 * scripts/check-versions.mjs 查三处一致、且 forwardx-fxp 源码里还留着它。
 */
export const FXP_HANDSHAKE_V3_MARKER = "fxp handshake timestamp outside window";

/** 从这一版起 Agent 会在注册和心跳里报 fxpVersion；更早的 Agent 不报，不能拿「没报」当问题。 */
export const AGENT_FXP_VERSION_REPORT_VERSION = "2.2.205";

export type FxpRuntimeState =
  | "ok"
  | "outdated"
  | "incompatible"
  | "missing"
  | "unreported"
  | "unknown";

export type FxpRuntimeStatus = {
  state: FxpRuntimeState;
  /** 原样的上报值（去掉 v 前缀），没报时为空串。 */
  version: string;
  /** 给人看的版本：legacy 之类换成说明文字。 */
  label: string;
  /** 重新跑一遍安装脚本能解决：一键升级要把这台算进去。 */
  needsUpgrade: boolean;
  /** true：能握手；false：确定握不上（隧道会断）；null：说不准。 */
  wireCompatible: boolean | null;
};

type HostVersions = {
  agentVersion?: string | null;
  fxpVersion?: string | null;
};

const SEMVER = /^\d+\.\d+\.\d+$/;

export function fxpRuntimeStatus(host: HostVersions | null | undefined): FxpRuntimeStatus {
  const version = normalizeVersion(host?.fxpVersion).toLowerCase();
  if (!version) {
    if (isAgentVersionAtLeast(host?.agentVersion, AGENT_FXP_VERSION_REPORT_VERSION)) {
      return { state: "unreported", version, label: "未上报", needsUpgrade: true, wireCompatible: null };
    }
    return { state: "unknown", version, label: "未上报", needsUpgrade: false, wireCompatible: null };
  }
  if (version === "missing") {
    return { state: "missing", version, label: "未安装", needsUpgrade: true, wireCompatible: false };
  }
  if (version === "legacy-v2") {
    return { state: "incompatible", version, label: `早于 ${FXP_MIN_WIRE_VERSION}`, needsUpgrade: true, wireCompatible: false };
  }
  if (version === "legacy") {
    return { state: "outdated", version, label: "2.2.121 ~ 2.2.123", needsUpgrade: true, wireCompatible: true };
  }
  if (!SEMVER.test(version)) {
    return { state: "unknown", version, label: "未知", needsUpgrade: false, wireCompatible: null };
  }
  if (compareVersions(version, FXP_MIN_WIRE_VERSION) < 0) {
    return { state: "incompatible", version, label: version, needsUpgrade: true, wireCompatible: false };
  }
  if (isAgentVersionBehind(version, FXP_RUNTIME_VERSION)) {
    return { state: "outdated", version, label: version, needsUpgrade: true, wireCompatible: true };
  }
  return { state: "ok", version, label: version, needsUpgrade: false, wireCompatible: true };
}

/** FXP 需要重新安装（一键升级会重跑安装脚本）。 */
export function fxpRuntimeNeedsUpgrade(host: HostVersions | null | undefined) {
  return fxpRuntimeStatus(host).needsUpgrade;
}

/**
 * 这台主机该不该出现在「可升级」里：Agent 落后于面板的版本，或者 Agent 已是最新、
 * 但 FXP 旧了/没装/握不上。没上报 Agent 版本的主机（离线很久、还没注册完）不算。
 */
export function hostNeedsAgentUpgrade(host: HostVersions | null | undefined, latestAgentVersion: string | null | undefined) {
  if (!host?.agentVersion) return false;
  if (isAgentVersionBehind(host.agentVersion, latestAgentVersion)) return true;
  return fxpRuntimeNeedsUpgrade(host);
}

/**
 * 「可升级」到底是哪一件事（2026-11 走查：Agent 已是最新的主机也挂着「可升级」，原因其实是没装 FXP）。
 *
 * 一键升级做的是同一件事（重跑安装脚本：Agent 和 FXP 一起装），但人要知道为什么亮着：
 *   - agent：Agent 落后于面板带的版本（FXP 有问题也会顺带修好，写在 detail 里）；
 *   - fxp：Agent 已是最新，FXP 没装 / 过旧 / 握不上 / 没报版本。
 * label 是详情里那几个字（带目标版本）；short 是卡片注脚上放得下的那几个字；detail 是悬停和详情里的一句完整说明。
 * 不该升级时返回 null。
 */
export type HostUpgradeReason = { kind: "agent" | "fxp"; label: string; short: string; detail: string };

export function hostUpgradeReason(host: HostVersions | null | undefined, latestAgentVersion: string | null | undefined): HostUpgradeReason | null {
  if (!host?.agentVersion) return null;
  const agent = normalizeVersion(host.agentVersion);
  const fxp = fxpRuntimeStatus(host);
  if (isAgentVersionBehind(host.agentVersion, latestAgentVersion)) {
    const target = normalizeVersion(latestAgentVersion);
    const fxpNote = !fxp.needsUpgrade
      ? ""
      : fxp.state === "missing"
        ? "；这台还没装 FXP 运行时，升级会一并装上"
        : `；FXP 运行时（${fxp.label}）也会一并更新`;
    return { kind: "agent", label: `Agent 有新版本 ${target}`, short: "Agent 有新版本", detail: `Agent ${agent} → ${target}${fxpNote}` };
  }
  if (!fxp.needsUpgrade) return null;
  switch (fxp.state) {
    case "missing":
      return { kind: "fxp", label: "缺 FXP 运行时", short: "缺 FXP 运行时", detail: `Agent 已是最新（${agent}），但这台没装 FXP 运行时，隧道转发用不了；点升级会重新安装 FXP` };
    case "incompatible":
      return { kind: "fxp", label: "FXP 过旧", short: "FXP 过旧", detail: `Agent 已是最新（${agent}），FXP 运行时（${fxp.label}）握不上现在的隧道协议；点升级会重新安装 FXP ${FXP_RUNTIME_VERSION}` };
    case "outdated":
      return { kind: "fxp", label: "FXP 可升级", short: "FXP 可升级", detail: `Agent 已是最新（${agent}），FXP 运行时 ${fxp.label} → ${FXP_RUNTIME_VERSION}` };
    default:
      return { kind: "fxp", label: "FXP 未上报", short: "FXP 未上报", detail: `Agent 已是最新（${agent}），但没报 FXP 运行时的版本；点升级会重新安装 FXP 补上` };
  }
}

/** 这台主机的 FXP 确定握不上当前的隧道协议（或者根本没装）。 */
export function fxpRuntimeIncompatible(host: HostVersions | null | undefined) {
  return fxpRuntimeStatus(host).wireCompatible === false;
}

/** 隧道/规则/诊断上给人看的一句话，例如「Po01 的 FXP 版本过旧（2.2.120），需要升级 Agent」。 */
export function fxpRuntimeIssueMessage(hostName: string | null | undefined, host: HostVersions | null | undefined) {
  const status = fxpRuntimeStatus(host);
  if (status.wireCompatible !== false) return "";
  const name = String(hostName || "").trim() || "隧道节点";
  if (status.state === "missing") return `${name} 没有安装 FXP，需要升级 Agent（会重新安装 FXP）`;
  return `${name} 的 FXP 版本过旧（${status.label}），需要升级 Agent`;
}
