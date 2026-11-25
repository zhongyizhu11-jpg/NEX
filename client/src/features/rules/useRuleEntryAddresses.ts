/*
  从 client/src/pages/Rules.tsx 第 6081-6228 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { enabledHostMembers, getForwardGroupRouteLabel, isForwardChainGroup, pushUniqueEntryAddress, type EntryAddress } from "../../pages/Rules";
import { getEntryAddressFamily as addressFamily, resolveRuleEntryHost } from "@/lib/ruleEntryDisplay";
import { getTunnelHopIds } from "@/lib/tunnelDisplay";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { getHostEntryAddresses } from "@shared/hostEntryAddress";

export type UseRuleEntryAddressesContext = {
  forwardGroupById: Map<number, any>;
  getTunnelEntryHostForDisplay: (tunnel: any | null | undefined, hostId: number) => any;
  hosts: Array<any> | undefined;
  tunnelById: Map<number, any>;
  entryDomainForForwardGroup: (group: any | null | undefined) => string;
};

export type UseRuleEntryAddressesResult = {
  getTunnelEntryAddresses: (tunnel: any | null | undefined) => EntryAddress[];
  getForwardChainEntryAddresses: (group: any | null | undefined) => EntryAddress[];
  getForwardGroupEntryAddresses: (group: any | null | undefined) => EntryAddress[];
  portEntryGroupOf: (group: any | null | undefined) => any;
  forwardGroupDisplayMembers: (group: any | null | undefined) => any[];
};

export function useRuleEntryAddresses(ctx: UseRuleEntryAddressesContext): UseRuleEntryAddressesResult {
  const { forwardGroupById, getTunnelEntryHostForDisplay, hosts, tunnelById, entryDomainForForwardGroup } = ctx;
  const getTunnelEntryAddresses = (tunnel: any | null | undefined): EntryAddress[] => {
    if (!tunnel) return [];
    const rows: EntryAddress[] = [];
    const entryGroup = Number(tunnel?.entryGroupId || 0) > 0
      ? forwardGroupById.get(Number(tunnel.entryGroupId)) || tunnel.entryGroup
      : null;
    const entryGroupDomain = String(entryGroup?.domain || "").trim();
    if (entryGroupDomain) {
      pushUniqueEntryAddress(rows, "入口组", entryGroupDomain);
      return rows;
    }
    const entryMembers = entryGroup && forwardGroupModeOf(entryGroup) === "entry"
      ? enabledHostMembers(entryGroup)
      : [];
    if (entryMembers.length > 0) {
      const memberEntries = entryMembers.flatMap((member: any) => {
        const host = getTunnelEntryHostForDisplay(tunnel, Number(member.hostId || 0));
        return getHostEntryAddresses(host);
      });
      const memberDomain = memberEntries.find((entry) => entry.label === "DDNS")
        || memberEntries.find((entry) => addressFamily(entry.value) === "hostname");
      if (memberDomain) {
        pushUniqueEntryAddress(rows, memberDomain.label, memberDomain.value);
        return rows;
      }
      const firstEntryHost = getTunnelEntryHostForDisplay(tunnel, Number(entryMembers[0]?.hostId || 0));
      for (const entry of getHostEntryAddresses(firstEntryHost)) {
        pushUniqueEntryAddress(rows, entry.label, entry.value);
      }
      return rows;
    }
    const entryHostId = Number(tunnel?.entryHostId || getTunnelHopIds(tunnel)[0] || 0);
    for (const entry of getHostEntryAddresses(getTunnelEntryHostForDisplay(tunnel, entryHostId))) {
      pushUniqueEntryAddress(rows, entry.label, entry.value);
    }
    return rows;
  };

  const getMemberEntryHost = (member: any | null | undefined) => {
    const hostId = Number(member?.hostId || 0);
    if (hostId > 0) {
      // Shared groups may expose the member host only through the ACL-filtered
      // `member.host` payload. Keep that nested summary as a display fallback;
      // otherwise a configured DDNS/domain entry is replaced by entryAddress
      // (usually an IPv4 literal) for ordinary users.
      return resolveRuleEntryHost(hosts, hostId, member?.host || null);
    }
    const tunnelId = Number(member?.tunnelId || 0);
    if (tunnelId > 0) {
      const tunnel = tunnelById.get(tunnelId);
      const entryHostId = Number(tunnel?.entryHostId || 0);
      return resolveRuleEntryHost(hosts, entryHostId, tunnel?.entryHost || member?.host || null);
    }
    return member?.host || null;
  };

  const pushMemberEntryAddresses = (rows: EntryAddress[], member: any | null | undefined) => {
    const tunnelId = Number(member?.tunnelId || 0);
    if (tunnelId > 0) {
      const tunnelRows = getTunnelEntryAddresses(tunnelById.get(tunnelId));
      for (const entry of tunnelRows) {
        pushUniqueEntryAddress(rows, entry.label, entry.value);
      }
      if (tunnelRows.length > 0) return;
    }
    const entryHost = getMemberEntryHost(member);
    for (const entry of getHostEntryAddresses(entryHost)) {
      pushUniqueEntryAddress(rows, entry.label, entry.value);
    }
    pushUniqueEntryAddress(rows, "入口", member?.entryAddress);
  };

  /** 挂了入口组的端口转发（2.3.438 起）：入口是入口组里的主机。 */
  const portEntryGroupOf = (group: any | null | undefined) => {
    if (!group || forwardGroupModeOf(group) !== "port" || Number(group.entryGroupId || 0) <= 0) return null;
    const entryGroup = forwardGroupById.get(Number(group.entryGroupId)) || group.entryGroup || null;
    return entryGroup && forwardGroupModeOf(entryGroup) === "entry" ? entryGroup : null;
  };
  /** 资源下拉、规则卡上当作入口来数 / 来画的成员：挂了入口组就是入口组的主机。 */
  const forwardGroupDisplayMembers = (group: any | null | undefined): any[] => {
    const entryGroup = portEntryGroupOf(group);
    return entryGroup ? enabledHostMembers(entryGroup) : (group?.members || []);
  };

  const getForwardGroupEntryAddresses = (group: any | null | undefined): EntryAddress[] => {
    if (!group) return [];
    const rows: EntryAddress[] = [];
    const portEntryGroup = portEntryGroupOf(group);
    if (portEntryGroup) {
      const entryDomain = String(portEntryGroup.domain || "").trim();
      if (entryDomain) pushUniqueEntryAddress(rows, "入口组", entryDomain);
      for (const member of enabledHostMembers(portEntryGroup)) pushMemberEntryAddresses(rows, member);
      return rows;
    }
    const domain = String(group?.domain || "").trim();
    if (domain) {
      pushUniqueEntryAddress(rows, getForwardGroupRouteLabel(group), domain);
      return rows;
    }
    const activeMemberId = Number(group?.activeMemberId || 0);
    const members = [...(group?.members || [])]
      .filter((member: any) => member?.isEnabled !== false)
      .sort((a: any, b: any) => {
        if (activeMemberId > 0) {
          if (Number(a.id) === activeMemberId) return -1;
          if (Number(b.id) === activeMemberId) return 1;
        }
        return Number(a.priority || 0) - Number(b.priority || 0);
      });
    // 多台入口的端口转发（2.3.437 起）每台都在监听，入口地址全列出来；转发组只列当前生效的那台。
    const listAllMembers = forwardGroupModeOf(group) === "port" && members.length > 1;
    for (const member of members) {
      pushMemberEntryAddresses(rows, member);
      if (rows.length > 0 && !listAllMembers) return rows;
    }
    return rows;
  };

  const getForwardChainEntryAddresses = (group: any | null | undefined): EntryAddress[] => {
    if (!group) return [];
    const rows: EntryAddress[] = [];
    const entryGroup = isForwardChainGroup(group) && group.entryGroupId
      ? forwardGroupById.get(Number(group.entryGroupId)) || group.entryGroup
      : null;
    const domain = entryDomainForForwardGroup(group);
    if (domain) {
      pushUniqueEntryAddress(rows, "入口组", domain);
      return rows;
    }
    const entryMembers = entryGroup && forwardGroupModeOf(entryGroup) === "entry"
      ? enabledHostMembers(entryGroup)
      : [];
    if (entryMembers.length > 0) {
      const memberDomain = entryMembers
        .map((member: any) => getHostEntryAddresses(getMemberEntryHost(member)).find((entry) => addressFamily(entry.value) === "hostname"))
        .find(Boolean);
      if (memberDomain) {
        pushUniqueEntryAddress(rows, memberDomain.label, memberDomain.value);
        return rows;
      }
      const firstEntryMember = entryMembers[0];
      pushMemberEntryAddresses(rows, firstEntryMember);
      return rows;
    }
    const entryMember = (group.members || [])[0];
    pushMemberEntryAddresses(rows, entryMember);
    return rows;
  };
  return { getTunnelEntryAddresses, getForwardChainEntryAddresses, getForwardGroupEntryAddresses, portEntryGroupOf, forwardGroupDisplayMembers };
}
