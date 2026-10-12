/*
  给 Agent 的 firewall 指令（纯函数，便于测试）。Go 端见 agent/ext_firewall.go。

  指令每轮都发，但国家段可能有上万条：只有 Agent 上报的 countryHash 和这次的不一样时才带上
  （geoIncluded=true），否则只发哈希，Agent 用自己缓存的那份。hash 覆盖其余全部内容，
  Agent 拿它判断要不要重写规则。
*/
import { createHash } from "node:crypto";
import { classifyIpAddress } from "../../shared/ipAddress";
import type { FirewallMode } from "../../shared/firewallCountries";
import { aggregateCidrs, parseIp } from "./firewallCidr";

export type FirewallDirective = {
  v: 1;
  enabled: boolean;
  hash: string;
  mode: FirewallMode;
  tcp: number[];
  udp: number[];
  block4: string[];
  block6: string[];
  allow4: string[];
  allow6: string[];
  countryHash: string;
  geoIncluded: boolean;
  geo4: string[];
  geo6: string[];
};

export type FirewallDirectiveInput = {
  /** 这台主机生效的地区规则。 */
  mode: FirewallMode;
  /** 合并后的国家段；ready=false（还没下载完）时地区规则先不生效。 */
  geo: { hash: string; v4: string[]; v6: string[]; ready: boolean } | null;
  ports: { tcp: number[]; udp: number[] };
  /** 还在生效的封禁（IP 或 CIDR）。 */
  blocked: string[];
  /** 面板自己那几台主机的地址：永远放行，否则隧道 / 中转会被自己的规则拦断。 */
  trusted: string[];
  /** Agent 上一轮报上来的 countryHash。 */
  reportedCountryHash?: string | null;
};

export type FirewallEffect = {
  /** 实际下发的模式：国家数据还没就绪时 block / allow 会退回 off。 */
  mode: FirewallMode;
  /** 退回的原因，界面上显示。 */
  note: string | null;
};

export function effectiveFirewallMode(mode: FirewallMode, geo: FirewallDirectiveInput["geo"]): FirewallEffect {
  if (mode === "off") return { mode: "off", note: null };
  if (!geo || !geo.ready) return { mode: "off", note: "国家数据还没下载好，下载完自动生效" };
  if (geo.v4.length + geo.v6.length === 0) {
    return { mode: "off", note: "选中的国家没有 IP 段数据" };
  }
  return { mode, note: null };
}

const OFF_DIRECTIVE_HASH = "off";

export function buildFirewallDirective(input: FirewallDirectiveInput): FirewallDirective {
  const effect = effectiveFirewallMode(input.mode, input.geo);
  const blocked = aggregateCidrs(input.blocked);
  // 受信地址只收公网 IP（内网段 Agent 本来就放行），域名不解析 —— 解析结果会变，哈希就跟着抖。
  const trustedStrings = input.trusted.filter((value) => {
    const ip = parseIp(value);
    return !!ip && classifyIpAddress(String(value).trim().replace(/^\[|\]$/g, "")) === "public";
  });
  const trusted = aggregateCidrs(trustedStrings);
  const tcp = uniquePorts(input.ports.tcp);
  const udp = uniquePorts(input.ports.udp);
  const hasPorts = tcp.length + udp.length > 0;
  const hasRules = effect.mode !== "off" || blocked.v4.length + blocked.v6.length > 0;
  if (!hasPorts || !hasRules) {
    return {
      v: 1, enabled: false, hash: OFF_DIRECTIVE_HASH, mode: "off", tcp: [], udp: [],
      block4: [], block6: [], allow4: [], allow6: [], countryHash: "", geoIncluded: false, geo4: [], geo6: [],
    };
  }
  const countryHash = effect.mode !== "off" && input.geo ? input.geo.hash : "";
  const body = {
    v: 1, mode: effect.mode, tcp, udp,
    block4: blocked.v4, block6: blocked.v6, allow4: trusted.v4, allow6: trusted.v6, countryHash,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  const geoIncluded = !!countryHash && input.reportedCountryHash !== countryHash;
  return {
    ...body,
    v: 1,
    enabled: true,
    hash,
    geoIncluded,
    geo4: geoIncluded && input.geo ? input.geo.v4 : [],
    geo6: geoIncluded && input.geo ? input.geo.v6 : [],
  };
}

function uniquePorts(list: number[]) {
  return Array.from(new Set(list.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))).sort((a, b) => a - b);
}

/**
 * 两次上报之间新增的拦截数。Agent 报的是「本进程启动（since）以来」的累计值：
 * since 没变就取差值；since 变了（Agent 重启过）或者值变小了（不该发生），这次的累计值全算新增。
 */
export function counterDelta(previous: { since: number; value: number } | null, current: { since: number; value: number }) {
  const value = Math.max(0, Math.floor(Number(current.value) || 0));
  if (!previous || previous.since !== current.since) return value;
  return value >= previous.value ? value - previous.value : value;
}
