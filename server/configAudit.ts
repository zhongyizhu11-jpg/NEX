import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, max, or } from "drizzle-orm";
import { configAuditEvents } from "../drizzle/schema";
import { afterDatabaseCommit, getDb, insertAndGetId, isDatabaseTransactionActive } from "./dbRuntime";
import { invalidateAgentStableHeartbeatPlan } from "./agentHeartbeatGate";
import { deleteExpiredHistoryRows } from "./repositories/historyRetention";
import { quoteIdentifier } from "./dbCompat";

export type ConfigAuditContext = {
  actorUserId?: number | null;
  actorName?: string | null;
  source: string;
  requestId?: string | null;
  requestPath?: string | null;
};

type AuditResourceType = "host" | "tunnel" | "forward_rule" | "runtime";
type AuditAction = "create" | "update" | "delete" | "dispatch";

const auditContext = new AsyncLocalStorage<ConfigAuditContext>();
// certKeyPem（Nginx TLS 私钥）这类字段名里没有 private/secret，要单独列出 cert/pem/privkey 组合，
// 否则私钥会原样写进审计的 before/after/diff。
const SECRET_KEY = /(password|passwd|secret|token|private.?key|privkey|cert.?key|key.?pem|pem.?key|certificate|authorization|cookie|credential)/i;
const VOLATILE_KEYS = new Set([
  "createdAt", "updatedAt", "lastHeartbeat", "isOnline", "isRunning", "lastLatencyMs",
  "lastTestAt", "lastTestStatus", "lastTestMessage", "lastError", "trafficUsed",
  "lastDdnsValue", "lastDdnsAt", "lastDdnsError", "geoUpdatedAt", "mimicCheckedAt",
  "mimicMessage", "mimicStatus", "mimicRuntimeStatus", "mimicRuntimeMessage",
  "mimicRuntimeCheckedAt", "agentRecoveryStartedAt", "agentRecoveryCompletedAt",
  "agentRecoveryExpected", "agentRecoveryReady", "agentLastReceivedRevision",
  "agentLastAppliedRevision", "agentLastReceivedHash", "agentLastAppliedHash",
  // 规则专属域名是面板对 DNS 的簿记，和 Agent 跑的配置无关，不能让它改动配置摘要。
  "entryDomain", "entryDomainValue", "entryDomainAt", "entryDomainError",
]);

type SecretMode = "redact" | "hash" | "plain";

function normalize(value: any, omitVolatile = false, secretMode: SecretMode = "redact"): any {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalize(item, omitVolatile, secretMode));
  if (typeof value !== "object") return value;
  const result: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (omitVolatile && VOLATILE_KEYS.has(key)) continue;
    if (SECRET_KEY.test(key) && secretMode !== "plain") {
      result[key] = secretMode === "redact"
        ? "[REDACTED]"
        : `sha256:${createHash("sha256").update(JSON.stringify(normalize(value[key], false, "plain")) ?? "null").digest("hex")}`;
    } else {
      result[key] = normalize(value[key], omitVolatile, secretMode);
    }
  }
  return result;
}

function stableJson(value: any) {
  return JSON.stringify(normalize(value));
}

export function hashConfig(value: any) {
  return hashNormalizedConfig(normalizeConfigForHash(value));
}

/*
  hashConfig 拆成「规整」和「求摘要」两步单独导出：心跳每条下发动作既要算自己的
  configHash，又要拼进整批的 desiredStateHash。规整（递归排序键、给密钥字段求摘要）
  才是贵的那步，拆开后同一份规整结果可以两处复用，而摘要值和直接调 hashConfig 逐字节相同。
*/
export function normalizeConfigForHash(value: any) {
  return normalize(value, true, "hash");
}

export function hashNormalizedConfig(normalized: any) {
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function shouldAuditConfigPatch(value: Record<string, any> | null | undefined) {
  return !!value && Object.keys(value).some((key) => !VOLATILE_KEYS.has(key));
}

function buildDiff(before: any, after: any) {
  const left = normalize(before || {}, true, "plain") as Record<string, any>;
  const right = normalize(after || {}, true, "plain") as Record<string, any>;
  const diff: Record<string, { before: any; after: any }> = {};
  for (const key of Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort()) {
    const leftComparable = normalize({ [key]: left[key] }, false, "hash");
    const rightComparable = normalize({ [key]: right[key] }, false, "hash");
    if (JSON.stringify(leftComparable) !== JSON.stringify(rightComparable)) {
      diff[key] = {
        before: normalize({ [key]: left[key] }, false, "redact")[key] ?? null,
        after: normalize({ [key]: right[key] }, false, "redact")[key] ?? null,
      };
    }
  }
  return diff;
}

/**
 * requestId 来自客户端的 x-request-id 头，原样写进 VARCHAR(64) 的 requestId 列。
 * 超长时 PG 报 value too long —— 审计本身失败只记一条 warn，可它发生在 tunnels.create/update
 * 的事务里，PG 的事务一旦有语句失败就整个作废，后面的 COMMIT 只会回滚，用户的保存莫名失败。
 * 只留 [A-Za-z0-9._-]，截到 64 个字符；洗完是空的就当没传，退回随机 UUID。
 */
export function sanitizeAuditRequestId(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || undefined;
}

export function runWithConfigAuditContext<T>(context: Partial<ConfigAuditContext>, callback: () => T): T {
  return auditContext.run({
    source: context.source || "system",
    actorUserId: context.actorUserId || null,
    actorName: context.actorName || null,
    requestId: sanitizeAuditRequestId(context.requestId) || randomUUID(),
    requestPath: context.requestPath || null,
  }, callback);
}

export function currentConfigAuditContext() {
  return auditContext.getStore();
}

export async function recordConfigAuditEvent(input: {
  resourceType: AuditResourceType;
  resourceId: number;
  hostId?: number | null;
  action: AuditAction;
  before?: any;
  after?: any;
  source?: string;
}) {
  const resourceId = Math.floor(Number(input.resourceId || 0));
  if (resourceId <= 0) return 0;
  const before = normalize(input.before ?? null, true, "redact");
  const after = normalize(input.after ?? null, true, "redact");
  const diff = buildDiff(input.before, input.after);
  if (input.action === "update" && Object.keys(diff).length === 0) return 0;
  const context = currentConfigAuditContext();
  const row = {
    resourceType: input.resourceType,
    resourceId,
    hostId: Number(input.hostId || 0) > 0 ? Number(input.hostId) : null,
    action: input.action,
    source: input.source || context?.source || "system",
    actorUserId: context?.actorUserId || null,
    actorName: context?.actorName || null,
    requestId: context?.requestId || null,
    requestPath: context?.requestPath || null,
    beforeJson: input.before === undefined ? null : stableJson(before),
    afterJson: input.after === undefined ? null : stableJson(after),
    diffJson: stableJson(diff),
    configHash: hashConfig(input.after),
  };
  const write = async () => {
    try {
      const revision = await insertAndGetId("config_audit_events", row);
      if (input.action !== "dispatch") {
        const hostId = Number(input.hostId || 0);
        invalidateAgentStableHeartbeatPlan(hostId > 0 ? hostId : undefined);
      }
      return revision;
    } catch (error) {
      console.warn(`[ConfigAudit] write failed resource=${input.resourceType}:${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  };
  /*
   * 事务里的审计挪到提交之后再写。审计写失败本来只该记一条 warn，可在 PG 的事务里任何一条语句
   * 失败都会让整个事务作废（后面的语句全报 current transaction is aborted），调用方的配置改动
   * 也就跟着没了。运行时没有保存点的封装，而手写 SAVEPOINT 在同一事务里并发调用时会互相释放、
   * 回滚到别人的保存点，悄悄吞掉中间的语句。提交后再写：事务回滚了就不记（和原来一样），
   * 心跳计划的失效也落在数据真正可见之后。调用方都不用返回的 revision，事务里返回 0。
   */
  if (isDatabaseTransactionActive()) {
    await afterDatabaseCommit(async () => {
      await write();
    });
    return 0;
  }
  return write();
}

/*
  最新的配置版本 = 最新一条非 dispatch 审计的 id。dispatch 行远多于真正的改动（每台机器的期望
  状态一变就记一条，留 30 天），以前用 action <> 'dispatch' 倒序扫，要先跨过所有更新的 dispatch 行。
  现在按三种改动各取一次「这种 action 的最大 id」，每次都走 (action, id) 索引只读一行，再取最大。
*/
const CONFIG_REVISION_ACTIONS: AuditAction[] = ["create", "update", "delete"];

export async function latestConfigRevision() {
  const db = await getDb();
  if (!db) return 0;
  let latest = 0;
  for (const action of CONFIG_REVISION_ACTIONS) {
    const rows = await db.select({ id: configAuditEvents.id }).from(configAuditEvents)
      .where(eq(configAuditEvents.action, action as any)).orderBy(desc(configAuditEvents.id)).limit(1);
    latest = Math.max(latest, Number(rows[0]?.id || 0));
  }
  return latest;
}

export async function listRecentConfigAuditEvents(limit = 500) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(configAuditEvents).orderBy(desc(configAuditEvents.id)).limit(Math.min(2000, Math.max(1, limit)));
}

/**
 * 清掉 30 天前的「下发」审计行（action = 'dispatch'），其他种类一律不动。
 *
 * 每台机器的期望状态哈希一变就记一条 dispatch，量远大于真正的配置改动，而且从来不删。
 * 读这张表的地方里，latestConfigRevision 明确排除了 dispatch；Mimic 生命周期签名只看
 * forward_rule / tunnel 两种资源（dispatch 行的 resourceType 是 runtime）；只有
 * listRecentConfigAuditEvents（支持包里的最近记录）会带上它们，30 天足够排查。
 */
export async function pruneDispatchConfigAuditEvents(retainDays = 30) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = Math.floor((Date.now() - Math.max(1, retainDays) * 24 * 3600 * 1000) / 1000);
  return deleteExpiredHistoryRows("config_audit_events", "createdAt", cutoff, {
    // 标识符按方言加引号：MySQL 默认 sql_mode 下 "action" 会被当成字符串字面量。
    whereSql: `${quoteIdentifier("action")} = ?`,
    whereParams: ["dispatch"],
    orderColumn: "id",
  });
}

export type MimicLifecycleResource = {
  resourceType: "forward_rule" | "tunnel";
  resourceId: number;
};

const MIMIC_LIFECYCLE_FIELDS: Record<MimicLifecycleResource["resourceType"], readonly string[]> = {
  forward_rule: [
    "isEnabled", "disabledByTunnel", "disabledByGroup", "disabledByUser", "pendingDelete",
    "udpOverTcp", "forwardType", "protocol", "tunnelId", "hostId",
  ],
  tunnel: [
    "isEnabled", "disabledByGroup", "udpOverTcp", "mode", "forwardxVersion",
    "entryHostId", "exitHostId", "entryGroupId", "exitGroupId", "relayMode",
  ],
};

export async function getMimicLifecycleRevisionSignature(resources: MimicLifecycleResource[]) {
  const normalized = Array.from(new Map(resources
    .map((resource) => ({
      resourceType: resource.resourceType,
      resourceId: Math.floor(Number(resource.resourceId) || 0),
    }))
    .filter((resource) => resource.resourceId > 0)
    .map((resource) => [`${resource.resourceType}:${resource.resourceId}`, resource] as const)).values())
    .sort((left, right) => left.resourceType.localeCompare(right.resourceType) || left.resourceId - right.resourceId);
  if (normalized.length === 0) return "";

  const db = await getDb();
  if (!db) return normalized.map((resource) => `${resource.resourceType}:${resource.resourceId}:0`).join("|");

  const revisionByResource = new Map<string, number>();
  for (const resourceType of ["forward_rule", "tunnel"] as const) {
    const ids = normalized
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => resource.resourceId);
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const lifecycleChange = or(
        eq(configAuditEvents.action, "create" as any),
        eq(configAuditEvents.action, "delete" as any),
        ...MIMIC_LIFECYCLE_FIELDS[resourceType].map((field) => (
          like(configAuditEvents.diffJson, `%\"${field}\"%`)
        )),
      );
      const rows = await db.select({
        resourceType: configAuditEvents.resourceType,
        resourceId: configAuditEvents.resourceId,
        revision: max(configAuditEvents.id),
      }).from(configAuditEvents).where(and(
        eq(configAuditEvents.resourceType, resourceType as any),
        inArray(configAuditEvents.resourceId, chunk),
        lifecycleChange,
      )).groupBy(configAuditEvents.resourceType, configAuditEvents.resourceId);
      for (const row of rows) {
        revisionByResource.set(
          `${String(row.resourceType)}:${Number(row.resourceId)}`,
          Number(row.revision || 0),
        );
      }
    }
  }

  return normalized.map((resource) => (
    `${resource.resourceType}:${resource.resourceId}:${revisionByResource.get(`${resource.resourceType}:${resource.resourceId}`) || 0}`
  )).join("|");
}
