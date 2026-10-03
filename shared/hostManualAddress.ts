import { isIP } from "node:net";

/**
 * 主机编辑框里的「Agent 检测 IP」可以手改。
 *
 * Agent 自己查到的公网 IP 有时不是别人连得进来的那个（国内机器查不到时面板用连接源地址补，
 * 那是出口 IP；NAT / IPLC 机器的出口和入口不是一个）。手改之后这台主机的地址就由用户说了算：
 * addressManual = true，心跳不再覆盖（agentAddressState.mergeAgentReportedAddress）；
 * 清空就交回 Agent 自动检测。
 *
 * 输入随便写：「1.2.3.4」「1.2.3.4, 2001:db8::1」，也接受框里原样显示的「IPv4 1.2.3.4  /  IPv6 …」。
 */
export type ManualHostAddress =
  | { manual: false }
  | { manual: true; ip: string; ipv4: string | null; ipv6: string | null };

export function parseManualHostAddress(input: string): ManualHostAddress | { error: string } {
  const tokens = String(input || "")
    .split(/[\s,，;；/]+/)
    .map((token) => token.trim().replace(/^\[(.*)\]$/, "$1"))
    .filter((token) => token && !/^(ipv4|ipv6|ip)$/i.test(token));
  if (tokens.length === 0) return { manual: false };
  let ipv4: string | null = null;
  let ipv6: string | null = null;
  for (const token of tokens) {
    const family = isIP(token);
    if (family === 4 && !ipv4) ipv4 = token;
    else if (family === 6 && !ipv6) ipv6 = token.toLowerCase();
    else if (family === 0) return { error: `「${token}」不是 IP 地址` };
    else return { error: "IPv4、IPv6 各填一个就行" };
  }
  return { manual: true, ip: (ipv4 || ipv6)!, ipv4, ipv6 };
}
