/*
  IP / CIDR 的解析、归一、合并和匹配（地区规则、IP 封禁、面板访问限制共用）。

  地址一律换成 bigint 算：IPv4 32 位、IPv6 128 位用同一套代码，不用分两份。
  国家段动辄几千上万条（美国 IPv4 聚合后一万多条），合并一次是毫秒级，够用。

  合并（aggregate）有两个目的：
    1. nftables 的 interval 集合不接受重叠的段，下发前必须去掉重叠；
    2. 几个国家拼在一起时相邻的段能并成更大的段，Agent 那边的集合小一些。
*/
import { expandIpv6 } from "../../shared/ipAddress";

export type IpFamily = 4 | 6;

export type ParsedIp = { family: IpFamily; value: bigint };

export type ParsedCidr = { family: IpFamily; start: bigint; prefix: number };

const BITS: Record<IpFamily, number> = { 4: 32, 6: 128 };

function parseIpv4Value(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/**
 * 解析一个 IP。`::ffff:1.2.3.4`（IPv4-mapped）当成 IPv4 —— 双栈监听的 Node 给 req.ip 的就是这种写法，
 * 不拆出来国家段永远匹配不上。方括号和 %zone 去掉。
 */
export function parseIp(input: unknown): ParsedIp | null {
  let text = String(input ?? "").trim();
  if (!text) return null;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const v4 = parseIpv4Value(text);
  if (v4 !== null) return { family: 4, value: v4 };
  if (!text.includes(":")) return null;
  const groups = expandIpv6(text);
  if (!groups) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { family: 4, value: (BigInt(groups[6]) << 16n) | BigInt(groups[7]) };
  }
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return { family: 6, value };
}

/** 客户端地址的统一写法：IPv4-mapped 拆成 IPv4，其余原样小写。认不出来返回空串。 */
export function normalizeClientIp(input: unknown): string {
  const parsed = parseIp(input);
  return parsed ? formatIp(parsed.family, parsed.value) : "";
}

function maskStart(family: IpFamily, value: bigint, prefix: number) {
  const bits = BITS[family];
  const hostBits = BigInt(bits - prefix);
  return (value >> hostBits) << hostBits;
}

/** 解析 CIDR；不带前缀的单个 IP 当成 /32 或 /128。主机位一律清零（1.2.3.4/24 → 1.2.3.0/24）。 */
export function parseCidr(input: unknown): ParsedCidr | null {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const slash = text.indexOf("/");
  const addressText = slash >= 0 ? text.slice(0, slash) : text;
  const ip = parseIp(addressText);
  if (!ip) return null;
  // 带前缀的 IPv4-mapped（::ffff:1.2.3.0/120）不收：前缀要换算，没有正经用法。
  if (slash >= 0 && ip.family === 4 && addressText.includes(":")) return null;
  const bits = BITS[ip.family];
  let prefix = bits;
  if (slash >= 0) {
    const prefixText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix < 0 || prefix > bits) return null;
  }
  return { family: ip.family, start: maskStart(ip.family, ip.value, prefix), prefix };
}

export function formatIp(family: IpFamily, value: bigint): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
  }
  const groups: number[] = [];
  for (let i = 7; i >= 0; i -= 1) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952：最长的一段连续 0（至少两组）压成 ::
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

export function formatCidr(cidr: ParsedCidr): string {
  return `${formatIp(cidr.family, cidr.start)}/${cidr.prefix}`;
}

/** 界面上的写法：单个地址不带 /32、/128。 */
export function formatCidrShort(cidr: ParsedCidr): string {
  return cidr.prefix === BITS[cidr.family] ? formatIp(cidr.family, cidr.start) : formatCidr(cidr);
}

export function cidrRange(cidr: ParsedCidr): [bigint, bigint] {
  const size = 1n << BigInt(BITS[cidr.family] - cidr.prefix);
  return [cidr.start, cidr.start + size - 1n];
}

type Range = [bigint, bigint];

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Range[] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const [start, end] = sorted[i];
    const last = out[out.length - 1];
    if (start <= last[1] + 1n) {
      if (end > last[1]) last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** 一段连续地址拆成最少的 CIDR。 */
function rangeToCidrs(family: IpFamily, start: bigint, end: bigint): ParsedCidr[] {
  const bits = BITS[family];
  const out: ParsedCidr[] = [];
  let cursor = start;
  while (cursor <= end) {
    // 从 cursor 起能放下的最大对齐块：受 cursor 的末尾 0 位数和剩余长度两头限制
    let size = bits;
    if (cursor !== 0n) {
      let trailing = 0;
      while (trailing < bits && ((cursor >> BigInt(trailing)) & 1n) === 0n) trailing += 1;
      size = trailing;
    }
    const remaining = end - cursor + 1n;
    while (size > 0 && (1n << BigInt(size)) > remaining) size -= 1;
    out.push({ family, start: cursor, prefix: bits - size });
    cursor += 1n << BigInt(size);
  }
  return out;
}

export type AggregatedCidrs = { v4: string[]; v6: string[]; invalid: number };

/** 一堆 CIDR（混着 v4 / v6、可能重叠、可能有错的）→ 合并后的最少 CIDR 列表。 */
export function aggregateCidrs(list: Iterable<unknown>): AggregatedCidrs {
  const ranges: Record<IpFamily, Range[]> = { 4: [], 6: [] };
  let invalid = 0;
  for (const item of list) {
    const cidr = parseCidr(item);
    if (!cidr) {
      if (String(item ?? "").trim()) invalid += 1;
      continue;
    }
    ranges[cidr.family].push(cidrRange(cidr));
  }
  const toStrings = (family: IpFamily) => mergeRanges(ranges[family])
    .flatMap(([start, end]) => rangeToCidrs(family, start, end))
    .map(formatCidr);
  return { v4: toStrings(4), v6: toStrings(6), invalid };
}

/**
 * 解析下载来的国家段文件（ipdeny 的 .zone、ipverse 的 .txt 都是一行一个 CIDR，# 开头是注释）。
 * 只留指定地址族的，合并后返回。
 */
export function parseZoneText(text: string, family: IpFamily): { cidrs: string[]; invalid: number; lines: number } {
  const lines: string[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (line) lines.push(line);
  }
  const aggregated = aggregateCidrs(lines);
  const cidrs = family === 4 ? aggregated.v4 : aggregated.v6;
  const wrongFamily = family === 4 ? aggregated.v6.length : aggregated.v4.length;
  return { cidrs, invalid: aggregated.invalid + (wrongFamily > 0 ? wrongFamily : 0), lines: lines.length };
}

/** 一组 CIDR 的匹配器：合并成有序区间，二分查找。 */
export class CidrMatcher {
  private readonly starts: Record<IpFamily, bigint[]> = { 4: [], 6: [] };
  private readonly ends: Record<IpFamily, bigint[]> = { 4: [], 6: [] };

  constructor(cidrs: Iterable<unknown>) {
    const ranges: Record<IpFamily, Range[]> = { 4: [], 6: [] };
    for (const item of cidrs) {
      const cidr = parseCidr(item);
      if (cidr) ranges[cidr.family].push(cidrRange(cidr));
    }
    for (const family of [4, 6] as IpFamily[]) {
      for (const [start, end] of mergeRanges(ranges[family])) {
        this.starts[family].push(start);
        this.ends[family].push(end);
      }
    }
  }

  get size() {
    return this.starts[4].length + this.starts[6].length;
  }

  contains(ip: unknown): boolean {
    const parsed = typeof ip === "object" && ip !== null && "family" in (ip as any) ? ip as ParsedIp : parseIp(ip);
    if (!parsed) return false;
    const starts = this.starts[parsed.family];
    const ends = this.ends[parsed.family];
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= parsed.value) {
        if (ends[mid] >= parsed.value) return true;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return false;
  }
}

/** 两段 CIDR 是否有交集（封禁时提示「已经封过一个更大的段」用）。 */
export function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  if (a.family !== b.family) return false;
  const [as, ae] = cidrRange(a);
  const [bs, be] = cidrRange(b);
  return as <= be && bs <= ae;
}
