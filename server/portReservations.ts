import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeForwardRuleProtocol, type ForwardRuleProtocol } from "../shared/forwardTypes";

type ReservationEntry = {
  token: symbol;
  protocol: ForwardRuleProtocol;
};

export type HostPortReservation = {
  hostId: number;
  port: number;
  protocol: ForwardRuleProtocol;
  release: () => void;
  /** combineHostPortReservations 合成的预留：各台主机上的那几个。 */
  parts?: readonly HostPortReservation[];
};

type PortUsageCheck = (port: number) => Promise<boolean>;

const reservations = new Map<number, Map<number, ReservationEntry[]>>();

function protocolsConflict(_left: ForwardRuleProtocol, _right: ForwardRuleProtocol) {
  return true;
}

function normalizedHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : 0;
}

function normalizedPort(value: unknown) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

export function reservedHostPorts(hostIdValue: unknown, protocolValue: unknown) {
  const hostId = normalizedHostId(hostIdValue);
  const protocol = normalizeForwardRuleProtocol(protocolValue, "both");
  const hostReservations = reservations.get(hostId);
  if (!hostReservations) return [];
  const ports: number[] = [];
  for (const [port, entries] of hostReservations) {
    if (entries.some((entry) => protocolsConflict(entry.protocol, protocol))) ports.push(port);
  }
  return ports;
}

export function tryReserveHostPort(hostIdValue: unknown, portValue: unknown, protocolValue: unknown): HostPortReservation | null {
  const hostId = normalizedHostId(hostIdValue);
  const port = normalizedPort(portValue);
  const protocol = normalizeForwardRuleProtocol(protocolValue, "both");
  if (!hostId || !port) return null;

  let hostReservations = reservations.get(hostId);
  if (!hostReservations) {
    hostReservations = new Map();
    reservations.set(hostId, hostReservations);
  }
  const entries = hostReservations.get(port) || [];
  if (entries.some((entry) => protocolsConflict(entry.protocol, protocol))) return null;

  const token = Symbol(`host:${hostId}:port:${port}`);
  entries.push({ token, protocol });
  hostReservations.set(port, entries);
  let released = false;
  return {
    hostId,
    port,
    protocol,
    release: () => {
      if (released) return;
      released = true;
      const currentHost = reservations.get(hostId);
      const currentEntries = currentHost?.get(port);
      if (!currentHost || !currentEntries) return;
      const remaining = currentEntries.filter((entry) => entry.token !== token);
      if (remaining.length > 0) currentHost.set(port, remaining);
      else currentHost.delete(port);
      if (currentHost.size === 0) reservations.delete(hostId);
    },
  };
}

export async function reserveSpecificHostPort(options: {
  hostId: number;
  port: number;
  protocol: unknown;
  isUsed?: PortUsageCheck;
}): Promise<HostPortReservation | null> {
  const reservation = tryReserveHostPort(options.hostId, options.port, options.protocol);
  if (!reservation) return null;
  try {
    if (options.isUsed && await options.isUsed(reservation.port)) {
      reservation.release();
      return null;
    }
    return reservation;
  } catch (error) {
    reservation.release();
    throw error;
  }
}

export async function reserveAvailableHostPort(options: {
  hostId: number;
  protocol: unknown;
  findPort: (reservedPorts: number[]) => Promise<number | null>;
  isUsed?: PortUsageCheck;
  maxAttempts?: number;
}): Promise<HostPortReservation | null> {
  const maxAttempts = Math.max(1, Math.min(256, Number(options.maxAttempts) || 64));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = await options.findPort(reservedHostPorts(options.hostId, options.protocol));
    if (!port) return null;
    const reservation = tryReserveHostPort(options.hostId, port, options.protocol);
    if (!reservation) continue;
    try {
      if (options.isUsed && await options.isUsed(port)) {
        reservation.release();
        continue;
      }
    } catch (error) {
      reservation.release();
      throw error;
    }
    return reservation;
  }
  return null;
}

export function releaseHostPortReservations(items: Iterable<HostPortReservation>) {
  for (const reservation of items) reservation.release();
}

/** 把几台主机上的同一端口预留合成一个：release() 时一起放掉。 */
export function combineHostPortReservations(items: HostPortReservation[]): HostPortReservation {
  if (items.length === 1) return items[0];
  const [first] = items;
  return {
    hostId: first.hostId,
    port: first.port,
    protocol: first.protocol,
    release: () => releaseHostPortReservations(items),
    parts: items,
  };
}

/**
 * 端口段规则（shared/portRange.ts）：段里每个端口都占住，任何一个占不到就把这次占到的全放掉。
 * 合成的预留 port 记段的第一个端口，release() 一起放。
 */
export function tryReserveHostPortRange(hostIdValue: unknown, startValue: unknown, endValue: unknown, protocolValue: unknown): HostPortReservation | null {
  const start = normalizedPort(startValue);
  const end = normalizedPort(endValue);
  if (!start || !end || end < start) return null;
  const acquired: HostPortReservation[] = [];
  for (let port = start; port <= end; port += 1) {
    const reservation = tryReserveHostPort(hostIdValue, port, protocolValue);
    if (!reservation) {
      releaseHostPortReservations(acquired);
      return null;
    }
    acquired.push(reservation);
  }
  return combineHostPortReservations(acquired);
}

/**
 * 同一个端口要在几台主机上同时监听（挂了入口组的隧道上的规则：入口机和组里每台启用的主机）：
 * 每台都占住并查一遍，任何一台占不到或已被使用就把这次占到的全部放掉、返回 null。
 * 只占一台的话，另一个请求可以同时在组里的其他主机上建同端口的规则，两边都通过检查。
 */
export async function reserveSpecificHostPortOnHosts(options: {
  hostIds: number[];
  port: number;
  protocol: unknown;
  isUsed?: (hostId: number, port: number) => Promise<boolean>;
}): Promise<HostPortReservation | null> {
  const hostIds = Array.from(new Set(options.hostIds.map(normalizedHostId).filter((id) => id > 0)));
  if (hostIds.length === 0) return null;
  const acquired: HostPortReservation[] = [];
  try {
    for (const hostId of hostIds) {
      const reservation = await reserveSpecificHostPort({
        hostId,
        port: options.port,
        protocol: options.protocol,
        isUsed: options.isUsed ? (port) => options.isUsed!(hostId, port) : undefined,
      });
      if (!reservation) {
        releaseHostPortReservations(acquired);
        return null;
      }
      acquired.push(reservation);
    }
  } catch (error) {
    releaseHostPortReservations(acquired);
    throw error;
  }
  return combineHostPortReservations(acquired);
}

/**
 * 随机分配一个在所有这些主机上都空着的端口并一起占住。findPort 拿到的 reservedPorts 是这些主机上
 * 进程内已预留端口的并集，再加上前几轮在别的主机上撞了的端口；findPort 自己要把其他主机上
 * 库里已占用的端口也排除掉（取交集），否则可能一直挑到同一个在成员机上被占的端口。
 */
export async function reserveAvailableHostPortOnHosts(options: {
  hostIds: number[];
  protocol: unknown;
  findPort: (reservedPorts: number[]) => Promise<number | null>;
  isUsed?: (hostId: number, port: number) => Promise<boolean>;
  maxAttempts?: number;
}): Promise<HostPortReservation | null> {
  const hostIds = Array.from(new Set(options.hostIds.map(normalizedHostId).filter((id) => id > 0)));
  if (hostIds.length === 0) return null;
  const maxAttempts = Math.max(1, Math.min(256, Number(options.maxAttempts) || 64));
  const rejected = new Set<number>();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const reserved = new Set<number>(rejected);
    for (const hostId of hostIds) {
      for (const port of reservedHostPorts(hostId, options.protocol)) reserved.add(port);
    }
    const port = await options.findPort(Array.from(reserved));
    if (!port) return null;
    const reservation = await reserveSpecificHostPortOnHosts({
      hostIds,
      port,
      protocol: options.protocol,
      isUsed: options.isUsed,
    });
    if (reservation) return reservation;
    rejected.add(port);
  }
  return null;
}

/*
  「这个端口是我这条调用链自己占着的」。

  建 / 改转发组模板的请求先替每台入口机占住端口，再去同步子规则；同步里给新子规则占端口
  自然占不到，这时要退回只查库。但后台同步（自愈、成员变更）并没有替谁占着：占不到说明
  另一个请求正在这台机器上分配同一个端口，退回只查库就会两边都通过、抢同一个端口。
  所以持有预留的调用方用 runWithHeldHostPortReservations 把预留登记到调用链上，同步里
  用 isHostPortReservationHeldByCaller 分辨。按数组引用登记：之后再 push 进去的预留也算。
*/
const heldReservationContext = new AsyncLocalStorage<ReadonlyArray<readonly HostPortReservation[]>>();

export function runWithHeldHostPortReservations<T>(items: readonly HostPortReservation[], task: () => Promise<T>): Promise<T> {
  const inherited = heldReservationContext.getStore() || [];
  return heldReservationContext.run([...inherited, items], task);
}

export function isHostPortReservationHeldByCaller(hostIdValue: unknown, portValue: unknown) {
  const hostId = normalizedHostId(hostIdValue);
  const port = normalizedPort(portValue);
  if (!hostId || !port) return false;
  // 已经放掉的预留不算：放掉之后全局表里就没有这个端口了。
  if (!reservations.get(hostId)?.has(port)) return false;
  const lists = heldReservationContext.getStore();
  const matches = (item: HostPortReservation): boolean => (item.parts
    ? item.parts.some(matches)
    : item.hostId === hostId && item.port === port);
  return !!lists?.some((list) => list.some(matches));
}

export function clearHostPortReservationsForTest() {
  reservations.clear();
}
