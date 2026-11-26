import { pushAgentRefresh } from "./agentEvents";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { clearTunnelRuntimeStatusForHosts } from "./tunnelRuntimeStatus";
import { getTunnelEntryHostIds } from "./repositories/tunnelRepository";

/*
  手动指定的出口掉线 / 回来时，马上让入口重新拿配置（C1）。

  下发时「指定的那台离线就不理它、照常自动分」（agentHeartbeatRoute 的 pinnedExitHostId，NEX 和 GOST 隧道都是）—— 可那是下一次
  下发时才看的。指定的出口掉线之后没有任何东西去催入口，入口手里还是「只走这一台」的那份配置，流量全进
  黑洞，直到入口自己下一次整份心跳（最长约 5 分钟）。回来的时候同理：入口要等很久才重新只走它。

  这里在主机上下线的那一刻找出指定着它的链路，通知这些链路的入口机：
    · 清掉入口在这条链路上的「已就绪」—— NEX 入口看到自己没就绪才会带着新规格再下发一次（和 setExitPin 一样）；
    · 紧急刷新。GOST 的配置按内容比对同步，拿到新的就热更新。
*/

const q = quoteDbIdentifier;

export async function refreshTunnelsPinnedToHost(hostId: number, reason: string): Promise<number[]> {
  const id = Number(hostId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const tunnels = await queryRaw<{ id: number; entryHostId?: number | null; entryGroupId?: number | null }>(
    `SELECT ${q("id")}, ${q("entryHostId")}, ${q("entryGroupId")} FROM ${q("tunnels")} WHERE ${q("balancePinHostId")} = ?`,
    [id],
  );
  const pushed = new Set<number>();
  for (const tunnel of tunnels) {
    const tunnelId = Number(tunnel.id);
    // 入口是入口组：组里每台都替这条链路监听，都要推
    const entryHostIds = new Set(await getTunnelEntryHostIds(tunnel));
    if (entryHostIds.size === 0) continue;
    clearTunnelRuntimeStatusForHosts(tunnelId, Array.from(entryHostIds));
    for (const entryHostId of entryHostIds) {
      pushAgentRefresh(entryHostId, `${reason}-tunnel-${tunnelId}`, { urgent: true });
      pushed.add(entryHostId);
    }
    appendPanelLog("info", `[Tunnel] exit pin host=${id} ${reason} tunnel=${tunnelId} entries=${Array.from(entryHostIds).join(",")}`);
  }
  return Array.from(pushed);
}

/*
  NEX 隧道（FXP）入口的手动指定（2.3.556）：出口全部下发，指定的那台排第一，分法换成主备（FXP 的 fallback = lbcore.First，
  每次挑「能用的里排最前的」）。指定的那台能用就只走它；它连不上目标 / 掉线就当场走下一台；好了马上切回。

  以前下发时只留指定的那一台：FXP 手里只有一台出口，不探「出口连得上目标吗」、不报真实状态、也没有别的可换 ——
  用户面板（2026-11-26）：指定 Jinx(29.9y)，高防时不时拦它，拦的那阵子整条规则断；面板也拿不到「在走哪台」，诊断退回去
  测主出口 jinx(39.9y)（被拦着），写「超时」。GOST 隧道早就是「全部下发 + 指定下标」（agent exitPinPickLocked）。
*/
export function orderEntryRoutesForPin<T extends { hostId?: number | null }>(routes: readonly T[], pinHostId: number): { routes: T[]; pinned: boolean } {
  const pin = Number(pinHostId) || 0;
  const index = pin > 0 && routes.length > 1 ? routes.findIndex((route) => Number(route.hostId || 0) === pin) : -1;
  if (index < 0) return { routes: [...routes], pinned: false };
  return { routes: [routes[index], ...routes.filter((_, i) => i !== index)], pinned: true };
}
