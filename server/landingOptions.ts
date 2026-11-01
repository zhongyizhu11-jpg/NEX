/**
 * 「落地选择器」的数据：转发规则的 Shadowsocks 出口和落地节点的分流共用这一份清单。
 *
 * 以前两处各问各的（ssEgress.ts 的 listEgressLandingOptions 按主机分组、inboundRoutingRuntime.ts 的
 * listRoutingLandingOptions 平铺一列带解锁结论），界面也是两套。现在统一成一个形状：按主机分组，
 * 每个入站带方法 / 启停 / 能不能做出口 / 最新一次解锁检测各服务的结论。
 *
 * 权限用的是规则出口那一套（不要求客户端订阅权限 —— 用管理员开放的落地出口不需要能看订阅）：
 *   - 管理员：所有主机、所有 SS 入站；
 *   - 普通用户：自己的主机 + 管理员授权的主机；上面自己的 SS 入站，或者管理员开放的「落地出口」入站。
 * 这和分流那边的 routingLandingUsableBy 是同一个判断，只是从主机这头算起。
 */

import { getHostEntryAddress } from "../shared/hostEntryAddress";
import { normalizeSsMethod, ssEgressMethodError } from "../shared/ssEgress";
import type { UnlockStatus } from "../shared/unlockCheck";
import * as db from "./db";
import { isHostConsideredOnline } from "./hostHeartbeatPolicy";
import { latestUnlockStatusesByHostIds } from "./ops/unlock";
import { dbBool } from "./repositories/repositoryUtils";

type Actor = { id: number; role: string };

export type LandingOptionInbound = {
  id: number;
  name: string;
  port: number;
  method: string;
  /** 这个方法不能做 gost 出口时的原因（分流那边 sing-box 同样只接这几种）。 */
  methodError: string | null;
  isEnabled: boolean;
  /** 管理员开放给大家当出口的入站（一键创建的就是这种）。 */
  landingEgress: boolean;
  /** 所在主机最新一次解锁检测：服务 id → 结论。没测过就是空对象。 */
  unlock: Record<string, UnlockStatus>;
  /** 最新一次检测的时间（秒）；没测过是 0。 */
  unlockCheckedAt: number;
};

export type LandingOptionHost = {
  hostId: number;
  name: string;
  isOnline: boolean;
  hasAddress: boolean;
  ownHost: boolean;
  /** 一键创建要能在这台机器上开落地节点：管理员，或者机器是自己的（细的权限 / 额度检查在创建时做）。 */
  canCreateInbound: boolean;
  inbounds: LandingOptionInbound[];
};

/** 操作者能当落地用的主机和上面的 Shadowsocks 入站。有入站的主机排前面，再按名字。 */
export async function listLandingOptions(actor: Actor): Promise<LandingOptionHost[]> {
  const isAdmin = actor.role === "admin";
  const hosts = (isAdmin
    ? await db.getHosts()
    : await (async () => {
      const own = await db.getHosts(actor.id) as any[];
      const allowedIds = (await db.getUserEffectiveAllowedHostIds(actor.id)).map(Number);
      const others = allowedIds.length > 0 ? await db.getHostsByIds(allowedIds) as any[] : [];
      const byId = new Map<number, any>();
      for (const host of [...own, ...others]) byId.set(Number(host.id), host);
      return Array.from(byId.values());
    })()) as any[];
  const visibleHosts = hosts.filter((host) => String(host.hostType || "slave") !== "master" || isAdmin);
  const inbounds = (isAdmin ? await db.getAllProxyInbounds() : await (async () => {
    const rows: any[] = [];
    for (const host of visibleHosts) rows.push(...await db.getProxyInboundsByHost(Number(host.id)) as any[]);
    return rows;
  })()) as any[];
  const unlockByHost = await latestUnlockStatusesByHostIds(visibleHosts.map((host) => Number(host.id)));
  const byHost = new Map<number, LandingOptionInbound[]>();
  for (const inbound of inbounds) {
    if (String(inbound.protocol) !== "shadowsocks") continue;
    // 落地池的成员入站跟着池走（池里去掉那台它就没了），不拿来当单独的出口 / 分流落地。
    if (Number(inbound.nodePoolId || 0) > 0) continue;
    const usable = isAdmin || Number(inbound.userId) === Number(actor.id) || dbBool(inbound.landingEgress);
    if (!usable) continue;
    const hostId = Number(inbound.hostId);
    const services = unlockByHost.get(hostId);
    const list = byHost.get(hostId) || [];
    list.push({
      id: Number(inbound.id),
      name: String(inbound.name || ""),
      port: Number(inbound.port),
      method: normalizeSsMethod(inbound.method),
      methodError: ssEgressMethodError(inbound.method),
      isEnabled: dbBool(inbound.isEnabled, true),
      landingEgress: dbBool(inbound.landingEgress),
      unlock: services ? Object.fromEntries(Array.from(services.entries()).map(([id, value]) => [id, value.status])) : {},
      unlockCheckedAt: services ? Math.max(0, ...Array.from(services.values()).map((value) => value.checkedAt)) : 0,
    });
    byHost.set(hostId, list);
  }
  return visibleHosts
    .map((host) => ({
      hostId: Number(host.id),
      name: String(host.name || `#${host.id}`),
      isOnline: isHostConsideredOnline(host),
      hasAddress: !!getHostEntryAddress(host),
      ownHost: Number(host.userId) === Number(actor.id),
      canCreateInbound: isAdmin || Number(host.userId) === Number(actor.id),
      inbounds: (byHost.get(Number(host.id)) || []).sort((a, b) => a.port - b.port),
    }))
    .sort((a, b) => Number(b.inbounds.length > 0) - Number(a.inbounds.length > 0) || a.name.localeCompare(b.name));
}
