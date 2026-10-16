/**
 * 共享 TLS 入站（SNI 分流）的接口。
 *
 * 入站只有管理员能建、改、删（在主机详情里管）；普通用户只能在自己有权使用的主机上，
 * 把规则挂到已有的入站上（见 rules.crud.ts 的 SNI 分支）。
 */

import { z } from "zod";

import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { pushAgentRefresh } from "../agentEvents";
import * as db from "../db";
import { dbBool } from "../repositories/repositoryUtils";
import {
  assertTlsInboundDeletable,
  normalizeTlsInboundInput,
  usableTlsInboundHostIds,
  validateTlsInboundChange,
} from "../tlsInbounds";
import {
  isTlsInboundAgentSupported,
  parseSniNameJson,
  TLS_INBOUND_AGENT_VERSION,
  TLS_INBOUND_MAX_HANDSHAKE_TIMEOUT,
  TLS_INBOUND_MAX_HANDSHAKES_LIMIT,
  TLS_INBOUND_PROXY_PROTOCOL_MODES,
  TLS_INBOUND_UNKNOWN_SNI_ACTIONS,
} from "../../shared/tlsInbound";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { getTlsInboundRuntimeStatus } from "../tlsInboundRuntime";

const settingsShape = {
  name: z.string().trim().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  isEnabled: z.boolean().optional(),
  allowedSni: z.union([z.string().max(20000), z.array(z.string().max(300)).max(512)]).optional(),
  rejectEmptySni: z.boolean().optional(),
  unknownSniAction: z.enum(TLS_INBOUND_UNKNOWN_SNI_ACTIONS).optional(),
  defaultRuleId: z.number().int().positive().nullable().optional(),
  proxyProtocol: z.enum(TLS_INBOUND_PROXY_PROTOCOL_MODES).optional(),
  maxHandshakes: z.number().int().min(1).max(TLS_INBOUND_MAX_HANDSHAKES_LIMIT).optional(),
  handshakeTimeoutSeconds: z.number().int().min(1).max(TLS_INBOUND_MAX_HANDSHAKE_TIMEOUT).optional(),
};

function hostLockKey(hostId: number) {
  return `tls-inbound-host:${Number(hostId)}`;
}

async function describeInboundRules(inboundIds: number[]) {
  const rules = await db.getSniRulesForInbounds(inboundIds) as any[];
  const userIds = Array.from(new Set(rules.map((rule) => Number(rule.userId)).filter((id) => id > 0)));
  const users = await Promise.all(userIds.map((id) => db.getUserById(id)));
  const userById = new Map(users.filter(Boolean).map((user: any) => [Number(user.id), user]));
  const byInbound = new Map<number, any[]>();
  for (const rule of rules) {
    const owner = userById.get(Number(rule.userId)) as any;
    const list = byInbound.get(Number(rule.tlsInboundId)) || [];
    list.push({
      id: Number(rule.id),
      name: String(rule.name || ""),
      userId: Number(rule.userId),
      username: owner ? String(owner.name || owner.username || "") : "",
      ownerIsAdmin: owner?.role === "admin",
      isEnabled: dbBool(rule.isEnabled),
      isRunning: dbBool(rule.isRunning),
      sniNames: parseSniNameJson(rule.sniNames),
    });
    byInbound.set(Number(rule.tlsInboundId), list);
  }
  return byInbound;
}

export const tlsInboundsRouter = router({
  /** 主机详情里那一节：这台主机的全部共享入站，连同挂在上面的规则。 */
  listByHost: adminProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      const inbounds = await db.listTlsInboundsByHost(input.hostId);
      const rulesByInbound = await describeInboundRules(inbounds.map((inbound) => inbound.id));
      return {
        agentSupported: isTlsInboundAgentSupported(String((host as any).agentVersion || "")),
        requiredAgentVersion: TLS_INBOUND_AGENT_VERSION,
        agentVersion: String((host as any).agentVersion || ""),
        inbounds: inbounds.map((inbound) => ({
          ...inbound,
          rules: rulesByInbound.get(inbound.id) || [],
          runtime: getTlsInboundRuntimeStatus(input.hostId, inbound.id),
        })),
      };
    }),
  create: adminProcedure
    .input(z.object({ hostId: z.number().int().positive(), ...settingsShape }))
    .mutation(async ({ input }) => withKeyedTaskLock(hostLockKey(input.hostId), async () => {
      const settings = normalizeTlsInboundInput(input);
      if (settings.unknownSniAction === "default_rule") {
        throw new Error("新入站上还没有规则；请先建好规则，再把「未知 SNI」改成交给默认规则");
      }
      await validateTlsInboundChange({ hostId: input.hostId, settings });
      const id = await db.createTlsInbound(input.hostId, settings);
      pushAgentRefresh(input.hostId, "tls-inbound-created");
      return { id };
    })),
  update: adminProcedure
    .input(z.object({ id: z.number().int().positive(), ...settingsShape }))
    .mutation(async ({ input }) => {
      const current = await db.getTlsInboundById(input.id);
      if (!current) throw new Error("入站不存在");
      return withKeyedTaskLock(hostLockKey(current.hostId), async () => {
        const fresh = await db.getTlsInboundById(input.id);
        if (!fresh) throw new Error("入站不存在");
        const settings = normalizeTlsInboundInput(input, fresh);
        await validateTlsInboundChange({ hostId: fresh.hostId, inboundId: fresh.id, settings });
        await db.updateTlsInbound(fresh.id, settings);
        pushAgentRefresh(fresh.hostId, "tls-inbound-updated");
        return { success: true };
      });
    }),
  setEnabled: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isEnabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const current = await db.getTlsInboundById(input.id);
      if (!current) throw new Error("入站不存在");
      return withKeyedTaskLock(hostLockKey(current.hostId), async () => {
        if (input.isEnabled) {
          // 停用期间端口照样算占用（见 getTlsInboundPortsOnHost），这里只是兜底再查一次。
          await validateTlsInboundChange({ hostId: current.hostId, inboundId: current.id, settings: { ...current, isEnabled: true } });
        }
        await db.updateTlsInbound(current.id, { isEnabled: input.isEnabled });
        pushAgentRefresh(current.hostId, input.isEnabled ? "tls-inbound-enabled" : "tls-inbound-disabled");
        return { success: true };
      });
    }),
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const current = await db.getTlsInboundById(input.id);
      if (!current) throw new Error("入站不存在");
      return withKeyedTaskLock(hostLockKey(current.hostId), async () => {
        await assertTlsInboundDeletable(current.id);
        await db.deleteTlsInbound(current.id);
        pushAgentRefresh(current.hostId, "tls-inbound-deleted");
        return { success: true };
      });
    }),
  /**
   * 规则编辑框和规则列表用：当前用户能挂规则的入站（usable），加上他已有规则挂着的入站
   * （只用来显示，授权收回后也能看到规则挂在哪）。
   */
  listForUser: protectedProcedure.query(async ({ ctx }) => {
    const all = await db.listAllTlsInbounds();
    const hostIds = Array.from(new Set(all.map((inbound) => inbound.hostId)));
    const usableHosts = await usableTlsInboundHostIds(ctx.user, hostIds);
    let referenced = new Set<number>();
    if (ctx.user.role !== "admin") {
      const ownRules = await db.getForwardRules(ctx.user.id) as any[];
      referenced = new Set(ownRules.map((rule) => Number(rule.tlsInboundId || 0)).filter((id) => id > 0));
    }
    const visible = all.filter((inbound) => usableHosts.has(inbound.hostId) || referenced.has(inbound.id));
    const hosts = await db.getHostsByIds(Array.from(new Set(visible.map((inbound) => inbound.hostId)))) as any[];
    const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
    return visible.map((inbound) => {
      const host = hostById.get(inbound.hostId);
      return {
        id: inbound.id,
        hostId: inbound.hostId,
        hostName: String(host?.name || ""),
        name: inbound.name,
        port: inbound.port,
        isEnabled: inbound.isEnabled,
        allowedSni: inbound.allowedSni,
        agentVersion: String(host?.agentVersion || ""),
        agentSupported: isTlsInboundAgentSupported(String(host?.agentVersion || "")),
        usable: usableHosts.has(inbound.hostId),
      };
    });
  }),
});
