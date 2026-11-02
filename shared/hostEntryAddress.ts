/**
 * 主机入口地址的推导规则。
 *
 * 这段逻辑原本只存在于 client/src/pages/Rules.tsx，供面板展示「入口地址」。
 * 客户端订阅需要在服务端算出完全相同的地址：一旦两边算法漂移，订阅里的节点
 * 地址就会和面板上显示的对不上，而这种不一致极难排查。所以统一放在 shared，
 * 面板与服务端共用同一份实现。
 */

export type EntryAddressFamily = "ipv4" | "ipv6" | "hostname" | "unknown";

export type HostEntryAddress = {
  /** 地址来源，例如「自定义」「DDNS」「IPv4」，直接展示给用户 */
  label: string;
  value: string;
};

/** 入口地址推导需要读到的主机字段。 */
export type HostEntryAddressSource = {
  ip?: unknown;
  ipv4?: unknown;
  ipv6?: unknown;
  entryIp?: unknown;
  ddnsEnabled?: unknown;
  ddnsDomain?: unknown;
};

function cleanAddressLiteral(value: unknown): string {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text.replace(/^tcp:\/\//i, "").trim();
  if (text.startsWith("[") && text.includes("]")) return text.slice(1, text.indexOf("]")).trim();
  return text;
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function getEntryAddressFamily(value: unknown): EntryAddressFamily {
  const text = cleanAddressLiteral(value);
  if (!text) return "unknown";
  if (isIpv4Literal(text)) return "ipv4";
  const withoutZone = text.replace(/%.+$/, "");
  if (withoutZone.includes(":") && /^[0-9a-f:.]+$/i.test(withoutZone)) return "ipv6";
  if (/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(text)) return "hostname";
  return "unknown";
}

/** 按值去重后追加一个入口地址；空值和重复值都会被丢弃。 */
export function pushUniqueHostEntryAddress(rows: HostEntryAddress[], label: string, value: unknown): void {
  const text = String(value ?? "").trim();
  if (!text || rows.some((row) => row.value === text)) return;
  rows.push({ label, value: text });
}

export function hostDdnsDomain(host: HostEntryAddressSource | null | undefined): string {
  return host?.ddnsEnabled ? String(host?.ddnsDomain ?? "").trim() : "";
}

export function hostAutoIpv4(host: HostEntryAddressSource | null | undefined): string {
  const ipv4 = String(host?.ipv4 ?? "").trim();
  if (ipv4) return ipv4;
  const ip = String(host?.ip ?? "").trim();
  return ip && !ip.includes(":") ? ip : "";
}

export function hostAutoIpv6(host: HostEntryAddressSource | null | undefined): string {
  const ipv6 = String(host?.ipv6 ?? "").trim();
  if (ipv6) return ipv6;
  const ip = String(host?.ip ?? "").trim();
  return ip && ip.includes(":") ? ip : "";
}

/**
 * 按优先级列出主机的入口地址：自定义域名 > DDNS 域名 > 自定义 IP > 自动探测的
 * IP。域名排在 IP 前面，是因为主机换 IP 后域名仍然有效。
 */
export function getHostEntryAddresses(host: HostEntryAddressSource | null | undefined): HostEntryAddress[] {
  const rows: HostEntryAddress[] = [];
  const manualEntry = String(host?.entryIp ?? "").trim();
  const ddnsDomain = hostDdnsDomain(host);
  const ipv4 = hostAutoIpv4(host);
  const ipv6 = hostAutoIpv6(host);
  const manualIsDomain = getEntryAddressFamily(manualEntry) === "hostname";
  if (manualEntry && manualIsDomain) pushUniqueHostEntryAddress(rows, "自定义", manualEntry);
  if (ddnsDomain) pushUniqueHostEntryAddress(rows, "DDNS", ddnsDomain);
  if (manualEntry && !manualIsDomain) pushUniqueHostEntryAddress(rows, "入口", manualEntry);
  if (!manualEntry && !ddnsDomain) {
    pushUniqueHostEntryAddress(rows, ipv4 ? "IPv4" : ipv6 ? "IPv6" : "IP", ipv4 || ipv6 || host?.ip);
  }
  if (ipv6) pushUniqueHostEntryAddress(rows, "IPv6", ipv6);
  return rows;
}

/** 主机的首选入口地址，也就是订阅里该用的那一个。 */
export function getHostEntryAddress(host: HostEntryAddressSource | null | undefined): string {
  return getHostEntryAddresses(host)[0]?.value || "";
}

/** 拼接地址和端口，IPv6 字面量补上方括号。 */
export function formatHostAddressWithPort(address: string, port: number | string): string {
  const value = String(address ?? "").trim();
  if (!value) return "";
  if (value.includes(":") && !value.startsWith("[") && !value.endsWith("]")) {
    return `[${value}]:${port}`;
  }
  return `${value}:${port}`;
}

/**
 * 这台机器的 Agent 到底装没装上。
 *
 * 「从没连上过」和「掉线了」是两件事，代价也不一样：
 *
 * - 掉线是暂时的，机器重启、网络抖一下都会掉。界面上那个状态点已经在说了，再拿它
 *   去警告一遍只会天天报。
 * - **从没连上过**不是暂时的，是一步没做完：机器加进面板了，Agent 却还没装。在这种
 *   机器上开出来的落地端口，配置根本下发不下去 —— 可面板照样把它当成一条好线路发进
 *   订阅，客户端拉到手连不上，而这一页上没有任何字提到过这件事。
 *
 * 判据是心跳：收过一次心跳，就说明 Agent 曾经装好并连上过，之后的掉线归状态点管。
 */
export function hostNeverConnected(host: { lastHeartbeat?: unknown } | null | undefined): boolean {
  if (!host) return false;
  const raw = (host as any).lastHeartbeat;
  if (raw === null || raw === undefined || raw === "") return true;
  const time = raw instanceof Date ? raw.getTime() : new Date(raw as any).getTime();
  // 解析不出来的时间戳当作「有过心跳」：宁可漏说一句，也不要对着一台好机器报警。
  return Number.isFinite(time) ? time <= 0 : false;
}
