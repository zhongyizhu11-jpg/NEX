import { classifyIpAddress } from "./ipAddress";

/**
 * 主机的多个公网地址与「主 IP」（上游 2.3.286 的多 IP 检测）。
 *
 * Agent 2.2.253 起在静态信息里多报一份 publicAddresses：网卡上真正配着的全部公网 IPv4 / IPv6
 * （agent/public_addresses.go），外加它现在出网用的那个。面板存在 hosts.detectedAddresses（JSON），
 * 管理员可以在编辑框里分别挑一个主 IPv4、主 IPv6（hosts.primaryIpv4 / primaryIpv6）。
 *
 * 主 IP 只做一件事：**喂给原来那几个单地址字段**（ip / ipv4 / ipv6）。规则、隧道、订阅、入口地址
 * 全都还是读这几个字段，一行都不用改 —— 这是故意的：要是让每个消费方自己去挑「哪一个」，迟早有
 * 一处挑得不一样，面板显示的入口和订阅里的入口就对不上了。
 *
 * 规则：
 * - 从没挑过（primaryIpv4 / primaryIpv6 为空）：跟今天一模一样，用 Agent 上报的那一个。
 * - 挑过：一直用它，哪怕它不在最近一次检测到的列表里了（机房回收、网卡重配期间常有短暂消失），
 *   这时只在界面上提示，不自动换 —— 自动换等于悄悄改了所有规则的入口。
 * - 手改过「Agent 检测 IP」（addressManual）：手填的说了算，主 IP 选择暂不生效（agentAddressState）。
 * - 老 Agent 不报列表：detectedAddresses 一直是空，主 IP 也挑不了，什么都不变。
 */

/** 从这个版本起 Agent 会上报网卡上的全部公网地址（agent/public_addresses.go）。 */
export const HOST_PUBLIC_ADDRESS_LIST_AGENT_VERSION = "2.2.253";

/** 每一族最多存多少个：和 Agent 那边的 maxReportedPublicAddresses 一致，面板这边再截一次防异常上报。 */
export const MAX_HOST_PUBLIC_ADDRESSES = 16;

export type HostAddressFamily = "ipv4" | "ipv6";

export type HostDetectedAddresses = {
  ipv4: string[];
  ipv6: string[];
  /** Agent 现在出网用的地址（ipify 看到的那个；NAT 机器上可能不在网卡列表里） */
  egressIpv4: string | null;
  egressIpv6: string | null;
  /** 最近一次上报的时间（毫秒） */
  reportedAt: number;
};

function addressFamilyOf(value: string): HostAddressFamily | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return "ipv4";
  if (value.includes(":") && /^[0-9a-f:.]+$/i.test(value)) return "ipv6";
  return null;
}

/** 规范成可以比较的写法；不是公网单播地址、或者族不对，返回空串。 */
export function normalizePublicAddress(value: unknown, family?: HostAddressFamily): string {
  let text = String(value ?? "").trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (!text || text.length > 64) return "";
  const detected = addressFamilyOf(text);
  if (!detected || (family && detected !== family)) return "";
  // 公网判定 Agent 那边已经做过（agent/public_addresses.go）。这里只挡明显不对的：内网、环回、链路本地、组播。
  // 不用 classifyIpAddress === "public"：它的几段保留段故意划得比 RFC 宽（见 shared/ipAddress.ts），
  // 拿来过滤主机自己的地址会误杀 203.0.x.x 这类真实分配出去的公网 IP。
  const kind = classifyIpAddress(text);
  if (kind === "invalid" || kind === "private" || kind === "loopback" || kind === "linkLocal" || kind === "multicast") return "";
  if (/^0\./.test(text) || /^(0*:)*:?0*$/.test(text)) return "";
  return detected === "ipv6" ? text.toLowerCase() : text;
}

function normalizeAddressList(raw: unknown, family: HostAddressFamily): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const value = normalizePublicAddress(item, family);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= MAX_HOST_PUBLIC_ADDRESSES) break;
  }
  return out;
}

/**
 * 心跳里的 publicAddresses。没带（老 Agent，或者这一拍不报静态信息）返回 null —— 调用方据此「不动」，
 * 不能当成「一个都没有」去清空。
 */
export function normalizeHostDetectedAddressReport(raw: unknown, nowMs = Date.now()): HostDetectedAddresses | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const report = raw as Record<string, unknown>;
  if (!Array.isArray(report.ipv4) && !Array.isArray(report.ipv6)) return null;
  return {
    ipv4: normalizeAddressList(report.ipv4, "ipv4"),
    ipv6: normalizeAddressList(report.ipv6, "ipv6"),
    egressIpv4: normalizePublicAddress(report.egressIpv4, "ipv4") || null,
    egressIpv6: normalizePublicAddress(report.egressIpv6, "ipv6") || null,
    reportedAt: Math.max(0, Math.floor(Number(nowMs) || 0)),
  };
}

/** 读库里的 detectedAddresses 栏（JSON 文本）；空、坏的都当没有。 */
export function parseHostDetectedAddresses(stored: unknown): HostDetectedAddresses | null {
  if (stored && typeof stored === "object") {
    return normalizeHostDetectedAddressReport(stored, Number((stored as { reportedAt?: unknown }).reportedAt) || 0);
  }
  const text = String(stored ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return normalizeHostDetectedAddressReport(parsed, Number(parsed?.reportedAt) || 0);
  } catch {
    return null;
  }
}

export function serializeHostDetectedAddresses(value: HostDetectedAddresses): string {
  return JSON.stringify({
    ipv4: value.ipv4,
    ipv6: value.ipv6,
    egressIpv4: value.egressIpv4,
    egressIpv6: value.egressIpv6,
    reportedAt: value.reportedAt,
  });
}

/** 不含上报时间的签名：只有地址真的变了才写库、才触发 DDNS。 */
export function hostDetectedAddressesSignature(value: HostDetectedAddresses | null | undefined): string {
  if (!value) return "";
  return [value.ipv4.join(","), value.ipv6.join(","), value.egressIpv4 || "", value.egressIpv6 || ""].join("|");
}

export type HostPrimaryAddressSource = {
  ip?: unknown;
  ipv4?: unknown;
  ipv6?: unknown;
  addressManual?: unknown;
  primaryIpv4?: unknown;
  primaryIpv6?: unknown;
  detectedAddresses?: unknown;
};

function boolish(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** 管理员挑的主 IPv4 / IPv6（没挑过是空串）。 */
export function hostChosenPrimaryAddress(host: HostPrimaryAddressSource | null | undefined, family: HostAddressFamily): string {
  return normalizePublicAddress(family === "ipv4" ? host?.primaryIpv4 : host?.primaryIpv6, family);
}

/**
 * 心跳合并地址时用：Agent 这次报的单个地址要不要换成管理员挑的主 IP。
 * 返回 null 表示「照旧用上报的」（没挑过）。手改过地址的主机不走这里（agentAddressState 先拦了）。
 */
export function applyChosenPrimaryAddress(
  host: HostPrimaryAddressSource | null | undefined,
  family: HostAddressFamily,
  reported: string,
): string {
  return hostChosenPrimaryAddress(host, family) || reported;
}

export type HostAddressRow = {
  family: HostAddressFamily;
  address: string;
  /** 现在实际在用的那个（= hosts.ipv4 / ipv6） */
  primary: boolean;
  /** 管理员挑的 */
  chosen: boolean;
  /** Agent 出网用的 */
  egress: boolean;
  /** 在最近一次检测到的网卡地址里 */
  detected: boolean;
};

/**
 * 主机列表 / 详情 / 编辑框里展示用：检测到的全部地址，标出主 IP、出口 IP；
 * 正在用、但已经不在检测列表里的地址也列出来（detected=false），好配合警告一起看。
 */
export function hostAddressRows(host: HostPrimaryAddressSource | null | undefined): HostAddressRow[] {
  const detected = parseHostDetectedAddresses(host?.detectedAddresses);
  const rows: HostAddressRow[] = [];
  for (const family of ["ipv4", "ipv6"] as const) {
    const current = normalizePublicAddress(family === "ipv4" ? host?.ipv4 : host?.ipv6, family)
      || (family === addressFamilyOf(String(host?.ip ?? "").trim()) ? normalizePublicAddress(host?.ip, family) : "");
    const chosen = hostChosenPrimaryAddress(host, family);
    const egress = family === "ipv4" ? detected?.egressIpv4 || "" : detected?.egressIpv6 || "";
    const list = family === "ipv4" ? detected?.ipv4 || [] : detected?.ipv6 || [];
    const ordered: string[] = [];
    for (const value of [current, ...list, egress]) {
      if (value && !ordered.includes(value)) ordered.push(value);
    }
    for (const address of ordered) {
      rows.push({
        family,
        address,
        primary: address === current,
        chosen: address === chosen,
        egress: address === egress,
        detected: list.includes(address),
      });
    }
  }
  return rows;
}

/** 编辑框里主 IP 下拉的候选：检测到的网卡地址 + 出口地址 + 已经挑过的那个（哪怕消失了，也得能看见它）。 */
export function hostPrimaryAddressOptions(host: HostPrimaryAddressSource | null | undefined, family: HostAddressFamily): string[] {
  const detected = parseHostDetectedAddresses(host?.detectedAddresses);
  const out: string[] = [];
  const list = family === "ipv4" ? detected?.ipv4 || [] : detected?.ipv6 || [];
  const egress = family === "ipv4" ? detected?.egressIpv4 : detected?.egressIpv6;
  for (const value of [...list, egress || "", hostChosenPrimaryAddress(host, family)]) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** 这台主机能不能挑主 IP：Agent 报过列表，而且某一族有不止一个候选（只有一个就没得挑）。 */
export function hostHasMultiplePublicAddresses(host: HostPrimaryAddressSource | null | undefined): boolean {
  return hostPrimaryAddressOptions(host, "ipv4").length > 1 || hostPrimaryAddressOptions(host, "ipv6").length > 1;
}

/** 主 IP 相关的提示：挑的地址不在检测列表里了、手改地址让主 IP 暂不生效。 */
export function hostPrimaryAddressWarnings(host: HostPrimaryAddressSource | null | undefined): string[] {
  const warnings: string[] = [];
  const detected = parseHostDetectedAddresses(host?.detectedAddresses);
  const manual = boolish(host?.addressManual);
  for (const family of ["ipv4", "ipv6"] as const) {
    const chosen = hostChosenPrimaryAddress(host, family);
    if (!chosen) continue;
    const label = family === "ipv4" ? "IPv4" : "IPv6";
    if (manual) {
      warnings.push(`已手改「Agent 检测 IP」，选的主 ${label} ${chosen} 暂不生效；清空手改的地址后恢复。`);
      continue;
    }
    if (!detected) continue;
    const list = family === "ipv4" ? detected.ipv4 : detected.ipv6;
    const egress = family === "ipv4" ? detected.egressIpv4 : detected.egressIpv6;
    if (!list.includes(chosen) && egress !== chosen) {
      warnings.push(`主 ${label} ${chosen} 不在 Agent 最近检测到的地址里了，仍按它使用；确认它已被回收就换一个。`);
    }
  }
  return warnings;
}

/**
 * 编辑框里挑主 IPv4 / IPv6：返回要写进库的补丁（primaryIpv4 / primaryIpv6，没手改地址时连 ip / ipv4 / ipv6 一起）。
 *
 * 只能从 Agent 检测到的地址里挑（再加上已经挑着的那个）：随便填一个地址是「手改检测 IP」那一栏的事，
 * 两条路各管各的，手改的优先（agentAddressState）。取消选择时回到 Agent 上次报的出口地址。
 */
export function hostPrimaryAddressPatch(
  host: HostPrimaryAddressSource | null | undefined,
  input: { primaryIpv4?: string | null; primaryIpv6?: string | null },
  options: { addressManual?: boolean } = {},
) {
  const patch: Record<string, string | null> = {};
  const detected = parseHostDetectedAddresses(host?.detectedAddresses);
  for (const family of ["ipv4", "ipv6"] as const) {
    const raw = family === "ipv4" ? input.primaryIpv4 : input.primaryIpv6;
    if (raw === undefined) continue;
    const label = family === "ipv4" ? "IPv4" : "IPv6";
    const text = String(raw ?? "").trim();
    let chosen: string | null = null;
    if (text) {
      chosen = normalizePublicAddress(text, family) || null;
      if (!chosen) throw new Error(`主 ${label}：「${text}」不是公网 ${label} 地址`);
      if (!hostPrimaryAddressOptions(host, family).includes(chosen)) {
        throw new Error(`主 ${label} 只能从 Agent 检测到的地址里选；要填别的地址请改「Agent 检测 IP」`);
      }
    }
    const column = family === "ipv4" ? "primaryIpv4" : "primaryIpv6";
    if ((normalizePublicAddress(host?.[column], family) || null) === chosen) continue;
    patch[column] = chosen;
    if (options.addressManual) continue;
    const egress = family === "ipv4" ? detected?.egressIpv4 : detected?.egressIpv6;
    const next = chosen || egress || String(host?.[family] || "").trim() || null;
    patch[family] = next;
  }
  if (patch.ipv4 !== undefined || patch.ipv6 !== undefined) {
    const ipv4 = patch.ipv4 !== undefined ? patch.ipv4 : String(host?.ipv4 || "").trim() || null;
    const ipv6 = patch.ipv6 !== undefined ? patch.ipv6 : String(host?.ipv6 || "").trim() || null;
    patch.ip = ipv4 || ipv6 || String(host?.ip || "").trim() || "unknown";
  }
  return patch;
}
