import { fxpRuntimeIncompatible, fxpRuntimeIssueMessage } from "../shared/fxpRuntime";

/*
  NEX（forwardx）隧道上每一台 Agent 都要跑 forwardx-fxp，任何一台的 FXP 握不上当前协议，
  整条隧道就不通：tcping 到入口端口是通的（那是 Agent 自己在听），真实流量在握手时被丢掉。
  以前面板只看 Agent 版本，这种隧道在列表里一切正常、诊断也过。这里按成员主机报上来的
  fxpVersion 找出握不上的那几台，给隧道列表、规则列表和诊断用。
*/

export type TunnelFxpRuntimeIssue = {
  hostId: number | null;
  hostName: string | null;
  fxpVersion: string | null;
  message: string;
};

export function isForwardXTunnel(tunnel: any) {
  return String(tunnel?.mode || "").trim().toLowerCase() === "forwardx";
}

export function tunnelFxpRuntimeIssues(
  tunnel: any,
  memberHostIds: readonly unknown[],
  hostById: ReadonlyMap<number, any>,
): TunnelFxpRuntimeIssue[] {
  if (!isForwardXTunnel(tunnel)) return [];
  const issues: TunnelFxpRuntimeIssue[] = [];
  const seen = new Set<number>();
  for (const value of memberHostIds) {
    const hostId = Number(value || 0);
    if (!Number.isFinite(hostId) || hostId <= 0 || seen.has(hostId)) continue;
    seen.add(hostId);
    const host = hostById.get(hostId);
    if (!host || !fxpRuntimeIncompatible(host)) continue;
    const hostName = String(host.name || "").trim() || `主机 ${hostId}`;
    issues.push({
      hostId,
      hostName,
      fxpVersion: host.fxpVersion ? String(host.fxpVersion) : null,
      message: fxpRuntimeIssueMessage(hostName, host),
    });
  }
  return issues;
}

/** 隧道上所有要跑 FXP 的主机：入口、出口、中转、负载均衡出口、入口/出口组成员。 */
export function tunnelFxpMemberHostIds(tunnel: any, extras: {
  hopHostIds?: readonly unknown[];
  extraExitHostIds?: readonly unknown[];
  groupHostIds?: readonly unknown[];
} = {}) {
  return [
    tunnel?.entryHostId,
    ...(extras.groupHostIds || []),
    ...(extras.hopHostIds || []),
    tunnel?.exitHostId,
    ...(extras.extraExitHostIds || []),
  ].map((value) => Number(value || 0)).filter((id) => Number.isFinite(id) && id > 0);
}

/** 一句话，诊断和自检直接拿去当失败原因。 */
export function tunnelFxpRuntimeIssueSummary(issues: readonly TunnelFxpRuntimeIssue[]) {
  if (issues.length === 0) return "";
  return `${issues.map((issue) => issue.message).join("；")}。升级前这条 NEX 隧道握不上手，流量会超时。`;
}

/** 非管理员看不到的主机：只说「有一台节点」，不报名字和版本。 */
export function redactTunnelFxpRuntimeIssue(issue: TunnelFxpRuntimeIssue, visible: boolean): TunnelFxpRuntimeIssue {
  if (visible) return issue;
  return {
    hostId: null,
    hostName: null,
    fxpVersion: null,
    message: "隧道中有一台节点的 FXP 版本过旧，需要管理员升级 Agent",
  };
}

/** 链路带宽上限字段能填的最大值（Mbit/s），和 FXP 的 linkShaperMaxMbps 一致。 */
export const TUNNEL_LINK_MBPS_MAX = 1_000_000;

/**
 * 隧道两端链路的带宽上限（Mbit/s）：upMbps 是入口→出口，downMbps 是出口→入口。
 * 中间有硬限速（云联网地域间带宽、公网带宽上限）时填：FXP 把往那个方向发的所有
 * 隧道帧合起来整形到上限之下，限速器不再丢包，多连接也能稳稳贴着上限跑。
 * 0 = 不整形。只对 NEX 隧道有意义。
 */
export type TunnelLinkShapingMode = "auto" | "manual" | "off";

export function normalizeTunnelLinkShapingMode(value: unknown): TunnelLinkShapingMode {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "manual" || mode === "off" ? mode : "auto";
}

/**
 * 主机公网出口整形（FXP 的 egress 整形器）：这台机器往客户端、往目标发的所有明文
 * 流量合起来整形到机房公网带宽上限之下。默认关：客户端来自四面八方，随机丢包
 * 不该让整台机器减速；只在确定有公网限速器的机器上打开。
 */
export type HostEgressShapingMode = "auto" | "manual" | "off";

export function normalizeHostEgressShapingMode(value: unknown): HostEgressShapingMode {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "manual" || mode === "auto" ? mode : "off";
}

export function hostEgressShaping(host: any): { mode: HostEgressShapingMode; mbps: number } {
  const parsed = Math.floor(Number(host?.egressMbps));
  const mbps = Number.isFinite(parsed) && parsed > 0 ? Math.min(TUNNEL_LINK_MBPS_MAX, parsed) : 0;
  const mode = normalizeHostEgressShapingMode(host?.egressShapingMode);
  if (mode === "manual") return { mode: mbps > 0 ? "manual" : "off", mbps };
  return { mode, mbps: 0 };
}

export function tunnelLinkShaping(tunnel: any): { mode: TunnelLinkShapingMode; upMbps: number; downMbps: number } {
  if (!isForwardXTunnel(tunnel)) return { mode: "off", upMbps: 0, downMbps: 0 };
  const clamp = (value: unknown) => {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(TUNNEL_LINK_MBPS_MAX, parsed);
  };
  const upMbps = clamp(tunnel?.linkUpMbps);
  const downMbps = clamp(tunnel?.linkDownMbps);
  const mode = normalizeTunnelLinkShapingMode(tunnel?.linkShapingMode);
  if (mode === "manual") return { mode: upMbps > 0 || downMbps > 0 ? "manual" : "off", upMbps, downMbps };
  return { mode, upMbps: 0, downMbps: 0 };
}
