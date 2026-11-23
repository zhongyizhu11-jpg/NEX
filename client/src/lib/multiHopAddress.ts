import { networkAddressKey } from "@shared/ipAddress";

export type MultiHopAddressHost = {
  ip?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  entryIp?: string | null;
  tunnelEntryIp?: string | null;
};

/** 和服务端共用同一套「算不算同一个地址」的判定，见 shared/ipAddress.ts。 */
function addressKey(value: unknown) {
  return networkAddressKey(value);
}

function sameMultiHopAddress(a: unknown, b: unknown) {
  const left = addressKey(a);
  const right = addressKey(b);
  return !!left && !!right && left === right;
}

export function selectedMultiHopConnectHost(input: {
  host: MultiHopAddressHost | undefined;
  index: number;
  externalEntry: boolean;
  useTunnelEntryIp: boolean;
  useIpv6: boolean;
}) {
  if (input.index === 0 && !input.externalEntry) return null;
  const privateAddr = String(input.host?.tunnelEntryIp || "").trim();
  const ipv6Addr = String(input.host?.ipv6 || "").trim();
  if (input.useTunnelEntryIp && privateAddr) return privateAddr;
  if (input.useIpv6 && ipv6Addr) return ipv6Addr;

  // null means the host's default public/entry address. Keeping the mode
  // separate from the address matters when public and private values match.
  return null;
}

export function multiHopAddressSelection(input: {
  host: MultiHopAddressHost | undefined;
  connectHost: unknown;
  index: number;
  externalEntry: boolean;
}) {
  if (input.index === 0 && !input.externalEntry) {
    return { useTunnelEntryIp: false, useIpv6: false };
  }
  const connectHost = String(input.connectHost || "").trim();
  const privateAddr = String(input.host?.tunnelEntryIp || "").trim();
  const ipv6Addr = String(input.host?.ipv6 || "").trim();
  const useTunnelEntryIp = !!connectHost && !!privateAddr && sameMultiHopAddress(connectHost, privateAddr);
  return {
    useTunnelEntryIp,
    useIpv6: !useTunnelEntryIp && !!connectHost && !!ipv6Addr && sameMultiHopAddress(connectHost, ipv6Addr),
  };
}

/** 两个地址是不是同一个（走 addressKey 归一，能识别 IPv6 的不同写法）。 */
export function sameAddress(a: unknown, b: unknown) {
  const left = addressKey(a);
  const right = addressKey(b);
  return !!left && !!right && left === right;
}

/** 内网入口地址：只有显式配过 tunnelEntryIp 才算。 */
export function hostPrivateAddress(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

export function hostIpv6Address(host: any) {
  return String(host?.ipv6 || "").trim();
}

/**
 * 把「连接地址」收敛到这台机器确实有的地址上。
 *
 * 链路管理和转发组原来各存一份。填的地址对不上这台机器的任何一个地址时回
 * fallback（通常是 null）—— null 在这里是有意义的：它让地址选择器保持禁用，
 * 由运行时去解析这台机器当前的公网/入口地址，而不是把一个过期的地址钉死。
 */
export function normalizeConnectHostForHost(value: unknown, host: any, fallback: string | null = null) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const privateAddr = hostPrivateAddress(host);
  const ipv6Addr = hostIpv6Address(host);
  if (privateAddr && sameAddress(text, privateAddr)) return privateAddr;
  if (ipv6Addr && sameAddress(text, ipv6Addr)) return ipv6Addr;
  return fallback;
}

/**
 * 两个「可空字符串数组」是不是等价。链路管理和转发组原来各存一份，一字不差。
 *
 * 用在「表单改过没有」的判断上：判错成「没改」就会静默丢掉用户刚填的东西。
 *
 * 注意 `|| null` 不是 `?? null` —— 原实现把**空串也当成 null**，也就是「没填」和
 * 「填了又清空」视为同一件事。这里照搬，不顺手改：那两页的表单初值本来就混用
 * null 和 ""，改成区分会让一批本来相等的表单突然被判成「改过了」。
 */
export function sameNullableStringArray(a: Array<string | null>, b: Array<string | null>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] || null) !== (b[i] || null)) return false;
  }
  return true;
}
