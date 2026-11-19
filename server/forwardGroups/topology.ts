import { MAX_PEER_OBSERVERS_PER_MEMBER, MAX_PEER_PROBE_PORTS_PER_MEMBER } from "./peerObservations";

/*
  探测拓扑的两样与库无关的东西：

    · TopologyCache —— 「全站的转发组探测拓扑」的进程内缓存。以前每台主机每次完整心跳、每次健康上报都把
      所有启用的组 / 成员 / 主机读一遍再挑出自己那份（P8）。现在整份只建一次，按主机查是一次 Map 读取；
      组、成员、主机地址变了就作废（invalidate），另有一个短 TTL 兜底（规则端口变化这类不逐个挂钩的）。
    · planPeerObservers —— 外部观察：每个成员由哪几台别的机器来探。

  真正读库建拓扑的函数在 probeTopology.ts（它要用 common.ts 里的成员 / 主机辅助函数）。
*/

type TimeSource = () => number;

export class TopologyCache<T> {
  private value: { snapshot: T; builtAt: number } | null = null;
  private building: Promise<T> | null = null;
  private generation = 0;

  constructor(
    private readonly build: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: TimeSource = Date.now,
  ) {}

  /** 拿当前拓扑：没过期直接给；过期 / 作废了重建，并发只建一次。 */
  async get(): Promise<T> {
    const current = this.value;
    if (current && this.now() - current.builtAt < this.ttlMs) return current.snapshot;
    if (this.building) return this.building;
    const generation = this.generation;
    const work = this.build().then((snapshot) => {
      // 建的过程中又被作废了：这份可能是旧数据，交给这次的调用方用，但不留在缓存里。
      if (generation === this.generation) this.value = { snapshot, builtAt: this.now() };
      return snapshot;
    }).finally(() => {
      if (this.building === work) this.building = null;
    });
    this.building = work;
    return work;
  }

  /** 已经建好的那份（可能过期）；从没建过是 null。只读内存。 */
  peek(): T | null {
    return this.value?.snapshot ?? null;
  }

  invalidate() {
    this.generation += 1;
    this.value = null;
    // 正在建的那份读的可能是改之前的数据：下一次 get 重新建，不搭它的车。
    this.building = null;
  }
}

export type PeerProbePort = { port: number; method: "tcp" | "udp" };

export type PeerObserverCandidate = {
  hostId: number;
  /** Agent 版本够新，能当观察点。 */
  capable: boolean;
};

export type PeerTargetMember = {
  memberId: number;
  /** 成员的入口主机（隧道成员是隧道入口机）。 */
  hostId: number;
  enabled: boolean;
  /** 访客实际连的地址（发布到解析里的那个值）。空 = 不探。 */
  targetIp: string;
  ports: PeerProbePort[];
};

export type PeerAssignment = {
  memberId: number;
  hostId: number;
  targetIp: string;
  ports: PeerProbePort[];
  observerHostIds: number[];
};

/** 访客实际连的端口里挑几个去探：TCP 优先（连得上才是真的通），再按端口号，最多 MAX_PEER_PROBE_PORTS_PER_MEMBER 个。 */
export function selectPeerProbePorts(listeners: ReadonlyArray<{ port: number; protocol: unknown }>, limit = MAX_PEER_PROBE_PORTS_PER_MEMBER): PeerProbePort[] {
  const byKey = new Map<string, PeerProbePort>();
  for (const listener of listeners) {
    const port = Number(listener.port || 0);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    // 同时开 TCP 和 UDP 的规则探 TCP；只开 UDP 的探 UDP（Agent 端说不准时退回 ping）。
    const method = String(listener.protocol || "both").trim().toLowerCase() === "udp" ? "udp" : "tcp";
    const key = `${method}:${port}`;
    if (!byKey.has(key)) byKey.set(key, { port, method });
  }
  const ports = Array.from(byKey.values());
  // 同一个端口既有 TCP 又有 UDP 时只留 TCP。
  const tcpPorts = new Set(ports.filter((entry) => entry.method === "tcp").map((entry) => entry.port));
  return ports
    .filter((entry) => entry.method === "tcp" || !tcpPorts.has(entry.port))
    .sort((left, right) => (left.method === right.method ? left.port - right.port : left.method === "tcp" ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

export function peerProbePortKey(port: PeerProbePort | { port: number; method: string }) {
  return `${String(port.method || "tcp").toLowerCase()}:${Number(port.port) || 0}`;
}

/**
 * 每个成员由谁来探。
 *
 * 优先同组里别的启用成员（从自己后面那个开始轮着取，观察任务摊得匀），不够再用组设置里指定的观察主机；
 * 每个成员最多 maxObservers 个，观察点不能是成员自己那台机器，Agent 版本不够的不算。
 * 没有地址或没有可探端口的成员不探（observerHostIds 为空的不返回）。
 */
export function planPeerObservers(input: {
  members: readonly PeerTargetMember[];
  /** 成员主机能不能当观察点（按主机 id）。 */
  capableHostIds: ReadonlySet<number>;
  explicitObservers?: readonly PeerObserverCandidate[];
  maxObservers?: number;
}): PeerAssignment[] {
  const maxObservers = Math.max(0, input.maxObservers ?? MAX_PEER_OBSERVERS_PER_MEMBER);
  const enabled = input.members.filter((member) => member.enabled && member.hostId > 0);
  const assignments: PeerAssignment[] = [];
  enabled.forEach((member, index) => {
    if (!member.targetIp || member.ports.length === 0 || maxObservers === 0) return;
    const observers: number[] = [];
    const add = (hostId: number, capable: boolean) => {
      if (observers.length >= maxObservers || !capable) return;
      if (!(hostId > 0) || hostId === member.hostId || observers.includes(hostId)) return;
      observers.push(hostId);
    };
    for (let offset = 1; offset < enabled.length; offset += 1) {
      const peer = enabled[(index + offset) % enabled.length];
      add(peer.hostId, input.capableHostIds.has(peer.hostId));
    }
    for (const candidate of input.explicitObservers || []) add(Number(candidate.hostId), candidate.capable);
    if (observers.length === 0) return;
    assignments.push({ memberId: member.memberId, hostId: member.hostId, targetIp: member.targetIp, ports: member.ports, observerHostIds: observers });
  });
  return assignments;
}

/** 组设置里的观察主机清单（JSON 数组或逗号分隔），规整成去重的正整数，最多 8 台。 */
export function parsePeerObserverHostIds(raw: unknown): number[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = raw.split(",");
    }
  }
  return Array.from(new Set(list.map((value) => Number(value)).filter((id) => Number.isInteger(id) && id > 0))).slice(0, 8);
}

export function serializePeerObserverHostIds(raw: unknown): string | null {
  const ids = parsePeerObserverHostIds(raw);
  return ids.length > 0 ? JSON.stringify(ids) : null;
}
