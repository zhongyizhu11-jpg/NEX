import crypto from "node:crypto";
import type { Pool } from "mysql2/promise";
import { quoteIdentifierFor } from "./dbRuntime";
import type Database from "better-sqlite3";
import type pg from "pg";
import { getDatabaseKind, getPool, getPostgresPool, getSqlite } from "./dbRuntime";

export type ColumnType = "id" | "text" | "longtext" | "varchar" | "int" | "bigint" | "bool" | "epoch";

export type ColumnDef = {
  name: string;
  type: ColumnType;
  notNull?: boolean;
  default?: string | number | boolean | null | "now";
  length?: number;
};

export type TableDef = {
  name: string;
  columns: ColumnDef[];
  unique?: string[][];
  indexes?: string[][];
};

const c = (name: string, type: ColumnType, opts: Omit<ColumnDef, "name" | "type"> = {}): ColumnDef => ({ name, type, ...opts });

export const MIGRATION_TABLES = [
  "users",
  "hosts",
  "host_groups",
  "host_group_members",
  "tunnels",
  "tunnel_exit_nodes",
  "tunnel_hops",
  "forward_rule_tunnel_exits",
  "forward_rules",
  "forward_groups",
  "forward_group_members",
  "forward_group_events",
  "forward_rule_route_events",
  "proxy_nodes",
  "proxy_inbounds",
  "proxy_inbound_users",
  "proxy_sub_tokens",
  "proxy_node_shares",
  "host_metrics",
  "host_traffic_counters",
  "user_traffic_counters",
  "forward_rule_traffic_counters",
  "traffic_stats",
  "traffic_stat_buckets",
  "agent_traffic_reports",
  "tunnel_latency_stats",
  "forward_group_latency_stats",
  "host_probe_services",
  "host_probe_service_stats",
  "ip_geo_cache",
  "agent_tokens",
  "tcping_stats",
  "forward_tests",
  "user_host_permissions",
  "user_tunnel_permissions",
  "user_forward_group_permissions",
  "system_settings",
  "payment_orders",
  "subscription_plans",
  "subscription_plan_hosts",
  "subscription_plan_tunnels",
  "subscription_plan_forward_groups",
  "subscription_plan_proxy_nodes",
  "subscription_plan_prices",
  "subscription_plan_traffic_addons",
  "user_subscriptions",
  "user_traffic_addons",
  "balance_transactions",
  "traffic_billing_configs",
  "traffic_billing_records",
  "traffic_billing_usage",
  "traffic_billing_rule_usage",
  "user_traffic_billing_permissions",
  "redemption_codes",
  "discount_codes",
  "discount_code_plans",
  "announcements",
  "announcement_reads",
  "plugins",
  "plugin_store_sources",
  "plugin_assets",
  "plugin_agent_states",
  "config_audit_events",
] as const;

const LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER = "last-auto-traffic-reset-backfill-v1";

function backfillSqliteLastAutoTrafficReset(sqlite: Database.Database) {
  const migrate = sqlite.transaction(() => {
    const claimed = sqlite.prepare(
      "INSERT OR IGNORE INTO system_settings (key, value, updatedAt) VALUES (?, '1', unixepoch())",
    ).run(LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER);
    if (claimed.changes === 0) return;
    sqlite.exec(
      'UPDATE "users" SET "lastAutoTrafficReset" = "lastTrafficReset" WHERE "lastAutoTrafficReset" IS NULL AND "lastTrafficReset" IS NOT NULL',
    );
  });
  migrate();
}

async function backfillMysqlLastAutoTrafficReset(pool: Pool) {
  const [rows] = await pool.query<any[]>(
    "SELECT `key` FROM `system_settings` WHERE `key` = ? LIMIT 1",
    [LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER],
  );
  if (rows.length > 0) return;
  await pool.query(
    'UPDATE `users` SET `lastAutoTrafficReset` = `lastTrafficReset` WHERE `lastAutoTrafficReset` IS NULL AND `lastTrafficReset` IS NOT NULL',
  );
  await pool.execute(
    "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, '1', UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE `key` = `key`",
    [LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER],
  );
}

async function backfillPostgresqlLastAutoTrafficReset(pool: pg.Pool) {
  await pool.query(
    `WITH claimed AS (
       INSERT INTO "system_settings" ("key", value, "updatedAt")
       VALUES ($1, '1', EXTRACT(EPOCH FROM NOW())::INT)
       ON CONFLICT ("key") DO NOTHING
       RETURNING "key"
     )
     UPDATE "users"
     SET "lastAutoTrafficReset" = "lastTrafficReset"
     WHERE "lastAutoTrafficReset" IS NULL
       AND "lastTrafficReset" IS NOT NULL
       AND EXISTS (SELECT 1 FROM claimed)`,
    [LAST_AUTO_TRAFFIC_RESET_BACKFILL_MARKER],
  );
}

/*
  旧版本的隧道可能没有 secret，运行时会退回到从隧道/主机 id 推导的「密钥」，谁都算得出。
  每次启动把空 secret 补成随机值。这会让这些旧隧道的密钥变化，Agent 下次心跳会按新配置
  重新下发，属于预期行为。只改空值，所以重复执行是安全的。
*/
function newTunnelSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function backfillSqliteTunnelSecrets(sqlite: Database.Database) {
  const rows = sqlite.prepare('SELECT "id" FROM "tunnels" WHERE "secret" IS NULL OR "secret" = \'\'').all() as Array<{ id: number }>;
  const update = sqlite.prepare('UPDATE "tunnels" SET "secret" = ? WHERE "id" = ? AND ("secret" IS NULL OR "secret" = \'\')');
  for (const row of rows) update.run(newTunnelSecret(), row.id);
}

async function backfillMysqlTunnelSecrets(pool: Pool) {
  const [rows] = await pool.query<any[]>("SELECT `id` FROM `tunnels` WHERE `secret` IS NULL OR `secret` = ''");
  for (const row of rows) {
    await pool.execute("UPDATE `tunnels` SET `secret` = ? WHERE `id` = ? AND (`secret` IS NULL OR `secret` = '')", [newTunnelSecret(), row.id]);
  }
}

async function backfillPostgresqlTunnelSecrets(pool: pg.Pool) {
  const { rows } = await pool.query('SELECT "id" FROM "tunnels" WHERE "secret" IS NULL OR "secret" = \'\'');
  for (const row of rows) {
    await pool.query('UPDATE "tunnels" SET "secret" = $1 WHERE "id" = $2 AND ("secret" IS NULL OR "secret" = \'\')', [newTunnelSecret(), row.id]);
  }
}

const tables: TableDef[] = [
  {
    name: "users",
    columns: [
      c("id", "id"), c("username", "text", { notNull: true }), c("password", "text", { notNull: true }),
      c("name", "text"), c("email", "text"), c("emailVerified", "bool", { notNull: true, default: false }), c("emailVerifiedAt", "epoch"), c("displayRemark", "text"), c("avatar", "text"),
      c("avatarChangeDay", "varchar", { length: 16 }), c("avatarChangeCount", "int", { notNull: true, default: 0 }), c("role", "varchar", { length: 32, notNull: true, default: "user" }), c("accountEnabled", "bool", { notNull: true, default: true }),
      c("canAddRules", "bool", { notNull: true, default: false }), c("forwardAccessPauseReason", "varchar", { length: 64 }), c("maxRules", "int", { notNull: true, default: 0 }),
      c("maxProxyInbounds", "int", { notNull: true, default: 0 }), c("maxProxySubTokens", "int", { notNull: true, default: 0 }),
      // 可空：留空 = 跟随全局上限，0 = 一台都不许加（见 drizzle/schema.ts）。
      c("maxSelfServiceHosts", "int"),
      c("maxPorts", "int", { notNull: true, default: 0 }), c("allowedForwardTypes", "text"),
      c("allowForwardXTunnel", "bool", { notNull: true, default: false }), c("allowProxySubscription", "bool", { notNull: true, default: false }), c("gostRateLimitIn", "int", { notNull: true, default: 0 }),
      c("gostRateLimitOut", "int", { notNull: true, default: 0 }), c("maxConnections", "int", { notNull: true, default: 0 }),
      c("maxIPs", "int", { notNull: true, default: 0 }), c("balanceCents", "bigint", { notNull: true, default: 0 }),
      c("manualCanAddRules", "bool", { notNull: true, default: false }), c("manualMaxRules", "int", { notNull: true, default: 0 }),
      c("manualMaxProxyInbounds", "int", { notNull: true, default: 0 }), c("manualMaxProxySubTokens", "int", { notNull: true, default: 0 }),
      c("manualMaxPorts", "int", { notNull: true, default: 0 }), c("manualMaxConnections", "int", { notNull: true, default: 0 }),
      c("manualMaxIPs", "int", { notNull: true, default: 0 }), c("manualAllowForwardXTunnel", "bool", { notNull: true, default: false }), c("manualAllowProxySubscription", "bool", { notNull: true, default: false }),
      c("manualGostRateLimitIn", "int", { notNull: true, default: 0 }), c("manualGostRateLimitOut", "int", { notNull: true, default: 0 }),
      c("manualTrafficLimit", "bigint", { notNull: true, default: 0 }), c("manualExpiresAt", "epoch"),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("trafficUsed", "bigint", { notNull: true, default: 0 }),
      c("trafficBillingResetBytes", "bigint", { notNull: true, default: 0 }),
      c("expiresAt", "epoch"), c("trafficAutoReset", "bool", { notNull: true, default: false }),
      c("trafficResetDay", "int", { notNull: true, default: 1 }), c("lastTrafficReset", "epoch"), c("lastAutoTrafficReset", "epoch"),
      c("telegramId", "text"), c("telegramUsername", "text"), c("telegramFirstName", "text"), c("telegramLastName", "text"),
      c("telegramLinkedAt", "epoch"), c("telegramLastSeenAt", "epoch"), c("telegramAnnouncementSubscribed", "bool", { notNull: true, default: false }), c("telegramBindCode", "text"),
      c("telegramBindCodeExpiresAt", "epoch"), c("telegramLoginCode", "text"), c("telegramLoginCodeExpiresAt", "epoch"),
      c("twoFactorEnabled", "bool", { notNull: true, default: false }), c("twoFactorSecret", "text"), c("twoFactorEnabledAt", "epoch"),
      c("browserSessionToken", "text"), c("mobileSessionToken", "text"), c("telegramSessionToken", "text"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
      c("lastSignedIn", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["username"], ["telegramId"], ["telegramBindCode"], ["telegramLoginCode"]],
  },
  {
    name: "auth_sessions",
    columns: [
      c("id", "id"), c("sid", "varchar", { length: 80, notNull: true }), c("userId", "int", { notNull: true }),
      c("kind", "varchar", { length: 32, notNull: true, default: "browser" }), c("expiresAt", "epoch", { notNull: true }),
      c("revokedAt", "epoch"), c("revokeReason", "varchar", { length: 64 }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("lastSeenAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["sid"]],
    indexes: [["userId"], ["userId", "kind"], ["expiresAt"]],
  },
  {
    name: "hosts",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("ip", "text", { notNull: true }),
      c("ipv4", "text"), c("ipv6", "text"), c("hostType", "varchar", { length: 32, notNull: true, default: "slave" }),
      c("agentToken", "text"), c("entryIp", "text"), c("tunnelEntryIp", "text"), c("osInfo", "text"), c("cpuInfo", "text"),
      c("memoryTotal", "bigint"), c("agentVersion", "text"), c("fxpVersion", "varchar", { length: 64 }),
      c("mimicAvailable", "bool"), c("mimicVersion", "text"), c("mimicStatus", "varchar", { length: 64 }),
      c("mimicMessage", "text"), c("mimicCheckedAt", "epoch"),
      c("mimicRuntimeStatus", "varchar", { length: 32 }), c("mimicRuntimeMessage", "text"), c("mimicRuntimeCheckedAt", "epoch"),
      c("agentBootId", "varchar", { length: 128 }), c("agentBootedAt", "epoch"), c("agentProcessId", "int"), c("agentProcessStartedAt", "epoch"),
      c("agentLastReceivedRevision", "bigint", { notNull: true, default: 0 }), c("agentLastAppliedRevision", "bigint", { notNull: true, default: 0 }),
      c("agentLastReceivedHash", "varchar", { length: 64 }), c("agentLastAppliedHash", "varchar", { length: 64 }),
      c("agentRecoveryStartedAt", "epoch"), c("agentRecoveryCompletedAt", "epoch"),
      c("agentRecoveryExpected", "int", { notNull: true, default: 0 }), c("agentRecoveryReady", "int", { notNull: true, default: 0 }),
      c("agentUpgradeRequested", "bool", { notNull: true, default: false }),
      c("agentUpgradeTargetVersion", "text"), c("agentUpgradeReleaseVersion", "text"), c("agentUpgradeRequestedAt", "epoch"), c("purchasedAt", "epoch"), c("stoppedAt", "epoch"),
      c("billingCycleMonths", "int", { notNull: true, default: 1 }), c("billingMonth", "int", { notNull: true, default: 1 }),
      c("billingDay", "int", { notNull: true, default: 1 }), c("expiryHandling", "varchar", { length: 24, notNull: true, default: "none" }),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("trafficMeasureMode", "varchar", { length: 16, notNull: true, default: "both" }),
      c("telegramTrafficAlertEnabled", "bool", { notNull: true, default: false }), c("trafficAlertThresholdPercent", "int", { notNull: true, default: 20 }),
      c("telegramRenewalReminderEnabled", "bool", { notNull: true, default: false }), c("renewalReminderDays", "int", { notNull: true, default: 3 }),
      c("trafficAutoReset", "bool", { notNull: true, default: false }), c("trafficResetDay", "int", { notNull: true, default: 1 }),
      c("lastTrafficReset", "epoch"), c("ddnsEnabled", "bool", { notNull: true, default: false }), c("ddnsDomain", "text"),
      c("ddnsRecordType", "varchar", { length: 8, notNull: true, default: "A" }), c("ddnsIpVersion", "varchar", { length: 8, notNull: true, default: "ipv4" }),
      c("lastDdnsValue", "text"), c("lastDdnsAt", "epoch"), c("lastDdnsError", "text"), c("networkInterface", "text"), c("sortOrder", "int", { notNull: true, default: 0 }),
      c("geoCountryCode", "varchar", { length: 8 }), c("geoCountryName", "text"), c("geoRegion", "text"), c("geoEmoji", "varchar", { length: 16 }),
      c("geoLatitudeMicro", "int"), c("geoLongitudeMicro", "int"), c("geoUpdatedAt", "epoch"),
      // 手动指定位置的标记：自动定位见到它就绕开（hostGeo.ts）
      c("geoManual", "bool", { notNull: true, default: false }),
      // 「Agent 检测 IP」手改过：心跳不再覆盖 ip / ipv4 / ipv6（agentAddressState）
      c("addressManual", "bool", { notNull: true, default: false }),
      c("portRangeStart", "int"), c("portRangeEnd", "int"), c("portAllowlist", "text"),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }),
      c("isOnline", "bool", { notNull: true, default: false }),
      c("lastHeartbeat", "epoch"), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [
      ["userId"],
      ["userId", "sortOrder"],
      ["userId", "createdAt"],
      ["agentToken"],
      ["isOnline", "lastHeartbeat"],
    ],
  },
  {
    name: "host_groups",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("isEnabled", "bool", { notNull: true, default: true }),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId", "sortOrder"], ["userId", "createdAt"], ["isEnabled"]],
  },
  {
    name: "host_group_members",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("hostId", "int", { notNull: true }),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["groupId", "hostId"]],
    indexes: [["groupId", "sortOrder"], ["hostId"]],
  },
  {
    name: "forward_rules",
    columns: [
      c("id", "id"), c("hostId", "int", { notNull: true }), c("name", "text", { notNull: true }),
      c("forwardType", "varchar", { length: 32, notNull: true, default: "iptables" }), c("protocol", "varchar", { length: 16, notNull: true, default: "both" }),
      c("gostMode", "varchar", { length: 32, notNull: true, default: "direct" }), c("gostRelayHost", "text"), c("gostRelayPort", "int"),
      c("tunnelId", "int"), c("tunnelExitPort", "int"),
      c("forwardGroupId", "int"), c("forwardGroupRuleId", "int"), c("forwardGroupMemberId", "int"),
      c("isForwardGroupTemplate", "bool", { notNull: true, default: false }),
      c("sourcePort", "int", { notNull: true }), c("targetIp", "text", { notNull: true }),
      c("targetPort", "int", { notNull: true }),
      c("telegramErrorNotifyEnabled", "bool", { notNull: true, default: false }),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }),
      c("proxyProtocolReceive", "bool", { notNull: true, default: false }), c("proxyProtocolSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolExitReceive", "bool", { notNull: true, default: false }), c("proxyProtocolExitSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolVersion", "int", { notNull: true, default: 1 }),
      c("tcpFastOpen", "bool", { notNull: true, default: false }), c("zeroCopy", "bool", { notNull: true, default: false }),
      c("udpOverTcp", "bool", { notNull: true, default: false }),
      c("udpOverTcpPort", "int"),
      c("protocolBlockReason", "text"), c("isEnabled", "bool", { notNull: true, default: true }),
      c("failoverEnabled", "bool", { notNull: true, default: false }), c("failoverTargets", "text"),
      c("failoverProbeTarget", "text"),
      c("failoverSchedule", "text"),
      c("failoverMinHoldSeconds", "int", { notNull: true, default: 0 }),
      c("failoverPinnedIndex", "int"), c("failoverPinnedUntil", "epoch"),
      c("failoverPreferFastest", "bool", { notNull: true, default: false }),
      c("failoverActiveTarget", "text"), c("failoverActiveAt", "epoch"),
      c("failoverStrategy", "varchar", { length: 32, notNull: true, default: "fallback" }),
      c("failoverSeconds", "int", { notNull: true, default: 60 }), c("recoverSeconds", "int", { notNull: true, default: 120 }),
      c("autoFailback", "bool", { notNull: true, default: true }),
      c("routeMode", "varchar", { length: 24 }), c("routePaths", "text"),
      c("routeSwitchMode", "varchar", { length: 16, notNull: true, default: "smooth" }),
      c("routeFailureThreshold", "int", { notNull: true, default: 3 }),
      c("routeScoreMargin", "int", { notNull: true, default: 10 }), c("routeScoreHoldSeconds", "int", { notNull: true, default: 180 }),
      c("routePrewarmSeconds", "int", { notNull: true, default: 300 }),
      c("routeParentRuleId", "int"), c("routePathKey", "varchar", { length: 32 }), c("routeHopIndex", "int"),
      c("disabledByTunnel", "bool", { notNull: true, default: false }), c("disabledByGroup", "bool", { notNull: true, default: false }),
      c("disabledByUser", "bool", { notNull: true, default: false }),
      c("isRunning", "bool", { notNull: true, default: false }), c("pendingDelete", "bool", { notNull: true, default: false }),
      c("sortOrder", "int", { notNull: true, default: 0 }),
      c("proxyNodeId", "int"), c("proxyNodeVisible", "bool", { notNull: true, default: true }), c("proxyNodeName", "text"),
      // 规则专属域名（见 shared/ruleEntryDomain.ts）：entryDomainEnabled 是规则上的开关（缺省开，
      // 老规则不变）；后面几列记的是**实际发布出去的**域名和值，后缀改了、功能关了也能照着它把旧记录删掉。
      c("entryDomainEnabled", "bool", { notNull: true, default: true }),
      c("entryDomain", "varchar", { length: 255 }), c("entryDomainValue", "varchar", { length: 255 }),
      c("entryDomainAt", "epoch"), c("entryDomainError", "text"),
      c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["hostId"], ["hostId", "createdAt"], ["hostId", "sourcePort", "pendingDelete", "isEnabled"], ["userId"], ["userId", "sortOrder"], ["userId", "createdAt"], ["userId", "pendingDelete", "createdAt"], ["tunnelId"], ["forwardGroupId"], ["forwardGroupId", "isForwardGroupTemplate", "pendingDelete"], ["forwardGroupRuleId"], ["forwardGroupRuleId", "pendingDelete"], ["forwardGroupMemberId"], ["forwardGroupMemberId", "pendingDelete"], ["proxyNodeId"], ["userId", "proxyNodeId", "pendingDelete"], ["routeParentRuleId"], ["routeParentRuleId", "pendingDelete"]],
  },
  {
    /*
      待删除的规则专属域名。规则行被真正删掉（或不再需要域名、后缀改了）时，发布过的
      域名记到这里，删成功才去掉；删失败留着给定时对账重试。不进面板迁移：换库后规则
      ID 会重排，旧 ID 的清理对新库没有意义。
    */
    name: "rule_entry_domain_cleanups",
    columns: [
      c("id", "id"), c("domain", "varchar", { length: 255, notNull: true }), c("recordType", "varchar", { length: 8 }),
      c("ruleId", "int", { notNull: true }), c("attempts", "int", { notNull: true, default: 0 }), c("lastError", "text"),
      c("nextRetryAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["domain"]],
  },
  {
    // 客户端订阅的节点模板；与计费的 subscription_plans 无关，命名一律用 proxy 前缀。
    name: "proxy_nodes",
    columns: [
      c("id", "id"), c("userId", "int", { notNull: true }), c("name", "text", { notNull: true }), c("remark", "text"),
      // 对外标注：分享出去时对方看得到的那一句（remark 是自己看的，会被抹掉）。
      c("publicLabel", "text"),
      c("protocol", "varchar", { length: 32, notNull: true, default: "vless" }), c("sourceLink", "text"),
      c("address", "text", { notNull: true }), c("port", "int", { notNull: true }),
      c("uuid", "text"), c("password", "text"), c("method", "text"),
      c("alterId", "int", { notNull: true, default: 0 }), c("flow", "text"),
      c("transport", "varchar", { length: 16, notNull: true, default: "tcp" }), c("path", "text"), c("host", "text"),
      c("tls", "bool", { notNull: true, default: false }), c("sni", "text"), c("alpn", "text"), c("fingerprint", "text"),
      c("allowInsecure", "bool", { notNull: true, default: false }),
      c("realityPublicKey", "text"), c("realityShortId", "text"),
      c("udp", "bool", { notNull: true, default: true }),
      c("obfs", "text"), c("obfsPassword", "text"),
      c("congestionControl", "text"), c("udpRelayMode", "text"),
      c("disableSni", "bool", { notNull: true, default: false }),
      c("snellVersion", "int", { notNull: true, default: 0 }), c("snellMode", "text"), c("xhttpMode", "text"),
      c("autoGroup", "varchar", { length: 16, notNull: true, default: "url-test" }), c("includeDirect", "bool", { notNull: true, default: false }), c("frontProxyId", "int", { notNull: true, default: 0 }),
      c("inboundId", "int", { notNull: true, default: 0 }), c("inboundUserId", "int", { notNull: true, default: 0 }),
      // 落地机的套餐规格与用量：带宽与总流量人填，已用由面板累加。
      c("bandwidthMbps", "int", { notNull: true, default: 0 }),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }),
      c("trafficUsed", "bigint", { notNull: true, default: 0 }),
      c("trafficAutoReset", "bool", { notNull: true, default: false }),
      c("trafficResetDay", "int", { notNull: true, default: 1 }),
      c("lastTrafficReset", "epoch"),
      c("isEnabled", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    /*
      inboundId 这一条不能少：派生节点的每一次读写都按它过滤 —— 保存入站、
      删除入站、主机换地址后重算、界面上列出某个端口派生了哪几条。原来没有索引，
      这些全都是整表扫描，而一个商家几百上千行节点时，删一个入站要扫一遍全表。
    */
    indexes: [["userId"], ["userId", "sortOrder"], ["trafficAutoReset"], ["inboundId"]],
  },
  {
    // 落地入站：面板在自己管的主机上开出来的节点。Reality 私钥只存在这张表。
    name: "proxy_inbounds",
    columns: [
      c("id", "id"), c("userId", "int", { notNull: true }), c("hostId", "int", { notNull: true }),
      c("name", "text", { notNull: true }), c("remark", "text"), c("publicLabel", "text"),
      c("protocol", "varchar", { length: 32, notNull: true, default: "vless" }),
      c("port", "int", { notNull: true }),
      c("transport", "varchar", { length: 16, notNull: true, default: "tcp" }),
      c("security", "varchar", { length: 16, notNull: true, default: "reality" }),
      c("uuid", "text"), c("password", "text"), c("method", "text"), c("flow", "text"),
      c("path", "text"), c("host", "text"), c("xhttpMode", "text"),
      c("serverName", "text"), c("alpn", "text"), c("certPath", "text"), c("keyPath", "text"), c("acmeEmail", "text"),
      c("realityPrivateKey", "text"), c("realityPublicKey", "text"),
      c("realityShortId", "text"), c("realityDest", "text"),
      c("obfs", "text"), c("obfsPassword", "text"),
      c("upMbps", "int", { notNull: true, default: 0 }), c("downMbps", "int", { notNull: true, default: 0 }),
      c("congestionControl", "text"),
      c("snellVersion", "int", { notNull: true, default: 0 }), c("snellMode", "text"),
      c("clonedFromInboundId", "int", { notNull: true, default: 0 }),
      // 普通用户靠主机授权开在别人机器上的入站：授权收回后不再下发。
      c("hostGrantRequired", "bool", { notNull: true, default: false }),
      // 端口自己的额度与用量。计数链装在监听端口上，多用户入站分不到人头，所以记在这里。
      c("bandwidthMbps", "int", { notNull: true, default: 0 }),
      c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("trafficUsed", "bigint", { notNull: true, default: 0 }),
      c("trafficAutoReset", "bool", { notNull: true, default: false }),
      c("trafficResetDay", "int", { notNull: true, default: 1 }), c("lastTrafficReset", "epoch"),
      c("isEnabled", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"], ["hostId"], ["userId", "sortOrder"], ["hostId", "isEnabled"]],
  },
  {
    // 落地入站上的用户：一个入站给多个人各发一份凭据。
    name: "proxy_inbound_users",
    columns: [
      c("id", "id"), c("inboundId", "int", { notNull: true }),
      c("name", "text", { notNull: true }), c("uuid", "text"), c("password", "text"),
      c("sharedUserId", "int", { notNull: true, default: 0 }),
      c("sortOrder", "int", { notNull: true, default: 0 }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["inboundId"], ["inboundId", "sortOrder"]],
  },
  {
    // 订阅令牌：地址里带着全部节点凭据，所以令牌可单独吊销。
    name: "proxy_sub_tokens",
    columns: [
      c("id", "id"), c("userId", "int", { notNull: true }), c("name", "text", { notNull: true }),
      c("token", "varchar", { length: 64, notNull: true }),
      c("defaultFormat", "varchar", { length: 16, notNull: true, default: "base64" }),
      c("rulePreset", "varchar", { length: 24, notNull: true, default: "balanced" }),
      c("isEnabled", "bool", { notNull: true, default: true }),
      c("accessCount", "int", { notNull: true, default: 0 }), c("lastAccessAt", "epoch"),
      c("lastAccessIp", "text"), c("lastAccessUserAgent", "text"), c("expiresAt", "epoch"),
      // 被拒的那一次：光记成功回答不了「客户说更新不了」。
      c("lastFailureAt", "epoch"), c("lastFailureReason", "varchar", { length: 32 }),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["token"]],
    indexes: [["userId"]],
  },
  {
    // 节点分享：同一个节点出现在别人的订阅里，所有权不变。
    name: "proxy_node_shares",
    columns: [
      c("id", "id"), c("nodeId", "int", { notNull: true }), c("userId", "int", { notNull: true }),
      c("source", "varchar", { length: 16, notNull: true, default: "manual" }),
      c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["nodeId", "userId"]],
    indexes: [["userId"], ["nodeId"]],
  },
  {
    name: "forward_groups",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("remark", "text"), c("groupType", "varchar", { length: 32, notNull: true, default: "host" }),
      c("groupMode", "varchar", { length: 32, notNull: true, default: "failover" }), c("exitStrategy", "varchar", { length: 32, notNull: true, default: "round_robin" }), c("entryGroupId", "int"),
      c("forwardType", "varchar", { length: 32, notNull: true, default: "iptables" }), c("failoverRuntimeInheritanceEnabled", "bool", { notNull: true, default: false }), c("domain", "text"),
      c("recordType", "varchar", { length: 16, notNull: true, default: "A" }), c("sourcePort", "int", { notNull: true, default: 1 }),
      c("protocol", "varchar", { length: 16, notNull: true, default: "both" }), c("targetIp", "text", { notNull: true }),
      c("targetPort", "int", { notNull: true, default: 1 }), c("rateLimitMbps", "int", { notNull: true, default: 0 }),
      c("trafficMultiplier", "int", { notNull: true, default: 100 }),
      c("proxyProtocolReceive", "bool", { notNull: true, default: false }), c("proxyProtocolSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolExitReceive", "bool", { notNull: true, default: false }), c("proxyProtocolExitSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolVersion", "int", { notNull: true, default: 1 }),
      c("tcpFastOpen", "bool", { notNull: true, default: false }), c("zeroCopy", "bool", { notNull: true, default: false }),
      c("udpOverTcp", "bool", { notNull: true, default: false }), c("udpOverTcpPort", "int"),
      c("failoverEnabled", "bool", { notNull: true, default: false }), c("failoverTargets", "text"),
      c("failoverStrategy", "varchar", { length: 32, notNull: true, default: "fallback" }),
      c("failoverSeconds", "int", { notNull: true, default: 60 }),
      c("recoverSeconds", "int", { notNull: true, default: 120 }), c("chinaHealthCheckEnabled", "bool", { notNull: true, default: false }), c("chinaHealthCheckTarget", "text"),
      // Probe method for member health: "tcp" connects to a port, "ping" only
      // measures ICMP latency and needs no port.
      c("chinaHealthCheckMethod", "varchar", { length: 16, notNull: true, default: "tcp" }),
      c("telegramSwitchNotifyEnabled", "bool", { notNull: true, default: false }),
      c("ddnsAutoResolveEnabled", "bool", { notNull: true, default: true }), c("autoFailback", "bool", { notNull: true, default: true }),
      // Multi-front-VPS bandwidth aggregation. Off by default so existing entry
      // groups keep publishing one equal record per healthy member.
      c("bandwidthAggregationEnabled", "bool", { notNull: true, default: false }),
      c("bandwidthAggregationStrategy", "varchar", { length: 32, notNull: true, default: "capacity" }),
      c("bandwidthAggregationSlots", "int", { notNull: true, default: 8 }),
      c("bandwidthAggregationMinMembers", "int", { notNull: true, default: 1 }),
      c("isEnabled", "bool", { notNull: true, default: true }), c("activeMemberId", "int"), c("lastDdnsValue", "text"),
      c("lastDdnsAt", "epoch"), c("lastFailoverAt", "epoch"), c("lastStatus", "varchar", { length: 32, notNull: true, default: "unknown" }),
      c("lastMessage", "text"), c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["userId"], ["userId", "sortOrder"], ["userId", "createdAt"], ["isEnabled"], ["activeMemberId"], ["entryGroupId"]],
  },
  {
    name: "forward_group_members",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("memberType", "varchar", { length: 32, notNull: true }),
      c("hostId", "int"), c("tunnelId", "int"), c("connectHost", "text"), c("priority", "int", { notNull: true, default: 0 }), c("ruleId", "int"),
      // Declared uplink of this front VPS in Mbps (0 = unknown) and its manual
      // aggregation weight (0 = derive the weight from the strategy).
      c("bandwidthMbps", "int", { notNull: true, default: 0 }), c("aggregationWeight", "int", { notNull: true, default: 0 }),
      c("isEnabled", "bool", { notNull: true, default: true }), c("healthStatus", "varchar", { length: 32, notNull: true, default: "unknown" }),
      c("lastLatencyMs", "int"), c("chinaHealthStatus", "varchar", { length: 32, notNull: true, default: "unknown" }), c("chinaHealthLatencyMs", "int"), c("chinaHealthCheckedAt", "epoch"), c("failureSince", "epoch"), c("healthySince", "epoch"), c("lastCheckedAt", "epoch"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["groupId", "priority"], ["ruleId"], ["hostId"], ["tunnelId"]],
  },
  {
    name: "forward_group_events",
    columns: [
      c("id", "id"), c("groupId", "int", { notNull: true }), c("memberId", "int"),
      c("type", "varchar", { length: 32, notNull: true }), c("message", "text"),
      c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["groupId", "createdAt"], ["createdAt", "groupId"], ["memberId"]],
  },
  {
    name: "forward_rule_route_events",
    columns: [
      c("id", "id"), c("ruleId", "int", { notNull: true }), c("kind", "varchar", { length: 24, notNull: true }),
      c("fromKey", "varchar", { length: 32 }), c("toKey", "varchar", { length: 32 }),
      c("fromLabel", "text"), c("toLabel", "text"), c("reason", "text"),
      c("score", "int"), c("latencyMs", "int"),
      c("createdAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["ruleId", "createdAt"], ["createdAt"]],
  },
  {
    /*
      换隧道后旧入口的临时桥接（shared/ruleEntryBridge）：规则换到别的入口主机后，在旧入口的老端口
      上临时把流量转到规则当前的入口，等客户端刷新订阅。一条规则在一台主机上最多一条。
      runtimeTarget 记最近一次下发时的目标「地址:端口」，目标变了（规则又换了入口）就重新下发；
      isRunning 由 Agent 的状态上报写。到期即失效，调度器定期删掉。
      不进面板迁移（MIGRATION_TABLES）：它只活几个小时，而且记的是这个面板的主机、规则 id。
    */
    name: "forward_rule_entry_bridges",
    columns: [
      c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }),
      c("sourcePort", "int", { notNull: true }), c("protocol", "varchar", { length: 16, notNull: true, default: "both" }),
      c("isRunning", "bool", { notNull: true, default: false }), c("runtimeTarget", "text"),
      c("createdAt", "epoch", { notNull: true, default: "now" }), c("expiresAt", "epoch", { notNull: true }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["ruleId", "hostId"]],
    indexes: [["hostId", "expiresAt"], ["hostId", "sourcePort"], ["expiresAt"]],
  },
  {
    name: "tunnels",
    columns: [
      c("id", "id"), c("name", "text", { notNull: true }), c("entryGroupId", "int"), c("exitGroupId", "int"), c("entryHostId", "int", { notNull: true }),
      c("exitHostId", "int", { notNull: true }), c("mode", "varchar", { length: 32, notNull: true, default: "tls" }),
      c("relayMode", "varchar", { length: 16, notNull: true, default: "chain" }),
      c("forwardxVersion", "varchar", { length: 8, notNull: true, default: "v1" }), c("certDomain", "text"),
      c("certPem", "text"), c("certKeyPem", "text"),
      c("secret", "text"), c("listenPort", "int", { notNull: true }), c("mimicPort", "int", { notNull: true, default: 0 }),
      c("rateLimitMbps", "int", { notNull: true, default: 0 }),
      c("trafficMultiplier", "int", { notNull: true, default: 100 }),
      // Legacy columns retained for migration compatibility; runtime ignores them.
      c("trafficPaddingEnabled", "bool", { notNull: true, default: false }),
      c("trafficPaddingRatio", "int", { notNull: true, default: 0 }),
      c("trafficPaddingMaxMbps", "int", { notNull: true, default: 0 }),
      c("portRangeStart", "int"), c("portRangeEnd", "int"),
      c("networkType", "varchar", { length: 32, notNull: true, default: "public" }), c("connectHost", "text"),
      c("proxyProtocolReceive", "bool", { notNull: true, default: false }), c("proxyProtocolSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolExitReceive", "bool", { notNull: true, default: false }), c("proxyProtocolExitSend", "bool", { notNull: true, default: false }),
      c("proxyProtocolVersion", "int", { notNull: true, default: 1 }),
      c("tcpFastOpen", "bool", { notNull: true, default: false }), c("udpOverTcp", "bool", { notNull: true, default: false }),
      c("blockHttp", "bool", { notNull: true, default: false }), c("blockSocks", "bool", { notNull: true, default: false }),
      c("blockTls", "bool", { notNull: true, default: false }), c("loadBalanceEnabled", "bool", { notNull: true, default: false }),
      c("loadBalanceStrategy", "varchar", { length: 32, notNull: true, default: "round_robin" }),
      c("isEnabled", "bool", { notNull: true, default: true }), c("disabledByGroup", "bool", { notNull: true, default: false }),
      c("isRunning", "bool", { notNull: true, default: false }),
      c("lastLatencyMs", "int"), c("lastTestStatus", "text"), c("lastTestMessage", "text"), c("lastTestAt", "epoch"),
      c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }),
      c("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    indexes: [["entryGroupId"], ["exitGroupId"], ["entryHostId"], ["exitHostId"], ["userId"], ["userId", "sortOrder"], ["userId", "createdAt"]],
  },
  { name: "tunnel_exit_nodes", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seq", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("listenPort", "int", { notNull: true }), c("mimicPort", "int", { notNull: true, default: 0 }), c("connectHost", "text"), c("isEnabled", "bool", { notNull: true, default: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["tunnelId", "seq"]], indexes: [["tunnelId"], ["hostId"], ["hostId", "listenPort"]] },
  { name: "tunnel_hops", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seq", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("listenPort", "int", { notNull: true, default: 0 }), c("mimicPort", "int", { notNull: true, default: 0 }), c("connectHost", "text")], unique: [["tunnelId", "seq"]], indexes: [["tunnelId"], ["hostId"]] },
  { name: "forward_rule_tunnel_exits", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("exitNodeId", "int", { notNull: true }), c("exitSeq", "int", { notNull: true }), c("exitHostId", "int", { notNull: true }), c("tunnelExitPort", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["ruleId", "exitNodeId"], ["ruleId", "exitSeq"]], indexes: [["ruleId"], ["tunnelId"], ["exitHostId"], ["exitHostId", "tunnelExitPort"]] },
  { name: "host_metrics", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("cpuUsage", "int"), c("memoryUsage", "int"), c("memoryUsed", "bigint"), c("swapUsage", "int"), c("swapUsed", "bigint"), c("swapTotal", "bigint"), c("networkIn", "bigint"), c("networkOut", "bigint"), c("diskUsage", "int"), c("diskUsed", "bigint"), c("diskTotal", "bigint"), c("uptime", "bigint"), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["hostId", "recordedAt"], ["recordedAt", "hostId"]] },
  { name: "host_traffic_counters", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("lastSystemIn", "bigint"), c("lastSystemOut", "bigint"), c("lastDeltaIn", "bigint", { notNull: true, default: 0 }), c("lastDeltaOut", "bigint", { notNull: true, default: 0 }), c("lastReportedAt", "epoch"), c("resetAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["hostId"]], indexes: [["updatedAt"], ["lastReportedAt"]] },
  // 两张计数表的 connections 从不清零，用 BIGINT（老库的升级见 BIGINT_COLUMN_UPGRADES）。
  { name: "user_traffic_counters", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "bigint", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["userId"]], indexes: [["updatedAt"]] },
  { name: "forward_rule_traffic_counters", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "bigint", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["ruleId", "hostId"]], indexes: [["userId"], ["ruleId"], ["hostId"], ["updatedAt"]] },
  { name: "traffic_stats", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "recordedAt"], ["hostId", "recordedAt"], ["recordedAt", "ruleId"], ["recordedAt", "hostId"]] },
  { name: "traffic_stat_buckets", columns: [c("id", "id"), c("bucketStart", "epoch", { notNull: true }), c("bucketMinutes", "int", { notNull: true, default: 30 }), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("bytesIn", "bigint", { notNull: true, default: 0 }), c("bytesOut", "bigint", { notNull: true, default: 0 }), c("connections", "int", { notNull: true, default: 0 }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["bucketStart", "bucketMinutes", "ruleId", "hostId"]], indexes: [["userId", "bucketStart"], ["bucketStart", "userId"], ["bucketMinutes", "bucketStart"], ["bucketMinutes", "userId", "bucketStart"], ["bucketMinutes", "ruleId", "bucketStart"], ["bucketMinutes", "hostId", "bucketStart"], ["ruleId", "bucketStart"], ["hostId", "bucketStart"]] },
  { name: "agent_traffic_reports", columns: [c("id", "id"), c("hostId", "int", { notNull: true }), c("producerId", "varchar", { length: 128 }), c("reportId", "varchar", { length: 128, notNull: true }), c("receivedAt", "epoch", { notNull: true, default: "now" })], unique: [["hostId", "reportId"], ["hostId", "producerId"]], indexes: [["receivedAt"]] },
  { name: "tunnel_latency_stats", columns: [c("id", "id"), c("tunnelId", "int", { notNull: true }), c("seriesKey", "varchar", { length: 64 }), c("seriesLabel", "text"), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["tunnelId", "recordedAt"], ["tunnelId", "seriesKey", "recordedAt"], ["recordedAt", "tunnelId"]] },
  { name: "forward_group_latency_stats", columns: [c("id", "id"), c("groupId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["groupId", "recordedAt"], ["recordedAt", "groupId"]] },
  { name: "host_probe_services", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("method", "varchar", { length: 16, notNull: true, default: "tcping" }), c("targetIp", "text", { notNull: true }), c("targetPort", "int"), c("hostScope", "varchar", { length: 16, notNull: true, default: "all" }), c("hostIds", "text"), c("excludeHostIds", "text"), c("intervalSeconds", "int", { notNull: true, default: 30 }), c("isEnabled", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "sortOrder"], ["userId", "createdAt"], ["isEnabled"], ["hostScope"]] },
  { name: "host_probe_service_stats", columns: [c("id", "id"), c("serviceId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["serviceId", "recordedAt"], ["hostId", "recordedAt"], ["recordedAt", "serviceId"]] },
  { name: "ip_geo_cache", columns: [c("id", "id"), c("address", "varchar", { length: 253, notNull: true }), c("resolvedAddress", "varchar", { length: 64, notNull: true }), c("geoCountryCode", "varchar", { length: 8, notNull: true }), c("geoCountryName", "text"), c("geoRegion", "text"), c("geoEmoji", "varchar", { length: 16 }), c("geoLatitudeMicro", "int"), c("geoLongitudeMicro", "int"), c("provider", "varchar", { length: 32, notNull: true, default: "ipapi.co" }), c("fetchedAt", "epoch", { notNull: true, default: "now" }), c("expiresAt", "epoch", { notNull: true })], unique: [["address"]], indexes: [["resolvedAddress"], ["expiresAt"]] },
  { name: "agent_tokens", columns: [c("id", "id"), c("token", "text", { notNull: true }), c("hostId", "int"), c("description", "text"), c("isUsed", "bool", { notNull: true, default: false }), c("sortOrder", "int", { notNull: true, default: 0 }), c("userId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["token"]], indexes: [["userId"], ["userId", "sortOrder"]] },
  { name: "tcping_stats", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("latencyMs", "int"), c("isTimeout", "bool", { notNull: true, default: false }), c("probeCount", "int", { notNull: true, default: 1 }), c("probeSuccesses", "int", { notNull: true, default: 0 }), c("healthStatus", "varchar", { length: 16 }), c("healthPending", "bool", { notNull: true, default: false }), c("recordedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "recordedAt"], ["hostId", "recordedAt"], ["recordedAt", "ruleId"], ["recordedAt", "hostId"]] },
  { name: "forward_tests", columns: [c("id", "id"), c("ruleId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "pending" }), c("listenOk", "bool", { notNull: true, default: false }), c("targetReachable", "bool", { notNull: true, default: false }), c("forwardOk", "bool", { notNull: true, default: false }), c("latencyMs", "int"), c("message", "text"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["ruleId", "createdAt"], ["hostId", "status"], ["status", "createdAt"], ["status", "updatedAt"], ["updatedAt"]] },
  { name: "user_host_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "hostId"]], indexes: [["hostId"]] },
  { name: "user_tunnel_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "tunnelId"]], indexes: [["tunnelId"]] },
  { name: "user_forward_group_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("forwardGroupId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "forwardGroupId"]], indexes: [["forwardGroupId"]] },
  { name: "system_settings", columns: [c("key", "varchar", { length: 191, notNull: true }), c("value", "longtext"), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["key"]] },
  { name: "payment_orders", columns: [c("id", "id"), c("outTradeNo", "text", { notNull: true }), c("userId", "int", { notNull: true }), c("provider", "varchar", { length: 32, notNull: true }), c("paymentType", "varchar", { length: 32, notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "pending" }), c("subject", "text", { notNull: true }), c("amountCents", "bigint", { notNull: true }), c("currency", "varchar", { length: 16, notNull: true, default: "CNY" }), c("tradeNo", "text"), c("payUrl", "text"), c("qrCode", "text"), c("orderType", "varchar", { length: 32, notNull: true, default: "balance" }), c("planId", "int"), c("planDurationDays", "int"), c("subscriptionId", "int"), c("discountCodeId", "int"), c("discountConsumed", "bool", { notNull: true, default: false }), c("discountAmountCents", "bigint", { notNull: true, default: 0 }), c("clientIp", "text"), c("rawNotify", "text"), c("expiresAt", "epoch"), c("paidAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["outTradeNo"]], indexes: [["userId", "createdAt"], ["status", "createdAt"]] },
  { name: "subscription_plans", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("description", "text"), c("priceCents", "bigint", { notNull: true, default: 0 }), c("currency", "varchar", { length: 16, notNull: true, default: "CNY" }), c("durationDays", "int", { notNull: true, default: 30 }), c("portCount", "int", { notNull: true, default: 20 }), c("trafficLimit", "bigint", { notNull: true, default: 0 }), c("rateLimitMbps", "int", { notNull: true, default: 0 }), c("maxRules", "int", { notNull: true, default: 20 }), c("maxProxyInbounds", "int", { notNull: true, default: 0 }), c("maxProxySubTokens", "int", { notNull: true, default: 0 }), c("maxConnections", "int", { notNull: true, default: 2000 }), c("maxIPs", "int", { notNull: true, default: 10 }), c("allowProxySubscription", "bool", { notNull: true, default: false }), c("isActive", "bool", { notNull: true, default: true }), c("isStoreVisible", "bool", { notNull: true, default: true }), c("dedicatedProxyPort", "bool", { notNull: true, default: false }), c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })] },
  // 套餐的多周期定价：一个套餐挂一组「周期 → 价格」。空表示这个套餐只有它自己
  // 那一档（存量数据全是这样），所以升级不需要迁移任何东西。
  { name: "subscription_plan_prices", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("durationDays", "int", { notNull: true }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "durationDays"]], indexes: [["planId"]] },
  { name: "subscription_plan_hosts", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("hostId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "hostId"]] },
  { name: "subscription_plan_tunnels", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("tunnelId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "tunnelId"]] },
  { name: "subscription_plan_proxy_nodes", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("nodeId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "nodeId"]] },
  { name: "subscription_plan_forward_groups", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("forwardGroupId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["planId", "forwardGroupId"]], indexes: [["forwardGroupId"]] },
  { name: "subscription_plan_traffic_addons", columns: [c("id", "id"), c("planId", "int", { notNull: true }), c("trafficBytes", "bigint", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("isActive", "bool", { notNull: true, default: true }), c("sortOrder", "int", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["planId", "isActive"], ["planId", "sortOrder"]] },
  { name: "user_subscriptions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("status", "varchar", { length: 32, notNull: true, default: "active" }), c("source", "varchar", { length: 32, notNull: true, default: "admin" }), c("paymentOrderNo", "text"), c("planSnapshot", "text"), c("durationDays", "int"), c("portRangeStart", "int"), c("portRangeEnd", "int"), c("nextTrafficResetAt", "epoch"), c("lastTrafficResetAt", "epoch"), c("userDismissedAt", "epoch"), c("adminDismissedAt", "epoch"), c("startedAt", "epoch", { notNull: true, default: "now" }), c("expiresAt", "epoch"), c("autoRenew", "bool", { notNull: true, default: false }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "status", "expiresAt"], ["planId"], ["paymentOrderNo"]] },
  { name: "user_traffic_addons", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("subscriptionId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("addonId", "int"), c("trafficBytes", "bigint", { notNull: true, default: 0 }), c("priceCents", "bigint", { notNull: true, default: 0 }), c("source", "varchar", { length: 32, notNull: true, default: "user" }), c("status", "varchar", { length: 32, notNull: true, default: "active" }), c("operatorUserId", "int"), c("description", "text"), c("cycleResetAt", "epoch"), c("expiresAt", "epoch"), c("expiredAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "status", "expiresAt"], ["subscriptionId", "status"], ["addonId"]] },
  { name: "balance_transactions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("amountCents", "bigint", { notNull: true }), c("balanceAfterCents", "bigint", { notNull: true }), c("description", "text"), c("operatorUserId", "int"), c("paymentOrderNo", "text"), c("redemptionCodeId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "createdAt"], ["paymentOrderNo"]] },
  { name: "traffic_billing_configs", columns: [c("id", "id"), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("enabled", "bool", { notNull: true, default: true }), c("requiresPermission", "bool", { notNull: true, default: false }), c("description", "text"), c("pricePerGbCents", "bigint", { notNull: true, default: 0 }), c("pricePerGbMilliCents", "bigint", { notNull: true, default: 0 }), c("multiplier", "int", { notNull: true, default: 100 }), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["resourceType", "resourceId"]], indexes: [["enabled"], ["requiresPermission"]] },
  { name: "traffic_billing_records", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("bytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pricePerGbCents", "bigint", { notNull: true, default: 0 }), c("pricePerGbMilliCents", "bigint", { notNull: true, default: 0 }), c("multiplier", "int", { notNull: true, default: 100 }), c("amountCents", "bigint", { notNull: true, default: 0 }), c("balanceAfterCents", "bigint", { notNull: true, default: 0 }), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["userId", "createdAt"], ["resourceType", "resourceId", "createdAt"], ["ruleId", "createdAt"]] },
  { name: "traffic_billing_usage", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("totalBytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pendingMilliCents", "bigint", { notNull: true, default: 0 }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "resourceType", "resourceId"]], indexes: [["resourceType", "resourceId"]] },
  { name: "traffic_billing_rule_usage", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("ruleId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("totalBytes", "bigint", { notNull: true, default: 0 }), c("billedGb", "int", { notNull: true, default: 0 }), c("pendingMilliCents", "bigint", { notNull: true, default: 0 }), c("settled", "bool", { notNull: true, default: false }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["ruleId", "resourceType", "resourceId"]], indexes: [["userId", "resourceType", "resourceId"], ["resourceType", "resourceId"]] },
  { name: "user_traffic_billing_permissions", columns: [c("id", "id"), c("userId", "int", { notNull: true }), c("resourceType", "varchar", { length: 16, notNull: true }), c("resourceId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["userId", "resourceType", "resourceId"]], indexes: [["userId"], ["resourceType", "resourceId"]] },
  { name: "redemption_codes", columns: [c("id", "id"), c("code", "text", { notNull: true }), c("type", "varchar", { length: 32, notNull: true }), c("planId", "int"), c("durationDays", "int"), c("amountCents", "bigint", { notNull: true, default: 0 }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("isActive", "bool", { notNull: true, default: true }), c("usedByUserId", "int"), c("usedAt", "epoch"), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["isActive", "startsAt", "expiresAt", "usedAt"]] },
  { name: "discount_codes", columns: [c("id", "id"), c("code", "text", { notNull: true }), c("discountType", "varchar", { length: 32, notNull: true }), c("discountValue", "int", { notNull: true }), c("maxUses", "int", { notNull: true, default: 0 }), c("usedCount", "int", { notNull: true, default: 0 }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("isActive", "bool", { notNull: true, default: true }), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["code"]], indexes: [["isActive", "startsAt", "expiresAt", "usedCount"]] },
  { name: "discount_code_plans", columns: [c("id", "id"), c("discountCodeId", "int", { notNull: true }), c("planId", "int", { notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], unique: [["discountCodeId", "planId"]], indexes: [["planId"]] },
  // 下面这几列在 MySQL 上用 LONGTEXT：TEXT 只有 64KB，而公告正文、商店条目缓存、插件资产（上限 512KB，
  // 内置的地区白名单数据就有超过 64KB 的）、Agent 回来的 dataJson（256KB）都可能更大 —— 严格模式下
  // 写入直接报 Data too long，非严格模式下被悄悄截断。SQLite / PG 的 TEXT 没有这个上限。
  { name: "announcements", columns: [c("id", "id"), c("title", "text", { notNull: true }), c("content", "longtext", { notNull: true }), c("type", "varchar", { length: 32, notNull: true, default: "normal" }), c("targetVersion", "text"), c("isActive", "bool", { notNull: true, default: true }), c("startsAt", "epoch"), c("expiresAt", "epoch"), c("createdByUserId", "int"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], indexes: [["type", "isActive", "updatedAt"], ["type", "targetVersion", "isActive"]] },
  { name: "announcement_reads", columns: [c("id", "id"), c("announcementId", "int", { notNull: true }), c("userId", "int", { notNull: true }), c("dismissedAt", "epoch", { notNull: true, default: "now" })], unique: [["announcementId", "userId"]], indexes: [["userId", "announcementId"]] },
  { name: "plugins", columns: [c("id", "id"), c("pluginId", "varchar", { length: 128, notNull: true }), c("name", "text", { notNull: true }), c("version", "varchar", { length: 64, notNull: true, default: "0.0.0" }), c("description", "text"), c("author", "text"), c("homepage", "text"), c("repository", "text"), c("sourceType", "varchar", { length: 32, notNull: true, default: "github" }), c("sourceUrl", "text"), c("branch", "varchar", { length: 128 }), c("manifestPath", "text"), c("manifestJson", "text", { notNull: true }), c("permissionsJson", "text"), c("extensionPointsJson", "text"), c("status", "varchar", { length: 32, notNull: true, default: "disabled" }), c("trusted", "bool", { notNull: true, default: false }), c("installedAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" }), c("lastCheckedAt", "epoch"), c("latestVersion", "varchar", { length: 64 }), c("lastError", "text")], unique: [["pluginId"]], indexes: [["status"], ["sourceType"]] },
  { name: "plugin_store_sources", columns: [c("id", "id"), c("name", "text", { notNull: true }), c("repository", "text", { notNull: true }), c("branch", "varchar", { length: 128, notNull: true, default: "main" }), c("catalogPath", "text", { notNull: true, default: "forwardx-store.json" }), c("itemsJson", "longtext"), c("lastSyncedAt", "epoch"), c("lastError", "text"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["repository", "branch", "catalogPath"]], indexes: [["updatedAt"]] },
  { name: "plugin_assets", columns: [c("id", "id"), c("pluginId", "varchar", { length: 128, notNull: true }), c("path", "text", { notNull: true }), c("contentType", "varchar", { length: 128 }), c("size", "int", { notNull: true, default: 0 }), c("sha256", "varchar", { length: 64 }), c("content", "longtext"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["pluginId", "path"]], indexes: [["pluginId"]] },
  { name: "plugin_agent_states", columns: [c("id", "id"), c("pluginId", "varchar", { length: 128, notNull: true }), c("resourceViewId", "varchar", { length: 128, notNull: true }), c("hostId", "int", { notNull: true }), c("pluginVersion", "varchar", { length: 64 }), c("actionId", "varchar", { length: 128 }), c("groupId", "varchar", { length: 64 }), c("taskId", "varchar", { length: 64 }), c("status", "varchar", { length: 32, notNull: true, default: "idle" }), c("dataJson", "longtext"), c("output", "longtext"), c("error", "text"), c("startedAt", "epoch"), c("finishedAt", "epoch"), c("createdAt", "epoch", { notNull: true, default: "now" }), c("updatedAt", "epoch", { notNull: true, default: "now" })], unique: [["pluginId", "resourceViewId", "hostId"]], indexes: [["hostId"], ["pluginId", "resourceViewId"], ["groupId"]] },
  { name: "config_audit_events", columns: [c("id", "id"), c("resourceType", "varchar", { length: 32, notNull: true }), c("resourceId", "int", { notNull: true }), c("hostId", "int"), c("action", "varchar", { length: 32, notNull: true }), c("source", "varchar", { length: 64, notNull: true, default: "system" }), c("actorUserId", "int"), c("actorName", "text"), c("requestId", "varchar", { length: 64 }), c("requestPath", "text"), c("beforeJson", "text"), c("afterJson", "text"), c("diffJson", "text"), c("configHash", "varchar", { length: 64, notNull: true }), c("createdAt", "epoch", { notNull: true, default: "now" })], indexes: [["resourceType", "resourceId", "id"], ["hostId", "id"], ["actorUserId", "id"]] },
];

const seedSettings = [
  ["storeEnabled", "false"],
  ["registrationEnabled", "true"],
  ["homepageEnabled", "true"],
  ["homepageCustomEnabled", "false"],
  ["personalizationTheme", "ink"],
  ["personalizationPageTint", "grey"],
  ["personalizationCardStyle", "edge"],
  ["lookingGlassUserEnabled", "true"],
  ["allowMultiDeviceLogin", "false"],
  ["publicHostMonitorEnabled", "false"],
  ["publicHostMonitorPath", "dev"],
  ["publicHostMonitorTitle", ""],
  ["redemptionEnabled", "true"],
  ["discountEnabled", "true"],
  ["trafficBillingEnabled", "false"],
  ["pluginsEnabled", "false"],
  ["twoFactorEnabled", "false"],
  ["ddnsTtl", "60"],
  // 规则专属域名后缀，空 = 不开（见 server/ruleEntryDomain.ts）。
  ["ruleEntryDomainSuffix", ""],
  // 换隧道后旧入口临时桥接保留的小时数，0 为关闭（shared/ruleEntryBridge）。
  ["ruleSwitchBridgeHours", "1"],
] as const;

export function getDatabaseTableDefs(): readonly TableDef[] {
  return tables;
}

type SchemaKind = "mysql" | "sqlite" | "postgresql";

function defaultSql(kind: SchemaKind, value: ColumnDef["default"], columnType?: ColumnType) {
  if (value === undefined || value === null) return "";
  if (kind === "mysql" && (columnType === "text" || columnType === "longtext")) return "";
  if (value === "now") {
    if (kind === "mysql") return " DEFAULT (UNIX_TIMESTAMP())";
    if (kind === "postgresql") return " DEFAULT (EXTRACT(EPOCH FROM NOW())::INT)";
    return " DEFAULT (unixepoch())";
  }
  if (typeof value === "boolean") {
    return kind === "postgresql" ? ` DEFAULT ${value ? "TRUE" : "FALSE"}` : ` DEFAULT ${value ? 1 : 0}`;
  }
  if (typeof value === "number") return ` DEFAULT ${value}`;
  return ` DEFAULT '${String(value).replace(/'/g, "''")}'`;
}

function columnSql(kind: SchemaKind, column: ColumnDef, forAlter = false) {
  const name = quoteIdentifierFor(kind, column.name);
  if (column.type === "id") {
    if (forAlter) return "";
    if (kind === "mysql") return `${name} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`;
    if (kind === "postgresql") return `${name} BIGSERIAL PRIMARY KEY`;
    return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
  const type = kind === "sqlite"
    ? (column.type === "varchar" || column.type === "text" || column.type === "longtext" ? "TEXT" : "INTEGER")
    : kind === "postgresql"
      ? ({
        text: "TEXT",
        longtext: "TEXT",
        varchar: `VARCHAR(${column.length || 191})`,
        int: "INTEGER",
        bigint: "BIGINT",
        bool: "BOOLEAN",
        epoch: "INTEGER",
      } as Record<ColumnType, string>)[column.type]
    : ({
      text: "TEXT",
      longtext: "LONGTEXT",
      varchar: `VARCHAR(${column.length || 191})`,
      int: "INT",
      bigint: "BIGINT",
      bool: "BOOLEAN",
      epoch: "INT",
    } as Record<ColumnType, string>)[column.type];
  return `${name} ${type}${column.notNull ? " NOT NULL" : ""}${defaultSql(kind, column.default, column.type)}`;
}

/*
 * 这两张计数表的 connections 从建号起一直累加、从不清零，INT 撑到 21 亿就溢出：之后这个
 * 用户（这条规则）的每次流量上报都报 out of range，整批上报事务一起回滚。新库直接建成
 * BIGINT；老库上的列在这里升一次。
 *
 * 只在查到当前还是 INT 这类窄整型时才改 —— MySQL 的 MODIFY 和 PG 的 ALTER TYPE 都会重写整表，
 * 不能每次启动都来一遍。这里只列真正会累加溢出的列，不做通用的「定义是 bigint 就升」，
 * 免得某张历史大表的类型漂移在某次升级时悄悄变成一次长时间锁表。
 */
const BIGINT_COLUMN_UPGRADES: ReadonlyArray<readonly [string, string]> = [
  ["user_traffic_counters", "connections"],
  ["forward_rule_traffic_counters", "connections"],
];
const NARROW_INTEGER_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer"]);

function bigintUpgradeTargets(rows: unknown) {
  const targets: Array<{ table: string; column: ColumnDef }> = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const table = String((row as any)?.tableName ?? "");
    const columnName = String((row as any)?.columnName ?? "");
    if (!NARROW_INTEGER_TYPES.has(String((row as any)?.dataType ?? "").toLowerCase())) continue;
    if (!BIGINT_COLUMN_UPGRADES.some(([t, col]) => t === table && col === columnName)) continue;
    const column = tables.find((t) => t.name === table)?.columns.find((col) => col.name === columnName);
    if (column?.type === "bigint") targets.push({ table, column });
  }
  return targets;
}

async function upgradeMysqlBigintColumns(pool: Pool) {
  const [rows] = await pool.query<any[]>(
    "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME IN (?)",
    [BIGINT_COLUMN_UPGRADES.map(([table]) => table), BIGINT_COLUMN_UPGRADES.map(([, column]) => column)],
  );
  for (const { table, column } of bigintUpgradeTargets(rows)) {
    // columnSql 带上原来的 NOT NULL DEFAULT 0，MODIFY 不会把约束弄丢。
    await pool.query(`ALTER TABLE ${quoteIdentifierFor("mysql", table)} MODIFY COLUMN ${columnSql("mysql", column, true)}`);
  }
}

async function upgradePostgresqlBigintColumns(pool: pg.Pool) {
  const result = await pool.query(
    'SELECT table_name AS "tableName", column_name AS "columnName", data_type AS "dataType" FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[]) AND column_name = ANY($2::text[])',
    [BIGINT_COLUMN_UPGRADES.map(([table]) => table), BIGINT_COLUMN_UPGRADES.map(([, column]) => column)],
  );
  for (const { table, column } of bigintUpgradeTargets(result?.rows)) {
    // PG 改类型时 NOT NULL 和 DEFAULT 原样保留。
    await pool.query(`ALTER TABLE ${quoteIdentifierFor("postgresql", table)} ALTER COLUMN ${quoteIdentifierFor("postgresql", column.name)} TYPE BIGINT`);
  }
}

function mysqlKey(table: string, prefix: string, cols: string[]) {
  const name = quoteIdentifierFor("mysql", `${prefix}_${table}_${cols.join("_")}`.slice(0, 60));
  const expr = cols.map((col) => {
    const def = tables.find((t) => t.name === table)?.columns.find((c) => c.name === col);
    const q = quoteIdentifierFor("mysql", col);
    return def?.type === "text" || def?.type === "longtext" ? `${q}(191)` : q;
  }).join(", ");
  return { name, expr };
}

async function ensureMysqlSchema(pool: Pool) {
  for (const table of tables) {
    const columns = table.columns.map((column) => columnSql("mysql", column)).filter(Boolean);
    const unique = (table.unique || []).map((cols) => {
      const key = mysqlKey(table.name, "uniq", cols);
      return `UNIQUE KEY ${key.name} (${key.expr})`;
    });
    const indexes = (table.indexes || []).map((cols) => {
      const key = mysqlKey(table.name, "idx", cols);
      return `KEY ${key.name} (${key.expr})`;
    });
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifierFor("mysql", table.name)} (${[...columns, ...unique, ...indexes].join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    for (const column of table.columns) {
      if (column.type === "id") continue;
      await pool.query(`ALTER TABLE ${quoteIdentifierFor("mysql", table.name)} ADD COLUMN ${columnSql("mysql", column, true)}`).catch(() => undefined);
      if (column.type === "longtext") {
        const definition = columnSql("mysql", column, true);
        await pool.query(`ALTER TABLE ${quoteIdentifierFor("mysql", table.name)} MODIFY COLUMN ${definition}${column.notNull ? "" : " NULL"}`);
      }
    }
    for (const cols of [...(table.indexes || []), ...(table.unique || [])]) {
      const uniquePrefix = (table.unique || []).some((u) => u.join("|") === cols.join("|")) ? "uniq" : "idx";
      const key = mysqlKey(table.name, uniquePrefix, cols);
      await pool.query(`ALTER TABLE ${quoteIdentifierFor("mysql", table.name)} ADD ${uniquePrefix === "uniq" ? "UNIQUE " : ""}INDEX ${key.name} (${key.expr})`).catch(() => undefined);
    }
  }
  await upgradeMysqlBigintColumns(pool);
  for (const [key, value] of seedSettings) {
    await pool.execute(
      "INSERT INTO system_settings (`key`, value, updatedAt) VALUES (?, ?, UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE `key` = `key`",
      [key, value],
    );
  }
  await backfillMysqlLastAutoTrafficReset(pool);
  await backfillMysqlTunnelSecrets(pool);
}

function indexName(prefix: string, table: string, cols: string[]) {
  return `${prefix}_${table}_${cols.join("_")}`.slice(0, 60);
}

async function ensurePostgresqlSchema(pool: pg.Pool) {
  for (const table of tables) {
    const columns = table.columns.map((column) => columnSql("postgresql", column)).filter(Boolean);
    const unique = (table.unique || []).map((cols) => `UNIQUE (${cols.map((col) => quoteIdentifierFor("postgresql", col)).join(", ")})`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifierFor("postgresql", table.name)} (${[...columns, ...unique].join(", ")})`,
    );
    for (const column of table.columns) {
      if (column.type === "id") continue;
      await pool.query(`ALTER TABLE ${quoteIdentifierFor("postgresql", table.name)} ADD COLUMN ${columnSql("postgresql", column, true)}`).catch(() => undefined);
    }
    for (const cols of table.indexes || []) {
      const name = quoteIdentifierFor("postgresql", indexName("idx", table.name, cols));
      await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${quoteIdentifierFor("postgresql", table.name)} (${cols.map((col) => quoteIdentifierFor("postgresql", col)).join(", ")})`).catch(() => undefined);
    }
    for (const cols of table.unique || []) {
      const name = quoteIdentifierFor("postgresql", indexName("uniq", table.name, cols));
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${quoteIdentifierFor("postgresql", table.name)} (${cols.map((col) => quoteIdentifierFor("postgresql", col)).join(", ")})`).catch(() => undefined);
    }
  }
  await upgradePostgresqlBigintColumns(pool);
  for (const [key, value] of seedSettings) {
    await pool.query(
      'INSERT INTO system_settings ("key", value, "updatedAt") VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::INT) ON CONFLICT ("key") DO NOTHING',
      [key, value],
    );
  }
  await backfillPostgresqlLastAutoTrafficReset(pool);
  await backfillPostgresqlTunnelSecrets(pool);
}

function ensureSqliteSchema(sqlite: Database.Database) {
  for (const table of tables) {
    const columns = table.columns.map((column) => columnSql("sqlite", column)).filter(Boolean);
    const unique = (table.unique || []).map((cols) => `UNIQUE (${cols.map((col) => quoteIdentifierFor("sqlite", col)).join(", ")})`);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifierFor("sqlite", table.name)} (${[...columns, ...unique].join(", ")})`);
    for (const column of table.columns) {
      if (column.type === "id") continue;
      try {
        sqlite.exec(`ALTER TABLE ${quoteIdentifierFor("sqlite", table.name)} ADD COLUMN ${columnSql("sqlite", column, true)}`);
      } catch {
        // Column already exists.
      }
    }
    for (const cols of [...(table.indexes || []), ...(table.unique || [])]) {
      const uniquePrefix = (table.unique || []).some((u) => u.join("|") === cols.join("|")) ? "UNIQUE " : "";
      const indexName = quoteIdentifierFor("sqlite", `${uniquePrefix ? "uniq" : "idx"}_${table.name}_${cols.join("_")}`.slice(0, 60));
      sqlite.exec(`CREATE ${uniquePrefix}INDEX IF NOT EXISTS ${indexName} ON ${quoteIdentifierFor("sqlite", table.name)} (${cols.map((col) => quoteIdentifierFor("sqlite", col)).join(", ")})`);
    }
  }
  for (const [key, value] of seedSettings) {
    sqlite.prepare(
      "INSERT OR IGNORE INTO system_settings (key, value, updatedAt) VALUES (?, ?, unixepoch())",
    ).run(key, value);
  }
  backfillSqliteLastAutoTrafficReset(sqlite);
  backfillSqliteTunnelSecrets(sqlite);
}

export async function ensureDatabaseSchema(target?: Pool | pg.Pool | Database.Database) {
  if (target && "prepare" in target) {
    ensureSqliteSchema(target as Database.Database);
    return;
  }
  if (target && "getConnection" in target) {
    await ensureMysqlSchema(target as unknown as Pool);
    return;
  }
  if (target) {
    await ensurePostgresqlSchema(target as pg.Pool);
    return;
  }
  const kind = getDatabaseKind();
  if (kind === "sqlite") {
    const sqlite = getSqlite();
    if (!sqlite) throw new Error("SQLite database is not connected");
    ensureSqliteSchema(sqlite);
    return;
  }
  if (kind === "postgresql") {
    const pool = getPostgresPool();
    if (!pool) throw new Error("PostgreSQL database is not connected");
    await ensurePostgresqlSchema(pool);
    return;
  }
  const pool = getPool();
  if (!pool) throw new Error("MySQL database is not connected");
  await ensureMysqlSchema(pool);
}
