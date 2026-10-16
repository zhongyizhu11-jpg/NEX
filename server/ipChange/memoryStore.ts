/*
  IpChangeStore 的内存实现：给测试用（也方便以后在开发面板里不连库跑通流程）。
  行为和 ./repository.ts 的 SQL 实现保持一致：同样的默认值、同样的「真更换」口径。
*/
import { IP_CHANGE_DEFAULTS } from "../../shared/ipChange";
import type {
  IpChangeAccountRecord,
  IpChangeConfigPatch,
  IpChangeConfigRecord,
  IpChangeEventInsert,
  IpChangeEventPatch,
  IpChangeEventRecord,
  IpChangeStore,
} from "./model";

export function defaultIpChangeConfig(id: number, hostId: number, now: Date): IpChangeConfigRecord {
  return {
    id,
    hostId,
    enabled: false,
    autoEnabled: false,
    cloudAccountId: null,
    target: {},
    checkTargets: IP_CHANGE_DEFAULTS.checkTargets,
    checkMethod: IP_CHANGE_DEFAULTS.checkMethod,
    failureThreshold: IP_CHANGE_DEFAULTS.failureThreshold,
    checkIntervalSeconds: IP_CHANGE_DEFAULTS.checkIntervalSeconds,
    cooldownMinutes: IP_CHANGE_DEFAULTS.cooldownMinutes,
    maxChangesPerDay: IP_CHANGE_DEFAULTS.maxChangesPerDay,
    releaseOldIp: IP_CHANGE_DEFAULTS.releaseOldIp,
    state: "idle",
    consecutiveFailures: 0,
    lastCheckAt: null,
    lastChangeAt: null,
    lastError: null,
    generation: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function isRealAttempt(event: Pick<IpChangeEventRecord, "trigger">) {
  return event.trigger === "manual" || event.trigger === "auto";
}

export function createMemoryIpChangeStore(now: () => Date = () => new Date()): IpChangeStore & {
  accounts: Map<number, IpChangeAccountRecord>;
  configs: Map<number, IpChangeConfigRecord>;
  events: IpChangeEventRecord[];
} {
  const accounts = new Map<number, IpChangeAccountRecord>();
  const configs = new Map<number, IpChangeConfigRecord>();
  const events: IpChangeEventRecord[] = [];
  let nextAccountId = 1;
  let nextConfigId = 1;
  let nextEventId = 1;
  const clone = <T>(value: T): T => (value && typeof value === "object" ? structuredClone(value) : value);

  return {
    accounts,
    configs,
    events,
    async listAccounts() {
      return [...accounts.values()].map(clone);
    },
    async getAccount(id) {
      return clone(accounts.get(id) || null);
    },
    async createAccount(input) {
      const id = nextAccountId++;
      accounts.set(id, { id, ...input, createdAt: now(), updatedAt: now() });
      return id;
    },
    async updateAccount(id, patch) {
      const row = accounts.get(id);
      if (!row) return;
      accounts.set(id, { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: now() });
    },
    async deleteAccount(id) {
      accounts.delete(id);
    },
    async listConfigs() {
      return [...configs.values()].map(clone);
    },
    async getConfig(hostId) {
      return clone(configs.get(hostId) || null);
    },
    async upsertConfig(hostId, patch: IpChangeConfigPatch) {
      const existing = configs.get(hostId) || defaultIpChangeConfig(nextConfigId++, hostId, now());
      const next = { ...existing, ...stripUndefined(patch), updatedAt: now() };
      configs.set(hostId, next);
      return clone(next);
    },
    async updateConfig(hostId, patch) {
      const existing = configs.get(hostId);
      if (!existing) return;
      configs.set(hostId, { ...existing, ...stripUndefined(patch), updatedAt: now() });
    },
    async deleteConfig(hostId) {
      configs.delete(hostId);
    },
    async insertEvent(event: IpChangeEventInsert) {
      const id = nextEventId++;
      events.push({ id, ...clone(event) });
      return id;
    },
    async updateEvent(id, patch: IpChangeEventPatch) {
      const index = events.findIndex((event) => event.id === id);
      if (index >= 0) events[index] = { ...events[index], ...stripUndefined(patch) };
    },
    async listEvents(query) {
      const filtered = events
        .filter((event) => !query.hostId || event.hostId === query.hostId)
        .sort((a, b) => b.id - a.id);
      return { items: filtered.slice(query.offset, query.offset + query.limit).map(clone), total: filtered.length };
    },
    async countAttemptsSince(hostId, since) {
      return events.filter((event) => event.hostId === hostId && isRealAttempt(event) && (event.startedAt?.getTime() || 0) >= since.getTime()).length;
    },
    async lastAttemptAt(hostId) {
      const times = events
        .filter((event) => event.hostId === hostId && isRealAttempt(event) && event.startedAt)
        .map((event) => event.startedAt!.getTime());
      return times.length ? new Date(Math.max(...times)) : null;
    },
    async markRunningEventsUncertain(hostIds, error, finishedAt) {
      let changed = 0;
      for (const event of events) {
        if (event.status !== "running") continue;
        if (hostIds && !hostIds.includes(event.hostId)) continue;
        event.status = "uncertain";
        event.error = error;
        event.finishedAt = finishedAt;
        changed += 1;
      }
      return changed;
    },
  };
}

function stripUndefined<T extends Record<string, any>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
