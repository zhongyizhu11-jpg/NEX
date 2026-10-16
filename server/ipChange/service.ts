/*
  自动换 IP 的业务流程。所有外部依赖（库、云厂商、主机地址联动、通知、时间）都从 deps 注入，
  线上的接法见 ./runtime.ts，测试用内存仓库和假云厂商（./service.test.ts）。

  ── 一次更换怎么走 ──
  1. 同一台主机同时只允许一次（进程内的 inFlight 集合，同步占位，不排队 —— 第二个请求直接报「正在更换」）。
  2. **先落库再调云厂商**：配置状态改成 changing、generation + 1，插一条 running 的记录。
     面板要是在调用中途重启，启动时看到 changing / running 就改成 uncertain（结果不确定），
     绝不自动重发 —— 重发一次可能就是又多申请一个要花钱的弹性 IP。
  3. 调 provider.changeIp：真实的 fetch、setTimeout 的 sleep、写面板日志的 log、最长 15 分钟的 AbortSignal。
  4. 成功：记结果，按 ipRole 联动地址（见 applyAddressChange），进入冷却，通知管理员。
     失败：云厂商说「可能已经生效」（ambiguous）、超时、或抛了认不出的错 → uncertain，等管理员确认后「重置状态」；
     明确可重试 → 进入冷却，冷却后自动再试（受每日上限约束）；明确不可重试 → error，等管理员处理。
*/
import { isIP } from "node:net";
import {
  IP_CHANGE_LIMITS,
  ipChangeProbeIndex,
  ipChangeProbeServiceId,
  normalizeIpChangeNumbers,
  parseIpChangeCheckTargets,
  type IpChangeCheckMethod,
  type IpChangeState,
  type IpChangeTrigger,
} from "../../shared/ipChange";
import { cooldownUntil, decideAutoChange, evaluateProbeRound, nextDetectionState, type AutoChangeBlockCode } from "./detection";
import type { IpChangeConfigRecord, IpChangeEventRecord, IpChangeStore } from "./model";
import type {
  IpChangeContext,
  IpChangeCredentials,
  IpChangeFieldDef,
  IpChangeProvider,
  IpChangeResult,
  IpChangeTarget,
} from "./providers";
import {
  IpChangeSecretError,
  maskIpChangeCredentials,
  mergeIpChangeCredentials,
  sanitizeCredentials,
  type CredentialCipher,
} from "./secrets";

export const IP_CHANGE_PLUGIN_INACTIVE_MESSAGE = "请先在「插件管理」里打开插件功能，并安装、启用「自动换 IP」插件";
export const IP_CHANGE_RESTART_MESSAGE = "面板在更换过程中重启，云厂商那边是否已经生效未知。请到云控制台确认实例和 IP 的实际情况后点「重置状态」";

export type IpChangeHost = {
  id: number;
  name?: string | null;
  ip?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  entryIp?: string | null;
  addressManual?: unknown;
  ddnsEnabled?: unknown;
  ddnsDomain?: string | null;
  isOnline?: unknown;
  lastHeartbeat?: unknown;
  [key: string]: unknown;
};

export type IpChangeNotice =
  | {
      kind: "changed";
      host: IpChangeHost;
      trigger: IpChangeTrigger;
      provider: string;
      oldIp: string | null;
      newIp: string;
      ipRole: "primary" | "entry";
      notes: string[];
    }
  | {
      kind: "failed";
      host: IpChangeHost;
      trigger: IpChangeTrigger;
      provider: string;
      error: string;
      uncertain: boolean;
    }
  | {
      /** 探测达到阈值，但没有（或不能）自动更换：提醒管理员看一眼。 */
      kind: "suspected";
      host: IpChangeHost;
      consecutiveFailures: number;
      threshold: number;
      reason: string;
    };

export type IpChangeDeps = {
  store: IpChangeStore;
  resolveProvider: (id: string) => IpChangeProvider | undefined;
  listProviders: () => IpChangeProvider[];
  /** 懒取：密钥文件只在真要加解密时才读。 */
  cipher: () => CredentialCipher;
  /** 插件已安装并启用、且插件功能总开关打开。 */
  isActive: () => Promise<boolean>;
  hosts: {
    get(id: number): Promise<IpChangeHost | null>;
    update(id: number, patch: Record<string, unknown>): Promise<void>;
    list(): Promise<IpChangeHost[]>;
  };
  isHostOnline: (host: IpChangeHost) => boolean;
  address: {
    handleHostAddressChanged(hostId: number, current: IpChangeHost, previous: IpChangeHost, reason: string): Promise<void>;
    refreshHostAddressRuntime(hostId: number, previous: IpChangeHost, reason: string): Promise<void>;
    scheduleHostDdnsUpdate(host: IpChangeHost, reason: string, options: { force?: boolean }): unknown;
  };
  pushAgentRefresh?: (hostId: number, reason: string) => void;
  notify: (notice: IpChangeNotice) => Promise<void> | void;
  log: (level: "info" | "warn" | "error", message: string) => void;
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** 一次 changeIp 最长多久（默认 15 分钟）。 */
  changeTimeoutMs?: number;
  /** 测试凭据最长多久（默认 2 分钟）。 */
  testTimeoutMs?: number;
  /** 主 IP 换完后等 Agent 上报新地址、再强制刷 DDNS（默认最多等 5 分钟，10 秒看一次）。 */
  followUp?: { timeoutMs: number; pollMs: number };
  /** 心跳里下发的探测任务缓存多久（默认 30 秒）。 */
  probeCacheTtlMs?: number;
};

export type HostProbeTask = {
  serviceId: number;
  method: "tcping" | "ping";
  targetIp: string;
  targetPort: number;
  intervalSeconds: number;
};

export type ProbeReport = {
  serviceId: number;
  targetIp?: string;
  targetPort?: number;
  isTimeout?: boolean;
  probeSuccesses?: number;
  latencyMs?: number | null;
};

export type SaveHostConfigInput = {
  hostId: number;
  enabled: boolean;
  autoEnabled: boolean;
  cloudAccountId: number | null;
  target: Record<string, unknown>;
  checkTargets: string;
  checkMethod: IpChangeCheckMethod;
  failureThreshold: number;
  checkIntervalSeconds: number;
  cooldownMinutes: number;
  maxChangesPerDay: number;
  releaseOldIp: boolean;
};

export type ChangeOutcome =
  | { status: "succeeded"; eventId: number; oldIp: string | null; newIp: string; ipRole: "primary" | "entry"; notes: string[]; followUp: Promise<void> | null }
  | { status: "failed" | "uncertain"; eventId: number; error: string };

const DEFAULT_CHANGE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TEST_TIMEOUT_MS = 2 * 60 * 1000;
const NOTIFY_ONCE_MS = 6 * 60 * 60 * 1000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isProviderError(error: unknown): error is Error & { options: { retryable: boolean; ambiguous?: boolean } } {
  return !!error && typeof error === "object" && (error as any).name === "IpChangeProviderError" && typeof (error as any).options === "object";
}

function isAbortError(error: unknown) {
  const name = (error as any)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** 错误信息里出现凭据原文的，一律换成 ***（云厂商的报错偶尔会把请求参数原样带回来）。 */
export function redactSecrets(message: string, credentials: IpChangeCredentials | null | undefined) {
  let text = String(message || "");
  for (const value of Object.values(credentials || {})) {
    if (value && value.length >= 6) text = text.split(value).join("***");
  }
  return text.slice(0, 2000);
}

function hostPrimaryIp(host: IpChangeHost | null | undefined) {
  return String(host?.ipv4 || host?.ip || host?.ipv6 || "").trim() || null;
}

function hostAddresses(host: IpChangeHost | null | undefined) {
  return [host?.ip, host?.ipv4, host?.ipv6].map((value) => String(value || "").trim()).filter(Boolean);
}

function boolish(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function hostLabel(host: IpChangeHost | null | undefined, hostId: number) {
  return String(host?.name || "").trim() || `主机 #${hostId}`;
}

function sanitizeTarget(value: Record<string, unknown> | null | undefined): IpChangeTarget {
  return sanitizeCredentials(value);
}

function probeTasksSignature(tasks: HostProbeTask[]) {
  return tasks.map((task) => `${task.serviceId}|${task.method}|${task.targetIp}|${task.targetPort}|${task.intervalSeconds}`).join(";");
}

function missingRequired(fields: IpChangeFieldDef[], values: Record<string, string>) {
  return fields.filter((field) => field.required && !String(values[field.key] ?? "").trim()).map((field) => field.label);
}

export class IpChangeService {
  private readonly inFlight = new Set<number>();
  private readonly windows = new Map<number, Set<number>>();
  private readonly notified = new Map<string, number>();
  private probeCache: { expiresAt: number; byHost: Map<number, HostProbeTask[]> } | null = null;
  /** 每台主机最近一次在完整心跳里拿走的探测任务签名（见 hasPendingProbeDelivery）。 */
  private readonly deliveredProbes = new Map<number, string>();
  private recovered = false;

  constructor(private readonly deps: IpChangeDeps) {}

  // ───────────────────────── 开关 ─────────────────────────

  async isActive() {
    return this.deps.isActive().catch(() => false);
  }

  async assertActive() {
    if (!(await this.isActive())) throw new Error(IP_CHANGE_PLUGIN_INACTIVE_MESSAGE);
  }

  isChanging(hostId: number) {
    return this.inFlight.has(hostId);
  }

  // ───────────────────────── 云厂商 ─────────────────────────

  listProviders() {
    return this.deps.listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      docsHint: provider.docsHint,
      credentialFields: provider.credentialFields,
      targetFields: provider.targetFields,
      requiresDowntime: provider.requiresDowntime,
    }));
  }

  private providerOrThrow(id: string) {
    const provider = this.deps.resolveProvider(id);
    if (!provider) throw new Error(`云厂商「${id}」在这个版本里不可用`);
    return provider;
  }

  // ───────────────────────── 云账号 ─────────────────────────

  private decryptAccount(account: { credentialsJson: string | null }) {
    return this.deps.cipher().decrypt(account.credentialsJson);
  }

  async listAccounts() {
    const [accounts, configs] = await Promise.all([this.deps.store.listAccounts(), this.deps.store.listConfigs()]);
    return accounts.map((account) => {
      const provider = this.deps.resolveProvider(account.provider);
      let credentials: IpChangeCredentials = {};
      let credentialsError: string | null = null;
      try {
        credentials = maskIpChangeCredentials(this.decryptAccount(account), provider?.credentialFields);
      } catch (error) {
        credentialsError = error instanceof IpChangeSecretError ? error.message : "凭据读取失败，请重新填写";
      }
      return {
        id: account.id,
        name: account.name,
        provider: account.provider,
        providerLabel: provider?.label || account.provider,
        providerAvailable: !!provider,
        credentials,
        credentialsError,
        usedByHosts: configs.filter((config) => config.cloudAccountId === account.id).map((config) => config.hostId),
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      };
    });
  }

  async createAccount(input: { name: string; provider: string; credentials: Record<string, unknown> }) {
    await this.assertActive();
    const provider = this.providerOrThrow(input.provider);
    const name = String(input.name || "").trim().slice(0, 128);
    if (!name) throw new Error("请填写账号名称");
    const credentials = sanitizeCredentials(input.credentials);
    const missing = missingRequired(provider.credentialFields, credentials);
    if (missing.length) throw new Error(`请填写：${missing.join("、")}`);
    return this.deps.store.createAccount({ name, provider: provider.id, credentialsJson: this.deps.cipher().encrypt(credentials) });
  }

  async updateAccount(input: { id: number; name?: string; credentials?: Record<string, unknown> }) {
    await this.assertActive();
    const account = await this.deps.store.getAccount(input.id);
    if (!account) throw new Error("云账号不存在");
    const provider = this.deps.resolveProvider(account.provider);
    const patch: { name?: string; credentialsJson?: string } = {};
    if (input.name !== undefined) {
      const name = String(input.name || "").trim().slice(0, 128);
      if (!name) throw new Error("请填写账号名称");
      patch.name = name;
    }
    if (input.credentials !== undefined) {
      let existing: IpChangeCredentials = {};
      try {
        existing = this.decryptAccount(account);
      } catch {
        // 旧密文解不开（面板换过密钥）：只能按这次提交的整套来，打码的占位值不会和任何旧值相等，原样当新值没意义，丢掉。
        existing = {};
      }
      const merged = mergeIpChangeCredentials(existing, input.credentials, provider?.credentialFields);
      if (provider) {
        const missing = missingRequired(provider.credentialFields, merged);
        if (missing.length) throw new Error(`请填写：${missing.join("、")}`);
      }
      patch.credentialsJson = this.deps.cipher().encrypt(merged);
    }
    await this.deps.store.updateAccount(account.id, patch);
  }

  async deleteAccount(id: number) {
    await this.assertActive();
    const configs = (await this.deps.store.listConfigs()).filter((config) => config.cloudAccountId === id);
    if (configs.length > 0) throw new Error(`还有 ${configs.length} 台主机在用这个账号，请先在主机配置里换掉`);
    await this.deps.store.deleteAccount(id);
  }

  /** 用一个账号 + 目标问一次云厂商：凭据对不对、实例找不找得到，返回它看到的公网 IP。不改任何东西。 */
  async testAccount(input: { accountId: number; hostId?: number | null; target?: Record<string, unknown> | null }) {
    await this.assertActive();
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) throw new Error("云账号不存在");
    const provider = this.providerOrThrow(account.provider);
    const credentials = this.decryptAccount(account);
    let target = sanitizeTarget(input.target);
    if (input.hostId && !input.target) {
      const config = await this.deps.store.getConfig(input.hostId);
      target = config?.target || {};
    }
    const missing = missingRequired(provider.targetFields, target);
    if (missing.length) throw new Error(`请先填写：${missing.join("、")}`);
    const startedAt = this.deps.now();
    try {
      const result = await this.withTimeout(this.deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, (ctx) =>
        provider.testCredentials(credentials, target, ctx), input.hostId || 0, credentials);
      if (input.hostId) {
        await this.deps.store.insertEvent({
          hostId: input.hostId, trigger: "test", provider: provider.id, oldIp: null, newIp: result.currentIp || null, ipRole: null,
          status: "succeeded", error: null, notes: [], startedAt, finishedAt: this.deps.now(),
        });
      }
      return { currentIp: result.currentIp || null };
    } catch (error) {
      const message = redactSecrets(errorMessage(error), credentials);
      if (input.hostId) {
        await this.deps.store.insertEvent({
          hostId: input.hostId, trigger: "test", provider: provider.id, oldIp: null, newIp: null, ipRole: null,
          status: "failed", error: message, notes: [], startedAt, finishedAt: this.deps.now(),
        }).catch(() => undefined);
      }
      throw new Error(`测试失败：${message}`);
    }
  }

  // ───────────────────────── 主机配置 ─────────────────────────

  async listHostConfigs() {
    const [configs, accounts, hosts] = await Promise.all([
      this.deps.store.listConfigs(),
      this.deps.store.listAccounts(),
      this.deps.hosts.list(),
    ]);
    const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const since = new Date(this.deps.now().getTime() - 24 * 60 * 60 * 1000);
    return Promise.all(configs.map(async (config) => {
      const host = hostById.get(config.hostId) || null;
      const account = config.cloudAccountId ? accountById.get(config.cloudAccountId) || null : null;
      const provider = account ? this.deps.resolveProvider(account.provider) : undefined;
      const [attemptsLast24h, lastAttemptAt] = await Promise.all([
        this.deps.store.countAttemptsSince(config.hostId, since),
        this.deps.store.lastAttemptAt(config.hostId),
      ]);
      const until = cooldownUntil(lastAttemptAt, config.cooldownMinutes);
      return {
        ...config,
        hostName: host ? hostLabel(host, config.hostId) : `已删除的主机 #${config.hostId}`,
        hostExists: !!host,
        hostAddress: hostPrimaryIp(host),
        hostOnline: host ? this.deps.isHostOnline(host) : false,
        accountName: account?.name || null,
        provider: account?.provider || null,
        providerLabel: provider?.label || account?.provider || null,
        providerAvailable: !!provider,
        requiresDowntime: !!provider?.requiresDowntime,
        attemptsLast24h,
        cooldownUntil: until && until.getTime() > this.deps.now().getTime() ? until : null,
        inFlight: this.inFlight.has(config.hostId),
      };
    }));
  }

  async listHostsForSelect() {
    const [hosts, configs] = await Promise.all([this.deps.hosts.list(), this.deps.store.listConfigs()]);
    const configured = new Set(configs.map((config) => config.hostId));
    return hosts.map((host) => ({
      id: Number(host.id),
      name: hostLabel(host, Number(host.id)),
      address: hostPrimaryIp(host),
      online: this.deps.isHostOnline(host),
      configured: configured.has(Number(host.id)),
    }));
  }

  /** 主机详情里那一小块：没配置 / 插件没开时返回 null。 */
  async hostStatus(hostId: number) {
    if (!(await this.isActive())) return null;
    const config = await this.deps.store.getConfig(hostId);
    if (!config) return null;
    const account = config.cloudAccountId ? await this.deps.store.getAccount(config.cloudAccountId) : null;
    const provider = account ? this.deps.resolveProvider(account.provider) : undefined;
    return {
      hostId,
      enabled: config.enabled,
      autoEnabled: config.autoEnabled,
      state: config.state,
      consecutiveFailures: config.consecutiveFailures,
      failureThreshold: config.failureThreshold,
      lastCheckAt: config.lastCheckAt,
      lastChangeAt: config.lastChangeAt,
      lastError: config.lastError,
      providerLabel: provider?.label || account?.provider || null,
      inFlight: this.inFlight.has(hostId),
    };
  }

  async saveHostConfig(input: SaveHostConfigInput) {
    await this.assertActive();
    const hostId = Math.floor(Number(input.hostId));
    const host = await this.deps.hosts.get(hostId);
    if (!host) throw new Error("主机不存在");
    const checkMethod: IpChangeCheckMethod = input.checkMethod === "ping" ? "ping" : "tcp";
    const parsed = parseIpChangeCheckTargets(input.checkTargets, checkMethod);
    if (parsed.errors.length) throw new Error(`探测目标有误：${parsed.errors.join("；")}`);
    if (input.enabled && parsed.targets.length === 0) throw new Error("至少填一个探测目标");
    const numbers = normalizeIpChangeNumbers(input);
    const target = sanitizeTarget(input.target);
    let cloudAccountId: number | null = input.cloudAccountId ? Math.floor(Number(input.cloudAccountId)) : null;
    if (cloudAccountId) {
      const account = await this.deps.store.getAccount(cloudAccountId);
      if (!account) throw new Error("云账号不存在");
      const provider = this.deps.resolveProvider(account.provider);
      if (input.autoEnabled && !provider) throw new Error(`云厂商「${account.provider}」在这个版本里不可用，不能打开自动更换`);
      if (provider && input.autoEnabled) {
        const missing = missingRequired(provider.targetFields, target);
        if (missing.length) throw new Error(`请填写：${missing.join("、")}`);
      }
    } else {
      cloudAccountId = null;
      if (input.autoEnabled) throw new Error("打开自动更换前请先选择云账号");
    }
    if (input.autoEnabled && !input.enabled) throw new Error("请先启用检测，再打开自动更换");

    const existing = await this.deps.store.getConfig(hostId);
    const normalizedTargets = parsed.targets.map((item) => `${item.host}:${item.port}`).join("\n");
    const previousTargets = existing
      ? parseIpChangeCheckTargets(existing.checkTargets, existing.checkMethod).targets.map((item) => `${item.host}:${item.port}`).join("\n")
      : "";
    const probesChanged = !existing || existing.checkMethod !== checkMethod || previousTargets !== normalizedTargets || existing.enabled !== input.enabled;

    let state: IpChangeState = existing?.state || "idle";
    if (!input.enabled) {
      if (state !== "changing" && state !== "uncertain") state = "disabled";
    } else if (state === "disabled" || !existing) {
      state = "idle";
    }
    const saved = await this.deps.store.upsertConfig(hostId, {
      enabled: !!input.enabled,
      autoEnabled: !!input.autoEnabled,
      cloudAccountId,
      target,
      checkTargets: String(input.checkTargets || "").trim().slice(0, 4000),
      checkMethod,
      ...numbers,
      releaseOldIp: input.releaseOldIp !== false,
      state,
      ...(probesChanged ? { consecutiveFailures: 0 } : {}),
    });
    if (probesChanged) {
      this.windows.delete(hostId);
      this.invalidateProbeCache();
      this.deps.pushAgentRefresh?.(hostId, "ip-change-probes-updated");
    }
    return saved;
  }

  async deleteHostConfig(hostId: number) {
    await this.assertActive();
    if (this.inFlight.has(hostId)) throw new Error("这台主机正在更换 IP，等这一次结束再删");
    await this.deps.store.deleteConfig(hostId);
    this.windows.delete(hostId);
    this.invalidateProbeCache();
    this.deps.pushAgentRefresh?.(hostId, "ip-change-probes-removed");
  }

  async resetState(hostId: number) {
    await this.assertActive();
    if (this.inFlight.has(hostId)) throw new Error("这台主机正在更换 IP，等这一次结束再重置");
    const config = await this.deps.store.getConfig(hostId);
    if (!config) throw new Error("这台主机还没有配置自动换 IP");
    await this.deps.store.updateConfig(hostId, {
      state: config.enabled ? "idle" : "disabled",
      consecutiveFailures: 0,
      lastError: null,
    });
    await this.deps.store.markRunningEventsUncertain([hostId], "管理员重置了状态", this.deps.now());
    this.windows.delete(hostId);
    this.clearNotified(hostId);
  }

  async listEvents(query: { hostId?: number | null; page: number; pageSize: number }) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize) || 20));
    const page = Math.max(1, Math.floor(query.page) || 1);
    const result = await this.deps.store.listEvents({ hostId: query.hostId || null, limit: pageSize, offset: (page - 1) * pageSize });
    const hosts = await this.deps.hosts.list();
    const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
    return {
      total: result.total,
      page,
      pageSize,
      items: result.items.map((event) => ({
        ...event,
        hostName: hostLabel(hostById.get(event.hostId), event.hostId),
        providerLabel: event.provider ? this.deps.resolveProvider(event.provider)?.label || event.provider : null,
      })),
    };
  }

  // ───────────────────────── 探测：心跳下发 + 上报 ─────────────────────────

  invalidateProbeCache() {
    this.probeCache = null;
  }

  private async probeSnapshot() {
    const nowMs = Date.now();
    if (this.probeCache && this.probeCache.expiresAt > nowMs) return this.probeCache.byHost;
    const byHost = new Map<number, HostProbeTask[]>();
    if (await this.isActive()) {
      for (const config of await this.deps.store.listConfigs()) {
        if (!config.enabled) continue;
        const tasks = this.probeTasksForConfig(config);
        if (tasks.length) byHost.set(config.hostId, tasks);
      }
    }
    this.probeCache = { expiresAt: nowMs + (this.deps.probeCacheTtlMs ?? 30_000), byHost };
    return byHost;
  }

  probeTasksForConfig(config: Pick<IpChangeConfigRecord, "checkTargets" | "checkMethod" | "checkIntervalSeconds">): HostProbeTask[] {
    const { targets } = parseIpChangeCheckTargets(config.checkTargets, config.checkMethod);
    return targets.slice(0, IP_CHANGE_LIMITS.maxTargets).map((target, index) => ({
      serviceId: ipChangeProbeServiceId(index),
      method: config.checkMethod === "ping" ? "ping" : "tcping",
      targetIp: target.host,
      targetPort: config.checkMethod === "ping" ? 0 : target.port,
      intervalSeconds: config.checkIntervalSeconds,
    }));
  }

  /** 心跳里追加给这台主机的探测任务（和主机探测服务同一个通道）。插件没开时是空的。 */
  async getProbeTasksForHost(hostId: number): Promise<HostProbeTask[]> {
    const tasks = (await this.probeSnapshot()).get(Number(hostId)) || [];
    this.deliveredProbes.set(Number(hostId), probeTasksSignature(tasks));
    return tasks;
  }

  /**
   * 同步判断：这台主机该拿的探测任务和它上次拿走的不一样了。
   * 心跳的稳定快路径（配置没变就直接回空）要把它算进 hasBlockingWork，否则插件刚启用 / 刚停用时，
   * 配置没变的主机永远收不到（或甩不掉）这些探测任务。只看内存里的快照，不打库。
   */
  hasPendingProbeDelivery(hostId: number) {
    if (!this.probeCache) return false;
    const id = Number(hostId);
    const expected = probeTasksSignature(this.probeCache.byHost.get(id) || []);
    return expected !== (this.deliveredProbes.get(id) ?? probeTasksSignature([]));
  }

  /** 刷新快照，把「该拿的和拿走的不一样」的主机推一次刷新（定时任务里调）。 */
  async refreshProbeDelivery() {
    const byHost = await this.probeSnapshot();
    const hostIds = new Set<number>([...byHost.keys(), ...this.deliveredProbes.keys()]);
    let pushed = 0;
    for (const hostId of hostIds) {
      if (!this.hasPendingProbeDelivery(hostId)) continue;
      this.deps.pushAgentRefresh?.(hostId, "ip-change-probes-changed");
      pushed += 1;
    }
    return pushed;
  }

  /** Agent 上报的、属于自动换 IP 的那部分探测结果。 */
  async ingestProbeReports(hostId: number, reports: ProbeReport[]) {
    const tasks = await this.getProbeTasksForHost(hostId);
    if (tasks.length === 0 || reports.length === 0) return { kind: "ignored" as const };
    const results: Array<{ index: number; ok: boolean }> = [];
    for (const report of reports) {
      const index = ipChangeProbeIndex(report.serviceId);
      const task = tasks[index];
      if (!task) continue;
      // 目标对不上（配置刚改、Agent 还拿着旧任务）的结果不算数
      if (report.targetIp && String(report.targetIp).trim().toLowerCase() !== task.targetIp) continue;
      if (task.method === "tcping" && report.targetPort && Number(report.targetPort) !== task.targetPort) continue;
      const ok = !report.isTimeout && (report.probeSuccesses === undefined || Number(report.probeSuccesses) > 0);
      results.push({ index, ok });
    }
    if (results.length === 0) return { kind: "ignored" as const };

    const config = await this.deps.store.getConfig(hostId);
    if (!config?.enabled) return { kind: "ignored" as const };
    const host = await this.deps.hosts.get(hostId);
    // 主机对面板离线：什么都不做（可能是面板侧网络问题，也可能是机器宕了）。
    if (!host || !this.deps.isHostOnline(host)) return { kind: "ignored" as const };

    const now = this.deps.now();
    const round = evaluateProbeRound({
      targetCount: tasks.length,
      results,
      window: this.windows.get(hostId) || new Set(),
      consecutiveFailures: config.consecutiveFailures,
      lastCheckAt: config.lastCheckAt,
      checkIntervalSeconds: config.checkIntervalSeconds,
      now,
    });
    if (round.kind === "ignored") return round;
    this.windows.set(hostId, round.window);
    if (round.kind === "pending") return round;

    const state = nextDetectionState(config.state, round.consecutiveFailures);
    if (round.recorded || state !== config.state || round.consecutiveFailures !== config.consecutiveFailures) {
      await this.deps.store.updateConfig(hostId, {
        consecutiveFailures: round.consecutiveFailures,
        lastCheckAt: round.lastCheckAt,
        state,
      });
    }
    if (round.kind === "success") {
      this.clearNotified(hostId, "suspected");
      return round;
    }
    if (round.consecutiveFailures >= config.failureThreshold) {
      this.deps.log("warn", `[IpChange] host=${hostId} 连续 ${round.consecutiveFailures} 轮所有大陆探测目标都不通（阈值 ${config.failureThreshold}）`);
      if (config.autoEnabled) {
        void this.maybeAutoChange(hostId).catch((error) => {
          this.deps.log("error", `[IpChange] host=${hostId} 自动更换没有启动：${errorMessage(error)}`);
        });
      } else {
        await this.notifyOnce(hostId, "suspected", {
          kind: "suspected",
          host,
          consecutiveFailures: round.consecutiveFailures,
          threshold: config.failureThreshold,
          reason: "没有打开自动更换，请确认后手动「立即更换」",
        });
      }
    }
    return round;
  }

  // ───────────────────────── 更换 ─────────────────────────

  private async autoDecision(config: IpChangeConfigRecord, host: IpChangeHost | null) {
    const now = this.deps.now();
    const [attemptsLast24h, lastAttemptAt, account] = await Promise.all([
      this.deps.store.countAttemptsSince(config.hostId, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      this.deps.store.lastAttemptAt(config.hostId),
      config.cloudAccountId ? this.deps.store.getAccount(config.cloudAccountId) : Promise.resolve(null),
    ]);
    return decideAutoChange({
      enabled: config.enabled,
      autoEnabled: config.autoEnabled,
      state: config.state,
      consecutiveFailures: config.consecutiveFailures,
      failureThreshold: config.failureThreshold,
      hostOnline: !!host && this.deps.isHostOnline(host),
      inFlight: this.inFlight.has(config.hostId),
      hasAccount: !!account && !!this.deps.resolveProvider(account.provider),
      cooldownMinutes: config.cooldownMinutes,
      maxChangesPerDay: config.maxChangesPerDay,
      lastAttemptAt,
      attemptsLast24h,
      now,
    });
  }

  /** 到阈值后自动更换（探测上报和定时任务都会调）。条件不满足只记一笔，必要时提醒一次。 */
  async maybeAutoChange(hostId: number): Promise<{ started: false; code: AutoChangeBlockCode | "inactive" | "missing"; reason: string } | { started: true; eventId: number; done: Promise<ChangeOutcome> }> {
    if (!(await this.isActive())) return { started: false, code: "inactive", reason: IP_CHANGE_PLUGIN_INACTIVE_MESSAGE };
    const config = await this.deps.store.getConfig(hostId);
    if (!config) return { started: false, code: "missing", reason: "没有配置" };
    const host = await this.deps.hosts.get(hostId);
    const decision = await this.autoDecision(config, host);
    if (!decision.ok) {
      if (host && (decision.code === "daily-cap" || decision.code === "no-account" || decision.code === "state")) {
        await this.notifyOnce(hostId, `blocked:${decision.code}`, {
          kind: "suspected",
          host,
          consecutiveFailures: config.consecutiveFailures,
          threshold: config.failureThreshold,
          reason: `没有自动更换：${decision.reason}`,
        });
      }
      return { started: false, code: decision.code, reason: decision.reason };
    }
    try {
      const begun = await this.beginChange(hostId, "auto");
      return { started: true, ...begun };
    } catch (error) {
      return { started: false, code: "in-flight", reason: errorMessage(error) };
    }
  }

  /**
   * 开始一次更换。前置检查和「先落库」都在这里同步做完（出错直接抛给调用方），
   * 调云厂商那一段在 done 里跑 —— 换 IP 可能要好几分钟（有的云要关机），接口不能一直挂着。
   * 手动更换不看冷却和每日上限，但「正在更换」「结果不确定」时一样拒绝。
   */
  async beginChange(hostId: number, trigger: "manual" | "auto"): Promise<{ eventId: number; done: Promise<ChangeOutcome> }> {
    await this.assertActive();
    if (this.inFlight.has(hostId)) throw new Error("这台主机正在更换 IP，请等这一次结束");
    this.inFlight.add(hostId);
    let claimed = false;
    try {
      const config = await this.deps.store.getConfig(hostId);
      if (!config) throw new Error("这台主机还没有配置自动换 IP");
      if (config.state === "changing") throw new Error("上一次更换还没有结果（面板可能重启过），请先确认后「重置状态」");
      if (config.state === "uncertain") throw new Error("上一次更换结果不确定，请到云控制台确认后先「重置状态」");
      const host = await this.deps.hosts.get(hostId);
      if (!host) throw new Error("主机不存在");
      if (trigger === "auto") {
        // 占位之后再判一次：探测上报和定时任务可能同时判过「可以换」。
        const decision = await this.autoDecision(config, host);
        if (!decision.ok && decision.code !== "in-flight") throw new Error(decision.reason);
      }
      if (!config.cloudAccountId) throw new Error("还没有选择云账号");
      const account = await this.deps.store.getAccount(config.cloudAccountId);
      if (!account) throw new Error("云账号不存在");
      const provider = this.providerOrThrow(account.provider);
      const missing = missingRequired(provider.targetFields, config.target);
      if (missing.length) throw new Error(`请先填写：${missing.join("、")}`);
      const credentials = this.decryptAccount(account);
      const oldIp = hostPrimaryIp(host);

      // 先落库再调云厂商：重启后看到 changing / running 就知道「可能做了一半」。
      await this.deps.store.updateConfig(hostId, { state: "changing", generation: config.generation + 1, lastError: null });
      const eventId = await this.deps.store.insertEvent({
        hostId,
        trigger,
        provider: provider.id,
        oldIp,
        newIp: null,
        ipRole: null,
        status: "running",
        error: null,
        notes: [],
        startedAt: this.deps.now(),
        finishedAt: null,
      });
      claimed = true;
      this.deps.log("info", `[IpChange] host=${hostId} 开始${trigger === "auto" ? "自动" : "手动"}更换 IP provider=${provider.id} old=${oldIp || "-"}`);
      const done = this.executeChange({ hostId, trigger, eventId, config, host, provider, credentials, oldIp })
        .finally(() => this.inFlight.delete(hostId));
      return { eventId, done };
    } finally {
      if (!claimed) this.inFlight.delete(hostId);
    }
  }

  private async withTimeout<T>(timeoutMs: number, work: (ctx: IpChangeContext) => Promise<T>, hostId: number, credentials: IpChangeCredentials): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`云厂商接口 ${Math.round(timeoutMs / 1000)} 秒内没有完成`);
        error.name = "TimeoutError";
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      (timer as any)?.unref?.();
    });
    const ctx: IpChangeContext = {
      fetch: this.deps.fetch,
      now: this.deps.now,
      sleep: this.deps.sleep,
      log: (message) => this.deps.log("info", `[IpChange] host=${hostId || "-"} ${redactSecrets(message, credentials)}`),
      signal: controller.signal,
    };
    try {
      return await Promise.race([work(ctx), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeChange(input: {
    hostId: number;
    trigger: "manual" | "auto";
    eventId: number;
    config: IpChangeConfigRecord;
    host: IpChangeHost;
    provider: IpChangeProvider;
    credentials: IpChangeCredentials;
    oldIp: string | null;
  }): Promise<ChangeOutcome> {
    const { hostId, trigger, eventId, config, host, provider, credentials } = input;
    let result: IpChangeResult;
    try {
      result = await this.withTimeout(
        this.deps.changeTimeoutMs ?? DEFAULT_CHANGE_TIMEOUT_MS,
        (ctx) => provider.changeIp(credentials, config.target, ctx, { releaseOldIp: config.releaseOldIp }),
        hostId,
        credentials,
      );
      const newIp = String(result?.newIp || "").trim();
      if (!isIP(newIp)) {
        const error = new Error(`云厂商返回的新 IP「${newIp || "空"}」无法识别`);
        error.name = "InvalidResult";
        throw error;
      }
      result = { ...result, newIp, ipRole: result.ipRole === "entry" ? "entry" : "primary", notes: Array.isArray(result.notes) ? result.notes.map(String) : [] };
    } catch (error) {
      return this.recordFailure(input, error);
    }

    const oldIp = result.oldIp || input.oldIp;
    const notes = [...result.notes];
    if (!result.releasedOldIp && config.releaseOldIp && result.ipRole === "primary") {
      notes.push("旧 IP 没有释放，可能仍在计费，请到云控制台确认");
    }
    await this.deps.store.updateEvent(eventId, {
      status: "succeeded",
      oldIp,
      newIp: result.newIp,
      ipRole: result.ipRole,
      notes,
      finishedAt: this.deps.now(),
    });
    let followUp: Promise<void> | null = null;
    try {
      const applied = await this.applyAddressChange(host, oldIp, result, eventId);
      notes.push(...applied.notes);
      followUp = applied.followUp;
    } catch (error) {
      notes.push(`地址联动失败：${errorMessage(error)}（请到主机编辑里检查入口地址和 DDNS）`);
    }
    if (notes.length > result.notes.length) await this.deps.store.updateEvent(eventId, { notes });
    await this.deps.store.updateConfig(hostId, {
      state: "cooldown",
      consecutiveFailures: 0,
      lastChangeAt: this.deps.now(),
      lastError: null,
    });
    this.windows.delete(hostId);
    this.clearNotified(hostId);
    this.invalidateProbeCache();
    this.deps.log("info", `[IpChange] host=${hostId} 更换成功 ${oldIp || "-"} -> ${result.newIp} role=${result.ipRole}`);
    await Promise.resolve(this.deps.notify({
      kind: "changed",
      host,
      trigger,
      provider: provider.id,
      oldIp,
      newIp: result.newIp,
      ipRole: result.ipRole,
      notes,
    })).catch(() => undefined);
    return { status: "succeeded", eventId, oldIp, newIp: result.newIp, ipRole: result.ipRole, notes, followUp };
  }

  private async recordFailure(
    input: { hostId: number; trigger: "manual" | "auto"; eventId: number; host: IpChangeHost; provider: IpChangeProvider; credentials: IpChangeCredentials },
    error: unknown,
  ): Promise<ChangeOutcome> {
    const message = redactSecrets(errorMessage(error), input.credentials);
    let state: IpChangeState;
    let status: "failed" | "uncertain";
    if (isProviderError(error)) {
      if (error.options.ambiguous) {
        state = "uncertain";
        status = "uncertain";
      } else if (error.options.retryable) {
        state = "cooldown";
        status = "failed";
      } else {
        state = "error";
        status = "failed";
      }
    } else {
      // 超时、返回值不对、或者抛了认不出的错：请求可能已经到了云厂商那边，不能当没发生过。
      state = "uncertain";
      status = "uncertain";
    }
    const shown = status === "uncertain"
      ? `${message}。请求可能已经生效，请到云控制台确认后「重置状态」`
      : message;
    await this.deps.store.updateEvent(input.eventId, { status, error: shown, finishedAt: this.deps.now() });
    await this.deps.store.updateConfig(input.hostId, { state, lastError: shown });
    this.deps.log(status === "uncertain" ? "error" : "warn", `[IpChange] host=${input.hostId} 更换${status === "uncertain" ? "结果不确定" : "失败"}：${shown}${isAbortError(error) ? "（超时）" : ""}`);
    await Promise.resolve(this.deps.notify({
      kind: "failed",
      host: input.host,
      trigger: input.trigger,
      provider: input.provider.id,
      error: shown,
      uncertain: status === "uncertain",
    })).catch(() => undefined);
    return { status, eventId: input.eventId, error: shown };
  }

  /**
   * 换完以后地址怎么跟：
   *   - 手填的入口地址（entryIp）正好是旧 IP 的，两种角色都改成新 IP。
   *   - entry：新 IP 只是一个入口，主机自己的 IP 不变 → 入口地址改成新 IP（入口是自定义域名的不动，只提醒）。
   *   - primary + 手动锁定了检测 IP（addressManual）：Agent 上报的地址会被忽略，面板直接改 ip / ipv4(ipv6)。
   *   - primary + 自动检测：不抢着写地址（Agent 下一次心跳还可能带着旧 IP，抢写会来回跳），
   *     等 Agent 自己报上新 IP —— 那一刻面板已有的流程会刷 DDNS、规则专属域名、转发组、隧道和转发链 ——
   *     然后再强制刷一次 DDNS，免得重试退避把它拖住。
   * 改了地址的，走和「主机编辑里改地址」一样的联动。
   */
  private async applyAddressChange(host: IpChangeHost, oldIp: string | null, result: IpChangeResult, eventId: number) {
    const notes: string[] = [];
    const hostId = Number(host.id);
    const reason = "ip-change";
    const newIp = result.newIp;
    const family = isIP(newIp);
    const previous = { ...host };
    const patch: Record<string, unknown> = {};
    const entryIp = String(host.entryIp || "").trim();
    const entryIsHostname = !!entryIp && isIP(entryIp) === 0;

    if (entryIp && oldIp && entryIp === oldIp) patch.entryIp = newIp;
    if (result.ipRole === "entry") {
      if (entryIsHostname) {
        notes.push(`入口地址是自定义域名 ${entryIp}，面板没有改它，请把它解析到 ${newIp}`);
      } else {
        patch.entryIp = newIp;
      }
      if (boolish(host.ddnsEnabled) && String(host.ddnsDomain || "").trim()) {
        notes.push(`主机 DDNS（${host.ddnsDomain}）跟随 Agent 检测到的 IP，入口型更换不会改它；规则里优先显示 DDNS 域名，需要的话请关闭主机 DDNS 或改用新入口`);
      }
    } else if (boolish(host.addressManual)) {
      if (family === 4) {
        patch.ipv4 = newIp;
        if (!host.ip || isIP(String(host.ip)) !== 6) patch.ip = newIp;
      } else {
        patch.ipv6 = newIp;
        if (!host.ip || isIP(String(host.ip)) === 6) patch.ip = newIp;
      }
      notes.push("这台主机锁定了检测 IP，面板已直接改成新 IP");
    }

    let followUp: Promise<void> | null = null;
    if (Object.keys(patch).length > 0) {
      Object.assign(patch, {
        geoCountryCode: null, geoCountryName: null, geoRegion: null, geoEmoji: null,
        geoLatitudeMicro: null, geoLongitudeMicro: null, geoUpdatedAt: null,
      });
      await this.deps.hosts.update(hostId, patch);
      const current = { ...host, ...patch };
      await this.deps.address.handleHostAddressChanged(hostId, current, previous, reason);
      // handleHostAddressChanged 只在原来没手填入口时重算运行时；手填入口变了要自己补上（同主机编辑）。
      if (patch.entryIp !== undefined && String(previous.entryIp || "").trim()) {
        await this.deps.address.refreshHostAddressRuntime(hostId, previous, reason);
      }
      if (patch.entryIp !== undefined) notes.push(`入口地址已改为 ${newIp}`);
      if (result.ipRole === "primary") {
        this.deps.address.scheduleHostDdnsUpdate(current, reason, { force: true });
      }
    }
    if (result.ipRole === "primary" && !boolish(host.addressManual)) {
      followUp = this.followUpPrimaryAddress(hostId, newIp, eventId).catch((error) => {
        this.deps.log("warn", `[IpChange] host=${hostId} 等待新 IP 上报时出错：${errorMessage(error)}`);
      });
    }
    return { notes, followUp };
  }

  private async followUpPrimaryAddress(hostId: number, newIp: string, eventId: number) {
    const { timeoutMs, pollMs } = this.deps.followUp ?? { timeoutMs: 5 * 60 * 1000, pollMs: 10_000 };
    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)));
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const host = await this.deps.hosts.get(hostId);
      if (host && hostAddresses(host).includes(newIp)) {
        this.deps.address.scheduleHostDdnsUpdate(host, "ip-change", { force: true });
        this.deps.log("info", `[IpChange] host=${hostId} Agent 已上报新 IP ${newIp}，已强制刷新 DDNS`);
        return;
      }
      if (attempt < attempts) await this.deps.sleep(pollMs);
    }
    const note = `Agent 在 ${Math.round(timeoutMs / 60000)} 分钟内没有上报新 IP ${newIp}，DDNS 会在它上报后自动更新；如果一直没有，请检查 Agent 是否在线`;
    this.deps.log("warn", `[IpChange] host=${hostId} ${note}`);
    const event = (await this.deps.store.listEvents({ hostId, limit: 20, offset: 0 })).items.find((item) => item.id === eventId);
    await this.deps.store.updateEvent(eventId, { notes: [...(event?.notes || []), note] });
  }

  // ───────────────────────── 定时任务 / 重启恢复 ─────────────────────────

  /** 面板启动时：上次停在「正在更换」的，改成「结果不确定」，绝不自动重发。 */
  async recoverInterrupted() {
    const configs = await this.deps.store.listConfigs();
    const stale = configs.filter((config) => config.state === "changing" && !this.inFlight.has(config.hostId));
    for (const config of stale) {
      await this.deps.store.updateConfig(config.hostId, { state: "uncertain", lastError: IP_CHANGE_RESTART_MESSAGE });
      this.deps.log("warn", `[IpChange] host=${config.hostId} 上次更换被面板重启打断，已标记为结果不确定`);
    }
    const running = this.inFlight.size === 0 ? null : configs.map((config) => config.hostId).filter((id) => !this.inFlight.has(id));
    await this.deps.store.markRunningEventsUncertain(running, IP_CHANGE_RESTART_MESSAGE, this.deps.now());
    this.recovered = true;
    return stale.map((config) => config.hostId);
  }

  /** 每 30 秒一次：冷却结束的回到正常 / 失败；到阈值的再试一次自动更换（上报时没赶上的、冷却刚结束的）。 */
  async tick() {
    if (!this.recovered) await this.recoverInterrupted();
    // 插件开关变了（没有钩子通知这里）：快照过期后重算，变了的主机推一次刷新，让 Agent 拿到 / 去掉探测任务。
    await this.refreshProbeDelivery().catch(() => 0);
    if (!(await this.isActive())) return { checked: 0, started: 0 };
    const now = this.deps.now();
    let started = 0;
    const configs = await this.deps.store.listConfigs();
    for (const config of configs) {
      if (!config.enabled || this.inFlight.has(config.hostId)) continue;
      let state = config.state;
      if (state === "cooldown") {
        const until = cooldownUntil(await this.deps.store.lastAttemptAt(config.hostId) || config.lastChangeAt, config.cooldownMinutes);
        if (!until || until.getTime() <= now.getTime()) {
          state = config.consecutiveFailures > 0 ? "failing" : "healthy";
          await this.deps.store.updateConfig(config.hostId, { state });
        }
      }
      if (config.autoEnabled && config.consecutiveFailures >= config.failureThreshold && state !== "cooldown") {
        const result = await this.maybeAutoChange(config.hostId).catch(() => null);
        if (result?.started) started += 1;
      }
    }
    return { checked: configs.length, started };
  }

  // ───────────────────────── 通知去重 ─────────────────────────

  private async notifyOnce(hostId: number, key: string, notice: IpChangeNotice) {
    const fullKey = `${hostId}:${key}`;
    const last = this.notified.get(fullKey) || 0;
    const nowMs = this.deps.now().getTime();
    if (nowMs - last < NOTIFY_ONCE_MS) return;
    this.notified.set(fullKey, nowMs);
    await Promise.resolve(this.deps.notify(notice)).catch(() => undefined);
  }

  private clearNotified(hostId: number, key?: string) {
    for (const fullKey of [...this.notified.keys()]) {
      if (fullKey === `${hostId}:${key}` || (!key && fullKey.startsWith(`${hostId}:`))) this.notified.delete(fullKey);
    }
  }
}

export type { IpChangeEventRecord };
