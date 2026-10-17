import { isIP } from "node:net";
import { normalizeClientIp } from "./ops/firewallCidr";

/*
  「本机端口转发回本机同端口」的死循环检查。规则新建 / 编辑（server/routers/rules.crud.ts）和
  转发组换成员（server/repositories/forwardGroupRepository.ts 的 replaceForwardGroupMembers：
  入口组加了主机、端口转发 / 故障转移组加了成员，子规则会铺到新主机上）共用这一份。
*/

export function normalizeAddressToken(value: unknown) {
  const token = String(value || "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
  // 是 IP 就换成统一写法再比：2001:0db8:0:0:0:0:0:9 和 2001:db8::9、::ffff:1.2.3.4 和 1.2.3.4 是同一个地址。
  // 带 %zone 的链路本地地址不动（zone 不同可能是另一台邻居）；不是 IP 的（域名）照旧按小写文本比。
  if (isIP(token) && !token.includes("%")) return normalizeClientIp(token) || token;
  return token;
}

export function isLoopbackAddress(value: unknown) {
  const target = normalizeAddressToken(value);
  if (!target) return false;
  if (target === "localhost" || target === "ip6-localhost") return true;
  if (target === "0.0.0.0" || target === "::" || target === "0:0:0:0:0:0:0:0") return true;
  if (target === "::1" || target === "0:0:0:0:0:0:0:1") return true;
  // Browsers and DNS libraries also accept non-dotted IPv4 forms. Normalize
  // 32-bit decimal/hex forms before applying the loopback check so 127.0.0.1
  // cannot be disguised as 2130706433 or 0x7f000001.
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(target)) {
    const value32 = target.startsWith("0x") ? Number.parseInt(target.slice(2), 16) : Number(target);
    if (Number.isSafeInteger(value32) && value32 >= 0 && value32 <= 0xffffffff) {
      const firstOctet = Math.floor(value32 / 0x1000000);
      if (firstOctet === 127) return true;
    }
  }
  if (isIP(target) === 4) return target.startsWith("127.");
  return false;
}

export function hostAddressTokens(host: any) {
  return new Set(
    [
      host?.ip,
      host?.ipv4,
      host?.ipv6,
      host?.entryIp,
      host?.tunnelEntryIp,
      host?.ddnsDomain,
    ]
      .map(normalizeAddressToken)
      .filter(Boolean),
  );
}

export function assertNoDirectSelfForwardLoop(options: {
  host?: any;
  sourcePort: number;
  targetIp: unknown;
  targetPort: number;
  tunnelId?: number | null;
}) {
  const sourcePort = Number(options.sourcePort || 0);
  const targetPort = Number(options.targetPort || 0);
  if (sourcePort <= 0 || sourcePort !== targetPort) return;
  if (Number(options.tunnelId || 0) > 0) return;
  const target = normalizeAddressToken(options.targetIp);
  if (!target) return;
  if (isLoopbackAddress(target) || hostAddressTokens(options.host).has(target)) {
    throw new Error(`禁止将本机 ${sourcePort} 端口转发回自身同端口，这会造成转发死循环`);
  }
}
