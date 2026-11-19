import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { clearAuthenticatedAgentActivity } from "./agentActivity";

export const AGENT_FAST_LIVENESS_MIN_VERSION = "2.2.171";
// Presence normally arrives every five seconds, but one attempt can occupy up
// to eight seconds and transient failures use bounded retries. Requiring 90
// seconds of silence tolerates transient network stalls without falling back
// to the legacy 150-second display TTL.
export const AGENT_FAST_LIVENESS_SILENCE_MS = 90_000;
// A live Agent reconnects its event stream within at most 30 seconds and its
// presence loop within 5 seconds. Keep the startup grace aligned with the
// silence window so a panel restart does not create a false offline transition.
export const AGENT_FAST_LIVENESS_STARTUP_GRACE_MS = 90_000;
/*
  多个面板实例时，Agent 只连其中一个：别的实例看不到它的请求，只能看库里的 hosts.lastHeartbeat（连着它的实例
  大约每 90 秒写一次，见 agentHeartbeatGate.ts 的 AGENT_PRESENCE_PERSIST_INTERVAL_MS）。按库里的时刻判离线要多等：
  写库间隔 90 秒 + 一个 presence 周期 5 秒 + 本进程读库的间隔和余量 15 秒，再加上原来的 90 秒沉默。
  只有一个实例时不读库，这一项不参与（agentPresenceElsewhere.ts）。
*/
export const AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS = AGENT_FAST_LIVENESS_SILENCE_MS + 90_000 + 5_000 + 15_000;
/** 库里的时刻要比本进程看到的晚这么多才算「别的实例看到的」（本进程自己写库时的秒级取整和先后差）。 */
const ELSEWHERE_MIN_LEAD_MS = 2_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

export type AgentFastLivenessHost = {
  id?: unknown;
  hostId?: unknown;
  agentVersion?: unknown;
  version?: unknown;
  isOnline?: unknown;
  lastHeartbeat?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type AgentFastLivenessState = {
  hostId: number;
  agentVersion: string;
  transitionEpoch: number;
  lastSeenAt: number | null;
  deadlineAt: number;
  offlineAt: number | null;
  lastOfflineAt: number | null;
  /** 上一次从「确认离线」回到在线的时刻（面板自己看到的）；转发组据此算「刚回来，还在观察」。没掉过线是 null。 */
  lastRestoredAt: number | null;
  confirmedOffline: boolean;
  /** 别的面板实例最近一次看到它的时刻（库里的 lastHeartbeat，只在有别的实例时有值）。 */
  lastSeenElsewhereAt: number | null;
};

export type AgentFastLivenessTransitionKind = "confirmed-offline" | "activity-restored";

export type AgentFastLivenessTransition = AgentFastLivenessState & {
  kind: AgentFastLivenessTransitionKind;
  /**
   * Async consumers must check this after every await before applying a
   * transition. A newer Agent request invalidates an older offline event.
   */
  isCurrent: () => boolean;
  /** 这次恢复是从库里看到「别的实例见过它」得来的（本进程没收到它的请求）。 */
  elsewhere?: boolean;
};

export type AgentFastLivenessTrackerOptions = {
  silenceMs?: number;
  startupGraceMs?: number;
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  onError?: (error: unknown, event: AgentFastLivenessTransition) => void;
  /** 别的面板实例最近一次看到这台的时刻（毫秒，null = 不知道）；见 AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS。 */
  lastSeenElsewhere?: (hostId: number) => number | null;
  elsewhereSilenceMs?: number;
};

type MutableAgentFastLivenessState = AgentFastLivenessState & {
  timerGeneration: number;
  timer: TimerHandle | null;
};

function positiveHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : null;
}

function normalizedTimestamp(value: unknown, now: number) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.min(timestamp, now) : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(numeric, now);
  }
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, now) : null;
}

function nextGeneration(current: number) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function snapshot(state: MutableAgentFastLivenessState): AgentFastLivenessState {
  return {
    hostId: state.hostId,
    agentVersion: state.agentVersion,
    transitionEpoch: state.transitionEpoch,
    lastSeenAt: state.lastSeenAt,
    deadlineAt: state.deadlineAt,
    offlineAt: state.offlineAt,
    lastOfflineAt: state.lastOfflineAt,
    lastRestoredAt: state.lastRestoredAt,
    confirmedOffline: state.confirmedOffline,
    lastSeenElsewhereAt: state.lastSeenElsewhereAt,
  };
}

export function supportsAgentFastLiveness(agentVersion: unknown) {
  return isAgentVersionAtLeast(String(agentVersion || ""), AGENT_FAST_LIVENESS_MIN_VERSION);
}

export class AgentFastLivenessTracker {
  private readonly silenceMs: number;
  private readonly startupGraceMs: number;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onError: (error: unknown, event: AgentFastLivenessTransition) => void;
  private readonly hosts = new Map<number, MutableAgentFastLivenessState>();
  private readonly listeners = new Set<(event: AgentFastLivenessTransition) => void | Promise<void>>();
  private transitionEpochCounter = 0;
  private lastSeenElsewhere: ((hostId: number) => number | null) | null;
  private elsewhereSilenceMs: number;

  constructor(options: AgentFastLivenessTrackerOptions = {}) {
    this.silenceMs = Math.max(1, Number(options.silenceMs ?? AGENT_FAST_LIVENESS_SILENCE_MS));
    this.startupGraceMs = Math.max(0, Number(options.startupGraceMs ?? AGENT_FAST_LIVENESS_STARTUP_GRACE_MS));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
    this.lastSeenElsewhere = options.lastSeenElsewhere ?? null;
    this.elsewhereSilenceMs = Math.max(this.silenceMs, Number(options.elsewhereSilenceMs ?? AGENT_FAST_LIVENESS_ELSEWHERE_SILENCE_MS));
  }

  /** 接上「别的实例看到过它」的来源（多实例部署，见 agentPresenceElsewhere.ts）；null = 断开。 */
  setLastSeenElsewhere(provider: ((hostId: number) => number | null) | null, silenceMs?: number) {
    this.lastSeenElsewhere = provider;
    if (silenceMs !== undefined) this.elsewhereSilenceMs = Math.max(this.silenceMs, Number(silenceMs));
  }

  /**
   * 库里显示别的实例在 seenAt 见过这台：没判离线的只记下时刻；已经判了离线、而这个时刻晚于判离线的时刻，
   * 就当它回来了（发 activity-restored，带 elsewhere）。比本进程自己看到的还早的不算（那是本进程写进库的）。
   * 本进程从没登记过的主机（本实例启动后才加的、Agent 只连别的实例）：给了 agentVersion 而且支持快速存活、
   * 时刻还在 elsewhere 沉默期内，就按库里的时刻登记成在线（以前不登记，转发组评估里它一直算离线）。
   * 第一次登记不发事件：它没有「恢复」，发了会多一条「主机上线」通知。
   */
  observeElsewhereActivity(hostIdValue: unknown, seenAtValue: unknown, agentVersion?: unknown) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    const state = this.hosts.get(hostId);
    const now = this.now();
    if (!state) return this.registerSeenElsewhere(hostId, normalizedTimestamp(seenAtValue, now), agentVersion, now);
    const seenAt = normalizedTimestamp(seenAtValue, now);
    if (seenAt === null || seenAt <= (state.lastSeenAt ?? 0) + ELSEWHERE_MIN_LEAD_MS) return false;
    state.lastSeenElsewhereAt = Math.max(state.lastSeenElsewhereAt ?? 0, seenAt);
    if (!state.confirmedOffline || seenAt <= (state.offlineAt ?? 0)) return false;
    if (now - seenAt >= this.elsewhereSilenceMs) return false;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = null;
    state.timerGeneration = nextGeneration(state.timerGeneration);
    state.deadlineAt = Math.min(seenAt + this.elsewhereSilenceMs, now + this.silenceMs);
    state.confirmedOffline = false;
    state.offlineAt = null;
    state.transitionEpoch = this.nextTransitionEpoch();
    state.lastRestoredAt = now;
    this.arm(state);
    this.emit("activity-restored", state, { elsewhere: true });
    return true;
  }

  private registerSeenElsewhere(hostId: number, seenAt: number | null, agentVersionValue: unknown, now: number) {
    const agentVersion = String(agentVersionValue ?? "").trim();
    if (seenAt === null || !supportsAgentFastLiveness(agentVersion)) return false;
    if (now - seenAt >= this.elsewhereSilenceMs) return false;
    const state: MutableAgentFastLivenessState = {
      hostId,
      agentVersion,
      transitionEpoch: 0,
      lastSeenAt: null,
      deadlineAt: Math.min(seenAt + this.elsewhereSilenceMs, now + this.silenceMs),
      offlineAt: null,
      lastOfflineAt: null,
      lastRestoredAt: null,
      confirmedOffline: false,
      lastSeenElsewhereAt: seenAt,
      timerGeneration: 1,
      timer: null,
    };
    this.hosts.set(hostId, state);
    this.arm(state);
    return true;
  }

  /** 到了本进程的沉默期限时，别的实例最近见过它的时刻（只认比本进程看到的更晚的）。 */
  private elsewhereSeenAt(state: MutableAgentFastLivenessState) {
    const provided = this.lastSeenElsewhere?.(state.hostId) ?? null;
    const candidate = Math.max(Number(provided || 0), Number(state.lastSeenElsewhereAt || 0));
    if (!(candidate > (state.lastSeenAt ?? 0) + ELSEWHERE_MIN_LEAD_MS)) return null;
    state.lastSeenElsewhereAt = candidate;
    return candidate;
  }

  subscribe(listener: (event: AgentFastLivenessTransition) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeOffline(listener: (event: AgentFastLivenessTransition) => void | Promise<void>) {
    return this.subscribe((event) => {
      if (event.kind === "confirmed-offline") return listener(event);
    });
  }

  registerHost(
    host: AgentFastLivenessHost,
    options: { startupGrace?: boolean; activityAt?: unknown } = {},
  ) {
    const hostId = positiveHostId(host?.hostId ?? host?.id);
    if (!hostId) return false;
    const agentVersion = String(host?.agentVersion ?? host?.version ?? "").trim();
    if (!supportsAgentFastLiveness(agentVersion)) {
      this.removeHost(hostId);
      return false;
    }

    const existing = this.hosts.get(hostId);
    if (existing) {
      existing.agentVersion = agentVersion;
      if (options.activityAt !== undefined) this.observeActivity(hostId, options.activityAt);
      return true;
    }

    const now = this.now();
    const activityAt = options.activityAt === undefined
      ? null
      : normalizedTimestamp(options.activityAt, now) ?? now;
    const persistedSeenAt = normalizedTimestamp(host?.lastHeartbeat, now);
    const persistedOffline = options.startupGrace
      && (host?.isOnline === false || host?.isOnline === 0 || host?.isOnline === "0");
    const deadlineDelay = options.startupGrace && activityAt === null
      ? this.startupGraceMs
      : this.silenceMs;
    const state: MutableAgentFastLivenessState = {
      hostId,
      agentVersion,
      transitionEpoch: 0,
      lastSeenAt: activityAt ?? persistedSeenAt,
      deadlineAt: now + deadlineDelay,
      offlineAt: null,
      // A persisted offline host must not reuse health samples from before a
      // panel restart when it reconnects during startup grace.
      lastOfflineAt: persistedOffline ? now : null,
      lastRestoredAt: null,
      confirmedOffline: false,
      lastSeenElsewhereAt: null,
      timerGeneration: 1,
      timer: null,
    };
    this.hosts.set(hostId, state);
    this.arm(state);
    return true;
  }

  /** Registers eligible persisted hosts without trusting a potentially stale DB heartbeat. */
  primeHosts(hosts: Iterable<AgentFastLivenessHost>) {
    let eligible = 0;
    for (const host of hosts) {
      if (this.registerHost(host, { startupGrace: true })) eligible += 1;
    }
    return eligible;
  }

  /** Registers a host whose request itself proves presence capability and liveness. */
  registerPresenceCapableHost(hostIdValue: unknown, seenAtValue: unknown = this.now()) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    if (this.hosts.has(hostId)) return this.observeActivity(hostId, seenAtValue);
    return this.registerHost(
      { hostId, agentVersion: AGENT_FAST_LIVENESS_MIN_VERSION },
      { activityAt: seenAtValue },
    );
  }

  observeActivity(hostIdValue: unknown, seenAtValue: unknown = this.now()) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    const state = this.hosts.get(hostId);
    if (!state) return false;

    const now = this.now();
    const seenAt = normalizedTimestamp(seenAtValue, now) ?? now;
    const wasOffline = state.confirmedOffline;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = null;
    state.timerGeneration = nextGeneration(state.timerGeneration);
    state.lastSeenAt = Math.max(state.lastSeenAt ?? 0, seenAt);
    state.deadlineAt = now + this.silenceMs;
    state.confirmedOffline = false;
    state.offlineAt = null;
    if (wasOffline) {
      state.transitionEpoch = this.nextTransitionEpoch();
      state.lastRestoredAt = now;
    }
    this.arm(state);

    if (wasOffline) this.emit("activity-restored", state);
    return true;
  }

  removeHost(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    if (!hostId) return false;
    const state = this.hosts.get(hostId);
    if (!state) return false;
    if (state.timer) this.clearTimer(state.timer);
    this.hosts.delete(hostId);
    return true;
  }

  clear() {
    for (const state of this.hosts.values()) {
      if (state.timer) this.clearTimer(state.timer);
    }
    this.hosts.clear();
  }

  hasHost(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    return !!hostId && this.hosts.has(hostId);
  }

  isConfirmedOffline(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    return !!hostId && this.hosts.get(hostId)?.confirmedOffline === true;
  }

  isCurrentTransition(hostIdValue: unknown, transitionEpochValue: unknown, confirmedOffline?: boolean) {
    const hostId = positiveHostId(hostIdValue);
    const transitionEpoch = Number(transitionEpochValue);
    if (!hostId || !Number.isSafeInteger(transitionEpoch) || transitionEpoch <= 0) return false;
    const state = this.hosts.get(hostId);
    if (!state || state.transitionEpoch !== transitionEpoch) return false;
    return confirmedOffline === undefined || state.confirmedOffline === confirmedOffline;
  }

  state(hostIdValue: unknown) {
    const hostId = positiveHostId(hostIdValue);
    const state = hostId ? this.hosts.get(hostId) : null;
    return state ? snapshot(state) : null;
  }

  registeredHostIds() {
    return Array.from(this.hosts.keys());
  }

  private arm(state: MutableAgentFastLivenessState) {
    const timerGeneration = state.timerGeneration;
    const delayMs = Math.max(0, state.deadlineAt - this.now());
    const timer = this.setTimer(() => {
      const current = this.hosts.get(state.hostId);
      if (!current || current.timerGeneration !== timerGeneration || current.timer !== timer) return;
      current.timer = null;
      if (this.now() < current.deadlineAt) {
        this.arm(current);
        return;
      }
      if (current.confirmedOffline) return;
      // 别的面板实例还看得到它（多实例部署）：按库里的时刻再等，别把连在别处的 Agent 判成离线。
      const elsewhere = this.elsewhereSeenAt(current);
      if (elsewhere !== null && this.now() < elsewhere + this.elsewhereSilenceMs) {
        current.deadlineAt = Math.min(elsewhere + this.elsewhereSilenceMs, this.now() + this.silenceMs);
        this.arm(current);
        return;
      }
      current.confirmedOffline = true;
      current.offlineAt = this.now();
      current.lastOfflineAt = current.offlineAt;
      current.transitionEpoch = this.nextTransitionEpoch();
      this.emit("confirmed-offline", current);
    }, delayMs);
    timer.unref?.();
    state.timer = timer;
  }

  private emit(kind: AgentFastLivenessTransitionKind, state: MutableAgentFastLivenessState, extra: { elsewhere?: boolean } = {}) {
    const expectedOffline = kind === "confirmed-offline";
    const transitionEpoch = state.transitionEpoch;
    const event: AgentFastLivenessTransition = {
      ...snapshot(state),
      kind,
      isCurrent: () => this.isCurrentTransition(state.hostId, transitionEpoch, expectedOffline),
      ...(extra.elsewhere ? { elsewhere: true } : {}),
    };
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch((error) => this.reportError(error, event));
        }
      } catch (error) {
        this.reportError(error, event);
      }
    }
  }

  private reportError(error: unknown, event: AgentFastLivenessTransition) {
    try {
      this.onError(error, event);
    } catch {
      // Liveness progression must not depend on diagnostics succeeding.
    }
  }

  private nextTransitionEpoch() {
    this.transitionEpochCounter = nextGeneration(this.transitionEpochCounter);
    return this.transitionEpochCounter;
  }
}

/** Shared process-local state for host status and DDNS health integration. */
export const agentFastLivenessTracker = new AgentFastLivenessTracker();

export function registerPresenceCapableHost(hostId: unknown, seenAt: unknown = Date.now()) {
  return agentFastLivenessTracker.registerPresenceCapableHost(hostId, seenAt);
}

/** Refreshes only an already registered presence-capable host. */
export function observePresenceCapableHostActivity(hostId: unknown, seenAt: unknown = Date.now()) {
  return agentFastLivenessTracker.observeActivity(hostId, seenAt);
}

export function primePresenceCapableHosts(hosts: Iterable<AgentFastLivenessHost>) {
  return agentFastLivenessTracker.primeHosts(hosts);
}

export function removePresenceCapableHost(hostId: unknown) {
  clearAuthenticatedAgentActivity(hostId);
  return agentFastLivenessTracker.removeHost(hostId);
}

/**
 * Observe every generation-safe liveness transition. Consumers that persist
 * host state can serialize online/offline transitions for one host so a late
 * database write cannot overwrite a newer recovery.
 */
export function subscribeAgentFastLiveness(
  listener: (event: AgentFastLivenessTransition) => void | Promise<void>,
) {
  return agentFastLivenessTracker.subscribe(listener);
}

export function isAgentFastLivenessConfirmedOffline(hostId: unknown) {
  return agentFastLivenessTracker.isConfirmedOffline(hostId);
}

function getAgentFastLivenessState(hostId: unknown) {
  return agentFastLivenessTracker.state(hostId);
}

export const getPresenceCapableHostLivenessSnapshot = getAgentFastLivenessState;
