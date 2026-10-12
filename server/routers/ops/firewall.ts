import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../../_core/trpc";
import {
  FIREWALL_BLOCK_EXPIRY_SECONDS,
  FIREWALL_COUNTRY_DATA_ATTRIBUTION,
  FIREWALL_HOST_POLICIES,
  FIREWALL_MIN_AGENT_VERSION,
  FIREWALL_MODES,
  firewallCountryLabel,
  normalizeFirewallCountries,
  type FirewallBlockExpiry,
  type FirewallMode,
} from "../../../shared/firewallCountries";
import { classifyIpAddress } from "../../../shared/ipAddress";
import { hostSupportsAgentExt } from "../../ops/agentExt";
import { formatIp, normalizeClientIp, parseCidr } from "../../ops/firewallCidr";
import { countryDataStatus, ensureCountryData, lookupCachedCountry } from "../../ops/firewallCountryData";
import { cachedHostFirewallState, firewallPlanForHost, getFirewallContext, invalidateFirewallContext, wakeFirewallHosts } from "../../ops/firewallAgent";
import { buildCountryLookup, decidePanelAccess, invalidatePanelAccessCache, panelAccessSelfLockoutError } from "../../ops/firewallPanelAccess";
import {
  deleteBlocked,
  deleteExpiredBlocked,
  firewallDayKey,
  listActiveBlocked,
  listDailyStats,
  listFirewallHosts,
  listHostPolicies,
  listHostStates,
  normalizeCountryRule,
  normalizePanelRule,
  readHostCountryRule,
  readPanelAccessRule,
  saveHostPolicy,
  upsertBlocked,
  writeHostCountryRule,
  writePanelAccessRule,
  type CountryRule,
} from "../../ops/firewallStore";
import { recordPanelEvent } from "../../ops/panelEvents";
import { lookupAddressGeo } from "../../hostGeo";

/*
  trpc.ops.firewall.* —— 地区规则（#4）、面板访问的地区限制（#4b）、IP 封禁（#5）。
  全部是管理员接口；保存后让受影响的主机马上来取（wakeFirewallHosts）。
*/

const modeSchema = z.enum(FIREWALL_MODES as unknown as [FirewallMode, ...FirewallMode[]]);
const countriesSchema = z.array(z.string().trim().max(4)).max(260);

function describeRule(rule: CountryRule) {
  if (rule.mode === "off") return "关闭";
  const names = rule.countries.slice(0, 6).map(firewallCountryLabel).join("、");
  const more = rule.countries.length > 6 ? ` 等 ${rule.countries.length} 个` : "";
  return `${rule.mode === "block" ? "拦截" : "只放行"} ${names}${more}`;
}

function requesterIp(ctx: { req: any }) {
  return normalizeClientIp(ctx.req?.ip || ctx.req?.socket?.remoteAddress || "");
}

/** 你现在的 IP 属于哪国：先看本地缓存的国家段，没有再问一次归属地服务（只在打开这一页时问，不是每个请求）。 */
async function describeRequester(ip: string) {
  if (!ip) return { ip: "", country: null as string | null, isPrivate: false };
  const isPrivate = classifyIpAddress(ip) !== "public";
  if (isPrivate) return { ip, country: null, isPrivate };
  let country = await lookupCachedCountry(ip).catch(() => null);
  if (!country) {
    const geo = await Promise.race([
      lookupAddressGeo(ip).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000).unref?.()),
    ]);
    country = geo?.geoCountryCode ? String(geo.geoCountryCode).toUpperCase() : null;
  }
  return { ip, country, isPrivate };
}

const CIDR_MIN_PREFIX = { 4: 8, 6: 16 } as const;

export const firewallRouter = router({
  /** 地区规则页：全局规则 + 每台主机的跟随方式、当前生效、今日拦截。 */
  getCountryRule: adminProcedure.query(async () => {
    const [global, policies, hosts, states, today] = await Promise.all([
      readHostCountryRule(),
      listHostPolicies(),
      listFirewallHosts(),
      listHostStates(),
      listDailyStats(firewallDayKey()),
    ]);
    const rows = await Promise.all(hosts.map(async (host) => {
      const policy = policies.get(host.id);
      const { rule, effect } = await firewallPlanForHost(host.id);
      const state = cachedHostFirewallState(host.id) ?? states.get(host.id) ?? null;
      const stats = today.get(host.id) ?? { blocked: 0, country: 0 };
      return {
        id: host.id,
        name: host.name,
        isOnline: host.isOnline,
        agentVersion: host.agentVersion,
        supported: hostSupportsAgentExt(host),
        policy: policy?.policy ?? "follow",
        customRule: policy?.policy === "custom" ? policy.rule : { mode: "off" as FirewallMode, countries: [] as string[] },
        rule,
        effectiveMode: effect.mode,
        note: effect.note,
        state: state
          ? {
            active: state.active,
            backend: state.backend,
            error: state.lastError || null,
            ports: state.ports,
            reportedAt: state.reportedAt,
          }
          : null,
        today: { blocked: stats.blocked, country: stats.country, total: stats.blocked + stats.country },
      };
    }));
    const context = await getFirewallContext();
    return {
      global,
      hosts: rows,
      data: await countryDataStatus(context.selectedCountries),
      minAgentVersion: FIREWALL_MIN_AGENT_VERSION,
      attribution: FIREWALL_COUNTRY_DATA_ATTRIBUTION,
    };
  }),

  /** 保存全局规则（不带 hostId），或者某台主机的单独设置（带 hostId + policy）。 */
  saveCountryRule: adminProcedure
    .input(z.object({
      hostId: z.number().int().positive().optional(),
      policy: z.enum(FIREWALL_HOST_POLICIES as unknown as ["follow", "custom", "off"]).optional(),
      mode: modeSchema,
      countries: countriesSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      const rule = normalizeCountryRule({ mode: input.mode, countries: normalizeFirewallCountries(input.countries) });
      if (input.mode !== "off" && rule.countries.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "至少选一个国家或地区" });
      }
      if (input.hostId) {
        const hosts = await listFirewallHosts();
        const host = hosts.find((item) => item.id === input.hostId);
        if (!host) throw new TRPCError({ code: "NOT_FOUND", message: "主机不存在" });
        const policy = input.policy ?? "custom";
        await saveHostPolicy(host.id, policy, rule);
        const text = policy === "follow" ? "改为跟随全局" : policy === "off" ? "改为本机不限制" : `改为单独规则：${describeRule(rule)}`;
        void recordPanelEvent({ kind: "security.country_rule", level: "info", hostId: host.id, userId: ctx.user.id, message: `${host.name} 的地区规则${text}` });
        await wakeFirewallHosts([host.id]);
      } else {
        await writeHostCountryRule(rule);
        void recordPanelEvent({ kind: "security.country_rule", level: "info", userId: ctx.user.id, message: `主机的地区规则改为：${describeRule(rule)}` });
        await wakeFirewallHosts();
      }
      if (rule.mode !== "off") void ensureCountryData(rule.countries).catch(() => undefined);
      return { ok: true, rule };
    }),

  /** 谁能打开面板：规则 + 你现在的 IP。 */
  getPanelAccessRule: adminProcedure.query(async ({ ctx }) => {
    const rule = await readPanelAccessRule();
    const you = await describeRequester(requesterIp(ctx));
    let allowedNow = true;
    if (rule.mode !== "off" && you.ip) {
      allowedNow = decidePanelAccess(you.ip, rule, await buildCountryLookup(rule.countries)).allowed;
    }
    return {
      rule,
      you: { ...you, label: you.country ? firewallCountryLabel(you.country) : null, allowedNow },
      data: await countryDataStatus(rule.mode !== "off" ? rule.countries : []),
    };
  }),

  savePanelAccessRule: adminProcedure
    .input(z.object({ mode: modeSchema, countries: countriesSchema, includeSubscription: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const rule = normalizePanelRule({ ...input, countries: normalizeFirewallCountries(input.countries) });
      if (input.mode !== "off" && rule.countries.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "至少选一个国家或地区" });
      }
      if (rule.mode !== "off") {
        // 要先拿到国家段才能判断保存后会不会把自己锁在外面：最多等 25 秒。
        await ensureCountryData(rule.countries, { waitMs: 25_000 });
        const lockout = panelAccessSelfLockoutError(requesterIp(ctx), rule, await buildCountryLookup(rule.countries));
        if (lockout) throw new TRPCError({ code: "BAD_REQUEST", message: lockout });
      }
      await writePanelAccessRule(rule);
      invalidatePanelAccessCache();
      invalidateFirewallContext();
      void recordPanelEvent({
        kind: "security.panel_access",
        level: "info",
        userId: ctx.user.id,
        message: `面板访问限制改为：${describeRule(rule)}${rule.mode !== "off" && rule.includeSubscription ? "（订阅链接也一起限制）" : ""}`,
      });
      return { ok: true, rule };
    }),

  listBlocked: adminProcedure.query(async () => {
    await deleteExpiredBlocked().catch(() => 0);
    const [rows, today] = await Promise.all([listActiveBlocked(), listDailyStats(firewallDayKey())]);
    let todayBlocked = 0;
    for (const stats of today.values()) todayBlocked += stats.blocked;
    return {
      items: rows.map((row) => ({
        id: row.id,
        cidr: row.cidr,
        note: row.note,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      })),
      todayBlocked,
    };
  }),

  blockIp: adminProcedure
    .input(z.object({
      cidr: z.string().trim().min(1).max(64),
      note: z.string().trim().max(200).default(""),
      expiry: z.enum(["1h", "1d", "7d", "forever"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const parsed = parseCidr(input.cidr);
      if (!parsed) throw new TRPCError({ code: "BAD_REQUEST", message: "IP 或网段格式不对，例如 1.2.3.4、1.2.3.0/24、2001:db8::/48" });
      if (parsed.prefix < CIDR_MIN_PREFIX[parsed.family]) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `网段太大了：IPv4 最大 /${CIDR_MIN_PREFIX[4]}，IPv6 最大 /${CIDR_MIN_PREFIX[6]}。要挡一整个国家，用地区规则。` });
      }
      if (classifyIpAddress(formatIp(parsed.family, parsed.start)) !== "public") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "内网、环回这些地址本来就不会被拦截，不用封" });
      }
      const seconds = FIREWALL_BLOCK_EXPIRY_SECONDS[input.expiry as FirewallBlockExpiry];
      const expiresAt = seconds ? Math.floor(Date.now() / 1000) + seconds : null;
      const { row, created } = await upsertBlocked({ cidr: input.cidr, note: input.note, expiresAt, createdBy: ctx.user.id });
      await wakeFirewallHosts();
      const span = input.expiry === "forever" ? "永久" : input.expiry === "1h" ? "1 小时" : input.expiry === "1d" ? "1 天" : "7 天";
      void recordPanelEvent({
        kind: "security.ip_blocked",
        level: "info",
        userId: ctx.user.id,
        message: `${created ? "封禁了" : "更新了封禁"} ${row?.cidr || input.cidr}（${span}）${input.note ? `：${input.note}` : ""}`,
        data: { cidr: row?.cidr || input.cidr, expiry: input.expiry },
      });
      return { ok: true, created, item: row };
    }),

  unblockIp: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const row = await deleteBlocked(input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "这条封禁已经不在了" });
      await wakeFirewallHosts();
      void recordPanelEvent({ kind: "security.ip_unblocked", level: "info", userId: ctx.user.id, message: `解除了对 ${row.cidr} 的封禁` });
      return { ok: true };
    }),

  /** 选中的国家的数据下载情况。 */
  countryDataStatus: adminProcedure.query(async () => {
    const context = await getFirewallContext();
    return { countries: await countryDataStatus(context.selectedCountries), attribution: FIREWALL_COUNTRY_DATA_ATTRIBUTION };
  }),

  /** 立即重新下载选中国家的数据（不等一周）。 */
  refreshCountryData: adminProcedure.mutation(async () => {
    const context = await getFirewallContext();
    void ensureCountryData(context.selectedCountries, { force: true }).catch(() => undefined);
    return { ok: true, countries: context.selectedCountries };
  }),

  /** 每台主机今天拦了多少（blocked = IP 封禁，country = 地区规则）。 */
  hostStats: adminProcedure.query(async () => {
    const today = await listDailyStats(firewallDayKey());
    return Array.from(today.entries()).map(([hostId, stats]) => ({ hostId, ...stats, total: stats.blocked + stats.country }));
  }),
});

