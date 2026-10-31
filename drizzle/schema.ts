import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import {
  bigint as mysqlBigint,
  boolean as mysqlBoolean,
  customType,
  int as mysqlInt,
  longtext as mysqlLongText,
  mysqlTable,
  serial as mysqlSerial,
  text as mysqlText,
  varchar as mysqlVarchar,
} from "drizzle-orm/mysql-core";
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import {
  bigint as pgBigint,
  bigserial as pgBigSerial,
  boolean as pgBoolean,
  customType as pgCustomType,
  integer as pgInteger,
  pgTable,
  text as pgText,
  varchar as pgVarchar,
} from "drizzle-orm/pg-core";

/**
 * MySQL schema for NEX.
 *
 * Notes:
 * - Time fields are stored as Unix epoch seconds to keep compatibility with the
 *   existing API shape. Drizzle maps them to JS Date values for application code.
 * - Booleans are mapped by mysql-core boolean() so app code stays clean.
 * - All `id` fields are auto-incrementing primary keys.
 */

export type DatabaseDialect = "mysql" | "sqlite" | "postgresql";

function readConfiguredDialect(): DatabaseDialect {
  const explicit = (process.env.DATABASE_TYPE || process.env.DB_TYPE || "").toLowerCase();
  if (explicit === "sqlite" || explicit === "mysql" || explicit === "postgresql" || explicit === "postgres" || explicit === "pg") {
    return explicit === "postgres" || explicit === "pg" ? "postgresql" : explicit;
  }
  const candidates = [
    process.env.DATABASE_CONFIG_PATH || "",
    process.env.DB_CONFIG_PATH || "",
    "/data/database.json",
    path.resolve(process.cwd(), "data", "database.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const type = String(parsed?.type || "").toLowerCase();
      if (type === "sqlite" || type === "mysql" || type === "postgresql" || type === "postgres" || type === "pg") {
        return type === "postgres" || type === "pg" ? "postgresql" : type;
      }
    } catch {
      // dbRuntime reports malformed config with a useful setup error.
    }
  }
  if (process.env.SQLITE_PATH && fs.existsSync(process.env.SQLITE_PATH)) return "sqlite";
  return "mysql";
}

export const SCHEMA_DIALECT: DatabaseDialect = readConfiguredDialect();
const isSqliteDialect = SCHEMA_DIALECT === "sqlite";
const isPostgresqlDialect = SCHEMA_DIALECT === "postgresql";

const table = (name: string, columns: any): any =>
  isSqliteDialect ? sqliteTable(name, columns) : isPostgresqlDialect ? pgTable(name, columns) : mysqlTable(name, columns);
const serial = (name: string): any =>
  isSqliteDialect
    ? sqliteInteger(name).primaryKey({ autoIncrement: true })
    : isPostgresqlDialect
      ? pgBigSerial(name, { mode: "number" }).primaryKey()
      : mysqlSerial(name);
const text = (name: string): any => (isSqliteDialect ? sqliteText(name) : isPostgresqlDialect ? pgText(name) : mysqlText(name));
const longtext = (name: string): any => (isSqliteDialect ? sqliteText(name) : isPostgresqlDialect ? pgText(name) : mysqlLongText(name));
const varchar = (name: string, config: { length: number }): any =>
  isSqliteDialect ? sqliteText(name) : isPostgresqlDialect ? pgVarchar(name, config) : mysqlVarchar(name, config);
const int = (name: string): any => (isSqliteDialect ? sqliteInteger(name) : isPostgresqlDialect ? pgInteger(name) : mysqlInt(name));
const boolean = (name: string): any =>
  isSqliteDialect ? sqliteInteger(name, { mode: "boolean" }) : isPostgresqlDialect ? pgBoolean(name) : mysqlBoolean(name);
const bigint = (name: string, config?: { mode?: "number" }): any =>
  isSqliteDialect ? sqliteInteger(name) : isPostgresqlDialect ? pgBigint(name, config as any) : mysqlBigint(name, config as any);
const nowDefault = () => (isSqliteDialect ? sql`(unixepoch())` : isPostgresqlDialect ? sql`(EXTRACT(EPOCH FROM NOW())::INT)` : sql`(UNIX_TIMESTAMP())`);

const mysqlEpoch = customType<{ data: Date; driverData: number | string | null }>({
  dataType() {
    return "int";
  },
  fromDriver(value) {
    if (value === null || value === undefined || value === "") return null as any;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null as any;
    return new Date(n * 1000);
  },
  toDriver(value) {
    if (!value) return null;
    return Math.floor(value.getTime() / 1000);
  },
});

const postgresEpoch = pgCustomType<{ data: Date; driverData: number | string | null }>({
  dataType() {
    return "int";
  },
  fromDriver(value) {
    if (value === null || value === undefined || value === "") return null as any;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null as any;
    return new Date(n * 1000);
  },
  toDriver(value) {
    if (!value) return null;
    return Math.floor(value.getTime() / 1000);
  },
});

const epoch = (name: string): any =>
  isSqliteDialect
    ? sqliteInteger(name, { mode: "timestamp" })
    : isPostgresqlDialect
      ? postgresEpoch(name)
    : mysqlEpoch(name);

export const users = table("users", {
  id: serial("id"),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name"),
  email: text("email"),
  emailVerified: boolean("emailVerified").notNull().default(false),
  emailVerifiedAt: epoch("emailVerifiedAt"),
  displayRemark: text("displayRemark"),
  avatar: text("avatar"),
  avatarChangeDay: varchar("avatarChangeDay", { length: 16 }),
  avatarChangeCount: int("avatarChangeCount").notNull().default(0),
  role: varchar("role", { length: 32 }).notNull().default("user"), // 'user' | 'admin'
  accountEnabled: boolean("accountEnabled").notNull().default(true),
  // ===== 权限控制 =====
  canAddRules: boolean("canAddRules").notNull().default(false), // 是否允许添加转发规则
  forwardAccessPauseReason: varchar("forwardAccessPauseReason", { length: 64 }),
  maxRules: int("maxRules").notNull().default(0),       // 最大规则条数，0 = 不限制
  maxPorts: int("maxPorts").notNull().default(0),       // 最大端口数，0 = 不限制（与 maxRules 相同概念，但可独立控制）
  // 自己能开几个落地节点（proxy_inbounds），0 = 不限制。
  // 与 maxRules 分开：转发和自建落地是两件事，租两个落地的人不一定只配两条转发。
  maxProxyInbounds: int("maxProxyInbounds").notNull().default(0),
  // 能生成几条订阅地址（proxy_sub_tokens），0 = 不限制。
  // 每条地址都是一份完整凭据，发出去就收不回来 —— 只能靠吊销那一条。
  maxProxySubTokens: int("maxProxySubTokens").notNull().default(0),
  /**
   * 自助能加几台机器。**留空 = 跟随系统设置里的全局上限，0 = 一台都不许加。**
   *
   * 特意做成可空，而不是学旁边几个「0 = 不限」：这是个数量字段，人填 0 就是想说
   * 「一台都不给他」。要是 0 当成「不限」，管理员想卡死某个人反而把他放开了；
   * 要是 0 当成「跟随全局」，他就根本没有办法卡死某一个人。两种都不对，只有
   * 「空」和「0」分开才说得清。
   */
  maxSelfServiceHosts: int("maxSelfServiceHosts"),
  // 允许使用的转发方式，逗号分隔，如 "iptables,realm,socat"；null 或空串 = 全部允许
  allowedForwardTypes: text("allowedForwardTypes"),
  allowForwardXTunnel: boolean("allowForwardXTunnel").notNull().default(false),
  // 是否允许使用客户端订阅（有效值，由手动授权与套餐授权合并得出）
  allowProxySubscription: boolean("allowProxySubscription").notNull().default(false),
  gostRateLimitIn: int("gostRateLimitIn").notNull().default(0),
  gostRateLimitOut: int("gostRateLimitOut").notNull().default(0),
  maxConnections: int("maxConnections").notNull().default(0),
  maxIPs: int("maxIPs").notNull().default(0),
  manualCanAddRules: boolean("manualCanAddRules").notNull().default(false),
  manualMaxRules: int("manualMaxRules").notNull().default(0),
  manualMaxProxyInbounds: int("manualMaxProxyInbounds").notNull().default(0),
  manualMaxProxySubTokens: int("manualMaxProxySubTokens").notNull().default(0),
  manualMaxPorts: int("manualMaxPorts").notNull().default(0),
  manualMaxConnections: int("manualMaxConnections").notNull().default(0),
  manualMaxIPs: int("manualMaxIPs").notNull().default(0),
  manualAllowForwardXTunnel: boolean("manualAllowForwardXTunnel").notNull().default(false),
  manualAllowProxySubscription: boolean("manualAllowProxySubscription").notNull().default(false),
  // 订阅设备数上限（有效值 / 手动值），0 = 不限。见 shared/proxySubDeviceLimit.ts。
  maxProxyDevices: int("maxProxyDevices").notNull().default(0),
  manualMaxProxyDevices: int("manualMaxProxyDevices").notNull().default(0),
  // 这个用户用哪份订阅模板（proxy_sub_templates.id）；0 = 看套餐，再看全局默认。
  proxySubTemplateId: int("proxySubTemplateId").notNull().default(0),
  // 管理员给这个用户写的自定义分流规则（前置），写法见 shared/proxySubCustomRules.ts。
  proxySubCustomRules: text("proxySubCustomRules"),
  manualGostRateLimitIn: int("manualGostRateLimitIn").notNull().default(0),
  manualGostRateLimitOut: int("manualGostRateLimitOut").notNull().default(0),
  // 转发突发（2.3.449）：峰值 Mbps 和能按峰值跑多少秒，0 = 不开。只在用户上手动设，见 shared/forwardRateLimit.ts。
  forwardBurstMbps: int("forwardBurstMbps").notNull().default(0),
  forwardBurstSeconds: int("forwardBurstSeconds").notNull().default(0),
  manualTrafficLimit: bigint("manualTrafficLimit", { mode: "number" }).notNull().default(0),
  manualExpiresAt: epoch("manualExpiresAt"),
  balanceCents: bigint("balanceCents", { mode: "number" }).notNull().default(0),
  // ===== 流量管理字段 =====
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),           // 流量额度（字节），0 = 不限制
  trafficUsed: bigint("trafficUsed", { mode: "number" }).notNull().default(0),             // 已用流量（字节）
  // 按量计费统计的显示基线；不修改按量计费累计/结算表。
  trafficBillingResetBytes: bigint("trafficBillingResetBytes", { mode: "number" }).notNull().default(0),
  expiresAt: epoch("expiresAt"),               // 到期时间，null = 永不过期
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false), // 月度自动重置开关
  trafficResetDay: int("trafficResetDay").notNull().default(1),     // 每月重置日（1-28）
  lastTrafficReset: epoch("lastTrafficReset"), // 上次重置时间
  // Automatic billing cycles use an independent marker so a manual reset
  // cannot suppress the scheduled reset for the same month.
  lastAutoTrafficReset: epoch("lastAutoTrafficReset"),
  telegramId: text("telegramId").unique(),
  telegramUsername: text("telegramUsername"),
  telegramFirstName: text("telegramFirstName"),
  telegramLastName: text("telegramLastName"),
  telegramLinkedAt: epoch("telegramLinkedAt"),
  telegramLastSeenAt: epoch("telegramLastSeenAt"),
  telegramAnnouncementSubscribed: boolean("telegramAnnouncementSubscribed").notNull().default(false),
  /** 布局偏好：null 跟随站点默认（设置 › 个性化 › 布局），"standard" / "compact" 自己定。见 shared/personalization.ts。 */
  uiLayout: varchar("uiLayout", { length: 16 }),
  telegramBindCode: text("telegramBindCode").unique(),
  telegramBindCodeExpiresAt: epoch("telegramBindCodeExpiresAt"),
  telegramLoginCode: text("telegramLoginCode").unique(),
  telegramLoginCodeExpiresAt: epoch("telegramLoginCodeExpiresAt"),
  twoFactorEnabled: boolean("twoFactorEnabled").notNull().default(false),
  twoFactorSecret: text("twoFactorSecret"),
  twoFactorEnabledAt: epoch("twoFactorEnabledAt"),
  // Google 登录（server/googleLoginService.ts）：Google 账号的 sub（永不变的用户 ID）、绑定时的邮箱、绑定时间。
  // 只按 sub 认人，邮箱只用来显示 —— Google 账号的邮箱是可以改的。
  googleSub: varchar("googleSub", { length: 191 }).unique(),
  googleEmail: text("googleEmail"),
  googleLinkedAt: epoch("googleLinkedAt"),
  // Discord 登录 / 通知（server/discordLoginService.ts、server/discordBot.ts）：Discord 用户 ID（雪花，永不变）、
  // 绑定时的用户名和邮箱（只用来显示）、绑定时间；discordDmBlockedAt = 最近一次私信被 Discord 拒收（对方关了私信）的时间。
  discordId: varchar("discordId", { length: 32 }).unique(),
  discordUsername: text("discordUsername"),
  discordEmail: text("discordEmail"),
  discordLinkedAt: epoch("discordLinkedAt"),
  discordDmBlockedAt: epoch("discordDmBlockedAt"),
  browserSessionToken: text("browserSessionToken"),
  mobileSessionToken: text("mobileSessionToken"),
  telegramSessionToken: text("telegramSessionToken"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
  lastSignedIn: epoch("lastSignedIn").notNull().default(nowDefault()),
  // ===== 邀请返利（shared/referral.ts） =====
  // 自己的邀请码：8 位、去掉易混字符；第一次打开「邀请返利」页才生成，没打开过的人是 null。
  inviteCode: varchar("inviteCode", { length: 32 }).unique(),
  // 邀请人：注册时凭邀请码绑定一次，用户侧接口改不了；管理员可以在用户管理里改 / 清。
  inviterId: int("inviterId"),
  // 绑定邀请人的时刻（注册时 / 管理员改的时候写，清掉时清空）。这之前下的单不返利；
  // 老数据是 null，按注册时刻算（见 billingRepository 的 creditReferralCommissionUnprotected）。
  inviterBoundAt: epoch("inviterBoundAt"),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const authSessions = table("auth_sessions", {
  id: serial("id"),
  sid: varchar("sid", { length: 80 }).notNull().unique(),
  userId: int("userId").notNull(),
  kind: varchar("kind", { length: 32 }).notNull().default("browser"),
  expiresAt: epoch("expiresAt").notNull(),
  revokedAt: epoch("revokedAt"),
  revokeReason: varchar("revokeReason", { length: 64 }),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  lastSeenAt: epoch("lastSeenAt").notNull().default(nowDefault()),
});
export type AuthSession = typeof authSessions.$inferSelect;
export type InsertAuthSession = typeof authSessions.$inferInsert;

export const hosts = table("hosts", {
  id: serial("id"),
  name: text("name").notNull(),
  // 整台主机的转发限速（2.3.449，Mbps，0 = 不限）：这台机器上所有用户的转发加起来共用一个桶。
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  /** 线路带宽（Mbps），负载均衡按它分连接。0 = 没填。 */
  lineBandwidthMbps: int("lineBandwidthMbps").notNull().default(0),
  ip: text("ip").notNull(),
  ipv4: text("ipv4"),
  ipv6: text("ipv6"),
  hostType: varchar("hostType", { length: 32 }).notNull().default("slave"), // 'master' | 'slave'
  agentToken: text("agentToken"),
  // 用户自定义的入口 IP/域名，为空时回退使用 ip
  entryIp: text("entryIp"),
  // 隧道链路使用的内网/专用入口地址（可选）
  tunnelEntryIp: text("tunnelEntryIp"),
  osInfo: text("osInfo"),
  cpuInfo: text("cpuInfo"),
  memoryTotal: bigint("memoryTotal", { mode: "number" }),
  agentVersion: text("agentVersion"),
  fxpVersion: varchar("fxpVersion", { length: 64 }),
  // Agent 2.2.227 起每次心跳上报：装着的 gost 运行时版本（例如 3.2.6-nex3）和它实测出来的能力
  // （JSON 数组，例如 ["ssEgress2022","ssEgressUdp"]），见 shared/ssEgress.ts。
  runtimeVersion: varchar("runtimeVersion", { length: 64 }),
  agentCapabilities: text("agentCapabilities"),
  mimicAvailable: boolean("mimicAvailable"),
  mimicVersion: text("mimicVersion"),
  mimicStatus: varchar("mimicStatus", { length: 64 }),
  mimicMessage: text("mimicMessage"),
  mimicCheckedAt: epoch("mimicCheckedAt"),
  mimicRuntimeStatus: varchar("mimicRuntimeStatus", { length: 32 }),
  mimicRuntimeMessage: text("mimicRuntimeMessage"),
  mimicRuntimeCheckedAt: epoch("mimicRuntimeCheckedAt"),
  agentBootId: varchar("agentBootId", { length: 128 }),
  agentBootedAt: epoch("agentBootedAt"),
  agentProcessId: int("agentProcessId"),
  agentProcessStartedAt: epoch("agentProcessStartedAt"),
  agentLastReceivedRevision: bigint("agentLastReceivedRevision", { mode: "number" }).notNull().default(0),
  agentLastAppliedRevision: bigint("agentLastAppliedRevision", { mode: "number" }).notNull().default(0),
  agentLastReceivedHash: varchar("agentLastReceivedHash", { length: 64 }),
  agentLastAppliedHash: varchar("agentLastAppliedHash", { length: 64 }),
  agentRecoveryStartedAt: epoch("agentRecoveryStartedAt"),
  agentRecoveryCompletedAt: epoch("agentRecoveryCompletedAt"),
  agentRecoveryExpected: int("agentRecoveryExpected").notNull().default(0),
  agentRecoveryReady: int("agentRecoveryReady").notNull().default(0),
  agentUpgradeRequested: boolean("agentUpgradeRequested").notNull().default(false),
  agentUpgradeTargetVersion: text("agentUpgradeTargetVersion"),
  agentUpgradeReleaseVersion: text("agentUpgradeReleaseVersion"),
  agentUpgradeRequestedAt: epoch("agentUpgradeRequestedAt"),
  purchasedAt: epoch("purchasedAt"),
  stoppedAt: epoch("stoppedAt"),
  // Host billing calendar. The legacy stoppedAt value remains the source of
  // truth; these fields only control optional automatic cycle extension.
  billingCycleMonths: int("billingCycleMonths").notNull().default(1),
  billingMonth: int("billingMonth").notNull().default(1),
  billingDay: int("billingDay").notNull().default(1),
  expiryHandling: varchar("expiryHandling", { length: 24 }).notNull().default("none"),
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  trafficMeasureMode: varchar("trafficMeasureMode", { length: 16 }).notNull().default("both"),
  // 流量故障转移（shared/hostTrafficPolicy.ts）：用到套餐流量的这个比例后暂停参与转发组 / 入口组 /
  // 出口组 / 多出口隧道。trafficFailoverExcluded 是按 host_traffic_counters 算出来的派生值，
  // 不改任何成员配置。
  trafficFailoverEnabled: boolean("trafficFailoverEnabled").notNull().default(false),
  trafficFailoverThresholdPercent: int("trafficFailoverThresholdPercent").notNull().default(100),
  trafficFailoverExcluded: boolean("trafficFailoverExcluded").notNull().default(false),
  // 节点维护：从所有线路和组的候选里拿掉（2.3.496）。
  maintenanceMode: boolean("maintenanceMode").notNull().default(false),
  maintenanceSince: epoch("maintenanceSince"),
  maintenanceNote: text("maintenanceNote"),
  // 主机公网出口整形（forwardx-fxp/link_shaper.go 的 egress）：off / auto / manual，
  // manual 时 egressMbps 是公网带宽上限（Mbit/s）。
  egressShapingMode: varchar("egressShapingMode", { length: 16 }).notNull().default("off"),
  egressMbps: int("egressMbps").notNull().default(0),
  // 内核快速转发（nftables flowtable，agent/flowtable_offload.go）：本机 iptables / nftables 规则和内核直通的
  // 连接建立后走 ingress 快速路径，流量改从 conntrack 计。只有管理员能开，默认关。
  flowOffload: boolean("flowOffload").notNull().default(false),
  hostStatusNotifyEnabled: boolean("hostStatusNotifyEnabled").notNull().default(true),
  ipWhitelistOnly: boolean("ipWhitelistOnly").notNull().default(false),
  telegramTrafficAlertEnabled: boolean("telegramTrafficAlertEnabled").notNull().default(false),
  trafficAlertThresholdPercent: int("trafficAlertThresholdPercent").notNull().default(20),
  telegramRenewalReminderEnabled: boolean("telegramRenewalReminderEnabled").notNull().default(false),
  renewalReminderDays: int("renewalReminderDays").notNull().default(3),
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false),
  trafficResetDay: int("trafficResetDay").notNull().default(1),
  lastTrafficReset: epoch("lastTrafficReset"),
  ddnsEnabled: boolean("ddnsEnabled").notNull().default(false),
  ddnsDomain: text("ddnsDomain"),
  ddnsRecordType: varchar("ddnsRecordType", { length: 8 }).notNull().default("A"),
  ddnsIpVersion: varchar("ddnsIpVersion", { length: 8 }).notNull().default("ipv4"),
  lastDdnsValue: text("lastDdnsValue"),
  lastDdnsAt: epoch("lastDdnsAt"),
  lastDdnsError: text("lastDdnsError"),
  networkInterface: text("networkInterface"),
  sortOrder: int("sortOrder").notNull().default(0),
  geoCountryCode: varchar("geoCountryCode", { length: 8 }),
  geoCountryName: text("geoCountryName"),
  geoRegion: text("geoRegion"),
  geoEmoji: varchar("geoEmoji", { length: 16 }),
  geoLatitudeMicro: int("geoLatitudeMicro"),
  geoLongitudeMicro: int("geoLongitudeMicro"),
  geoUpdatedAt: epoch("geoUpdatedAt"),
  /** 运营商 / ASN（AS13335）。NULL = 还没问过，"" = 问过、定位服务没给。 */
  geoAsn: varchar("geoAsn", { length: 16 }),
  geoIsp: text("geoIsp"),
  geoOrg: text("geoOrg"),
  /*
    位置是人手填的（见 hosts.setLocation）：为 true 时上面几列由用户说了算，
    按 IP 的自动定位不得覆盖 —— 机房 IP 段的库经常把香港机器放到深圳。
  */
  geoManual: boolean("geoManual").notNull().default(false),
  /*
    「Agent 检测 IP」是人手改的（shared/hostManualAddress）：为 true 时 ip / ipv4 / ipv6 由用户说了算，
    心跳上报的地址不再覆盖。
  */
  addressManual: boolean("addressManual").notNull().default(false),
  // ===== 端口区间限制 =====
  portRangeStart: int("portRangeStart"),  // 允许转发的起始端口，null = 不限制
  portRangeEnd: int("portRangeEnd"),      // 允许转发的结束端口，null = 不限制
  portAllowlist: text("portAllowlist"),    // 逗号分隔的额外允许端口
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
  isOnline: boolean("isOnline").notNull().default(false),
  lastHeartbeat: epoch("lastHeartbeat"),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Host = typeof hosts.$inferSelect;
export type InsertHost = typeof hosts.$inferInsert;

export const hostGroups = table("host_groups", {
  id: serial("id"),
  name: text("name").notNull(),
  isEnabled: boolean("isEnabled").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostGroup = typeof hostGroups.$inferSelect;
export type InsertHostGroup = typeof hostGroups.$inferInsert;

export const hostGroupMembers = table("host_group_members", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  hostId: int("hostId").notNull(),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type HostGroupMember = typeof hostGroupMembers.$inferSelect;
export type InsertHostGroupMember = typeof hostGroupMembers.$inferInsert;

export const forwardRules = table("forward_rules", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  name: text("name").notNull(),
  forwardType: varchar("forwardType", { length: 32 }).notNull().default("iptables"), // 'iptables' | 'realm' | 'socat'
  protocol: varchar("protocol", { length: 16 }).notNull().default("both"), // 'tcp' | 'udp' | 'both'
  gostMode: varchar("gostMode", { length: 32 }).notNull().default("direct"), // 'direct' | 'reverse'
  gostRelayHost: text("gostRelayHost"),
  gostRelayPort: int("gostRelayPort"),
  tunnelId: int("tunnelId"),
  tunnelExitPort: int("tunnelExitPort"),
  forwardGroupId: int("forwardGroupId"),
  forwardGroupRuleId: int("forwardGroupRuleId"),
  forwardGroupMemberId: int("forwardGroupMemberId"),
  isForwardGroupTemplate: boolean("isForwardGroupTemplate").notNull().default(false),
  sourcePort: int("sourcePort").notNull(),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort").notNull(),
  telegramErrorNotifyEnabled: boolean("telegramErrorNotifyEnabled").notNull().default(false),
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
  proxyProtocolReceive: boolean("proxyProtocolReceive").notNull().default(false),
  proxyProtocolSend: boolean("proxyProtocolSend").notNull().default(false),
  proxyProtocolExitReceive: boolean("proxyProtocolExitReceive").notNull().default(false),
  proxyProtocolExitSend: boolean("proxyProtocolExitSend").notNull().default(false),
  proxyProtocolVersion: int("proxyProtocolVersion").notNull().default(1),
  tcpFastOpen: boolean("tcpFastOpen").notNull().default(false),
  zeroCopy: boolean("zeroCopy").notNull().default(false),
  udpOverTcp: boolean("udpOverTcp").notNull().default(false),
  udpOverTcpPort: int("udpOverTcpPort"),
  protocolBlockReason: text("protocolBlockReason"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  failoverEnabled: boolean("failoverEnabled").notNull().default(false),
  failoverStrategy: varchar("failoverStrategy", { length: 32 }).notNull().default("fallback"),
  failoverTargets: text("failoverTargets"),
  // 主出站的健康探测目标（`地址:端口`，留空就探出站地址本身）。备用出站的探测目标
  // 存在 failoverTargets 的每一项里；主出站没地方放，所以单独一列。
  failoverProbeTarget: text("failoverProbeTarget"),
  // 时段表（JSON：{timezone, windows[]}）。某几个时段里优先走哪一条出站。
  failoverSchedule: text("failoverSchedule"),
  // 刚切过去之后至少待多久才允许按优先级切回；0 = 不限制。
  failoverMinHoldSeconds: int("failoverMinHoldSeconds").notNull().default(0),
  // 人工指定优先走第几条出站；null = 交回自动。到期时间 null = 一直钉着。
  failoverPinnedIndex: int("failoverPinnedIndex"),
  failoverPinnedUntil: epoch("failoverPinnedUntil"),
  // 按实测延迟自动择优（只在主备模式下生效）。
  failoverPreferFastest: boolean("failoverPreferFastest").notNull().default(false),
  /*
    Agent 当前实际在走的那条出站（`地址:端口`），随心跳上报。
    切换本身是数据面做的、毫秒级、不经面板，所以面板原先只能从日志里
    事后翻 —— 规则列表上看不出「这条现在走的是主线还是备线」，等于配了
    主备也不知道它有没有在起作用。这两列就是给列表用的。
  */
  failoverActiveTarget: text("failoverActiveTarget"),
  failoverActiveAt: epoch("failoverActiveAt"),
  failoverSeconds: int("failoverSeconds").notNull().default(60),
  recoverSeconds: int("recoverSeconds").notNull().default(120),
  autoFailback: boolean("autoFailback").notNull().default(true),
  /*
    线路组（一个入口 + 多条路径 + 一个调度策略）。
    routePaths 是唯一的真源：一个 JSON 数组，第 0 条是主线路，每条都可以带
    0～5 个中转主机（hops 存主机 id）和一个落地（为空就是规则本身的目标）。
    老的 failover* 列由它派生（shared/routeGroup.ts legacyFailoverFields），
    保存时一起写，这样没升级的 Agent 和旧代码照旧能跑。
    routeMode 为空表示这条规则还是老式主备，只有 failover* 列。
  */
  routeMode: varchar("routeMode", { length: 24 }),
  routePaths: text("routePaths"),
  // 切换时对旧连接怎么办：smooth 不动、fast 只在故障切换时断、force 每次都断。
  routeSwitchMode: varchar("routeSwitchMode", { length: 16 }).notNull().default("smooth"),
  // 连续失败几次才算这条线坏了（一次失败不切）。
  routeFailureThreshold: int("routeFailureThreshold").notNull().default(3),
  // 智能择优：评分高出多少、持续多久才切。
  routeScoreMargin: int("routeScoreMargin").notNull().default(10),
  routeScoreHoldSeconds: int("routeScoreHoldSeconds").notNull().default(180),
  // 计划切换提前多久预热并预检目标线路。
  routePrewarmSeconds: int("routePrewarmSeconds").notNull().default(300),
  // 线路定义：每条线路几层候选（shared/routeLines.ts）；空 = 由 routePaths 推。
  routeLines: text("routeLines"),
  // 备用怎么候着：cold / hot / aggregate / replicate。
  routeDelivery: varchar("routeDelivery", { length: 16 }).notNull().default("cold"),
  /*
    中转跳上自动生成的转发规则用这三列指回它属于哪条线路组规则的哪条路径
    的第几跳。它们不出现在列表、配额和流量统计里，随父规则一起改和删。
    故意不复用 forwardGroupRuleId / MemberId：那两列的完整性修复会把没有
    转发组的行当孤儿回收。
  */
  routeParentRuleId: int("routeParentRuleId"),
  routePathKey: varchar("routePathKey", { length: 32 }),
  routeHopIndex: int("routeHopIndex"),
  disabledByTunnel: boolean("disabledByTunnel").notNull().default(false),
  disabledByGroup: boolean("disabledByGroup").notNull().default(false),
  disabledByUser: boolean("disabledByUser").notNull().default(false),
  isRunning: boolean("isRunning").notNull().default(false),
  pendingDelete: boolean("pendingDelete").notNull().default(false),
  sortOrder: int("sortOrder").notNull().default(0),
  // 客户端订阅：绑定的节点模板，为空表示这条转发不进订阅
  proxyNodeId: int("proxyNodeId"),
  // 单个节点的显示开关，绑定了模板也可以临时不出现在订阅里
  proxyNodeVisible: boolean("proxyNodeVisible").notNull().default(true),
  // 覆盖自动生成的节点名，为空时按「入口主机 → 模板名」生成
  proxyNodeName: text("proxyNodeName"),
  /*
    规则专属域名（见 shared/ruleEntryDomain.ts 和 server/ruleEntryDomain.ts）：
    entryDomainEnabled 是规则对话框里的开关，关掉这条规则就不发域名、订阅直接用入口地址
    （不是每条转发都要域名）；缺省开着，老规则行为不变。
    entryDomain / entryDomainValue 是**实际发布出去的**域名和记录值，只有同步逻辑写。
    entryDomainValue 为空表示还没发布成功过，订阅照旧用入口主机地址。
  */
  entryDomainEnabled: boolean("entryDomainEnabled").notNull().default(true),
  entryDomain: varchar("entryDomain", { length: 255 }),
  entryDomainValue: varchar("entryDomainValue", { length: 255 }),
  entryDomainAt: epoch("entryDomainAt"),
  entryDomainError: text("entryDomainError"),
  /*
    共享 TLS 入站（shared/tlsInbound.ts）：tlsInboundId 不为空时这条规则没有自己的对外端口，
    按 sniNames（JSON 数组）里的名字从入站分过来；sourcePort 是面板分配的本机回环端口。
  */
  tlsInboundId: int("tlsInboundId"),
  sniNames: text("sniNames"),
  /*
    Shadowsocks 出口（shared/ssEgress.ts）：egressType = none | ss_host | ss_link。
    ss_host 指向 proxy_inbounds 里的一个 Shadowsocks 落地入站（凭据每次下发时从入站现取，轮换后自动跟上）；
    ss_link 是用户粘贴的外部链接，解析后的服务器 / 方法 / 密码用面板密钥加密存在 egressConfigJson 里。
  */
  egressType: varchar("egressType", { length: 16 }).notNull().default("none"),
  egressInboundId: int("egressInboundId"),
  egressConfigJson: text("egressConfigJson"),
  egressUdp: boolean("egressUdp").notNull().default(false),
  /*
    单条规则限额（shared/ruleLimits.ts、server/ruleLimits.ts），只有管理员能设：
    rateLimitMbps 叠在用户 / 隧道 / 转发组限速上取最严的那个；trafficLimit + trafficMode
    是这条规则自己的流量额度；expiresAt 到期停用。达到时 ruleLimitReason 记原因
    （expired / traffic_limit），运行时按停用下发，规则自己的开关不动。
    adminManaged：管理员替用户建的、或设过限额的规则，用户只能看不能改。
    quotaUsedIn/Out：这条逻辑规则的累计用量（转发组成员汇总到模板），null 表示还没开始记。
  */
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  trafficMode: varchar("trafficMode", { length: 16 }).notNull().default("both"),
  expiresAt: epoch("expiresAt"),
  ruleLimitReason: varchar("ruleLimitReason", { length: 32 }),
  adminManaged: boolean("adminManaged").notNull().default(false),
  quotaUsedIn: bigint("quotaUsedIn", { mode: "number" }),
  quotaUsedOut: bigint("quotaUsedOut", { mode: "number" }),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardRule = typeof forwardRules.$inferSelect;
export type InsertForwardRule = typeof forwardRules.$inferInsert;

/** 待删除的规则专属域名：删成功才去掉，失败留给定时对账重试。 */
export const ruleEntryDomainCleanups = table("rule_entry_domain_cleanups", {
  id: serial("id"),
  domain: varchar("domain", { length: 255 }).notNull(),
  // 为空表示不知道发布时用的类型（发布半途失败），删的时候 A / AAAA / CNAME 都删一遍。
  recordType: varchar("recordType", { length: 8 }),
  ruleId: int("ruleId").notNull(),
  attempts: int("attempts").notNull().default(0),
  lastError: text("lastError"),
  nextRetryAt: epoch("nextRetryAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});

/**
 * 客户端订阅的节点模板。
 *
 * 转发规则只存 host:port，不含任何节点凭据，所以订阅无法凭空生成。用户把落地机
 * 的原始节点链接粘贴一次存在这里，面板据此把每条转发的入口地址改写成可导入的
 * 节点。与计费的「套餐订阅」(subscription_plans / user_subscriptions) 无关。
 */
export const proxyNodes = table("proxy_nodes", {
  id: serial("id"),
  userId: int("userId").notNull(),
  name: text("name").notNull(),
  /** 备注：只给节点主人自己看，共享出去时会被抹掉（见 redactSharedProxyNodeRow）。 */
  remark: text("remark"),
  /**
   * 对外标注：分享给别人时，对方看得到的那一句。
   *
   * 和 remark 分开是因为它们服务两种人。remark 是「给张三的」「这条快到期了」
   * 「便宜线」—— 自己的账本，泄给租户会出事；publicLabel 是「家宽」「IEPL」
   * 「深港专线」—— 恰恰是租户最想知道、而只有主人说得出的那件事。
   *
   * 合成一个字段的话，两种用途只能二选一：要么泄露账本，要么租户看到的永远是
   * 一个没有信息量的「直连」。
   */
  publicLabel: text("publicLabel"),
  // vless | vmess | trojan | shadowsocks | hysteria2 | tuic | anytls | snell
  protocol: varchar("protocol", { length: 32 }).notNull().default("vless"),
  // 用户粘贴的原始链接，仅作留档与重新导入，渲染以下面解析后的字段为准
  sourceLink: text("sourceLink"),
  address: text("address").notNull(),
  port: int("port").notNull(),
  uuid: text("uuid"),
  password: text("password"),
  method: text("method"),
  alterId: int("alterId").notNull().default(0),
  flow: text("flow"),
  transport: varchar("transport", { length: 16 }).notNull().default("tcp"), // tcp | ws | grpc | http | xhttp
  path: text("path"),
  host: text("host"),
  tls: boolean("tls").notNull().default(false),
  sni: text("sni"),
  alpn: text("alpn"),
  fingerprint: text("fingerprint"),
  // 服务端证书的 SHA-256 钉扎（Hysteria2 链接的 pinSHA256、Clash 的 fingerprint）
  certSha256: text("certSha256"),
  allowInsecure: boolean("allowInsecure").notNull().default(false),
  realityPublicKey: text("realityPublicKey"),
  realityShortId: text("realityShortId"),
  udp: boolean("udp").notNull().default(true),
  // Hysteria2 的混淆：salamander | gecko，空表示不混淆
  obfs: text("obfs"),
  obfsPassword: text("obfsPassword"),
  // Hysteria2 客户端声明的带宽（Brutal）。物理列在 server/dbSchema.ts；这里不声明的话
  // db.select().from(proxyNodes) 根本不会把它们读出来，订阅里永远是 0。
  upMbps: int("upMbps").notNull().default(0),
  downMbps: int("downMbps").notNull().default(0),
  // TUIC 的拥塞控制（cubic | new_reno | bbr）与 UDP 转发模式（native | quic）
  congestionControl: text("congestionControl"),
  udpRelayMode: text("udpRelayMode"),
  disableSni: boolean("disableSni").notNull().default(false),
  // Snell 的版本（1-6，0 表示不是 Snell）与 v6 的整形模式
  snellVersion: int("snellVersion").notNull().default(0),
  snellMode: text("snellMode"),
  // XHTTP 传输的 mode：auto | stream-one | stream-up | packet-up
  xhttpMode: text("xhttpMode"),
  // 多台中转指向同一落地节点时，订阅里额外生成的选路组类型：off | url-test | fallback | load-balance（负载均衡）
  autoGroup: varchar("autoGroup", { length: 16 }).notNull().default("url-test"),
  // 把落地机自己的地址也作为一个节点放进订阅。默认关：开了之后落地 IP 会出现在
  // 每一条订阅地址里，中转机挂了能换，落地机被墙要重搭。
  includeDirect: boolean("includeDirect").notNull().default(false),
  // 前置代理：这个节点的连接先经由哪个节点建立（指向同表另一行）。0 表示不经由。
  frontProxyId: int("frontProxyId").notNull().default(0),
  // 由哪个落地入站派生而来（proxy_inbounds.id）。0 表示是用户自己粘链接建的。
  // 派生出来的节点不该手工改：下次保存入站时会被整行覆盖。
  inboundId: int("inboundId").notNull().default(0),
  // 对应入站上的哪个用户（proxy_inbound_users.id）。0 表示该协议只有单用户。
  // 派生时靠它把节点与用户对齐，用户删掉时才知道该删哪一条节点。
  inboundUserId: int("inboundUserId").notNull().default(0),
  // 这台落地机的套餐规格与用量。带宽与总流量是人填的（面板无从得知你买的是什么套餐），
  // 已用由面板自己累加 —— traffic_stats 只保留 72 小时，累计量必须单独存一列，
  // 不能靠查那张表算出来。
  // 上行带宽 Mbps，0 表示没填。
  bandwidthMbps: int("bandwidthMbps").notNull().default(0),
  // 套餐总流量（字节），0 表示不限或没填。
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  // 已用流量（字节）。只统计经面板转发规则走过的量 —— 直连订阅条目和这台机器上
  // 别的服务面板看不见，所以这个数是「面板经手的量」，可以手工校准成机房口径。
  trafficUsed: bigint("trafficUsed", { mode: "number" }).notNull().default(0),
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false),
  trafficResetDay: int("trafficResetDay").notNull().default(1),
  lastTrafficReset: epoch("lastTrafficReset"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  // 从哪个外部订阅同步来的（proxy_sub_sources.id），0 = 不是。sourceKey 是在那份订阅里的身份，再次同步时按它对账。
  sourceId: int("sourceId").notNull().default(0),
  sourceKey: text("sourceKey"),
  // 手工填的地区（ISO 国家码）；空则看落地机器的 geo，再猜名字。订阅处理器用。
  countryCode: varchar("countryCode", { length: 8 }),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ProxyNode = typeof proxyNodes.$inferSelect;
export type InsertProxyNode = typeof proxyNodes.$inferInsert;

/**
 * 落地入站：面板在自己管的主机上开出来的节点。
 *
 * 与 proxy_nodes 的分工 —— 这张表是「落地机怎么听」，那张是「客户端怎么连」。
 * 保存入站时会派生一行 proxy_nodes（带 inboundId 标记），订阅那一整套原样接上。
 * Reality 私钥只存在这张表，绝不进派生节点。
 */
export const proxyInbounds = table("proxy_inbounds", {
  id: serial("id"),
  userId: int("userId").notNull(),
  // 开在哪台主机上。那台机器必须装了 Agent，面板才推得下去配置。
  hostId: int("hostId").notNull(),
  name: text("name").notNull(),
  remark: text("remark"),
  /** 对外标注：分享出去时对方看得到的那一句，会带到派生节点上。见 proxy_nodes.publicLabel。 */
  publicLabel: text("publicLabel"),
  // vless | vmess | trojan | shadowsocks | hysteria2 | tuic | anytls | snell
  protocol: varchar("protocol", { length: 32 }).notNull().default("vless"),
  port: int("port").notNull(),
  transport: varchar("transport", { length: 16 }).notNull().default("tcp"), // tcp | ws | grpc | http
  security: varchar("security", { length: 16 }).notNull().default("reality"), // reality | acme | tls | none
  uuid: text("uuid"),
  password: text("password"),
  method: text("method"),
  flow: text("flow"),
  path: text("path"),
  host: text("host"),
  xhttpMode: text("xhttpMode"),
  serverName: text("serverName"),
  alpn: text("alpn"),
  certPath: text("certPath"),
  keyPath: text("keyPath"),
  // security=acme 时注册 ACME 账户用的邮箱
  acmeEmail: text("acmeEmail"),
  // Reality 私钥只在服务端，公钥才发给客户端
  realityPrivateKey: text("realityPrivateKey"),
  realityPublicKey: text("realityPublicKey"),
  realityShortId: text("realityShortId"),
  realityDest: text("realityDest"),
  obfs: text("obfs"),
  obfsPassword: text("obfsPassword"),
  upMbps: int("upMbps").notNull().default(0),
  downMbps: int("downMbps").notNull().default(0),
  congestionControl: text("congestionControl"),
  snellVersion: int("snellVersion").notNull().default(0),
  snellMode: text("snellMode"),
  /**
   * 这个入站是从哪个入站克隆出来的（0 = 人手建的）。
   *
   * 「给租户独享一个端口」用的：面板照着源入站在同一台机器上另开一个端口，
   * 归属直接落到租户名下 —— 这样现有的**按端口**计费链路就把流量算到他头上，
   * 不必等 sing-box 给出 per-user 统计（官方发布的二进制根本没编进 v2ray API，
   * clash API 的连接列表里也没有用户字段，都实测过）。
   *
   * 有了这一列才知道哪些入站是面板托管的：界面上只读、租户的自建配额不算它、
   * 取消授权时连端口一起收掉。
   */
  clonedFromInboundId: int("clonedFromInboundId").notNull().default(0),
  /**
   * 这个入站是不是普通用户靠「主机授权」开在别人机器上的。
   *
   * 是的话，授权收回之后这个端口就不该再下发（见 getEnabledProxyInboundsWithUsersByHost）。
   * 管理员替租户开的（分租）、面板克隆的专属端口、开在自己机器上的都不是：那些不靠主机授权，
   * 按授权去收会把管理员明确分出去的端口一起停掉。老数据一律是 false（维持原来的行为）。
   */
  hostGrantRequired: boolean("hostGrantRequired").notNull().default(false),
  /**
   * 「一键创建落地 SS 入站」开出来的：给转发规则当 Shadowsocks 出口用（shared/ssEgress.ts）。
   * 派生节点默认不进订阅（includeDirect = false），管理员想给客户端用时在订阅页里打开即可；
   * 管理员开的这种入站，有这台主机使用权限的用户都能拿来当出口。
   */
  landingEgress: boolean("landingEgress").notNull().default(false),
  routingJson: text("routingJson"),
  /**
   * 这个端口自己的额度与用量。
   *
   * 记在入站上而不是派生节点上：Agent 的计数链装在**监听端口**上，一个多用户入站
   * 派生出好几个节点，它们共用这一个端口，上报回来的字节数分不到人头上（sing-box
   * 官方二进制没有 per-user 统计，见 clonedFromInboundId 那段）。所以「跑了多少」
   * 天然是端口的属性，不是某一份凭据的。
   *
   * 和主机那一层的区别要记牢：主机层是机房账单口径（系统级网卡计数，直连和机器上
   * 跑的别的服务都算），这一层只数**面板经手的这个端口**。两个数不该被当成一回事。
   */
  bandwidthMbps: int("bandwidthMbps").notNull().default(0),
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  trafficUsed: bigint("trafficUsed", { mode: "number" }).notNull().default(0),
  trafficAutoReset: boolean("trafficAutoReset").notNull().default(false),
  trafficResetDay: int("trafficResetDay").notNull().default(1),
  lastTrafficReset: epoch("lastTrafficReset"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ProxyInbound = typeof proxyInbounds.$inferSelect;
export type InsertProxyInbound = typeof proxyInbounds.$inferInsert;

/**
 * 落地入站上的用户：一个入站可以给多个人各发一份凭据。
 *
 * 只有支持多用户的协议用得上（见 shared/proxyInbound.ts 的
 * PROXY_INBOUND_MULTI_USER_PROTOCOLS）。Shadowsocks 与 Snell 的凭据仍在入站行上。
 */
export const proxyInboundUsers = table("proxy_inbound_users", {
  id: serial("id"),
  inboundId: int("inboundId").notNull(),
  // 给人看的标签，会拼进派生出来的节点名
  name: text("name").notNull(),
  uuid: text("uuid"),
  password: text("password"),
  /**
   * 这份凭据是为哪个面板用户单独发的（分享用），0 = 管理员在弹窗里手工加的。
   *
   * 有了它，取消分享才有得可删 —— 删掉这一行，只有那个人连不上，同一个端口上
   * 别人的凭据照旧。也正因为它不是从弹窗里加的，保存入站时不能被表单的全量
   * 替换顺手删掉（见 replaceProxyInboundUsers）。
   */
  sharedUserId: int("sharedUserId").notNull().default(0),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ProxyInboundUser = typeof proxyInboundUsers.$inferSelect;
export type InsertProxyInboundUser = typeof proxyInboundUsers.$inferInsert;

/**
 * 共享 TLS 入站（SNI 分流）。一台主机上一个 TCP 端口，多条规则按 ClientHello 的 SNI 分走，
 * 纯透传、不终止 TLS。见 shared/tlsInbound.ts。
 */
export const hostTlsInbounds = table("host_tls_inbounds", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  name: text("name").notNull(),
  port: int("port").notNull(),
  isEnabled: boolean("isEnabled").notNull().default(true),
  // JSON 数组；空 = 全部放行。`example.com` 含子域名，`.example.com` 只放子域名。
  allowedSni: text("allowedSni"),
  rejectEmptySni: boolean("rejectEmptySni").notNull().default(true),
  unknownSniAction: varchar("unknownSniAction", { length: 16 }).notNull().default("reject"),
  defaultRuleId: int("defaultRuleId"),
  proxyProtocol: varchar("proxyProtocol", { length: 8 }).notNull().default("off"),
  maxHandshakes: int("maxHandshakes").notNull().default(128),
  handshakeTimeoutSeconds: int("handshakeTimeoutSeconds").notNull().default(5),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostTlsInbound = typeof hostTlsInbounds.$inferSelect;

/** 规则在共享入站上占用的 SNI。(tlsInboundId, name) 唯一。 */
export const ruleSniNames = table("rule_sni_names", {
  id: serial("id"),
  tlsInboundId: int("tlsInboundId").notNull(),
  name: varchar("name", { length: 253 }).notNull(),
  ruleId: int("ruleId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});

/**
 * 订阅令牌。订阅地址里带着全部节点凭据，所以令牌必须不可猜且可单独吊销，
 * 例如手机丢了只吊销那一个而不影响其他设备。
 */
export const proxySubTokens = table("proxy_sub_tokens", {
  id: serial("id"),
  userId: int("userId").notNull(),
  name: text("name").notNull(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  defaultFormat: varchar("defaultFormat", { length: 16 }).notNull().default("base64"),
  // 分流规则预设：off | minimal | balanced | comprehensive，按订阅链接（即按设备）配置
  rulePreset: varchar("rulePreset", { length: 24 }).notNull().default("balanced"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  accessCount: int("accessCount").notNull().default(0),
  lastAccessAt: epoch("lastAccessAt"),
  lastAccessIp: text("lastAccessIp"),
  lastAccessUserAgent: text("lastAccessUserAgent"),
  /**
   * 最近一次**被拒**的拉取。
   *
   * 只记成功的话，「客户说订阅更新不了」就没法回答：到底是他没试，还是试了被挡了、
   * 挡在哪一步。这两列专门回答后半句，见 shared/proxySubTokenStatus。
   */
  lastFailureAt: epoch("lastFailureAt"),
  lastFailureReason: varchar("lastFailureReason", { length: 32 }),
  expiresAt: epoch("expiresAt"),
  // 短链别名：/s/<alias>。唯一；空 = 没开。
  alias: varchar("alias", { length: 32 }),
  // 作用域（只给哪些节点）和外观选项，JSON 文本，见 shared/proxySubTokenScope.ts。空 = 默认。
  scopeJson: text("scopeJson"),
  optionsJson: text("optionsJson"),
  remark: text("remark"),
  // 这条地址自己的设备数上限，0 = 看用户 / 全局。
  maxDevices: int("maxDevices").notNull().default(0),
  // 指定模板（proxy_sub_templates.id），0 = 看用户 / 套餐 / 全局默认。
  templateId: int("templateId").notNull().default(0),
  // 最近一次拉取认出来的客户端。
  lastClientFamily: varchar("lastClientFamily", { length: 32 }),
  lastClientVersion: varchar("lastClientVersion", { length: 32 }),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ProxySubToken = typeof proxySubTokens.$inferSelect;
export type InsertProxySubToken = typeof proxySubTokens.$inferInsert;

/**
 * 节点分享：把某个节点放进另一个用户的订阅，但不转让所有权。
 *
 * 与「归属用户」的区别 —— 归属是把这一份凭据整个转给对方（对方的订阅、对方的
 * 配额、对方能改）；分享是同一份凭据同时出现在别人的订阅里，节点仍然是我的。
 * 有人只租一两个落地，不值得为他单开端口时用这个。
 *
 * 流量记在节点主人头上：分享出去的是同一个端口，面板按端口计量，没法把这个
 * 端口上的量拆给几个订阅者。界面上要写清楚，别让人事后才发现。
 */
export const proxyNodeShares = table("proxy_node_shares", {
  id: serial("id"),
  // 分享出去的是哪个节点（proxy_nodes.id），节点主人看它的 userId。
  nodeId: int("nodeId").notNull(),
  // 分享给谁。这个人的订阅里会多出这个节点。
  userId: int("userId").notNull(),
  /**
   * 这条分享是怎么来的：manual = 管理员手工分的，plan = 套餐带的。
   *
   * 两种要分开管：套餐那份随订阅生灭（买了自动给、到期自动收），手工那份
   * 是管理员的决定，不能被套餐同步顺手删掉 —— 反过来也一样。
   */
  source: varchar("source", { length: 16 }).notNull().default("manual"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ProxyNodeShare = typeof proxyNodeShares.$inferSelect;
export type InsertProxyNodeShare = typeof proxyNodeShares.$inferInsert;

/**
 * 订阅拉取日志：每次拉取（成功或被拒）一行。
 *
 * 令牌行上只留「最后一次」，回答不了「这条地址这周被几个客户端拉过」「哪个 IP 在狂刷」。
 * 保留天数在订阅设置里（默认 30 天），定时清理。
 */
export const proxySubAccessLogs = table("proxy_sub_access_logs", {
  id: serial("id"),
  tokenId: int("tokenId").notNull(),
  userId: int("userId").notNull(),
  at: epoch("at").notNull().default(nowDefault()),
  ip: text("ip"),
  userAgent: text("userAgent"),
  clientFamily: varchar("clientFamily", { length: 32 }),
  clientVersion: varchar("clientVersion", { length: 32 }),
  format: varchar("format", { length: 16 }),
  profile: boolean("profile").notNull().default(false),
  // ok | page | disabled | token-expired | not-eligible | rate-limited | device-limit | hwid-required | error
  result: varchar("result", { length: 32 }).notNull().default("ok"),
  hwid: varchar("hwid", { length: 80 }),
  bytes: int("bytes").notNull().default(0),
});
export type ProxySubAccessLog = typeof proxySubAccessLogs.$inferSelect;
export type InsertProxySubAccessLog = typeof proxySubAccessLogs.$inferInsert;

/**
 * 订阅设备：一条地址在哪些设备上。hwid 是客户端发的 x-hwid，退化模式下是 `ip:<地址>`。
 */
export const proxySubDevices = table("proxy_sub_devices", {
  id: serial("id"),
  tokenId: int("tokenId").notNull(),
  userId: int("userId").notNull(),
  hwid: varchar("hwid", { length: 80 }).notNull(),
  deviceOs: varchar("deviceOs", { length: 64 }),
  osVersion: varchar("osVersion", { length: 64 }),
  model: varchar("model", { length: 120 }),
  firstSeenAt: epoch("firstSeenAt").notNull().default(nowDefault()),
  lastSeenAt: epoch("lastSeenAt").notNull().default(nowDefault()),
  lastIp: text("lastIp"),
  userAgent: text("userAgent"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ProxySubDevice = typeof proxySubDevices.$inferSelect;
export type InsertProxySubDevice = typeof proxySubDevices.$inferInsert;

/**
 * 订阅模板：每种目标格式的「开头部分」加自定义策略组，见 shared/proxySubTemplates.ts。
 * isDefault = 这种目标格式没被用户 / 套餐 / 令牌指定模板时用这份。
 */
export const proxySubTemplates = table("proxy_sub_templates", {
  id: serial("id"),
  name: text("name").notNull(),
  target: varchar("target", { length: 16 }).notNull(),
  prelude: text("prelude").notNull().default(""),
  customGroupsJson: text("customGroupsJson"),
  isDefault: boolean("isDefault").notNull().default(false),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ProxySubTemplate = typeof proxySubTemplates.$inferSelect;
export type InsertProxySubTemplate = typeof proxySubTemplates.$inferInsert;

/**
 * 外部订阅：用户填一条别处的订阅地址，面板定时拉取、解析、并进他的订阅（import），
 * 或者原样透传给 mihomo / Stash 当 proxy-provider（provider）。见 shared/proxySubSource.ts。
 */
export const proxySubSources = table("proxy_sub_sources", {
  id: serial("id"),
  userId: int("userId").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  userAgent: text("userAgent"),
  intervalSec: int("intervalSec").notNull().default(21600),
  mode: varchar("mode", { length: 16 }).notNull().default("import"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  lastFetchAt: epoch("lastFetchAt"),
  // ok | error | never
  lastStatus: varchar("lastStatus", { length: 16 }).notNull().default("never"),
  lastError: text("lastError"),
  upstreamUserinfo: text("upstreamUserinfo"),
  nodeCount: int("nodeCount").notNull().default(0),
  lastContentHash: varchar("lastContentHash", { length: 64 }),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ProxySubSource = typeof proxySubSources.$inferSelect;
export type InsertProxySubSource = typeof proxySubSources.$inferInsert;

export const forwardGroups = table("forward_groups", {
  id: serial("id"),
  name: text("name").notNull(),
  remark: text("remark"),
  groupType: varchar("groupType", { length: 32 }).notNull().default("host"),
  groupMode: varchar("groupMode", { length: 32 }).notNull().default("failover"),
  exitStrategy: varchar("exitStrategy", { length: 32 }).notNull().default("round_robin"),
  entryGroupId: int("entryGroupId"),
  forwardType: varchar("forwardType", { length: 32 }).notNull().default("iptables"),
  // Failover groups created before group-level runtime inheritance was
  // introduced keep their legacy template-driven child semantics until an
  // administrator explicitly saves the group.
  failoverRuntimeInheritanceEnabled: boolean("failoverRuntimeInheritanceEnabled").notNull().default(false),
  domain: text("domain"),
  recordType: varchar("recordType", { length: 16 }).notNull().default("A"),
  sourcePort: int("sourcePort").notNull().default(1),
  protocol: varchar("protocol", { length: 16 }).notNull().default("both"),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort").notNull().default(1),
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  trafficMultiplier: int("trafficMultiplier").notNull().default(100), // 0.01x = 1, 1x = 100, 50x = 5000
  proxyProtocolReceive: boolean("proxyProtocolReceive").notNull().default(false),
  proxyProtocolSend: boolean("proxyProtocolSend").notNull().default(false),
  proxyProtocolExitReceive: boolean("proxyProtocolExitReceive").notNull().default(false),
  proxyProtocolExitSend: boolean("proxyProtocolExitSend").notNull().default(false),
  proxyProtocolVersion: int("proxyProtocolVersion").notNull().default(1),
  tcpFastOpen: boolean("tcpFastOpen").notNull().default(false),
  zeroCopy: boolean("zeroCopy").notNull().default(false),
  udpOverTcp: boolean("udpOverTcp").notNull().default(false),
  udpOverTcpPort: int("udpOverTcpPort"),
  failoverEnabled: boolean("failoverEnabled").notNull().default(false),
  failoverStrategy: varchar("failoverStrategy", { length: 32 }).notNull().default("fallback"),
  failoverTargets: text("failoverTargets"),
  failoverSeconds: int("failoverSeconds").notNull().default(60),
  recoverSeconds: int("recoverSeconds").notNull().default(120),
  chinaHealthCheckEnabled: boolean("chinaHealthCheckEnabled").notNull().default(false),
  chinaHealthCheckTarget: text("chinaHealthCheckTarget"),
  // Probe method for member health: "tcp" connects to a port, "ping" only
  // measures ICMP latency and needs no port.
  chinaHealthCheckMethod: varchar("chinaHealthCheckMethod", { length: 16 }).notNull().default("tcp"),
  telegramSwitchNotifyEnabled: boolean("telegramSwitchNotifyEnabled").notNull().default(false),
  ddnsAutoResolveEnabled: boolean("ddnsAutoResolveEnabled").notNull().default(true),
  autoFailback: boolean("autoFailback").notNull().default(true),
  // Multi-front-VPS bandwidth aggregation for entry groups. Disabled by default
  // so existing groups keep their equal-share publishing behaviour.
  bandwidthAggregationEnabled: boolean("bandwidthAggregationEnabled").notNull().default(false),
  bandwidthAggregationStrategy: varchar("bandwidthAggregationStrategy", { length: 32 }).notNull().default("capacity"),
  bandwidthAggregationSlots: int("bandwidthAggregationSlots").notNull().default(8),
  bandwidthAggregationMinMembers: int("bandwidthAggregationMinMembers").notNull().default(1),
  isEnabled: boolean("isEnabled").notNull().default(true),
  activeMemberId: int("activeMemberId"),
  /** 成员跟着哪个节点池（server/nodePoolGroups.ts）；null = 手动维护。 */
  poolId: int("poolId"),
  lastDdnsValue: text("lastDdnsValue"),
  lastDdnsAt: epoch("lastDdnsAt"),
  lastFailoverAt: epoch("lastFailoverAt"),
  lastStatus: varchar("lastStatus", { length: 32 }).notNull().default("unknown"),
  lastMessage: text("lastMessage"),
  sortOrder: int("sortOrder").notNull().default(0),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardGroup = typeof forwardGroups.$inferSelect;
export type InsertForwardGroup = typeof forwardGroups.$inferInsert;

export const forwardGroupMembers = table("forward_group_members", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  memberType: varchar("memberType", { length: 32 }).notNull(),
  hostId: int("hostId"),
  tunnelId: int("tunnelId"),
  connectHost: text("connectHost"),
  priority: int("priority").notNull().default(0),
  ruleId: int("ruleId"),
  // Declared uplink of this front VPS in Mbps (0 = unknown) and its manual
  // aggregation weight (0 = derive the weight from the group strategy).
  bandwidthMbps: int("bandwidthMbps").notNull().default(0),
  aggregationWeight: int("aggregationWeight").notNull().default(0),
  isEnabled: boolean("isEnabled").notNull().default(true),
  activeSchedule: text("activeSchedule"),
  scheduleSuspended: boolean("scheduleSuspended").notNull().default(false),
  healthStatus: varchar("healthStatus", { length: 32 }).notNull().default("unknown"),
  lastLatencyMs: int("lastLatencyMs"),
  chinaHealthStatus: varchar("chinaHealthStatus", { length: 32 }).notNull().default("unknown"),
  chinaHealthLatencyMs: int("chinaHealthLatencyMs"),
  chinaHealthCheckedAt: epoch("chinaHealthCheckedAt"),
  failureSince: epoch("failureSince"),
  healthySince: epoch("healthySince"),
  lastCheckedAt: epoch("lastCheckedAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardGroupMember = typeof forwardGroupMembers.$inferSelect;
export type InsertForwardGroupMember = typeof forwardGroupMembers.$inferInsert;

export const forwardGroupEvents = table("forward_group_events", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  memberId: int("memberId"),
  type: varchar("type", { length: 32 }).notNull(),
  message: text("message"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ForwardGroupEvent = typeof forwardGroupEvents.$inferSelect;
export type InsertForwardGroupEvent = typeof forwardGroupEvents.$inferInsert;

/*
  线路组的切换记录：谁切到谁、为什么、当时的评分。规则卡「最近切换」读它。
  Agent 上报的事件先经 shared/routeGroup.ts 的 describeRouteReason 翻成人话
  再入库，所以 reason 存的是 Agent 原话，展示时再翻。定期只留 72 小时。
*/
export const forwardRuleRouteEvents = table("forward_rule_route_events", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  kind: varchar("kind", { length: 24 }).notNull(),
  fromKey: varchar("fromKey", { length: 32 }),
  toKey: varchar("toKey", { length: 32 }),
  fromLabel: text("fromLabel"),
  toLabel: text("toLabel"),
  reason: text("reason"),
  score: int("score"),
  latencyMs: int("latencyMs"),
  fromChainMs: int("fromChainMs"),
  toChainMs: int("toChainMs"),
  heldSeconds: int("heldSeconds"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ForwardRuleRouteEvent = typeof forwardRuleRouteEvents.$inferSelect;
export type InsertForwardRuleRouteEvent = typeof forwardRuleRouteEvents.$inferInsert;

/*
  线路组每条路径的质量历史：入口 Agent 随心跳报的评分（routeGroupStats 里的 RouteTargetStat），
  每条路径最多一分钟落一行，给线路组面板画近几天的走势。丢包、可用率按千分比存整数
  （和 tunnel_link_shaping.lossPermille 一样），接口里再换回百分比。定期只留 7 天。
*/
export const routePathQualityStats = table("route_path_quality_stats", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  pathKey: varchar("pathKey", { length: 32 }).notNull(),
  sampledAt: epoch("sampledAt").notNull().default(nowDefault()),
  latencyMs: int("latencyMs"),
  lossPermille: int("lossPermille").notNull().default(0),
  jitterMs: int("jitterMs"),
  availabilityPermille: int("availabilityPermille"),
  score: int("score"),
});
export type RoutePathQualityStat = typeof routePathQualityStats.$inferSelect;
export type InsertRoutePathQualityStat = typeof routePathQualityStats.$inferInsert;

/*
  换隧道后旧入口的临时桥接：规则换到别的入口主机后，旧入口的老端口在这段时间里继续把流量转到
  规则当前的入口（见 shared/ruleEntryBridge 与 server/repositories/ruleEntryBridgeRepository）。
*/
export const forwardRuleEntryBridges = table("forward_rule_entry_bridges", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  sourcePort: int("sourcePort").notNull(),
  protocol: varchar("protocol", { length: 16 }).notNull().default("both"),
  isRunning: boolean("isRunning").notNull().default(false),
  runtimeTarget: text("runtimeTarget"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  expiresAt: epoch("expiresAt").notNull(),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardRuleEntryBridge = typeof forwardRuleEntryBridges.$inferSelect;

// ===== gost 隧道配置（两台公网 Agent 组建链路） =====
export const tunnels = table("tunnels", {
  id: serial("id"),
  name: text("name").notNull(),
  entryGroupId: int("entryGroupId"),
  exitGroupId: int("exitGroupId"),
  entryHostId: int("entryHostId").notNull(),
  exitHostId: int("exitHostId").notNull(),
  mode: varchar("mode", { length: 32 }).notNull().default("tls"), // forwardx | tls | wss | tcp | mtls | mwss | mtcp | nginx_stream
  relayMode: varchar("relayMode", { length: 16 }).notNull().default("chain"), // chain 链路中转 | failover 主备 | aggregate 单连接叠加
  forwardxVersion: varchar("forwardxVersion", { length: 8 }).notNull().default("v1"),
  certDomain: text("certDomain"),
  certPem: text("certPem"),
  certKeyPem: text("certKeyPem"),
  secret: text("secret"),
  listenPort: int("listenPort").notNull(),
  mimicPort: int("mimicPort").notNull().default(0),
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  trafficMultiplier: int("trafficMultiplier").notNull().default(100), // 0.01x = 1, 1x = 100, 50x = 5000
  // Legacy columns retained for migration compatibility; runtime ignores them.
  trafficPaddingEnabled: boolean("trafficPaddingEnabled").notNull().default(false),
  trafficPaddingRatio: int("trafficPaddingRatio").notNull().default(0),
  trafficPaddingMaxMbps: int("trafficPaddingMaxMbps").notNull().default(0),
  portRangeStart: int("portRangeStart"),
  portRangeEnd: int("portRangeEnd"),
  networkType: varchar("networkType", { length: 32 }).notNull().default("public"),
  connectHost: text("connectHost"),
  proxyProtocolReceive: boolean("proxyProtocolReceive").notNull().default(false),
  proxyProtocolSend: boolean("proxyProtocolSend").notNull().default(false),
  proxyProtocolExitReceive: boolean("proxyProtocolExitReceive").notNull().default(false),
  proxyProtocolExitSend: boolean("proxyProtocolExitSend").notNull().default(false),
  proxyProtocolVersion: int("proxyProtocolVersion").notNull().default(1),
  tcpFastOpen: boolean("tcpFastOpen").notNull().default(false),
  udpOverTcp: boolean("udpOverTcp").notNull().default(false),
  linkUpMbps: int("linkUpMbps").notNull().default(0),
  linkDownMbps: int("linkDownMbps").notNull().default(0),
  linkShapingMode: varchar("linkShapingMode", { length: 16 }).notNull().default("off"),
  /** 抗丢包：UDP 直连额外发纠错包（FXP 的 udp_fec.go）。只对 NEX 隧道有意义，默认关。 */
  udpFec: boolean("udpFec").notNull().default(false),
  /** 内核直通：V2 隧道两端都是内核 WireGuard 时，普通 TCP/UDP 规则改走 iptables DNAT 进 nexwg，不经 FXP。默认关。 */
  kernelPassthrough: boolean("kernelPassthrough").notNull().default(false),
  // 复制模式（2.3.449）：中转带宽叠加的隧道上，每一片都从两条中转各发一份，一条线路断了连接也不断。
  multipathReplicate: boolean("multipathReplicate").notNull().default(false),
  parallelStreams: int("parallelStreams").notNull().default(1),
  blockHttp: boolean("blockHttp").notNull().default(false),
  blockSocks: boolean("blockSocks").notNull().default(false),
  blockTls: boolean("blockTls").notNull().default(false),
  loadBalanceEnabled: boolean("loadBalanceEnabled").notNull().default(false),
  loadBalanceStrategy: varchar("loadBalanceStrategy", { length: 32 }).notNull().default("round_robin"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  disabledByGroup: boolean("disabledByGroup").notNull().default(false),
  isRunning: boolean("isRunning").notNull().default(false),
  lastLatencyMs: int("lastLatencyMs"),
  lastTestStatus: text("lastTestStatus"),
  lastTestMessage: text("lastTestMessage"),
  lastTestAt: epoch("lastTestAt"),
  sortOrder: int("sortOrder").notNull().default(0),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Tunnel = typeof tunnels.$inferSelect;
export type InsertTunnel = typeof tunnels.$inferInsert;

export const tunnelExitNodes = table("tunnel_exit_nodes", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  seq: int("seq").notNull(),
  hostId: int("hostId").notNull(),
  listenPort: int("listenPort").notNull(),
  mimicPort: int("mimicPort").notNull().default(0),
  connectHost: text("connectHost"),
  isEnabled: boolean("isEnabled").notNull().default(true),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TunnelExitNode = typeof tunnelExitNodes.$inferSelect;
export type InsertTunnelExitNode = typeof tunnelExitNodes.$inferInsert;

export const tunnelHops = table("tunnel_hops", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  seq: int("seq").notNull(),
  hostId: int("hostId").notNull(),
  listenPort: int("listenPort").notNull().default(0),
  mimicPort: int("mimicPort").notNull().default(0),
  connectHost: text("connectHost"),
});
export type TunnelHop = typeof tunnelHops.$inferSelect;
export type InsertTunnelHop = typeof tunnelHops.$inferInsert;

export const tunnelLinkShaping = table("tunnel_link_shaping", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  hostId: int("hostId").notNull(),
  role: varchar("role", { length: 16 }).notNull().default("entry"),
  direction: varchar("direction", { length: 8 }).notNull(),
  mode: varchar("mode", { length: 16 }).notNull().default("auto"),
  state: varchar("state", { length: 16 }).notNull().default("watching"),
  rateMbps: int("rateMbps").notNull().default(0),
  learnedMbps: int("learnedMbps").notNull().default(0),
  lossPermille: int("lossPermille").notNull().default(0),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TunnelLinkShaping = typeof tunnelLinkShaping.$inferSelect;
export type InsertTunnelLinkShaping = typeof tunnelLinkShaping.$inferInsert;

export const forwardRuleTunnelExits = table("forward_rule_tunnel_exits", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  tunnelId: int("tunnelId").notNull(),
  exitNodeId: int("exitNodeId").notNull(),
  exitSeq: int("exitSeq").notNull(),
  exitHostId: int("exitHostId").notNull(),
  tunnelExitPort: int("tunnelExitPort").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardRuleTunnelExit = typeof forwardRuleTunnelExits.$inferSelect;
export type InsertForwardRuleTunnelExit = typeof forwardRuleTunnelExits.$inferInsert;

export const hostMetrics = table("host_metrics", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  cpuUsage: int("cpuUsage"),
  memoryUsage: int("memoryUsage"),
  memoryUsed: bigint("memoryUsed", { mode: "number" }),
  swapUsage: int("swapUsage"),
  swapUsed: bigint("swapUsed", { mode: "number" }),
  swapTotal: bigint("swapTotal", { mode: "number" }),
  networkIn: bigint("networkIn", { mode: "number" }),
  networkOut: bigint("networkOut", { mode: "number" }),
  diskUsage: int("diskUsage"),
  diskUsed: bigint("diskUsed", { mode: "number" }),
  diskTotal: bigint("diskTotal", { mode: "number" }),
  uptime: bigint("uptime", { mode: "number" }),
  /** 此刻的 TCP / UDP 连接数（Agent 2.2.215 起上报；旧 Agent 为 null） */
  tcpConnections: int("tcpConnections"),
  udpConnections: int("udpConnections"),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type HostMetric = typeof hostMetrics.$inferSelect;
export type InsertHostMetric = typeof hostMetrics.$inferInsert;

export const hostTrafficCounters = table("host_traffic_counters", {
  id: serial("id"),
  hostId: int("hostId").notNull().unique(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  lastSystemIn: bigint("lastSystemIn", { mode: "number" }),
  lastSystemOut: bigint("lastSystemOut", { mode: "number" }),
  lastDeltaIn: bigint("lastDeltaIn", { mode: "number" }).notNull().default(0),
  lastDeltaOut: bigint("lastDeltaOut", { mode: "number" }).notNull().default(0),
  lastReportedAt: epoch("lastReportedAt"),
  resetAt: epoch("resetAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostTrafficCounter = typeof hostTrafficCounters.$inferSelect;
export type InsertHostTrafficCounter = typeof hostTrafficCounters.$inferInsert;

export const userTrafficCounters = table("user_traffic_counters", {
  id: serial("id"),
  userId: int("userId").notNull().unique(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  connections: bigint("connections", { mode: "number" }).notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type UserTrafficCounter = typeof userTrafficCounters.$inferSelect;
export type InsertUserTrafficCounter = typeof userTrafficCounters.$inferInsert;

export const forwardRuleTrafficCounters = table("forward_rule_traffic_counters", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  userId: int("userId").notNull(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  connections: bigint("connections", { mode: "number" }).notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardRuleTrafficCounter = typeof forwardRuleTrafficCounters.$inferSelect;
export type InsertForwardRuleTrafficCounter = typeof forwardRuleTrafficCounters.$inferInsert;

export const trafficStats = table("traffic_stats", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  connections: int("connections").notNull().default(0),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TrafficStat = typeof trafficStats.$inferSelect;
export type InsertTrafficStat = typeof trafficStats.$inferInsert;

export const trafficStatBuckets = table("traffic_stat_buckets", {
  id: serial("id"),
  bucketStart: epoch("bucketStart").notNull(),
  bucketMinutes: int("bucketMinutes").notNull().default(30),
  userId: int("userId").notNull(),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  bytesIn: bigint("bytesIn", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytesOut", { mode: "number" }).notNull().default(0),
  connections: int("connections").notNull().default(0),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficStatBucket = typeof trafficStatBuckets.$inferSelect;
export type InsertTrafficStatBucket = typeof trafficStatBuckets.$inferInsert;

export const agentTrafficReports = table("agent_traffic_reports", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  producerId: varchar("producerId", { length: 128 }),
  reportId: varchar("reportId", { length: 128 }).notNull(),
  receivedAt: epoch("receivedAt").notNull().default(nowDefault()),
});
export type AgentTrafficReport = typeof agentTrafficReports.$inferSelect;
export type InsertAgentTrafficReport = typeof agentTrafficReports.$inferInsert;

// Cumulative real-probe counter snapshots (Agent 2.2.229+). Deliberately
// separate from the path-health rows in tcping_stats / *_latency_stats: those
// suppress steady successes and reuse cached hops, so they cannot yield an
// accurate failure rate. Statistics are deltas between snapshots of one
// (hostId, kind, refId, probeKey, epoch) stream.
export const probeCounterSnapshots = table("probe_counter_snapshots", {
  id: serial("id"),
  kind: varchar("kind", { length: 16 }).notNull(),
  refId: int("refId").notNull(),
  hostId: int("hostId").notNull(),
  probeKey: varchar("probeKey", { length: 64 }).notNull(),
  epoch: varchar("epoch", { length: 64 }).notNull(),
  totalCount: int("totalCount").notNull(),
  totalSuccesses: int("totalSuccesses").notNull(),
  batchCount: int("batchCount").notNull(),
  batchSuccesses: int("batchSuccesses").notNull(),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});

export const tunnelLatencyStats = table("tunnel_latency_stats", {
  id: serial("id"),
  tunnelId: int("tunnelId").notNull(),
  seriesKey: varchar("seriesKey", { length: 64 }),
  seriesLabel: text("seriesLabel"),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  // A latency row may represent several probes (for example, a 5-packet ping).
  // Keep the successful count so partial packet loss is not collapsed into a
  // binary timeout/success value.
  probeCount: int("probeCount").notNull().default(1),
  probeSuccesses: int("probeSuccesses").notNull().default(0),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TunnelLatencyStat = typeof tunnelLatencyStats.$inferSelect;
export type InsertTunnelLatencyStat = typeof tunnelLatencyStats.$inferInsert;

export const forwardGroupLatencyStats = table("forward_group_latency_stats", {
  id: serial("id"),
  groupId: int("groupId").notNull(),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  probeCount: int("probeCount").notNull().default(1),
  probeSuccesses: int("probeSuccesses").notNull().default(0),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type ForwardGroupLatencyStat = typeof forwardGroupLatencyStats.$inferSelect;
export type InsertForwardGroupLatencyStat = typeof forwardGroupLatencyStats.$inferInsert;

/*
  30 天延迟历史的按天汇总（server/repositories/latencyDailyRepository.ts）。原始样本只留 72 小时；
  这张表每个对象每天一行。dayStart 是面板时区那天 0 点的 epoch 秒（用整数存，汇总 SQL 里直接算）。
  latencySum / latencyWeight 是成功次数加权的延迟和与权重，平均延迟 = 两者相除。
*/
export const latencyDailyStats = table("latency_daily_stats", {
  id: serial("id"),
  targetType: varchar("targetType", { length: 16 }).notNull(),
  targetId: int("targetId").notNull(),
  dayStart: int("dayStart").notNull(),
  probeCount: bigint("probeCount", { mode: "number" }).notNull().default(0),
  probeSuccesses: bigint("probeSuccesses", { mode: "number" }).notNull().default(0),
  latencySum: bigint("latencySum", { mode: "number" }).notNull().default(0),
  latencyWeight: bigint("latencyWeight", { mode: "number" }).notNull().default(0),
  minLatencyMs: int("minLatencyMs"),
  maxLatencyMs: int("maxLatencyMs"),
  updatedAt: int("updatedAt").notNull().default(0),
});

/*
  主机探测的按小时汇总（server/repositories/hostProbeHourlyRepository.ts）。原始样本只留 72 小时；
  这张表每个（服务, 主机）每小时一行，留 30 天，服务延迟图表的 7 天 / 30 天读它。
*/
export const hostProbeServiceHourly = table("host_probe_service_hourly", {
  id: serial("id"),
  serviceId: int("serviceId").notNull(),
  hostId: int("hostId").notNull(),
  hourStart: int("hourStart").notNull(),
  probeCount: bigint("probeCount", { mode: "number" }).notNull().default(0),
  probeSuccesses: bigint("probeSuccesses", { mode: "number" }).notNull().default(0),
  latencySum: bigint("latencySum", { mode: "number" }).notNull().default(0),
  latencyWeight: bigint("latencyWeight", { mode: "number" }).notNull().default(0),
  minLatencyMs: int("minLatencyMs"),
  maxLatencyMs: int("maxLatencyMs"),
  updatedAt: int("updatedAt").notNull().default(0),
});

export const hostProbeServices = table("host_probe_services", {
  id: serial("id"),
  name: text("name").notNull(),
  method: varchar("method", { length: 16 }).notNull().default("tcping"),
  targetIp: text("targetIp").notNull(),
  targetPort: int("targetPort"),
  /** 目标是域名时按哪一族解析：auto / ipv4 / ipv6（shared/probeFamily.ts，Agent 2.2.225 起生效）。 */
  addressFamily: varchar("addressFamily", { length: 8 }).notNull().default("auto"),
  hostScope: varchar("hostScope", { length: 16 }).notNull().default("all"),
  hostIds: text("hostIds"),
  excludeHostIds: text("excludeHostIds"),
  intervalSeconds: int("intervalSeconds").notNull().default(30),
  isEnabled: boolean("isEnabled").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostProbeService = typeof hostProbeServices.$inferSelect;
export type InsertHostProbeService = typeof hostProbeServices.$inferInsert;

export const hostProbeServiceStats = table("host_probe_service_stats", {
  id: serial("id"),
  serviceId: int("serviceId").notNull(),
  hostId: int("hostId").notNull(),
  latencyMs: int("latencyMs"),
  isTimeout: boolean("isTimeout").notNull().default(false),
  probeCount: int("probeCount").notNull().default(1),
  probeSuccesses: int("probeSuccesses").notNull().default(0),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type HostProbeServiceStat = typeof hostProbeServiceStats.$inferSelect;
export type InsertHostProbeServiceStat = typeof hostProbeServiceStats.$inferInsert;

export const ipGeoCache = table("ip_geo_cache", {
  id: serial("id"),
  address: varchar("address", { length: 253 }).notNull().unique(),
  resolvedAddress: varchar("resolvedAddress", { length: 64 }).notNull(),
  geoCountryCode: varchar("geoCountryCode", { length: 8 }).notNull(),
  geoCountryName: text("geoCountryName"),
  geoRegion: text("geoRegion"),
  geoEmoji: varchar("geoEmoji", { length: 16 }),
  geoLatitudeMicro: int("geoLatitudeMicro"),
  geoLongitudeMicro: int("geoLongitudeMicro"),
  /** NULL = 加 ASN 之前写的旧行（读到时当作过期，重新问一次）。 */
  geoAsn: varchar("geoAsn", { length: 16 }),
  geoIsp: text("geoIsp"),
  geoOrg: text("geoOrg"),
  provider: varchar("provider", { length: 32 }).notNull().default("ipapi.co"),
  fetchedAt: epoch("fetchedAt").notNull().default(nowDefault()),
  expiresAt: epoch("expiresAt").notNull(),
});
export type IpGeoCache = typeof ipGeoCache.$inferSelect;
export type InsertIpGeoCache = typeof ipGeoCache.$inferInsert;

export const agentTokens = table("agent_tokens", {
  id: serial("id"),
  token: text("token").notNull().unique(),
  hostId: int("hostId"),
  description: text("description"),
  isUsed: boolean("isUsed").notNull().default(false),
  sortOrder: int("sortOrder").notNull().default(0),
  userId: int("userId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type AgentToken = typeof agentTokens.$inferSelect;
export type InsertAgentToken = typeof agentTokens.$inferInsert;

export const forwardTests = table("forward_tests", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  userId: int("userId").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"), // pending | running | success | failed | timeout
  listenOk: boolean("listenOk").notNull().default(false),
  targetReachable: boolean("targetReachable").notNull().default(false),
  forwardOk: boolean("forwardOk").notNull().default(false),
  latencyMs: int("latencyMs"),
  message: longtext("message"),
  // The dispatch payload (self-test meta). `message` is overwritten by the
  // Agent's result, so batch aggregation and timeouts read this instead.
  requestMessage: text("requestMessage"),
  // Durable multi-hop batch ("fc-..." forward chain, "tb-..." tunnel hops). Rows
  // of a batch are aggregated from the database, so a panel restart no longer
  // loses the batch; batchSettled is the single-winner claim on aggregation.
  batchId: varchar("batchId", { length: 96 }),
  batchSettled: boolean("batchSettled").notNull().default(false),
  // First delivery to an Agent; lease renewals never extend the timeout.
  firstDispatchedAt: epoch("firstDispatchedAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type ForwardTest = typeof forwardTests.$inferSelect;
export type InsertForwardTest = typeof forwardTests.$inferInsert;

// ===== TCPing 延迟统计表 =====
export const tcpingStats = table("tcping_stats", {
  id: serial("id"),
  ruleId: int("ruleId").notNull(),
  hostId: int("hostId").notNull(),
  latencyMs: int("latencyMs"),           // 延迟毫秒数，null 表示超时/不可达
  isTimeout: boolean("isTimeout").notNull().default(false),
  probeCount: int("probeCount").notNull().default(1),
  probeSuccesses: int("probeSuccesses").notNull().default(0),
  healthStatus: varchar("healthStatus", { length: 16 }),
  healthPending: boolean("healthPending").notNull().default(false),
  recordedAt: epoch("recordedAt").notNull().default(nowDefault()),
});
export type TcpingStat = typeof tcpingStats.$inferSelect;
export type InsertTcpingStat = typeof tcpingStats.$inferInsert;

// ===== 系统设置表（键值存储） =====
export const systemSettings = table("system_settings", {
  key: varchar("key", { length: 191 }).primaryKey(),
  value: longtext("value"),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// ===== Payment orders =====
export const paymentOrders = table("payment_orders", {
  id: serial("id"),
  outTradeNo: text("outTradeNo").notNull().unique(),
  userId: int("userId").notNull(),
  provider: varchar("provider", { length: 32 }).notNull(), // easypay | alipay | wxpay | stripe | gmpay
  paymentType: varchar("paymentType", { length: 32 }).notNull(), // alipay | wxpay | stripe | usdt
  status: varchar("status", { length: 32 }).notNull().default("pending"), // pending | paid | completed | expired | cancelled | failed
  subject: text("subject").notNull(),
  amountCents: bigint("amountCents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 16 }).notNull().default("CNY"),
  tradeNo: text("tradeNo"),
  payUrl: text("payUrl"),
  qrCode: text("qrCode"),
  orderType: varchar("orderType", { length: 32 }).notNull().default("balance"), // balance | plan | test
  planId: int("planId"),
  // 买的是哪一档周期。下单和收款之间隔着一次跳转，不存下来这个选择就丢了 ——
  // 回调回来只知道「买了这个套餐」，开出来的就会是默认档。
  planDurationDays: int("planDurationDays"),
  subscriptionId: int("subscriptionId"),
  discountCodeId: int("discountCodeId"),
  discountConsumed: boolean("discountConsumed").notNull().default(false),
  discountAmountCents: bigint("discountAmountCents", { mode: "number" }).notNull().default(0),
  clientIp: text("clientIp"),
  rawNotify: text("rawNotify"),
  expiresAt: epoch("expiresAt"),
  paidAt: epoch("paidAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type PaymentOrder = typeof paymentOrders.$inferSelect;
export type InsertPaymentOrder = typeof paymentOrders.$inferInsert;

// ===== Subscription plans =====
export const subscriptionPlans = table("subscription_plans", {
  id: serial("id"),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  currency: varchar("currency", { length: 16 }).notNull().default("CNY"),
  durationDays: int("durationDays").notNull().default(30),
  portCount: int("portCount").notNull().default(20),
  trafficLimit: bigint("trafficLimit", { mode: "number" }).notNull().default(0),
  rateLimitMbps: int("rateLimitMbps").notNull().default(0),
  maxRules: int("maxRules").notNull().default(20),
  // 套餐附带的自建落地节点数，0 = 不限制。只在套餐开了客户端订阅时才有意义。
  maxProxyInbounds: int("maxProxyInbounds").notNull().default(0),
  // 套餐附带的订阅地址条数，0 = 不限制。同样只在开了客户端订阅时有意义。
  maxProxySubTokens: int("maxProxySubTokens").notNull().default(0),
  maxConnections: int("maxConnections").notNull().default(2000),
  maxIPs: int("maxIPs").notNull().default(10),
  // 该套餐是否附带客户端订阅权限
  allowProxySubscription: boolean("allowProxySubscription").notNull().default(false),
  isActive: boolean("isActive").notNull().default(true),
  isStoreVisible: boolean("isStoreVisible").notNull().default(true),
  /**
   * 套餐附带的节点怎么给：false = 共用一个端口各发一份凭据（省端口，流量按端口
   * 统计、分不到人头上）；true = 每人在同一台机器上单开一个端口（能按人计量、
   * 能单独限速，代价是一人一个端口）。
   *
   * 之所以有这个二选一：sing-box 给不出 per-user 流量（官方二进制没编进 v2ray
   * API，clash API 的连接列表也没有用户字段，都实测过），而这套面板本来就按
   * 监听端口计数。想按量收费就只能一人一个端口。
   */
  dedicatedProxyPort: boolean("dedicatedProxyPort").notNull().default(false),
  // 订阅那一套的套餐权益：设备数上限（0 = 不限）、指定模板（0 = 全局默认）、能不能加外部订阅、信息节点默认开不开。
  maxProxyDevices: int("maxProxyDevices").notNull().default(0),
  proxySubTemplateId: int("proxySubTemplateId").notNull().default(0),
  allowExternalSubSources: boolean("allowExternalSubSources").notNull().default(false),
  showSubInfoNodes: boolean("showSubInfoNodes").notNull().default(false),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
  /**
   * 邀请返利比例，单位基点（1 bps = 0.01%，10000 = 100%）。0 = 这个套餐不返利。
   * 按套餐分开设：利润薄的套餐可以不返，引流套餐可以多返。
   */
  referralRateBps: int("referralRateBps").notNull().default(0),
});
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = typeof subscriptionPlans.$inferInsert;

/**
 * 套餐的多周期定价：一个套餐挂一组「周期 → 价格」。
 *
 * 空表示这个套餐只有它自己那一档（subscription_plans 上的 durationDays /
 * priceCents），存量数据全是这样 —— 所以这张表加进来不需要迁移任何东西。
 * 有行时以这张表为准，套餐主表上那两列退化成「默认档」，兑换码、后台分配、
 * 自动续费这些老路径照旧读它。
 */
export const subscriptionPlanPrices = table("subscription_plan_prices", {
  id: serial("id"),
  planId: int("planId").notNull(),
  durationDays: int("durationDays").notNull(),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanPrice = typeof subscriptionPlanPrices.$inferSelect;
export type InsertSubscriptionPlanPrice = typeof subscriptionPlanPrices.$inferInsert;

export const subscriptionPlanHosts = table("subscription_plan_hosts", {
  id: serial("id"),
  planId: int("planId").notNull(),
  hostId: int("hostId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanHost = typeof subscriptionPlanHosts.$inferSelect;
export type InsertSubscriptionPlanHost = typeof subscriptionPlanHosts.$inferInsert;

export const subscriptionPlanTunnels = table("subscription_plan_tunnels", {
  id: serial("id"),
  planId: int("planId").notNull(),
  tunnelId: int("tunnelId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanTunnel = typeof subscriptionPlanTunnels.$inferSelect;
export type InsertSubscriptionPlanTunnel = typeof subscriptionPlanTunnels.$inferInsert;

/**
 * 套餐附带哪些落地节点。
 *
 * 买了这个套餐（或被管理员分配），面板自动在这些节点上给他发一份独立凭据，
 * 到期、取消、换套餐就自动收回 —— 商家不必每来一个客户手工分一次节点。
 */
export const subscriptionPlanProxyNodes = table("subscription_plan_proxy_nodes", {
  id: serial("id"),
  planId: int("planId").notNull(),
  nodeId: int("nodeId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanProxyNode = typeof subscriptionPlanProxyNodes.$inferSelect;
export type InsertSubscriptionPlanProxyNode = typeof subscriptionPlanProxyNodes.$inferInsert;

export const subscriptionPlanForwardGroups = table("subscription_plan_forward_groups", {
  id: serial("id"),
  planId: int("planId").notNull(),
  forwardGroupId: int("forwardGroupId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanForwardGroup = typeof subscriptionPlanForwardGroups.$inferSelect;
export type InsertSubscriptionPlanForwardGroup = typeof subscriptionPlanForwardGroups.$inferInsert;

export const subscriptionPlanTrafficAddons = table("subscription_plan_traffic_addons", {
  id: serial("id"),
  planId: int("planId").notNull(),
  trafficBytes: bigint("trafficBytes", { mode: "number" }).notNull().default(0),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type SubscriptionPlanTrafficAddon = typeof subscriptionPlanTrafficAddons.$inferSelect;
export type InsertSubscriptionPlanTrafficAddon = typeof subscriptionPlanTrafficAddons.$inferInsert;

export const userSubscriptions = table("user_subscriptions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  planId: int("planId").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"), // active | expired | cancelled
  source: varchar("source", { length: 32 }).notNull().default("admin"), // admin | payment | balance | redeem
  paymentOrderNo: text("paymentOrderNo"),
  planSnapshot: text("planSnapshot"),
  // 这条订阅当初按哪一档买的。自动续费要按同一档续 —— 按月付的人不该某天
  // 醒来发现被扣了一年的钱。
  durationDays: int("durationDays"),
  portRangeStart: int("portRangeStart"),
  portRangeEnd: int("portRangeEnd"),
  nextTrafficResetAt: epoch("nextTrafficResetAt"),
  lastTrafficResetAt: epoch("lastTrafficResetAt"),
  userDismissedAt: epoch("userDismissedAt"),
  adminDismissedAt: epoch("adminDismissedAt"),
  startedAt: epoch("startedAt").notNull().default(nowDefault()),
  expiresAt: epoch("expiresAt"),
  /**
   * 到期时用余额自动续一期。
   *
   * 商家系统里「到期 → 断服 → 客户发现 → 手工去付 → 等回调」这一串每一步都在
   * 掉人。余额够就自动续，是把这一串砍成零步。默认关：从用户余额里扣钱这件事
   * 得他自己点头。
   */
  autoRenew: boolean("autoRenew").notNull().default(false),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type UserSubscription = typeof userSubscriptions.$inferSelect;
export type InsertUserSubscription = typeof userSubscriptions.$inferInsert;

export const userTrafficAddons = table("user_traffic_addons", {
  id: serial("id"),
  userId: int("userId").notNull(),
  subscriptionId: int("subscriptionId").notNull(),
  planId: int("planId").notNull(),
  addonId: int("addonId"),
  trafficBytes: bigint("trafficBytes", { mode: "number" }).notNull().default(0),
  priceCents: bigint("priceCents", { mode: "number" }).notNull().default(0),
  source: varchar("source", { length: 32 }).notNull().default("user"), // user | admin
  status: varchar("status", { length: 32 }).notNull().default("active"), // active | expired
  operatorUserId: int("operatorUserId"),
  description: text("description"),
  cycleResetAt: epoch("cycleResetAt"),
  expiresAt: epoch("expiresAt"),
  expiredAt: epoch("expiredAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type UserTrafficAddon = typeof userTrafficAddons.$inferSelect;
export type InsertUserTrafficAddon = typeof userTrafficAddons.$inferInsert;

export const balanceTransactions = table("balance_transactions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  type: varchar("type", { length: 32 }).notNull(), // admin_recharge | admin_adjust | payment | purchase | redeem | traffic_addon_purchase | referral_commission
  amountCents: bigint("amountCents", { mode: "number" }).notNull(),
  balanceAfterCents: bigint("balanceAfterCents", { mode: "number" }).notNull(),
  description: text("description"),
  operatorUserId: int("operatorUserId"),
  paymentOrderNo: text("paymentOrderNo"),
  redemptionCodeId: int("redemptionCodeId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type BalanceTransaction = typeof balanceTransactions.$inferSelect;
export type InsertBalanceTransaction = typeof balanceTransactions.$inferInsert;

export const trafficBillingConfigs = table("traffic_billing_configs", {
  id: serial("id"),
  resourceType: varchar("resourceType", { length: 16 }).notNull(), // host | tunnel | forward_group
  resourceId: int("resourceId").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  requiresPermission: boolean("requiresPermission").notNull().default(false),
  description: text("description"),
  pricePerGbCents: bigint("pricePerGbCents", { mode: "number" }).notNull().default(0),
  pricePerGbMilliCents: bigint("pricePerGbMilliCents", { mode: "number" }).notNull().default(0),
  multiplier: int("multiplier").notNull().default(100), // snapshot from linked resource, 0.01x = 1, 1x = 100, 50x = 5000
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingConfig = typeof trafficBillingConfigs.$inferSelect;
export type InsertTrafficBillingConfig = typeof trafficBillingConfigs.$inferInsert;

export const trafficBillingRecords = table("traffic_billing_records", {
  id: serial("id"),
  userId: int("userId").notNull(),
  ruleId: int("ruleId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  billedGb: int("billedGb").notNull().default(0),
  pricePerGbCents: bigint("pricePerGbCents", { mode: "number" }).notNull().default(0),
  pricePerGbMilliCents: bigint("pricePerGbMilliCents", { mode: "number" }).notNull().default(0),
  multiplier: int("multiplier").notNull().default(100),
  amountCents: bigint("amountCents", { mode: "number" }).notNull().default(0),
  balanceAfterCents: bigint("balanceAfterCents", { mode: "number" }).notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type TrafficBillingRecord = typeof trafficBillingRecords.$inferSelect;
export type InsertTrafficBillingRecord = typeof trafficBillingRecords.$inferInsert;

export const trafficBillingUsage = table("traffic_billing_usage", {
  id: serial("id"),
  userId: int("userId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  totalBytes: bigint("totalBytes", { mode: "number" }).notNull().default(0),
  billedGb: int("billedGb").notNull().default(0),
  pendingMilliCents: bigint("pendingMilliCents", { mode: "number" }).notNull().default(0),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingUsage = typeof trafficBillingUsage.$inferSelect;
export type InsertTrafficBillingUsage = typeof trafficBillingUsage.$inferInsert;

export const trafficBillingRuleUsage = table("traffic_billing_rule_usage", {
  id: serial("id"),
  userId: int("userId").notNull(),
  ruleId: int("ruleId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  totalBytes: bigint("totalBytes", { mode: "number" }).notNull().default(0),
  billedGb: int("billedGb").notNull().default(0),
  pendingMilliCents: bigint("pendingMilliCents", { mode: "number" }).notNull().default(0),
  settled: boolean("settled").notNull().default(false),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type TrafficBillingRuleUsage = typeof trafficBillingRuleUsage.$inferSelect;
export type InsertTrafficBillingRuleUsage = typeof trafficBillingRuleUsage.$inferInsert;

export const userTrafficBillingPermissions = table("user_traffic_billing_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  resourceType: varchar("resourceType", { length: 16 }).notNull(),
  resourceId: int("resourceId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserTrafficBillingPermission = typeof userTrafficBillingPermissions.$inferSelect;
export type InsertUserTrafficBillingPermission = typeof userTrafficBillingPermissions.$inferInsert;

export const redemptionCodes = table("redemption_codes", {
  id: serial("id"),
  code: text("code").notNull().unique(),
  type: varchar("type", { length: 32 }).notNull(), // plan | balance
  planId: int("planId"),
  durationDays: int("durationDays"),
  amountCents: bigint("amountCents", { mode: "number" }).notNull().default(0),
  startsAt: epoch("startsAt"),
  expiresAt: epoch("expiresAt"),
  isActive: boolean("isActive").notNull().default(true),
  usedByUserId: int("usedByUserId"),
  usedAt: epoch("usedAt"),
  createdByUserId: int("createdByUserId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type RedemptionCode = typeof redemptionCodes.$inferSelect;
export type InsertRedemptionCode = typeof redemptionCodes.$inferInsert;

export const discountCodes = table("discount_codes", {
  id: serial("id"),
  code: text("code").notNull().unique(),
  discountType: varchar("discountType", { length: 32 }).notNull(), // percent | amount
  discountValue: int("discountValue").notNull(),
  maxUses: int("maxUses").notNull().default(0),
  usedCount: int("usedCount").notNull().default(0),
  startsAt: epoch("startsAt"),
  expiresAt: epoch("expiresAt"),
  isActive: boolean("isActive").notNull().default(true),
  createdByUserId: int("createdByUserId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type DiscountCode = typeof discountCodes.$inferSelect;
export type InsertDiscountCode = typeof discountCodes.$inferInsert;

export const discountCodePlans = table("discount_code_plans", {
  id: serial("id"),
  discountCodeId: int("discountCodeId").notNull(),
  planId: int("planId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type DiscountCodePlan = typeof discountCodePlans.$inferSelect;
export type InsertDiscountCodePlan = typeof discountCodePlans.$inferInsert;

/**
 * 邀请返利记录：每一行是「被邀请人买了一次套餐，给邀请人返了多少」。
 *
 * (sourceType, sourceRef) 唯一，是幂等锁 —— 支付回调重放、维护任务重试、同一笔订单
 * 被结算两次，都只能插进来一行、只返一次钱。sourceRef：在线支付是订单号
 * （outTradeNo），余额购买是那笔扣款的余额流水 id。
 *
 * 返利本身记在 balance_transactions（type = referral_commission），paymentOrderNo 故意
 * 留空：那一列被当成「这笔订单是否已入账」的判断依据，带上被邀请人的订单号会让
 * 被邀请人自己的订单被误判为已入账。
 */
export const referralCommissions = table("referral_commissions", {
  id: serial("id"),
  inviterId: int("inviterId").notNull(),
  inviteeId: int("inviteeId").notNull(),
  sourceType: varchar("sourceType", { length: 32 }).notNull(), // payment_order | balance_purchase
  sourceRef: varchar("sourceRef", { length: 128 }).notNull(),
  planId: int("planId"),
  // 套餐名快照：套餐日后改名或删除，记录里仍是当时买的那个名字。
  planName: text("planName"),
  baseAmountCents: bigint("baseAmountCents", { mode: "number" }).notNull().default(0),
  rateBps: int("rateBps").notNull().default(0),
  commissionCents: bigint("commissionCents", { mode: "number" }).notNull().default(0),
  mode: varchar("mode", { length: 16 }).notNull().default("first"), // first | recurring
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ReferralCommission = typeof referralCommissions.$inferSelect;
export type InsertReferralCommission = typeof referralCommissions.$inferInsert;

export const announcements = table("announcements", {
  id: serial("id"),
  title: text("title").notNull(),
  content: longtext("content").notNull(),
  type: varchar("type", { length: 32 }).notNull().default("normal"), // normal | popup | upgrade_popup
  targetVersion: text("targetVersion"),
  isActive: boolean("isActive").notNull().default(true),
  startsAt: epoch("startsAt"),
  expiresAt: epoch("expiresAt"),
  createdByUserId: int("createdByUserId"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Announcement = typeof announcements.$inferSelect;
export type InsertAnnouncement = typeof announcements.$inferInsert;

export const announcementReads = table("announcement_reads", {
  id: serial("id"),
  announcementId: int("announcementId").notNull(),
  userId: int("userId").notNull(),
  dismissedAt: epoch("dismissedAt").notNull().default(nowDefault()),
});
export type AnnouncementRead = typeof announcementReads.$inferSelect;
export type InsertAnnouncementRead = typeof announcementReads.$inferInsert;

/** 工单（见 server/repositories/ticketRepository.ts）。status：waiting_staff | waiting_user | closed。 */
export const tickets = table("tickets", {
  id: serial("id"),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 128 }).notNull(),
  priority: varchar("priority", { length: 16 }).notNull().default("medium"), // low | medium | high
  status: varchar("status", { length: 32 }).notNull().default("waiting_staff"),
  lastMessageAt: epoch("lastMessageAt").notNull().default(nowDefault()),
  lastMessageByStaff: boolean("lastMessageByStaff").notNull().default(false),
  closedAt: epoch("closedAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type Ticket = typeof tickets.$inferSelect;
export type InsertTicket = typeof tickets.$inferInsert;

export const ticketMessages = table("ticket_messages", {
  id: serial("id"),
  ticketId: int("ticketId").notNull(),
  senderId: int("senderId"),
  isStaff: boolean("isStaff").notNull().default(false),
  content: longtext("content").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type TicketMessage = typeof ticketMessages.$inferSelect;
export type InsertTicketMessage = typeof ticketMessages.$inferInsert;

export const plugins = table("plugins", {
  id: serial("id"),
  pluginId: varchar("pluginId", { length: 128 }).notNull().unique(),
  name: text("name").notNull(),
  version: varchar("version", { length: 64 }).notNull().default("0.0.0"),
  description: text("description"),
  author: text("author"),
  homepage: text("homepage"),
  repository: text("repository"),
  sourceType: varchar("sourceType", { length: 32 }).notNull().default("github"), // github | upload | local
  sourceUrl: text("sourceUrl"),
  branch: varchar("branch", { length: 128 }),
  manifestPath: text("manifestPath"),
  manifestJson: text("manifestJson").notNull(),
  permissionsJson: text("permissionsJson"),
  extensionPointsJson: text("extensionPointsJson"),
  status: varchar("status", { length: 32 }).notNull().default("disabled"), // enabled | disabled | error
  trusted: boolean("trusted").notNull().default(false),
  installedAt: epoch("installedAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
  lastCheckedAt: epoch("lastCheckedAt"),
  latestVersion: varchar("latestVersion", { length: 64 }),
  lastError: text("lastError"),
});
export type Plugin = typeof plugins.$inferSelect;
export type InsertPlugin = typeof plugins.$inferInsert;

export const pluginStoreSources = table("plugin_store_sources", {
  id: serial("id"),
  name: text("name").notNull(),
  repository: text("repository").notNull(),
  branch: varchar("branch", { length: 128 }).notNull().default("main"),
  catalogPath: text("catalogPath").notNull().default("forwardx-store.json"),
  itemsJson: longtext("itemsJson"),
  lastSyncedAt: epoch("lastSyncedAt"),
  lastError: text("lastError"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type PluginStoreSource = typeof pluginStoreSources.$inferSelect;
export type InsertPluginStoreSource = typeof pluginStoreSources.$inferInsert;

export const pluginAssets = table("plugin_assets", {
  id: serial("id"),
  pluginId: varchar("pluginId", { length: 128 }).notNull(),
  path: text("path").notNull(),
  contentType: varchar("contentType", { length: 128 }),
  size: int("size").notNull().default(0),
  sha256: varchar("sha256", { length: 64 }),
  content: longtext("content"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type PluginAsset = typeof pluginAssets.$inferSelect;
export type InsertPluginAsset = typeof pluginAssets.$inferInsert;

export const pluginAgentStates = table("plugin_agent_states", {
  id: serial("id"),
  pluginId: varchar("pluginId", { length: 128 }).notNull(),
  resourceViewId: varchar("resourceViewId", { length: 128 }).notNull(),
  hostId: int("hostId").notNull(),
  pluginVersion: varchar("pluginVersion", { length: 64 }),
  actionId: varchar("actionId", { length: 128 }),
  groupId: varchar("groupId", { length: 64 }),
  taskId: varchar("taskId", { length: 64 }),
  status: varchar("status", { length: 32 }).notNull().default("idle"),
  dataJson: longtext("dataJson"),
  output: longtext("output"),
  error: text("error"),
  startedAt: epoch("startedAt"),
  finishedAt: epoch("finishedAt"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type PluginAgentState = typeof pluginAgentStates.$inferSelect;
export type InsertPluginAgentState = typeof pluginAgentStates.$inferInsert;

export const configAuditEvents = table("config_audit_events", {
  id: serial("id"),
  resourceType: varchar("resourceType", { length: 32 }).notNull(),
  resourceId: int("resourceId").notNull(),
  hostId: int("hostId"),
  action: varchar("action", { length: 32 }).notNull(),
  source: varchar("source", { length: 64 }).notNull().default("system"),
  actorUserId: int("actorUserId"),
  actorName: text("actorName"),
  requestId: varchar("requestId", { length: 64 }),
  requestPath: text("requestPath"),
  beforeJson: text("beforeJson"),
  afterJson: text("afterJson"),
  diffJson: text("diffJson"),
  configHash: varchar("configHash", { length: 64 }).notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type ConfigAuditEvent = typeof configAuditEvents.$inferSelect;
export type InsertConfigAuditEvent = typeof configAuditEvents.$inferInsert;

// ===== 用户-主机权限表（管理员指定用户可使用哪些 Agent/主机） =====
export const userHostPermissions = table("user_host_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  hostId: int("hostId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserHostPermission = typeof userHostPermissions.$inferSelect;
export type InsertUserHostPermission = typeof userHostPermissions.$inferInsert;

export const userTunnelPermissions = table("user_tunnel_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  tunnelId: int("tunnelId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserTunnelPermission = typeof userTunnelPermissions.$inferSelect;
export type InsertUserTunnelPermission = typeof userTunnelPermissions.$inferInsert;
export const userForwardGroupPermissions = table("user_forward_group_permissions", {
  id: serial("id"),
  userId: int("userId").notNull(),
  forwardGroupId: int("forwardGroupId").notNull(),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type UserForwardGroupPermission = typeof userForwardGroupPermissions.$inferSelect;
export type InsertUserForwardGroupPermission = typeof userForwardGroupPermissions.$inferInsert;

// ===== 自动换 IP（插件 auto-ip-change；建表定义见 server/ipChange/tables.ts，读写走 server/ipChange/repository.ts） =====
export const ipChangeCloudAccounts = table("ip_change_cloud_accounts", {
  id: serial("id"),
  name: varchar("name", { length: 128 }).notNull(),
  provider: varchar("provider", { length: 64 }).notNull(),
  /** AES-256-GCM 密文，见 server/ipChange/secrets.ts；永远不直接回给前端。 */
  credentialsJson: longtext("credentialsJson"),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type IpChangeCloudAccount = typeof ipChangeCloudAccounts.$inferSelect;

export const ipChangeHostConfigs = table("ip_change_host_configs", {
  id: serial("id"),
  hostId: int("hostId").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  autoEnabled: boolean("autoEnabled").notNull().default(false),
  cloudAccountId: int("cloudAccountId"),
  targetJson: text("targetJson"),
  checkTargets: text("checkTargets"),
  checkMethod: varchar("checkMethod", { length: 16 }).notNull().default("tcp"),
  failureThreshold: int("failureThreshold").notNull().default(5),
  checkIntervalSeconds: int("checkIntervalSeconds").notNull().default(60),
  cooldownMinutes: int("cooldownMinutes").notNull().default(30),
  maxChangesPerDay: int("maxChangesPerDay").notNull().default(3),
  releaseOldIp: boolean("releaseOldIp").notNull().default(true),
  state: varchar("state", { length: 32 }).notNull().default("idle"),
  consecutiveFailures: int("consecutiveFailures").notNull().default(0),
  lastCheckAt: epoch("lastCheckAt"),
  lastChangeAt: epoch("lastChangeAt"),
  lastError: text("lastError"),
  generation: int("generation").notNull().default(0),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type IpChangeHostConfig = typeof ipChangeHostConfigs.$inferSelect;

export const ipChangeEvents = table("ip_change_events", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  triggerKind: varchar("triggerKind", { length: 16 }).notNull().default("manual"),
  provider: varchar("provider", { length: 64 }),
  oldIp: varchar("oldIp", { length: 64 }),
  newIp: varchar("newIp", { length: 64 }),
  ipRole: varchar("ipRole", { length: 16 }),
  status: varchar("status", { length: 16 }).notNull().default("running"),
  error: text("error"),
  notes: text("notes"),
  startedAt: epoch("startedAt").notNull().default(nowDefault()),
  finishedAt: epoch("finishedAt"),
});
export type IpChangeEvent = typeof ipChangeEvents.$inferSelect;

// ===== 主机网络画像（建表定义见 server/ops/netProfileTables.ts，读写走 server/ops/netProfile.ts 的原生 SQL） =====
export const hostNetworkProfiles = table("host_network_profiles", {
  id: serial("id"),
  hostId: int("hostId").notNull().unique(),
  /** shared/netProfile.ts 的 NetProfileReport */
  profileJson: longtext("profileJson"),
  /** 最近 30 次的摘要（NetProfileHistoryItem[]） */
  historyJson: longtext("historyJson"),
  checkedAt: epoch("checkedAt"),
  agentCheckedAt: epoch("agentCheckedAt"),
  updatedAt: epoch("updatedAt").notNull().default(nowDefault()),
});
export type HostNetworkProfile = typeof hostNetworkProfiles.$inferSelect;

// ===== 流媒体 / AI 解锁检测（建表定义见 server/ops/unlockTables.ts，读写走 server/ops/unlock.ts） =====
export const hostUnlockChecks = table("host_unlock_checks", {
  id: serial("id"),
  hostId: int("hostId").notNull(),
  family: varchar("family", { length: 8 }).notNull().default("auto"),
  runId: varchar("runId", { length: 64 }).notNull().unique(),
  triggerKind: varchar("triggerKind", { length: 16 }).notNull().default("manual"),
  latest: boolean("latest").notNull().default(false),
  resultsJson: text("resultsJson").notNull(),
  requestedBy: int("requestedBy"),
  checkedAt: epoch("checkedAt").notNull().default(nowDefault()),
  createdAt: epoch("createdAt").notNull().default(nowDefault()),
});
export type HostUnlockCheck = typeof hostUnlockChecks.$inferSelect;
