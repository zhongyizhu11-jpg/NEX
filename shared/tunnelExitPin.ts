/*
  负载均衡「手动指定出口」（tunnels.balancePinHostId）在哪些链路上做不到（C1）。

  指定是在「挑出口的那台机器」上执行的：入口下发时只留指定的那一台。下面两种链路挑出口的不是入口，
  面板下发的指定到不了它手里，以前照样让设、设了没有任何效果，界面上却写着「已指定走 xxx」：
    · Nginx 隧道：出口由入口机上的 nginx upstream 自己挑；
    · 带中转的 NEX 链路：入口只拨中转，出口由最后一台中转挑（server/agentHeartbeatForwardXHop.ts）。
  GOST 隧道（含多跳）、不带中转的 NEX 链路照常能指定。

  服务端（tunnels.setExitPin）拒绝、界面（链路的负载均衡出口弹窗）不给按钮，用的是同一个判断和同一句话。
*/

/** hopCount：链路的跳数（入口、中转、出口都算；直连是 0 或 2，带中转 ≥ 3）。返回 null = 可以指定。 */
export function tunnelExitPinUnsupportedReason(tunnel: { mode?: unknown } | null | undefined, hopCount: number): string | null {
  const mode = String(tunnel?.mode ?? "").trim().toLowerCase();
  if (mode === "nginx_stream") return "Nginx 隧道的出口由 nginx 自己挑，不能手动指定出口";
  if (mode === "forwardx" && Number(hopCount) >= 3) return "带中转的 NEX 链路由中转挑出口，不能手动指定出口";
  return null;
}
