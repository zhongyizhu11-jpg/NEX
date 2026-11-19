/*
  外部观察（观察点探成员）的结果表：进程内存，面板重启后由观察点下一次上报重新填（Agent 每分钟报一次全量，
  有变化立刻报）。成员行的 externalHealth 里存着「哪些观察点连通过它」「外部是否判了不可用」，重启后从那里接上。

  键：观察点主机 → 组 → 成员（memberId = 0 是这个组的参照目标）→ 端口。一个成员探几个端口时，
  任何一个端口连得上就算这个观察点「连得上这个成员」。

  只存结论，不判定：判定在 evaluate.ts 的 decideExternalHealth。
*/

/** 一个观察点的结果多久没更新就不算数（Agent 每 60 秒报一次全量，留两轮半）。 */
export const PEER_OBSERVATION_TTL_MS = 150_000;
export const MAX_PEER_OBSERVERS_PER_MEMBER = 3;
export const MAX_PEER_PROBE_PORTS_PER_MEMBER = 3;
/** 上报里参照目标的成员号。 */
export const PEER_REFERENCE_MEMBER_ID = 0;

type PortObservation = { ok: boolean; at: number; latencyMs: number | null };

type TargetObservation = {
  ports: Map<string, PortObservation>;
  /** 上一次汇总出来的结论（null = 还没有 / 全过期）。 */
  ok: boolean | null;
  /** 现在这个结论从什么时候开始。 */
  since: number;
  everOk: boolean;
};

export type PeerObservationView = {
  reachable: boolean | null;
  since: number | null;
  everReached: boolean;
  checkedAt: number | null;
  latencyMs: number | null;
};

function targetKey(groupId: number, memberId: number) {
  return `${Number(groupId)}:${Number(memberId)}`;
}

export class ForwardGroupPeerObservationStore {
  private readonly byObserver = new Map<number, Map<string, TargetObservation>>();

  constructor(private readonly ttlMs = PEER_OBSERVATION_TTL_MS) {}

  private summarize(target: TargetObservation, now: number, expectedPorts?: ReadonlySet<string>): boolean | null {
    let fresh = 0;
    for (const [port, observation] of target.ports) {
      if (expectedPorts && !expectedPorts.has(port)) continue;
      if (now - observation.at > this.ttlMs) continue;
      fresh += 1;
      if (observation.ok) return true;
    }
    return fresh > 0 ? false : null;
  }

  /**
   * 记一次上报。expectedPorts 是拓扑里这个观察点现在该探这个成员的哪些端口：不在里面的旧端口丢掉。
   * 返回汇总结论有没有变（变了要重新评估这个组）。
   */
  record(input: {
    observerHostId: number;
    groupId: number;
    memberId: number;
    portKey: string;
    ok: boolean;
    latencyMs?: number | null;
    expectedPorts?: ReadonlySet<string>;
    now: number;
  }) {
    const observerHostId = Number(input.observerHostId);
    if (!(observerHostId > 0) || !(Number(input.groupId) > 0)) return false;
    let targets = this.byObserver.get(observerHostId);
    if (!targets) {
      targets = new Map();
      this.byObserver.set(observerHostId, targets);
    }
    const key = targetKey(input.groupId, input.memberId);
    let target = targets.get(key);
    if (!target) {
      target = { ports: new Map(), ok: null, since: input.now, everOk: false };
      targets.set(key, target);
    }
    if (input.expectedPorts) {
      for (const port of Array.from(target.ports.keys())) {
        if (!input.expectedPorts.has(port)) target.ports.delete(port);
      }
    }
    // 上一份结论这一刻已经过期了（观察点断了一阵）：回来后的结论哪怕和过期前一样，也从现在重新算 since。
    const wasStale = target.ok !== null && this.summarize(target, input.now, input.expectedPorts) === null;
    target.ports.set(input.portKey, { ok: !!input.ok, at: input.now, latencyMs: input.ok ? (input.latencyMs ?? null) : null });
    const next = this.summarize(target, input.now, input.expectedPorts);
    if (next === true) target.everOk = true;
    if (next === target.ok && !wasStale) return false;
    target.ok = next;
    target.since = input.now;
    return true;
  }

  view(observerHostId: number, groupId: number, memberId: number, now: number, expectedPorts?: ReadonlySet<string>): PeerObservationView {
    const target = this.byObserver.get(Number(observerHostId))?.get(targetKey(groupId, memberId));
    if (!target) return { reachable: null, since: null, everReached: false, checkedAt: null, latencyMs: null };
    const reachable = this.summarize(target, now, expectedPorts);
    let checkedAt: number | null = null;
    let latencyMs: number | null = null;
    for (const [port, observation] of target.ports) {
      if (expectedPorts && !expectedPorts.has(port)) continue;
      if (checkedAt === null || observation.at > checkedAt) checkedAt = observation.at;
      if (observation.ok && observation.latencyMs !== null && now - observation.at <= this.ttlMs) {
        latencyMs = latencyMs === null ? observation.latencyMs : Math.min(latencyMs, observation.latencyMs);
      }
    }
    return {
      reachable,
      // 结论过期了（null）就没有「从什么时候开始」；和记下的结论不一致（刚有端口过期）时按现在算。
      since: reachable === null ? null : reachable === target.ok ? target.since : now,
      everReached: target.everOk,
      checkedAt,
      latencyMs,
    };
  }

  /** 从成员行里存的「连通过它的观察点」接上（面板重启后内存是空的）。 */
  seedEverReached(groupId: number, memberId: number, observerHostIds: Iterable<number>, now: number) {
    for (const value of observerHostIds) {
      const observerHostId = Number(value);
      if (!(observerHostId > 0)) continue;
      let targets = this.byObserver.get(observerHostId);
      if (!targets) {
        targets = new Map();
        this.byObserver.set(observerHostId, targets);
      }
      const key = targetKey(groupId, memberId);
      const target = targets.get(key);
      if (target) target.everOk = true;
      else targets.set(key, { ports: new Map(), ok: null, since: now, everOk: true });
    }
  }

  /** 拓扑变了：不再分配的观察关系丢掉。keep 返回 false 的删。 */
  prune(keep: (observerHostId: number, groupId: number, memberId: number) => boolean) {
    for (const [observerHostId, targets] of this.byObserver) {
      for (const key of Array.from(targets.keys())) {
        const [groupId, memberId] = key.split(":").map(Number);
        if (!keep(observerHostId, groupId, memberId)) targets.delete(key);
      }
      if (targets.size === 0) this.byObserver.delete(observerHostId);
    }
  }

  clear() {
    this.byObserver.clear();
  }

  size() {
    let total = 0;
    for (const targets of this.byObserver.values()) total += targets.size;
    return total;
  }
}

export const forwardGroupPeerObservations = new ForwardGroupPeerObservationStore();

/** 成员行 externalHealth 列（JSON）：面板重启后还要接着用的那一点外部观察状态。 */
export type StoredExternalHealth = {
  /** 外部判定不可用。 */
  down: boolean;
  /** 连通过这个成员的观察点主机。 */
  reachedBy: number[];
};

export function parseStoredExternalHealth(raw: unknown): StoredExternalHealth {
  const empty: StoredExternalHealth = { down: false, reachedBy: [] };
  if (!raw) return empty;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return empty;
    const item = value as { down?: unknown; reachedBy?: unknown };
    const reachedBy = Array.isArray(item.reachedBy)
      ? Array.from(new Set(item.reachedBy.map(Number).filter((id) => Number.isInteger(id) && id > 0))).sort((left, right) => left - right).slice(0, 16)
      : [];
    return { down: item.down === true, reachedBy };
  } catch {
    return empty;
  }
}

export function serializeStoredExternalHealth(value: StoredExternalHealth): string | null {
  const reachedBy = Array.from(new Set(value.reachedBy.map(Number).filter((id) => Number.isInteger(id) && id > 0))).sort((left, right) => left - right).slice(0, 16);
  if (!value.down && reachedBy.length === 0) return null;
  return JSON.stringify({ down: !!value.down, reachedBy });
}
