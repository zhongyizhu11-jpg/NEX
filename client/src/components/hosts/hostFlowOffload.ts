/**
 * 主机「内核快速转发」（agent/flowtable_offload.go）在编辑框里的状态一句话。
 *
 * 面板在 hosts.list 里给 flowOffloadStatus（server/routers/hosts.ts 的 flowOffloadStatusView，开关关着是 null）。
 */

export type HostFlowOffloadStatus = {
  state?: string | null;
  message?: string | null;
  offloaded?: number | null;
} | null | undefined;

export function describeHostFlowOffload(status: HostFlowOffloadStatus) {
  if (!status) return "";
  const state = String(status.state || "");
  const message = String(status.message || "").trim();
  if (state === "active") {
    const offloaded = Math.max(0, Math.floor(Number(status.offloaded || 0)));
    const base = offloaded > 0 ? `生效中，${offloaded} 条连接走快速路径` : "生效中";
    return message ? `${base}（${message}）` : base;
  }
  if (state === "pending") return "等主机上报";
  return message || "没有生效";
}
