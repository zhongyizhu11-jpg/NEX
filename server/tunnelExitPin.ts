import { pushAgentRefresh } from "./agentEvents";
import { queryRaw, quoteDbIdentifier } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { clearTunnelRuntimeStatusForHosts } from "./tunnelRuntimeStatus";

/*
  手动指定的出口掉线 / 回来时，马上让入口重新拿配置（C1）。

  下发时「指定的那台离线就不理它、照常自动分」（agentHeartbeatRoute 的 pinnedExitHostId）—— 可那是下一次
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
    const entryHostIds = new Set<number>();
    if (Number(tunnel.entryHostId || 0) > 0) entryHostIds.add(Number(tunnel.entryHostId));
    const entryGroupId = Number(tunnel.entryGroupId || 0);
    if (entryGroupId > 0) {
      // 入口是入口组：组里每台都替这条链路监听，都要推
      const members = await queryRaw<{ hostId?: number | null }>(
        `SELECT ${q("hostId")} FROM ${q("forward_group_members")} WHERE ${q("groupId")} = ? AND ${q("memberType")} = ?`,
        [entryGroupId, "host"],
      );
      for (const member of members) if (Number(member.hostId || 0) > 0) entryHostIds.add(Number(member.hostId));
    }
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
