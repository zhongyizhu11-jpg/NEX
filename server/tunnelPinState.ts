/*
  每条链路此刻实际生效的「手动指定出口」（2.3.558）：入口心跳下发配置时算的那一个（heartbeat/exitSelectionHelpers 的
  pinnedExitHostId —— 指定的那台离线时不理它，记 0），和入口手里的配置一致。

  规则卡要分清「指定的出口连不上、已切到别的出口」（走势线琥珀，提醒指定没生效）和「自动分配时某台出口坏了、流量在好的
  上面照走」（正常的绿色）。exitTargetHealth 只在快速探测上报时才拿得到链路行，「只看出口组」时没有快速探测，所以单独记在这里。
  这个模块不引别的模块，谁都能引。
*/

const pinByTunnel = new Map<number, number>();
const MAX_TUNNELS = 20_000;

export function noteTunnelEffectivePin(tunnelId: unknown, hostId: unknown) {
  const tid = Number(tunnelId);
  if (!Number.isInteger(tid) || tid <= 0) return;
  const pin = Number(hostId);
  if (!Number.isInteger(pin) || pin <= 0) {
    pinByTunnel.delete(tid);
    return;
  }
  if (!pinByTunnel.has(tid) && pinByTunnel.size >= MAX_TUNNELS) pinByTunnel.delete(pinByTunnel.keys().next().value as number);
  pinByTunnel.set(tid, pin);
}

/** 这条链路此刻实际生效的指定出口；没指定（或指定的那台离线）是 0。 */
export function tunnelEffectivePin(tunnelId: unknown): number {
  return pinByTunnel.get(Number(tunnelId)) || 0;
}

/** 只给测试用 */
export function resetTunnelPinStateForTest() {
  pinByTunnel.clear();
}
