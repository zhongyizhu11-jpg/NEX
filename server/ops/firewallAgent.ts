/*
  firewall 的 Agent 扩展模块（见 agentExt.ts）：地区规则（#4）+ IP 封禁（#5）。

  每轮给每台主机算一份指令（firewallDirective.ts），收 Agent 报回来的状态和拦截计数。
  规则、封禁列表、主机地址这些每台主机都要读的东西缓存 10 秒，保存时立即作废 ——
  一百台主机一分钟一轮，不缓存就是一分钟几百次同样的查询。
*/
import { registerAgentExtModule, hostSupportsAgentExt, wakeAgentExt, type AgentExtHost } from "./agentExt";
import { buildFirewallDirective, counterDelta, effectiveFirewallMode } from "./firewallDirective";
import {
  addDailyStats,
  effectiveHostRule,
  firewallDayKey,
  getHostState,
  listActiveBlocked,
  listFirewallHosts,
  listHostPolicies,
  listManagedPorts,
  pruneDailyStats,
  readHostCountryRule,
  readPanelAccessRule,
  saveHostState,
  type CountryRule,
  type HostFirewallState,
  type HostPolicyRow,
} from "./firewallStore";
import { combinedCountryGeo, ensureCountryData, scheduleCountryDataRefresh } from "./firewallCountryData";
import { recordPanelEvent } from "./panelEvents";

type FirewallContext = {
  global: CountryRule;
  policies: Map<number, HostPolicyRow>;
  blocked: string[];
  trusted: string[];
  selectedCountries: string[];
  loadedAt: number;
};

const CONTEXT_TTL_MS = 10_000;
let contextCache: FirewallContext | null = null;
let contextLoad: Promise<FirewallContext> | null = null;

export function invalidateFirewallContext() {
  contextCache = null;
}

async function loadContext(): Promise<FirewallContext> {
  const [global, policies, blockedRows, hosts, panelRule] = await Promise.all([
    readHostCountryRule(),
    listHostPolicies(),
    listActiveBlocked(),
    listFirewallHosts(),
    readPanelAccessRule(),
  ]);
  const selected = new Set<string>();
  if (global.mode !== "off") global.countries.forEach((code) => selected.add(code));
  for (const policy of policies.values()) {
    if (policy.policy === "custom" && policy.rule.mode !== "off") policy.rule.countries.forEach((code) => selected.add(code));
  }
  if (panelRule.mode !== "off") panelRule.countries.forEach((code) => selected.add(code));
  return {
    global,
    policies,
    blocked: blockedRows.map((row) => row.cidr),
    trusted: hosts.flatMap((host) => host.addresses),
    selectedCountries: Array.from(selected).sort(),
    loadedAt: Date.now(),
  };
}

export async function getFirewallContext(): Promise<FirewallContext> {
  if (contextCache && Date.now() - contextCache.loadedAt < CONTEXT_TTL_MS) return contextCache;
  if (!contextLoad) {
    contextLoad = loadContext()
      .then((value) => {
        contextCache = value;
        return value;
      })
      .finally(() => {
        contextLoad = null;
      });
  }
  return contextLoad;
}

type ReportedState = { countryHash: string };
const lastReports = new Map<number, ReportedState>();
const stateCache = new Map<number, HostFirewallState>();

/** 这台主机现在该下发什么（地区规则页「当前生效」那一栏也用它）。 */
export async function firewallPlanForHost(hostId: number) {
  const context = await getFirewallContext();
  const rule = effectiveHostRule(context.global, context.policies.get(hostId));
  const geo = rule.mode !== "off" ? await combinedCountryGeo(rule.countries) : null;
  if (rule.mode !== "off" && geo && !geo.ready) void ensureCountryData(geo.missing);
  return { context, rule, geo, effect: effectiveFirewallMode(rule.mode, geo) };
}

async function directiveForHost(host: AgentExtHost) {
  if (!hostSupportsAgentExt(host)) return undefined;
  const hostId = Number(host.id);
  const { context, rule, geo } = await firewallPlanForHost(hostId);
  scheduleCountryDataRefresh(context.selectedCountries);
  const ports = await listManagedPorts(hostId);
  return buildFirewallDirective({
    mode: rule.mode,
    geo,
    ports,
    blocked: context.blocked,
    trusted: context.trusted,
    reportedCountryHash: lastReports.get(hostId)?.countryHash ?? null,
  });
}

type AgentFirewallReport = {
  hash: string;
  countryHash: string;
  backend: string;
  active: boolean;
  error: string;
  since: number;
  block: number;
  country: number;
  ports: number;
};

function parseReport(value: unknown): AgentFirewallReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  return {
    hash: String(raw.hash || "").slice(0, 64),
    countryHash: String(raw.countryHash || "").slice(0, 64),
    backend: String(raw.backend || "").slice(0, 16),
    active: raw.active === true,
    error: String(raw.error || "").slice(0, 500),
    since: num(raw.since),
    block: num(raw.block),
    country: num(raw.country),
    ports: num(raw.ports),
  };
}

let lastPruneDay = "";

async function ingestReport(host: AgentExtHost, value: unknown) {
  const report = parseReport(value);
  if (!report) return;
  const hostId = Number(host.id);
  lastReports.set(hostId, { countryHash: report.countryHash });
  let previous = stateCache.get(hostId) ?? null;
  if (!previous) previous = await getHostState(hostId);
  const blockDelta = counterDelta(previous ? { since: previous.since, value: previous.lastBlock } : null, { since: report.since, value: report.block });
  const countryDelta = counterDelta(previous ? { since: previous.since, value: previous.lastCountry } : null, { since: report.since, value: report.country });
  const day = firewallDayKey();
  if (blockDelta > 0 || countryDelta > 0) await addDailyStats(hostId, day, blockDelta, countryDelta);
  const now = new Date();
  const next: HostFirewallState = {
    hostId,
    appliedHash: report.hash,
    countryHash: report.countryHash,
    backend: report.backend,
    active: report.active,
    lastError: report.error,
    since: report.since,
    lastBlock: report.block,
    lastCountry: report.country,
    ports: report.ports,
    reportedAt: now,
  };
  const changed = !previous
    || previous.appliedHash !== next.appliedHash
    || previous.countryHash !== next.countryHash
    || previous.backend !== next.backend
    || previous.active !== next.active
    || previous.lastError !== next.lastError
    || previous.since !== next.since
    || previous.lastBlock !== next.lastBlock
    || previous.lastCountry !== next.lastCountry
    || previous.ports !== next.ports
    || !previous.reportedAt
    || now.getTime() - previous.reportedAt.getTime() > 5 * 60_000;
  if (changed) {
    await saveHostState(next);
    stateCache.set(hostId, next);
  } else if (previous) {
    stateCache.set(hostId, { ...previous, reportedAt: previous.reportedAt });
  }
  // 「等面板发来国家 IP 段」是换国家后那一轮的正常过渡，不记事件。
  if (report.error && report.error !== (previous?.lastError || "") && !report.error.startsWith("等面板")) {
    void recordPanelEvent({
      kind: "security.firewall_error",
      level: "warn",
      hostId,
      message: `${host.name || `主机 #${hostId}`} 的地区规则 / IP 封禁没能生效：${report.error}`,
    });
  }
  if (day !== lastPruneDay) {
    lastPruneDay = day;
    void pruneDailyStats().catch(() => undefined);
  }
}

/** 刚保存了规则：作废缓存，让受影响的主机马上来取。 */
export async function wakeFirewallHosts(hostIds?: number[]) {
  invalidateFirewallContext();
  const hosts = await listFirewallHosts();
  const targets = hostIds ? hosts.filter((host) => hostIds.includes(host.id)) : hosts;
  for (const host of targets) {
    if (!hostSupportsAgentExt(host)) continue;
    try {
      wakeAgentExt(host.id, "firewall");
    } catch {
      // 没连着事件流：下一轮照常来取
    }
  }
}

export function cachedHostFirewallState(hostId: number) {
  return stateCache.get(hostId) ?? null;
}

registerAgentExtModule({
  name: "firewall",
  directive: directiveForHost,
  ingest: ingestReport,
});
