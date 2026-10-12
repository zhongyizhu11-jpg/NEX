/*
  地区规则 / IP 封禁的存取：系统设置里的两条规则、主机单独规则、封禁列表、Agent 上报的状态和每日计数。
  全部是裸 SQL（三种数据库通用，不用方言语法），表定义见 firewallTables.ts。
*/
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawEpochToDate } from "../dbRuntime";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import {
  FIREWALL_HOST_POLICIES,
  FIREWALL_MODES,
  normalizeFirewallCountries,
  type FirewallHostPolicy,
  type FirewallMode,
} from "../../shared/firewallCountries";
import { formatCidrShort, parseCidr } from "./firewallCidr";

const q = (name: string) => quoteDbIdentifier(name);

export const HOST_RULE_SETTING = "ops.firewall.hostRule";
export const PANEL_RULE_SETTING = "ops.firewall.panelRule";

export type CountryRule = { mode: FirewallMode; countries: string[] };
export type PanelAccessRule = CountryRule & { includeSubscription: boolean };

export function normalizeMode(value: unknown): FirewallMode {
  return FIREWALL_MODES.includes(value as FirewallMode) ? value as FirewallMode : "off";
}

export function normalizeHostPolicy(value: unknown): FirewallHostPolicy {
  return FIREWALL_HOST_POLICIES.includes(value as FirewallHostPolicy) ? value as FirewallHostPolicy : "follow";
}

function parseJson(text: string | null): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function normalizeCountryRule(value: any): CountryRule {
  const countries = normalizeFirewallCountries(value?.countries);
  const mode = normalizeMode(value?.mode);
  // 选了模式却一个国家都没有：「只放行」会挡掉所有人，「拦截」什么也不挡 —— 都按关闭算。
  return { mode: countries.length > 0 ? mode : "off", countries };
}

export async function readHostCountryRule(): Promise<CountryRule> {
  return normalizeCountryRule(parseJson(await getSetting(HOST_RULE_SETTING)));
}

export async function writeHostCountryRule(rule: CountryRule) {
  await setSetting(HOST_RULE_SETTING, JSON.stringify(normalizeCountryRule(rule)));
}

export function normalizePanelRule(value: any): PanelAccessRule {
  return { ...normalizeCountryRule(value), includeSubscription: value?.includeSubscription === true };
}

export async function readPanelAccessRule(): Promise<PanelAccessRule> {
  return normalizePanelRule(parseJson(await getSetting(PANEL_RULE_SETTING)));
}

export async function writePanelAccessRule(rule: PanelAccessRule) {
  await setSetting(PANEL_RULE_SETTING, JSON.stringify(normalizePanelRule(rule)));
}

// ── 主机单独规则 ──────────────────────────────────────────────

export type HostPolicyRow = { hostId: number; policy: FirewallHostPolicy; rule: CountryRule };

function rowToHostPolicy(row: any): HostPolicyRow {
  const countries = String(row?.countries || "").split(",").filter(Boolean);
  return {
    hostId: Number(row.hostId),
    policy: normalizeHostPolicy(row.policy),
    rule: normalizeCountryRule({ mode: row.mode, countries }),
  };
}

export async function listHostPolicies(): Promise<Map<number, HostPolicyRow>> {
  const rows = await queryRaw(`SELECT ${q("hostId")}, ${q("policy")}, ${q("mode")}, ${q("countries")} FROM ${q("firewall_host_policies")}`);
  const map = new Map<number, HostPolicyRow>();
  for (const row of rows) map.set(Number((row as any).hostId), rowToHostPolicy(row));
  return map;
}

export async function getHostPolicy(hostId: number): Promise<HostPolicyRow> {
  const rows = await queryRaw(
    `SELECT ${q("hostId")}, ${q("policy")}, ${q("mode")}, ${q("countries")} FROM ${q("firewall_host_policies")} WHERE ${q("hostId")} = ?`,
    [hostId],
  );
  return rows[0] ? rowToHostPolicy(rows[0]) : { hostId, policy: "follow", rule: { mode: "off", countries: [] } };
}

export async function saveHostPolicy(hostId: number, policy: FirewallHostPolicy, rule: CountryRule) {
  const normalized = normalizeCountryRule(rule);
  const now = Math.floor(Date.now() / 1000);
  const existing = await queryRaw(`SELECT ${q("id")} FROM ${q("firewall_host_policies")} WHERE ${q("hostId")} = ?`, [hostId]);
  if (policy === "follow") {
    if (existing.length > 0) await executeRaw(`DELETE FROM ${q("firewall_host_policies")} WHERE ${q("hostId")} = ?`, [hostId]);
    return;
  }
  const values = [policy, normalized.mode, normalized.countries.join(","), now];
  if (existing.length > 0) {
    await executeRaw(
      `UPDATE ${q("firewall_host_policies")} SET ${q("policy")} = ?, ${q("mode")} = ?, ${q("countries")} = ?, ${q("updatedAt")} = ? WHERE ${q("hostId")} = ?`,
      [...values, hostId],
    );
  } else {
    await insertAndGetId("firewall_host_policies", { hostId, policy, mode: normalized.mode, countries: normalized.countries.join(","), updatedAt: now });
  }
}

/** 这台主机实际生效的地区规则。 */
export function effectiveHostRule(global: CountryRule, policy: HostPolicyRow | undefined): CountryRule {
  if (!policy || policy.policy === "follow") return global;
  if (policy.policy === "off") return { mode: "off", countries: [] };
  return policy.rule;
}

// ── 封禁列表 ──────────────────────────────────────────────

export type BlockedIpRow = {
  id: number;
  cidr: string;
  note: string;
  expiresAt: Date | null;
  createdAt: Date | null;
  createdBy: number | null;
};

function rowToBlocked(row: any): BlockedIpRow {
  return {
    id: Number(row.id),
    cidr: String(row.cidr || ""),
    note: String(row.note || ""),
    expiresAt: rawEpochToDate(row.expiresAt),
    createdAt: rawEpochToDate(row.createdAt),
    createdBy: row.createdBy == null ? null : Number(row.createdBy),
  };
}

const BLOCKED_COLUMNS = () => ["id", "cidr", "note", "expiresAt", "createdBy", "createdAt"].map(q).join(", ");

/** 还在生效的封禁（没过期的）。 */
export async function listActiveBlocked(nowSeconds = Math.floor(Date.now() / 1000)): Promise<BlockedIpRow[]> {
  const rows = await queryRaw(
    `SELECT ${BLOCKED_COLUMNS()} FROM ${q("firewall_blocked_ips")} WHERE ${q("expiresAt")} IS NULL OR ${q("expiresAt")} > ? ORDER BY ${q("id")} DESC`,
    [nowSeconds],
  );
  return rows.map(rowToBlocked);
}

export async function deleteExpiredBlocked(nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
  const rows = await queryRaw(
    `SELECT ${q("id")}, ${q("cidr")} FROM ${q("firewall_blocked_ips")} WHERE ${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} <= ?`,
    [nowSeconds],
  );
  if (rows.length === 0) return 0;
  await executeRaw(
    `DELETE FROM ${q("firewall_blocked_ips")} WHERE ${q("expiresAt")} IS NOT NULL AND ${q("expiresAt")} <= ?`,
    [nowSeconds],
  );
  return rows.length;
}

/** 封禁一个地址 / 网段；已经在列表里就更新备注和到期时间。返回 { row, created }。 */
export async function upsertBlocked(input: { cidr: string; note: string; expiresAt: number | null; createdBy: number | null }) {
  const parsed = parseCidr(input.cidr);
  if (!parsed) throw new Error("IP 或网段格式不对");
  const cidr = formatCidrShort(parsed);
  const note = String(input.note || "").trim().slice(0, 200);
  const existing = await queryRaw(`SELECT ${q("id")} FROM ${q("firewall_blocked_ips")} WHERE ${q("cidr")} = ?`, [cidr]);
  let id: number;
  let created = false;
  if (existing.length > 0) {
    id = Number((existing[0] as any).id);
    await executeRaw(
      `UPDATE ${q("firewall_blocked_ips")} SET ${q("note")} = ?, ${q("expiresAt")} = ? WHERE ${q("id")} = ?`,
      [note || null, input.expiresAt, id],
    );
  } else {
    id = await insertAndGetId("firewall_blocked_ips", {
      cidr,
      note: note || null,
      expiresAt: input.expiresAt ?? undefined,
      createdBy: input.createdBy ?? undefined,
      createdAt: Math.floor(Date.now() / 1000),
    });
    created = true;
  }
  const rows = await queryRaw(`SELECT ${BLOCKED_COLUMNS()} FROM ${q("firewall_blocked_ips")} WHERE ${q("id")} = ?`, [id]);
  return { row: rows[0] ? rowToBlocked(rows[0]) : null, created };
}

export async function deleteBlocked(id: number): Promise<BlockedIpRow | null> {
  const rows = await queryRaw(`SELECT ${BLOCKED_COLUMNS()} FROM ${q("firewall_blocked_ips")} WHERE ${q("id")} = ?`, [id]);
  if (!rows[0]) return null;
  await executeRaw(`DELETE FROM ${q("firewall_blocked_ips")} WHERE ${q("id")} = ?`, [id]);
  return rowToBlocked(rows[0]);
}

// ── Agent 上报的状态与计数 ──────────────────────────────────

export type HostFirewallState = {
  hostId: number;
  appliedHash: string;
  countryHash: string;
  backend: string;
  active: boolean;
  lastError: string;
  since: number;
  lastBlock: number;
  lastCountry: number;
  ports: number;
  reportedAt: Date | null;
};

const STATE_COLUMNS = ["hostId", "appliedHash", "countryHash", "backend", "active", "lastError", "since", "lastBlock", "lastCountry", "ports", "reportedAt"];

function rowToState(row: any): HostFirewallState {
  return {
    hostId: Number(row.hostId),
    appliedHash: String(row.appliedHash || ""),
    countryHash: String(row.countryHash || ""),
    backend: String(row.backend || ""),
    active: row.active === true || Number(row.active) === 1,
    lastError: String(row.lastError || ""),
    since: Number(row.since) || 0,
    lastBlock: Number(row.lastBlock) || 0,
    lastCountry: Number(row.lastCountry) || 0,
    ports: Number(row.ports) || 0,
    reportedAt: rawEpochToDate(row.reportedAt),
  };
}

export async function listHostStates(): Promise<Map<number, HostFirewallState>> {
  const rows = await queryRaw(`SELECT ${STATE_COLUMNS.map(q).join(", ")} FROM ${q("firewall_host_state")}`);
  const map = new Map<number, HostFirewallState>();
  for (const row of rows) map.set(Number((row as any).hostId), rowToState(row));
  return map;
}

export async function getHostState(hostId: number): Promise<HostFirewallState | null> {
  const rows = await queryRaw(`SELECT ${STATE_COLUMNS.map(q).join(", ")} FROM ${q("firewall_host_state")} WHERE ${q("hostId")} = ?`, [hostId]);
  return rows[0] ? rowToState(rows[0]) : null;
}

export async function saveHostState(state: HostFirewallState) {
  const reportedAt = state.reportedAt ? Math.floor(state.reportedAt.getTime() / 1000) : null;
  const values = [
    state.appliedHash.slice(0, 64), state.countryHash.slice(0, 64), state.backend.slice(0, 16), state.active,
    state.lastError.slice(0, 1000) || null, state.since, state.lastBlock, state.lastCountry, state.ports, reportedAt,
  ];
  const existing = await queryRaw(`SELECT ${q("id")} FROM ${q("firewall_host_state")} WHERE ${q("hostId")} = ?`, [state.hostId]);
  if (existing.length > 0) {
    const sets = STATE_COLUMNS.slice(1).map((name) => `${q(name)} = ?`).join(", ");
    await executeRaw(`UPDATE ${q("firewall_host_state")} SET ${sets} WHERE ${q("hostId")} = ?`, [...values, state.hostId]);
  } else {
    const record: Record<string, any> = { hostId: state.hostId };
    STATE_COLUMNS.slice(1).forEach((name, index) => { record[name] = values[index] ?? undefined; });
    await insertAndGetId("firewall_host_state", record);
  }
}

/** 北京时间的日期（YYYY-MM-DD）。「今天拦了多少」按这个切。 */
export function firewallDayKey(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export async function addDailyStats(hostId: number, day: string, blocked: number, country: number) {
  if (blocked <= 0 && country <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const existing = await queryRaw(
    `SELECT ${q("id")} FROM ${q("firewall_daily_stats")} WHERE ${q("hostId")} = ? AND ${q("day")} = ?`,
    [hostId, day],
  );
  if (existing.length > 0) {
    await executeRaw(
      `UPDATE ${q("firewall_daily_stats")} SET ${q("blocked")} = ${q("blocked")} + ?, ${q("country")} = ${q("country")} + ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
      [blocked, country, now, Number((existing[0] as any).id)],
    );
  } else {
    await insertAndGetId("firewall_daily_stats", { hostId, day, blocked, country, updatedAt: now });
  }
}

export async function listDailyStats(day: string): Promise<Map<number, { blocked: number; country: number }>> {
  const rows = await queryRaw(
    `SELECT ${q("hostId")}, ${q("blocked")}, ${q("country")} FROM ${q("firewall_daily_stats")} WHERE ${q("day")} = ?`,
    [day],
  );
  const map = new Map<number, { blocked: number; country: number }>();
  for (const row of rows as any[]) map.set(Number(row.hostId), { blocked: Number(row.blocked) || 0, country: Number(row.country) || 0 });
  return map;
}

/** 统计只留 60 天。 */
export async function pruneDailyStats(keepDays = 60) {
  const cutoff = firewallDayKey(new Date(Date.now() - keepDays * 86400_000));
  await executeRaw(`DELETE FROM ${q("firewall_daily_stats")} WHERE ${q("day")} < ?`, [cutoff]);
}

// ── 主机 ──────────────────────────────────────────────

export type FirewallHostRow = {
  id: number;
  name: string;
  agentVersion: string | null;
  isOnline: boolean;
  addresses: string[];
};

export async function listFirewallHosts(): Promise<FirewallHostRow[]> {
  const rows = await queryRaw(
    `SELECT ${["id", "name", "ip", "ipv4", "ipv6", "entryIp", "tunnelEntryIp", "agentVersion", "isOnline"].map(q).join(", ")}
       FROM ${q("hosts")} ORDER BY ${q("sortOrder")}, ${q("id")}`,
  );
  return (rows as any[]).map((row) => ({
    id: Number(row.id),
    name: String(row.name || `#${row.id}`),
    agentVersion: row.agentVersion ? String(row.agentVersion) : null,
    isOnline: row.isOnline === true || Number(row.isOnline) === 1,
    addresses: [row.ip, row.ipv4, row.ipv6, row.entryIp, row.tunnelEntryIp].map((value) => String(value || "").trim()).filter(Boolean),
  }));
}

export type ManagedPorts = { tcp: number[]; udp: number[] };

function addPort(target: Set<number>, value: unknown) {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) target.add(port);
}

function addByProtocol(ports: { tcp: Set<number>; udp: Set<number> }, port: unknown, protocol: unknown) {
  const proto = String(protocol || "both").toLowerCase();
  if (proto !== "udp") addPort(ports.tcp, port);
  if (proto !== "tcp") addPort(ports.udp, port);
}

/**
 * 面板在这台主机上管着的、对外的端口：
 *   - 转发规则的入口端口（含隧道入口；挂了入口组的隧道，组里每台成员机也在听）
 *   - 落地入站（sing-box）的端口 —— 协议分不清，TCP / UDP 都算
 *   - 换隧道后旧入口的临时桥接
 * 隧道出口 / 中转节点的监听端口不算：那些端口的连接来自别的主机（入口机），按国家拦会把隧道自己拦断。
 */
export async function listManagedPorts(hostId: number): Promise<ManagedPorts> {
  const ports = { tcp: new Set<number>(), udp: new Set<number>() };
  const ruleWhere = `${q("isEnabled")} = ? AND ${q("pendingDelete")} = ? AND ${q("isForwardGroupTemplate")} = ?`;
  const ruleParams = [true, false, false];
  const direct = await queryRaw(
    `SELECT ${q("sourcePort")}, ${q("protocol")} FROM ${q("forward_rules")} WHERE ${q("hostId")} = ? AND ${ruleWhere}`,
    [hostId, ...ruleParams],
  );
  for (const row of direct as any[]) addByProtocol(ports, row.sourcePort, row.protocol);
  const entryGroup = await queryRaw(
    `SELECT ${q("r")}.${q("sourcePort")}, ${q("r")}.${q("protocol")} FROM ${q("forward_rules")} ${q("r")}
      WHERE ${q("r")}.${q("isEnabled")} = ? AND ${q("r")}.${q("pendingDelete")} = ? AND ${q("r")}.${q("isForwardGroupTemplate")} = ?
        AND ${q("r")}.${q("tunnelId")} IN (
          SELECT ${q("t")}.${q("id")} FROM ${q("tunnels")} ${q("t")}
           WHERE ${q("t")}.${q("entryGroupId")} IN (
             SELECT ${q("g")}.${q("id")} FROM ${q("forward_groups")} ${q("g")}
              INNER JOIN ${q("forward_group_members")} ${q("m")} ON ${q("m")}.${q("groupId")} = ${q("g")}.${q("id")}
              WHERE ${q("g")}.${q("groupMode")} = ? AND ${q("g")}.${q("isEnabled")} = ?
                AND ${q("m")}.${q("memberType")} = ? AND ${q("m")}.${q("hostId")} = ? AND ${q("m")}.${q("isEnabled")} = ?
           )
        )`,
    [...ruleParams, "entry", true, "host", hostId, true],
  );
  for (const row of entryGroup as any[]) addByProtocol(ports, row.sourcePort, row.protocol);
  const inbounds = await queryRaw(
    `SELECT ${q("port")} FROM ${q("proxy_inbounds")} WHERE ${q("hostId")} = ? AND ${q("isEnabled")} = ?`,
    [hostId, true],
  );
  for (const row of inbounds as any[]) addByProtocol(ports, row.port, "both");
  try {
    const { getActiveEntryBridgesOnHost } = await import("../repositories/ruleEntryBridgeRepository");
    for (const bridge of await getActiveEntryBridgesOnHost(hostId)) addByProtocol(ports, bridge.sourcePort, bridge.protocol);
  } catch {
    // 桥接表读不到不影响主流程：少守一个临时端口而已。
  }
  const sorted = (set: Set<number>) => Array.from(set).sort((a, b) => a - b);
  return { tcp: sorted(ports.tcp), udp: sorted(ports.udp) };
}
