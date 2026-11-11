import { appendPanelLog } from "./_core/panelLogger";
import { getDdnsSettings, updateDdnsRecord, updateDdnsRecordValues } from "./ddns";
import {
  describeHostDdnsPlan,
  hostDdnsPlanHasWork,
  hostDdnsRecordTypeFor,
  normalizeHostDdnsIpVersion,
  planHostDdnsRecords,
  type HostDdnsPlanSource,
} from "../shared/hostDdnsPlan";
import * as db from "./db";

const HOST_DDNS_RETRY_BASE_MS = 60_000;
const HOST_DDNS_RETRY_MAX_MS = 30 * 60_000;

type HostDdnsRetryState = {
  failures: number;
  retryAt: number;
};

type HostDdnsRetryTimer = ReturnType<typeof setTimeout>;
type SetHostDdnsRetryTimer = (callback: () => void, delayMs: number) => HostDdnsRetryTimer;
type ClearHostDdnsRetryTimer = (timer: HostDdnsRetryTimer) => void;

export class HostDdnsRetryScheduler {
  private readonly pending = new Map<number, { retryAt: number; timer: HostDdnsRetryTimer }>();

  constructor(
    private readonly retry: (hostId: number) => void | Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly setTimer: SetHostDdnsRetryTimer = setTimeout,
    private readonly clearTimer: ClearHostDdnsRetryTimer = clearTimeout,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  replace(hostIdValue: unknown, retryAtValue: unknown) {
    const hostId = Number(hostIdValue);
    const retryAt = Number(retryAtValue);
    if (!Number.isInteger(hostId) || hostId <= 0) return false;
    const existing = this.pending.get(hostId);
    if (!Number.isFinite(retryAt) || retryAt <= 0) {
      if (existing) this.clearTimer(existing.timer);
      this.pending.delete(hostId);
      return false;
    }
    if (existing?.retryAt === retryAt) return true;
    if (existing) this.clearTimer(existing.timer);
    const delayMs = Math.max(0, retryAt - this.now()) + 25;
    const timer = this.setTimer(() => {
      const current = this.pending.get(hostId);
      if (!current || current.timer !== timer) return;
      this.pending.delete(hostId);
      void Promise.resolve(this.retry(hostId)).catch(this.onError);
    }, delayMs);
    timer.unref?.();
    this.pending.set(hostId, { retryAt, timer });
    return true;
  }

  retryAt(hostIdValue: unknown) {
    return this.pending.get(Number(hostIdValue))?.retryAt ?? null;
  }
}

export class HostDdnsUpdateCoordinator {
  private readonly inFlight = new Set<number>();
  private readonly rerunRequested = new Set<number>();
  private readonly immediateRerunRequested = new Set<number>();
  private readonly retries = new Map<number, HostDdnsRetryState>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retryBaseMs = HOST_DDNS_RETRY_BASE_MS,
    private readonly retryMaxMs = HOST_DDNS_RETRY_MAX_MS,
  ) {}

  tryStart(hostId: number, options: { force?: boolean } = {}) {
    if (!Number.isInteger(hostId) || hostId <= 0) return false;
    if (options.force) this.retries.delete(hostId);
    if (this.inFlight.has(hostId)) {
      this.rerunRequested.add(hostId);
      if (options.force) this.immediateRerunRequested.add(hostId);
      return false;
    }
    this.inFlight.add(hostId);
    return true;
  }

  finish(hostId: number) {
    if (!this.inFlight.delete(hostId)) {
      return { rerunRequested: false, immediate: false };
    }
    return {
      rerunRequested: this.rerunRequested.delete(hostId),
      immediate: this.immediateRerunRequested.delete(hostId),
    };
  }

  recordSuccess(hostId: number) {
    this.retries.delete(hostId);
  }

  recordFailure(hostId: number) {
    const failures = (this.retries.get(hostId)?.failures || 0) + 1;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(failures - 1, 30)));
    const retryAt = this.now() + delay;
    this.retries.set(hostId, { failures, retryAt });
    return retryAt;
  }

  canReconcile(hostId: number) {
    if (!Number.isFinite(hostId) || hostId <= 0 || this.inFlight.has(hostId)) return false;
    return (this.retries.get(hostId)?.retryAt || 0) <= this.now();
  }
}

const hostDdnsUpdates = new HostDdnsUpdateCoordinator();
const hostDdnsRetryScheduler = new HostDdnsRetryScheduler(
  retryHostDdnsUpdate,
  Date.now,
  setTimeout,
  clearTimeout,
  (error) => {
    appendPanelLog("warn", `[HostDDNS] retry wake failed: ${error instanceof Error ? error.message : String(error)}`);
  },
);

function clearHostDdnsRetry(hostId: number) {
  hostDdnsUpdates.recordSuccess(hostId);
  hostDdnsRetryScheduler.replace(hostId, null);
}

function finishHostDdnsUpdate(hostId: number, retryAt: number | null = null) {
  const outcome = hostDdnsUpdates.finish(hostId);
  if (retryAt) hostDdnsRetryScheduler.replace(hostId, retryAt);
  if (outcome.immediate) clearHostDdnsRetry(hostId);
  if (outcome.rerunRequested && hostDdnsUpdates.canReconcile(hostId)) {
    void retryHostDdnsUpdate(hostId, { force: outcome.immediate });
  }
}

export type HostDdnsWriter = {
  updateRecord: typeof updateDdnsRecord;
  updateValues: typeof updateDdnsRecordValues;
};

const defaultHostDdnsWriter: HostDdnsWriter = { updateRecord: updateDdnsRecord, updateValues: updateDdnsRecordValues };

// 最近一次读到的服务商：只给 scheduleHostDdnsUpdate 估「要不要真调服务商」用，真正执行时会重新读设置。
let lastKnownDdnsProvider = "";

/**
 * 原来的单值目标（日志、错误提示还在用）：主记录类型和它的值。
 * 记录要发哪些、发几个由 shared/hostDdnsPlan.planHostDdnsRecords 决定。
 */
export function hostDdnsTargetValue(host: any) {
  const ipVersion = normalizeHostDdnsIpVersion(host?.ddnsIpVersion, host?.ddnsRecordType);
  const recordType = hostDdnsRecordTypeFor(ipVersion);
  const value = String(recordType === "AAAA" ? host?.ipv6 || "" : host?.ipv4 || "").trim();
  return { recordType, ipVersion, value };
}

/** 计划要读的主机栏：地址、DDNS 配置和上次发出去的签名。 */
type HostDdnsHost = HostDdnsPlanSource & { lastDdnsValue?: unknown; lastDdnsError?: unknown };

export function hostDdnsPlanFor(host: HostDdnsHost | null | undefined, provider: unknown = lastKnownDdnsProvider) {
  return planHostDdnsRecords(host || {}, { provider, previous: host?.lastDdnsValue });
}

function hostDdnsCurrent(host: HostDdnsHost, plan: ReturnType<typeof planHostDdnsRecords>) {
  return String(host?.lastDdnsValue || "") === plan.signature && !host?.lastDdnsError;
}

function hostNeedsDdnsUpdate(host: any) {
  const hostId = Number(host?.id || 0);
  const domain = String(host?.ddnsDomain || "").trim();
  if (!hostId || !host?.ddnsEnabled || !domain) return false;
  const plan = hostDdnsPlanFor(host);
  if (!hostDdnsPlanHasWork(plan)) return false;
  return !hostDdnsCurrent(host, plan);
}

/**
 * 把计划写到服务商。老配置（plan.legacy 且没有要清理的）就是原来那一次 updateDdnsRecord，参数一字不差。
 * 多条记录按 A、AAAA 的次序挨个写；中间一条失败就整体算失败，下次重试从头再来（每一步都是幂等的）。
 */
export async function applyHostDdnsPlan(
  plan: ReturnType<typeof planHostDdnsRecords>,
  target: { domain: string; hostId: number },
  writer: HostDdnsWriter = defaultHostDdnsWriter,
) {
  for (const record of plan.records) {
    if (record.multiValue) {
      await writer.updateValues({ domain: target.domain, recordType: record.recordType, values: record.values, groupId: -target.hostId });
    } else {
      await writer.updateRecord({ domain: target.domain, recordType: record.recordType, value: record.values[0], groupId: -target.hostId });
    }
  }
  for (const recordType of plan.removals) {
    await writer.updateValues({ domain: target.domain, recordType, values: [], groupId: -target.hostId });
  }
}

async function retryHostDdnsUpdate(hostId: number, options: { force?: boolean } = {}) {
  if (!hostDdnsUpdates.canReconcile(hostId)) return;
  if (!hostDdnsUpdates.tryStart(hostId, options)) return;
  await executeHostDdnsUpdate(hostId, () => db.getHostById(hostId), "host-ddns-retry", options);
}

async function executeHostDdnsUpdate(
  hostId: number,
  loadHost: () => any | Promise<any>,
  reason: string,
  options: { force?: boolean } = {},
) {
  let host: any;
  let retryAt: number | null = null;
  try {
    host = await loadHost();
    if (!host) {
      clearHostDdnsRetry(hostId);
      return;
    }

    const domain = String(host?.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase();
    if (!host?.ddnsEnabled || !domain) {
      clearHostDdnsRetry(hostId);
      return;
    }

    const settings = await getDdnsSettings();
    lastKnownDdnsProvider = settings.provider;
    const plan = hostDdnsPlanFor(host, settings.provider);
    if (!hostDdnsPlanHasWork(plan)) {
      clearHostDdnsRetry(hostId);
      const families = plan.missing.length ? plan.missing : [hostDdnsTargetValue(host).ipVersion];
      await db.updateHost(hostId, { lastDdnsError: `No reported ${families.map((family) => family.toUpperCase()).join("/")} address` });
      return;
    }
    if (!options.force && hostDdnsCurrent(host, plan)) {
      clearHostDdnsRetry(hostId);
      return;
    }

    if (!settings.enabled || settings.provider === "disabled") {
      throw new Error("DDNS service is not enabled in system settings");
    }
    await applyHostDdnsPlan(plan, { domain, hostId });
    await db.updateHost(hostId, {
      lastDdnsValue: plan.signature,
      lastDdnsAt: new Date(),
      lastDdnsError: null,
    } as any);
    clearHostDdnsRetry(hostId);
    if (plan.legacy && plan.records.length === 1 && plan.removals.length === 0) {
      appendPanelLog("info", `[HostDDNS] host=${hostId} ${plan.records[0].recordType} ${domain} -> ${plan.records[0].values[0]} reason=${reason}`);
    } else {
      appendPanelLog("info", `[HostDDNS] host=${hostId} ${domain} -> ${describeHostDdnsPlan(plan)} reason=${reason}${plan.notices.length ? ` note=${plan.notices.join(" ")}` : ""}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    retryAt = hostDdnsUpdates.recordFailure(hostId);
    await db.updateHost(hostId, { lastDdnsError: message } as any).catch(() => undefined);
    const domain = String(host?.ddnsDomain || "").trim().replace(/\.+$/, "").toLowerCase() || "-";
    const value = host ? describeHostDdnsPlan(hostDdnsPlanFor(host)) : "-";
    appendPanelLog("warn", `[HostDDNS] host=${hostId} update failed domain=${domain} value=${value}: ${message}`);
  } finally {
    // Arm retries only after releasing the per-host in-flight guard. Otherwise
    // a very slow error write could consume its own timer before work can run.
    finishHostDdnsUpdate(hostId, retryAt);
  }
}

export function scheduleHostDdnsUpdate(
  host: any,
  reason = "agent-address-changed",
  options: { force?: boolean } = {},
) {
  const hostId = Number(host?.id || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return false;
  if (options.force) hostDdnsRetryScheduler.replace(hostId, null);
  if (!hostDdnsUpdates.tryStart(hostId, options)) return false;
  const domain = String(host?.ddnsDomain || "").trim();
  const willAttemptProviderUpdate = options.force
    ? !!host?.ddnsEnabled && !!domain && hostDdnsPlanHasWork(hostDdnsPlanFor(host))
    : hostNeedsDdnsUpdate(host);
  void executeHostDdnsUpdate(hostId, () => host, reason, options);
  return willAttemptProviderUpdate;
}

export async function reconcileHostDdnsRecords(
  reason = "host-ddns-reconcile",
  options: { force?: boolean } = {},
) {
  const settings = await getDdnsSettings();
  lastKnownDdnsProvider = settings.provider;
  if (!settings.enabled || settings.provider === "disabled") return 0;
  const hosts = await db.getHosts();
  let queued = 0;
  for (const host of hosts as any[]) {
    const hostId = Number(host?.id || 0);
    const domain = String(host?.ddnsDomain || "").trim();
    if (!hostId || !host?.ddnsEnabled || !domain) continue;
    const plan = hostDdnsPlanFor(host, settings.provider);
    if (!hostDdnsPlanHasWork(plan)) continue;
    if (!options.force && hostDdnsCurrent(host, plan)) continue;
    if (!options.force && !hostDdnsUpdates.canReconcile(hostId)) continue;
    if (scheduleHostDdnsUpdate(host, reason, options)) queued += 1;
  }
  return queued;
}
