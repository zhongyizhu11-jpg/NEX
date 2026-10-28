import { isIP } from "node:net";

import { setBoundedMapValue } from "./boundedCache";

/*
  出口 IP 核对：面板看到的 Agent 连接源地址，和这台机器登记的 IP 对不对得上。

  Open-Box 的链式代理编辑时直接查出口 IP 和归属 —— 落地的 IP 被机房换了、机器上多了一层
  代理、用户手填的地址早就不是这台机器，都是「以为在走 A，其实在走 B」。NEX 每次心跳本来就
  看得到对端地址（agentAddressState.observedAgentAddress），只是只拿来补空、从不拿来核对。

  只留内存：心跳几秒一次，重启就又有了。不同族（登记的是 v4、看到的是 v6）不比。
*/

type Entry = { address: string; at: number };

const MAX_HOSTS = 50_000;
const STALE_MS = 10 * 60_000;
const byHost = new Map<number, Entry>();

export function recordHostObservedAddress(hostId: number, address: string, nowMs = Date.now()) {
  const id = Math.floor(Number(hostId));
  const value = String(address || "").trim();
  if (!(id > 0) || !isIP(value)) return;
  setBoundedMapValue(byHost, id, { address: value, at: nowMs }, MAX_HOSTS);
}

export function getHostObservedAddress(hostId: number, nowMs = Date.now()): string | null {
  const entry = byHost.get(Math.floor(Number(hostId)));
  if (!entry || nowMs - entry.at > STALE_MS) return null;
  return entry.address;
}

/**
 * 登记的地址（Agent 报的或手填的）和面板看到的出口 IP 是不是同一个。
 * 同一族才比；登记的那一族是空的也不算不符（没法比）。
 */
export function exitAddressMismatch(host: { ipv4?: unknown; ipv6?: unknown; ip?: unknown }, observed: string | null): boolean {
  if (!observed) return false;
  const family = isIP(observed);
  const registered = String((family === 4 ? host.ipv4 : host.ipv6) || "").trim() || (isIP(String(host.ip || "").trim()) === family ? String(host.ip).trim() : "");
  if (!registered) return false;
  return registered !== observed;
}

export function withHostObservedAddress<T extends { id: number | string; ipv4?: unknown; ipv6?: unknown; ip?: unknown }>(rows: T[], nowMs = Date.now()): Array<T & { observedIp: string | null; exitIpMismatch: boolean }> {
  return rows.map((row) => {
    const observed = getHostObservedAddress(Number(row.id), nowMs);
    return { ...row, observedIp: observed, exitIpMismatch: exitAddressMismatch(row, observed) };
  });
}

export function resetHostObservedAddressesForTest() {
  byHost.clear();
}
