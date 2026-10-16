/**
 * 共享 TLS 入站（host_tls_inbounds）和规则占用的 SNI（rule_sni_names）的读写。
 *
 * 规则的 SNI 有两份：规则行上的 sniNames（JSON，给列表和心跳用）和 rule_sni_names
 * 侧表（(tlsInboundId, name) 唯一索引，用来挡并发抢同一个名字）。两份必须在同一个
 * 事务里一起改 —— 调用方用 withDatabaseTransaction 把规则行的写入和
 * replaceRuleSniNames 包在一起。
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { forwardRules, hostTlsInbounds, ruleSniNames } from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { dbBool } from "./repositoryUtils";
import {
  normalizeTlsInboundHandshakeTimeout,
  normalizeTlsInboundMaxHandshakes,
  normalizeTlsInboundProxyProtocol,
  normalizeTlsInboundUnknownSniAction,
  parseSniNameJson,
  TLS_INBOUND_SNI_CONFLICT_MESSAGE,
  type TlsInboundSettings,
} from "../../shared/tlsInbound";

export type TlsInboundRow = TlsInboundSettings & {
  id: number;
  hostId: number;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export function tlsInboundFromRow(row: any): TlsInboundRow {
  const defaultRuleId = Number(row?.defaultRuleId || 0);
  return {
    id: Number(row?.id || 0),
    hostId: Number(row?.hostId || 0),
    name: String(row?.name || "").trim(),
    port: Number(row?.port || 0),
    isEnabled: dbBool(row?.isEnabled),
    allowedSni: parseSniNameJson(row?.allowedSni),
    rejectEmptySni: row?.rejectEmptySni === undefined || row?.rejectEmptySni === null ? true : dbBool(row.rejectEmptySni),
    unknownSniAction: normalizeTlsInboundUnknownSniAction(row?.unknownSniAction),
    defaultRuleId: defaultRuleId > 0 ? defaultRuleId : null,
    proxyProtocol: normalizeTlsInboundProxyProtocol(row?.proxyProtocol),
    maxHandshakes: normalizeTlsInboundMaxHandshakes(row?.maxHandshakes),
    handshakeTimeoutSeconds: normalizeTlsInboundHandshakeTimeout(row?.handshakeTimeoutSeconds),
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

function settingsToColumns(settings: Partial<TlsInboundSettings>) {
  const columns: Record<string, unknown> = {};
  if (settings.name !== undefined) columns.name = settings.name;
  if (settings.port !== undefined) columns.port = settings.port;
  if (settings.isEnabled !== undefined) columns.isEnabled = settings.isEnabled;
  if (settings.allowedSni !== undefined) columns.allowedSni = JSON.stringify(settings.allowedSni);
  if (settings.rejectEmptySni !== undefined) columns.rejectEmptySni = settings.rejectEmptySni;
  if (settings.unknownSniAction !== undefined) columns.unknownSniAction = settings.unknownSniAction;
  if (settings.defaultRuleId !== undefined) columns.defaultRuleId = settings.defaultRuleId;
  if (settings.proxyProtocol !== undefined) columns.proxyProtocol = settings.proxyProtocol;
  if (settings.maxHandshakes !== undefined) columns.maxHandshakes = settings.maxHandshakes;
  if (settings.handshakeTimeoutSeconds !== undefined) columns.handshakeTimeoutSeconds = settings.handshakeTimeoutSeconds;
  return columns;
}

export async function getTlsInboundById(id: number): Promise<TlsInboundRow | null> {
  const db = await getDb();
  if (!db || !(Number(id) > 0)) return null;
  const rows = await db.select().from(hostTlsInbounds).where(eq(hostTlsInbounds.id, Number(id))).limit(1);
  return rows[0] ? tlsInboundFromRow(rows[0]) : null;
}

export async function listTlsInboundsByHostIds(hostIds: readonly number[]): Promise<TlsInboundRow[]> {
  const ids = Array.from(new Set(hostIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  // 心跳每次都读它：只建了部分表的库里（测试库、迁移中途）当作没有入站。
  const rows = await tolerateMissingTable(async () => db.select().from(hostTlsInbounds)
    .where(inArray(hostTlsInbounds.hostId, ids))
    .orderBy(asc(hostTlsInbounds.hostId), asc(hostTlsInbounds.port), asc(hostTlsInbounds.id)) as Promise<any[]>, [] as any[]);
  return (rows as any[]).map(tlsInboundFromRow);
}

export async function listTlsInboundsByHost(hostId: number): Promise<TlsInboundRow[]> {
  return listTlsInboundsByHostIds([hostId]);
}

export async function listAllTlsInbounds(): Promise<TlsInboundRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(hostTlsInbounds).orderBy(asc(hostTlsInbounds.hostId), asc(hostTlsInbounds.port));
  return (rows as any[]).map(tlsInboundFromRow);
}

export async function countTlsInboundsOnHost(hostId: number) {
  return (await listTlsInboundsByHost(hostId)).length;
}

export async function createTlsInbound(hostId: number, settings: TlsInboundSettings): Promise<number> {
  return insertAndGetId("host_tls_inbounds", {
    hostId: Number(hostId),
    ...settingsToColumns(settings),
    createdAt: nowDate(),
    updatedAt: nowDate(),
  });
}

export async function updateTlsInbound(id: number, settings: Partial<TlsInboundSettings>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(hostTlsInbounds).set({ ...settingsToColumns(settings), updatedAt: nowDate() } as any)
    .where(eq(hostTlsInbounds.id, Number(id)));
}

export async function deleteTlsInbound(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(ruleSniNames).where(eq(ruleSniNames.tlsInboundId, Number(id)));
  await db.delete(hostTlsInbounds).where(eq(hostTlsInbounds.id, Number(id)));
}

/** 删主机时连同它上面的共享入站和名字占用一起清掉（规则行由 deleteHost 自己删）。 */
export async function deleteTlsInboundsForHost(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await tolerateMissingTable(async () => {
    const inbounds = await listTlsInboundsByHost(hostId);
    const ids = inbounds.map((inbound) => inbound.id);
    if (ids.length > 0) await db.delete(ruleSniNames).where(inArray(ruleSniNames.tlsInboundId, ids));
    await db.delete(hostTlsInbounds).where(eq(hostTlsInbounds.hostId, Number(hostId)));
  }, undefined);
}

/** 这个入站上还在的规则（不含待删除的）。暂停的也算：它们保留着自己的 SNI。 */
export async function getSniRulesForInbound(tlsInboundId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(and(
    eq(forwardRules.tlsInboundId, Number(tlsInboundId)),
    eq(forwardRules.pendingDelete, false),
  ));
}

export async function getSniRulesForInbounds(tlsInboundIds: readonly number[]) {
  const ids = Array.from(new Set(tlsInboundIds.map(Number).filter((id) => id > 0)));
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  return db.select().from(forwardRules).where(and(
    inArray(forwardRules.tlsInboundId, ids),
    eq(forwardRules.pendingDelete, false),
  ));
}

export async function countSniRulesForInbound(tlsInboundId: number) {
  return (await getSniRulesForInbound(tlsInboundId)).length;
}

/** 这些名字在这个入站上分别归谁（排除 excludeRuleId 自己）。 */
export async function findSniNameOwners(tlsInboundId: number, names: readonly string[], excludeRuleId = 0) {
  const db = await getDb();
  if (!db || names.length === 0) return [] as Array<{ name: string; ruleId: number }>;
  const rows = await db.select({ name: ruleSniNames.name, ruleId: ruleSniNames.ruleId })
    .from(ruleSniNames)
    .where(and(eq(ruleSniNames.tlsInboundId, Number(tlsInboundId)), inArray(ruleSniNames.name, [...names])));
  return (rows as any[])
    .map((row) => ({ name: String(row.name), ruleId: Number(row.ruleId) }))
    .filter((row) => row.ruleId !== Number(excludeRuleId || 0));
}

/**
 * 表还不在（只建了部分表的老库 / 测试库）。删规则、删主机、查端口这些老路径不能因为新功能的表缺了就失败。
 */
function isMissingTableError(error: unknown) {
  const code = String((error as any)?.code || "");
  const message = String((error as any)?.message || error || "");
  return code === "ER_NO_SUCH_TABLE" || code === "42P01"
    || /no such table|doesn't exist|does not exist/i.test(message);
}

async function tolerateMissingTable<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isMissingTableError(error)) return fallback;
    throw error;
  }
}

export function isUniqueViolation(error: unknown) {
  const code = String((error as any)?.code || "");
  const message = String((error as any)?.message || error || "");
  return code === "ER_DUP_ENTRY"
    || code === "23505"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || /UNIQUE constraint failed|Duplicate entry|duplicate key value/i.test(message);
}

/**
 * 把一条规则在侧表里的名字整份换掉。tlsInboundId 为空就是全删（规则改回普通端口或被删掉）。
 * 撞了唯一索引说明名字刚被别人抢走了，抛统一的冲突提示 —— 外面的事务随之回滚。
 */
export async function replaceRuleSniNames(ruleId: number, tlsInboundId: number | null, names: readonly string[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(ruleSniNames).where(eq(ruleSniNames.ruleId, Number(ruleId)));
  if (!tlsInboundId || names.length === 0) return;
  try {
    for (const name of names) {
      await insertAndGetId("rule_sni_names", {
        tlsInboundId: Number(tlsInboundId),
        name,
        ruleId: Number(ruleId),
        createdAt: nowDate(),
      });
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error(TLS_INBOUND_SNI_CONFLICT_MESSAGE);
    throw error;
  }
}

/** 规则删掉（或标记待删）时放掉它占的名字。 */
export async function releaseRuleSniNames(ruleId: number) {
  const db = await getDb();
  if (!db || !(Number(ruleId) > 0)) return;
  await tolerateMissingTable(async () => { await db.delete(ruleSniNames).where(eq(ruleSniNames.ruleId, Number(ruleId))); }, undefined);
}

/** 这台机器上共享入站占的端口（停用的也算：它的规则还挂着，随时会被重新启用）。 */
export async function getTlsInboundPortsOnHost(hostId: number, excludeInboundId = 0): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await tolerateMissingTable(
    async () => db.select({ id: hostTlsInbounds.id, port: hostTlsInbounds.port })
      .from(hostTlsInbounds)
      .where(eq(hostTlsInbounds.hostId, Number(hostId))) as Promise<any[]>,
    [] as any[],
  );
  return (rows as any[])
    .filter((row) => !excludeInboundId || Number(row.id) !== Number(excludeInboundId))
    .map((row) => Number(row.port))
    .filter((port) => port > 0);
}
