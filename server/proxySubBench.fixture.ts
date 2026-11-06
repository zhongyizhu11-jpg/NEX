/**
 * 订阅「金样」和压测共用的固定账号。
 *
 *   node --import tsx server/proxySubBench.fixture.ts golden   （FORWARDX_TEST_DB 指向一个空的 SQLite 文件）
 *     小账号 → 每种格式 × 典型客户端 × 几条不同作用域 / 模板的令牌 × 节点订阅 / 规则订阅都拉一遍，
 *     每行打印一条 JSON（状态、字节数、sha256），然后退出。server/proxySubGolden.test.ts 拿它和
 *     记下来的值逐条比：改性能不许改输出的任何一个字节。
 *
 *   node --import tsx server/proxySubBench.fixture.ts serve    （同上；库是空的就先灌大账号）
 *     大账号（约一千条节点：落地入站派生的、粘来的、落地池的、别人分享的）→ 起一个只挂订阅路由的
 *     HTTP 服务，打印一行 READY {json}；/__bench/stats 回本进程的 CPU 与内存。scripts/bench-proxy-sub.mjs
 *     用它测冷 / 热、并发。BENCH_CACHE_TTL 设订阅缓存秒数（默认 0 = 不缓存）。
 *
 * 数据用固定种子的伪随机数生成：同一个规模每次生成的库逐字节一样。金样那一档不写任何跟
 * 「现在几点」有关的东西（探测记录、到期日），换台机器、换个时区跑也是同一份输出。
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import compression from "compression";
import express from "express";

import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { PROXY_SUBSCRIPTION_FORMATS } from "../shared/proxySubscription";

type Scale = {
  landingHosts: number;
  relayHosts: number;
  inbounds: number;
  /** 这个账号自己的节点（一半从落地入站派生，一半是粘来的）。 */
  ownedNodes: number;
  /** 管理员分享给他的节点。 */
  sharedNodes: number;
  /** 落地池节点（整个池在订阅里一条）。 */
  poolNodes: number;
  /** 为别人单独发的凭据派生的节点：不该进他自己的订阅。 */
  tenantNodes: number;
  rules: number;
  /** 写最近的探测记录（「自动隐藏不通的节点」要查）。跟时间有关，金样不写。 */
  probes: boolean;
};

const SCALES: Record<"golden" | "bench", Scale> = {
  golden: { landingHosts: 6, relayHosts: 4, inbounds: 6, ownedNodes: 28, sharedNodes: 6, poolNodes: 4, tenantNodes: 2, rules: 56, probes: false },
  bench: { landingHosts: 30, relayHosts: 20, inbounds: 30, ownedNodes: 300, sharedNodes: 100, poolNodes: 50, tenantNodes: 10, rules: 760, probes: true },
};

const OWNER_ID = 2;
const ADMIN_ID = 1;
const TENANT_ID = 3;
const PANEL_URL = "https://panel.example.test";

const TOKENS = {
  default: "goldenDefaultToken000000000000000000000001",
  scoped: "goldenScopedToken0000000000000000000000002",
  templated: "goldenTemplatedToken00000000000000000000003",
  info: "goldenInfoToken000000000000000000000000004",
} as const;
type TokenKey = keyof typeof TOKENS;
const ALIAS = "golden-alias";

/** 典型客户端。每种格式配一个「平时就用它拉这种格式」的客户端；后面一段只靠 UA 识别格式。 */
const FORMAT_CLIENT: Record<(typeof PROXY_SUBSCRIPTION_FORMATS)[number], string> = {
  base64: "v2rayNG/1.9.30",
  clash: "mihomo/1.18.10",
  singbox: "SFA/1.9.3 (sing-box 1.9.3)",
  v2rayjson: "v2rayN/7.4.2",
  loon: "Loon/3.2.4 (iPhone)",
  surge: "Surge iOS/3048",
  quantumultx: "Quantumult%20X/1.5.0",
  shadowrocket: "Shadowrocket/2.2.48 CFNetwork/1494.0.7 Darwin/23.4.0",
};
const DETECTED_CLIENTS: Record<string, string> = {
  mihomo: "mihomo/1.18.10",
  "clash-verge": "clash-verge/v2.0.3",
  stash: "Stash/2.4.6 Clash/1.9.0",
  cmfa: "ClashMetaForAndroid/2.11.1.Meta",
  sfa: "SFA/1.9.3 (sing-box 1.9.3)",
  "sing-box": "sing-box 1.10.0",
  v2rayn: "v2rayN/7.4.2",
  "v2rayn-old": "v2rayN/6.23",
  v2rayng: "v2rayNG/1.9.30",
  shadowrocket: "Shadowrocket/2.2.48 CFNetwork/1494.0.7 Darwin/23.4.0",
  surge: "Surge iOS/3048",
  loon: "Loon/3.2.4 (iPhone)",
  qx: "Quantumult%20X/1.5.0",
  hiddify: "HiddifyNext/2.5.7",
  unknown: "curl/8.5.0",
};

const COUNTRIES = [
  ["HK", "香港"], ["JP", "日本"], ["SG", "新加坡"], ["US", "美国"], ["TW", "台湾"], ["KR", "韩国"],
  ["DE", "德国"], ["GB", "英国"], ["FR", "法国"], ["NL", "荷兰"], ["CA", "加拿大"], ["AU", "澳大利亚"],
] as const;
const RELAY_CITIES = ["广州", "上海", "深圳", "杭州", "北京", "成都", "南京", "武汉"];
const CARRIERS = ["移动", "电信", "联通", "BGP"];
const LINE_KINDS = ["IPLC", "IEPL", "专线", "BGP", "CN2", "直连"];

/** mulberry32：够用、可复现。 */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedData() {
  const rng = prng(20261106);
  const int = (max: number) => Math.floor(rng() * max);
  const chance = (p: number) => rng() < p;
  const pick = <T,>(items: readonly T[]) => items[int(items.length)];
  const weighted = <T,>(items: ReadonlyArray<readonly [T, number]>) => {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = rng() * total;
    for (const [value, w] of items) {
      roll -= w;
      if (roll < 0) return value;
    }
    return items[items.length - 1][0];
  };
  const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[int(16)]).join("");
  const b64url = (length: number) => Array.from({ length }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[int(64)]).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  return { rng, int, chance, pick, weighted, hex, b64url, uuid };
}

type Row = Record<string, string | number | null>;

/** 一个节点的协议相关字段：按真实里常见的组合来，渲染器各条分支都走到。 */
function protocolFields(protocol: string, r: ReturnType<typeof seedData>, sni: string): Row {
  switch (protocol) {
    case "vless": {
      const flavour = r.weighted([["reality", 50], ["ws", 20], ["grpc", 14], ["xhttp", 10], ["httpupgrade", 6]] as const);
      if (flavour === "reality") {
        return { uuid: r.uuid(), transport: "tcp", tls: 1, sni: "www.microsoft.com", flow: "xtls-rprx-vision", fingerprint: "chrome", realityPublicKey: r.b64url(43), realityShortId: r.hex(8) };
      }
      if (flavour === "xhttp") {
        return { uuid: r.uuid(), transport: "xhttp", tls: 1, sni: "www.apple.com", path: `/${r.hex(6)}`, xhttpMode: "auto", fingerprint: "chrome", realityPublicKey: r.b64url(43), realityShortId: r.hex(8) };
      }
      return { uuid: r.uuid(), transport: flavour, tls: 1, sni, host: sni, path: flavour === "grpc" ? `grpc-${r.hex(4)}` : `/${r.hex(8)}`, alpn: flavour === "ws" ? "http/1.1" : "", fingerprint: r.chance(0.5) ? "chrome" : "" };
    }
    case "vmess": {
      const transport = r.weighted([["ws", 50], ["tcp", 20], ["grpc", 20], ["http", 10]] as const);
      const tls = transport === "grpc" || r.chance(0.5) ? 1 : 0;
      return { uuid: r.uuid(), alterId: 0, transport, tls, sni: tls ? sni : "", host: transport === "ws" || transport === "http" ? sni : "", path: transport === "grpc" ? `vm-${r.hex(4)}` : transport === "tcp" ? "" : `/vm${r.hex(4)}` };
    }
    case "trojan": {
      const transport = r.weighted([["tcp", 60], ["ws", 25], ["grpc", 15]] as const);
      return { password: r.b64url(24), transport, tls: 1, sni, host: transport === "ws" ? sni : "", path: transport === "tcp" ? "" : transport === "grpc" ? `tj-${r.hex(4)}` : `/tj${r.hex(4)}`, alpn: r.chance(0.4) ? "h2,http/1.1" : "", allowInsecure: r.chance(0.1) ? 1 : 0 };
    }
    case "shadowsocks": {
      const method = r.weighted([["2022-blake3-aes-128-gcm", 40], ["aes-128-gcm", 25], ["chacha20-ietf-poly1305", 20], ["aes-256-gcm", 15]] as const);
      const password = method.startsWith("2022") ? Buffer.from(r.hex(32), "hex").toString("base64") : r.b64url(16);
      return { method, password, transport: "tcp", tls: 0 };
    }
    case "hysteria2": {
      const obfs = r.chance(0.4);
      return { password: r.b64url(20), tls: 1, sni, alpn: "h3", obfs: obfs ? "salamander" : "", obfsPassword: obfs ? r.b64url(12) : "", upMbps: r.chance(0.5) ? 100 : 0, downMbps: r.chance(0.5) ? 500 : 0 };
    }
    case "tuic":
      return { uuid: r.uuid(), password: r.b64url(16), tls: 1, sni, alpn: "h3", congestionControl: "bbr", udpRelayMode: "native" };
    case "anytls":
      return { password: r.b64url(20), tls: 1, sni };
    case "snell":
      return { password: r.b64url(20), snellVersion: r.chance(0.7) ? 4 : 3, obfs: r.chance(0.3) ? "http" : "", host: "bing.com" };
    default:
      return { uuid: `user${r.hex(4)}`, password: r.b64url(12) };
  }
}

const PROTOCOLS = [["vless", 34], ["vmess", 13], ["trojan", 14], ["shadowsocks", 16], ["hysteria2", 9], ["tuic", 4], ["anytls", 4], ["snell", 4], ["socks5", 2]] as const;

async function insertRows(table: string, rows: Row[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    await runtime.executeRaw(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      columns.map((column) => row[column]),
    );
  }
}

async function seed(scale: Scale) {
  const r = seedData();
  const users: Row[] = [
    { id: ADMIN_ID, username: "admin", password: "unused", role: "admin", accountEnabled: 1, allowProxySubscription: 1 },
    {
      id: OWNER_ID, username: "merchant", password: "unused", role: "user", accountEnabled: 1, allowProxySubscription: 1,
      trafficLimit: 1_099_511_627_776, trafficUsed: 132_070_244_352, proxySubCustomRules: "DOMAIN-SUFFIX,steampowered.com,PROXY\nGEOSITE,openai,PROXY",
    },
    { id: TENANT_ID, username: "tenant", password: "unused", role: "user", accountEnabled: 1, allowProxySubscription: 1 },
  ];
  await insertRows("users", users);

  // 固定的「最后心跳」：只要不是从没连上过就行，金样不能跟现在几点有关。
  const heartbeat = 1_790_000_000;
  const hosts: Row[] = [];
  const landingHostIds: number[] = [];
  for (let i = 0; i < scale.landingHosts; i++) {
    const [code, place] = COUNTRIES[i % COUNTRIES.length];
    const id = 1 + i;
    landingHostIds.push(id);
    const ip = `203.0.${113 + Math.floor(i / 200)}.${10 + (i % 200)}`;
    hosts.push({ id, name: `${place}落地-${String(i + 1).padStart(2, "0")}`, ip, ipv4: ip, ipv6: r.chance(0.3) ? `2001:db8:${i.toString(16)}::10` : null, userId: OWNER_ID, geoCountryCode: code, lastHeartbeat: heartbeat, isOnline: 1, lineBandwidthMbps: r.pick([0, 200, 500, 1000]) });
  }
  const relayHostIds: number[] = [];
  for (let i = 0; i < scale.relayHosts; i++) {
    const id = 1 + scale.landingHosts + i;
    relayHostIds.push(id);
    const ip = `198.51.${100 + Math.floor(i / 200)}.${10 + (i % 200)}`;
    hosts.push({
      id, name: `${RELAY_CITIES[i % RELAY_CITIES.length]}${CARRIERS[i % CARRIERS.length]}-${String(i + 1).padStart(2, "0")}`,
      ip, ipv4: ip, entryIp: r.chance(0.25) ? `relay${i + 1}.example.net` : null, userId: OWNER_ID, lastHeartbeat: heartbeat, isOnline: 1,
      lineBandwidthMbps: r.pick([100, 300, 1000, 2500]),
    });
  }
  await insertRows("hosts", hosts);

  // 两个转发组：组里第一台成员才是这些规则真正的入口（applyEffectiveEntryHosts）。
  await insertRows("forward_groups", [
    { id: 1, name: "华南入口组", groupType: "host", groupMode: "failover", domain: "", targetIp: "0.0.0.0", userId: OWNER_ID, isEnabled: 1 },
    { id: 2, name: "华东入口组", groupType: "host", groupMode: "failover", domain: "", targetIp: "0.0.0.0", userId: OWNER_ID, isEnabled: 1 },
  ]);
  await insertRows("forward_group_members", [
    { id: 1, groupId: 1, memberType: "host", hostId: relayHostIds[0], priority: 0, isEnabled: 1 },
    { id: 2, groupId: 1, memberType: "host", hostId: relayHostIds[1 % relayHostIds.length], priority: 1, isEnabled: 1 },
    { id: 3, groupId: 2, memberType: "host", hostId: relayHostIds[2 % relayHostIds.length], priority: 0, isEnabled: 1 },
  ]);

  const inbounds: Row[] = [];
  const inboundById = new Map<number, Row>();
  for (let i = 0; i < scale.inbounds; i++) {
    const id = 1 + i;
    const hostId = landingHostIds[i % landingHostIds.length];
    const protocol = r.weighted([["vless", 50], ["trojan", 15], ["shadowsocks", 20], ["hysteria2", 15]] as const);
    const row: Row = { id, userId: OWNER_ID, hostId, name: `入站-${id}`, protocol, port: 20000 + id, transport: "tcp", security: protocol === "vless" ? "reality" : "tls", isEnabled: 1, sortOrder: i };
    inbounds.push(row);
    inboundById.set(id, row);
  }
  await insertRows("proxy_inbounds", inbounds);

  const nodes: Row[] = [];
  let nodeId = 0;
  const visibleTemplates: Array<{ id: number; address: string; port: number; protocol: string; place: string }> = [];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const makeNode = (userId: number, index: number, extra: Row, opts: { visible: boolean }) => {
    nodeId += 1;
    const inboundId = Number(extra.inboundId || 0);
    const inbound = inboundId ? inboundById.get(inboundId) : undefined;
    const protocol = inbound ? String(inbound.protocol) : r.weighted(PROTOCOLS);
    const host = inbound ? hostById.get(Number(inbound.hostId)) : undefined;
    const country = host ? COUNTRIES.find(([code]) => code === host.geoCountryCode)! : COUNTRIES[r.int(COUNTRIES.length)];
    const address = host ? String(host.ip) : r.chance(0.6) ? `${country[0].toLowerCase()}${index + 1}.nodes.example.org` : `192.0.2.${1 + (index % 250)}`;
    const port = inbound ? Number(inbound.port) : 10000 + ((index * 7) % 50000);
    const sni = `${country[0].toLowerCase()}-${r.hex(4)}.cdn.example.com`;
    const row: Row = {
      id: nodeId, userId, name: `${country[1]} ${r.pick(LINE_KINDS)} ${String(index + 1).padStart(3, "0")}`,
      protocol, address, port, isEnabled: r.chance(0.97) ? 1 : 0, sortOrder: index,
      includeDirect: r.chance(0.32) ? 1 : 0, autoGroup: r.pick(["url-test", "url-test", "load-balance", "fallback"]),
      udp: r.chance(0.9) ? 1 : 0, countryCode: !host && r.chance(0.5) ? country[0] : null,
      ...protocolFields(protocol, r, sni),
      ...extra,
    };
    nodes.push(row);
    if (opts.visible && row.isEnabled) visibleTemplates.push({ id: nodeId, address, port, protocol, place: country[1] });
    return row;
  };
  for (let i = 0; i < scale.ownedNodes; i++) {
    const fromInbound = i % 2 === 0;
    makeNode(OWNER_ID, i, fromInbound ? { inboundId: 1 + (i / 2) % scale.inbounds } : {}, { visible: true });
  }
  // 少数节点挂前置代理（dialer-proxy / detour）：前面几条自己的节点当前置。
  for (let i = 5; i < nodes.length; i += 23) nodes[i].frontProxyId = Number(nodes[i % 4].id);
  for (let i = 0; i < scale.poolNodes; i++) makeNode(OWNER_ID, scale.ownedNodes + i, { nodePoolId: 1 + (i % 5) }, { visible: true });
  // 池里为租户单独发的凭据，以及入站上为租户单独发的凭据：都不进主人自己的订阅。
  const inboundUsers: Row[] = [];
  for (let i = 0; i < scale.tenantNodes; i++) {
    if (i % 2 === 0) {
      makeNode(OWNER_ID, 900 + i, { nodePoolId: 1 + (i % 5), poolSharedUserId: TENANT_ID }, { visible: false });
    } else {
      const inboundId = 1 + (i % scale.inbounds);
      inboundUsers.push({ id: 1 + i, inboundId, name: `tenant-${i}`, uuid: r.uuid(), password: r.b64url(16), sharedUserId: TENANT_ID, sortOrder: i });
      makeNode(OWNER_ID, 900 + i, { inboundId, inboundUserId: 1 + i }, { visible: false });
    }
  }
  const shares: Row[] = [];
  for (let i = 0; i < scale.sharedNodes; i++) {
    const row = makeNode(ADMIN_ID, 2000 + i, { publicLabel: `官方线路 ${i + 1}` }, { visible: true });
    shares.push({ id: 1 + i, nodeId: Number(row.id), userId: OWNER_ID, source: i % 3 === 0 ? "plan" : "manual" });
  }
  await insertRows("proxy_nodes", nodes);
  await insertRows("proxy_inbound_users", inboundUsers);
  await insertRows("proxy_node_shares", shares);

  // 转发规则：大多数绑一个节点（中转条目），少数没绑、停用、隐藏、只放 TCP、目标不对、走转发组。
  const rules: Row[] = [];
  for (let i = 0; i < scale.rules; i++) {
    const id = 1 + i;
    const template = visibleTemplates[(i * 5 + r.int(3)) % visibleTemplates.length];
    const unbound = r.chance(0.04);
    const relayHostId = relayHostIds[i % relayHostIds.length];
    const groupId = r.chance(0.05) ? 1 + (i % 2) : null;
    const mismatch = r.chance(0.03);
    rules.push({
      id, hostId: relayHostId, userId: OWNER_ID,
      name: r.chance(0.75) ? `${template.place} ${r.pick(LINE_KINDS)} ${String(id).padStart(3, "0")}` : "",
      forwardType: r.pick(["iptables", "iptables", "gost", "realm"]),
      protocol: r.chance(0.1) ? "tcp" : "both",
      sourcePort: 30000 + id, targetIp: mismatch ? `192.0.2.${200 + (i % 50)}` : template.address, targetPort: template.port,
      isEnabled: r.chance(0.96) ? 1 : 0, pendingDelete: r.chance(0.01) ? 1 : 0, sortOrder: i,
      proxyNodeId: unbound ? null : template.id, proxyNodeVisible: r.chance(0.97) ? 1 : 0,
      proxyNodeName: r.chance(0.08) ? `★ ${template.place}精品 ${id}` : null,
      forwardGroupId: groupId,
    });
  }
  await insertRows("forward_rules", rules);

  if (scale.probes) {
    // 最近一刻钟的探测：绝大多数通，几条一直超时（开着「自动隐藏不通的节点」时会被摘掉）。
    const now = Math.floor(Date.now() / 1000);
    const probes: Row[] = [];
    for (const rule of rules) {
      if (!rule.proxyNodeId) continue;
      const dead = Number(rule.id) % 97 === 0;
      for (let k = 0; k < 3; k++) {
        probes.push({ ruleId: Number(rule.id), hostId: Number(rule.hostId), latencyMs: dead ? null : 20 + r.int(180), isTimeout: dead ? 1 : 0, recordedAt: now - 60 - k * 240 });
      }
    }
    await insertRows("tcping_stats", probes);
  }

  await insertRows("proxy_sub_templates", [
    {
      id: 1, name: "商家 Clash 模板", target: "clash", isDefault: 0,
      prelude: "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: warning\ndns:\n  enable: true\n  enhanced-mode: fake-ip\n  nameserver:\n    - https://dns.alidns.com/dns-query\n# {appName} · {username} · {expireDate} · {dataLeft}\n",
      customGroupsJson: JSON.stringify([
        { name: "🎬 流媒体", type: "select", filter: "香港|台湾|日本|新加坡", match: "regex", includeGroups: true },
        { name: "⚡ 专线", type: "url-test", filter: "IPLC IEPL 专线", match: "any" },
      ]),
    },
    { id: 2, name: "sing-box 默认", target: "singbox", isDefault: 1, prelude: "", customGroupsJson: JSON.stringify([{ name: "🇭🇰 香港", type: "url-test", filter: "香港", match: "any" }]) },
  ]);

  const tokens: Row[] = [
    { id: 1, userId: OWNER_ID, name: "主力", token: TOKENS.default, defaultFormat: "clash", rulePreset: "balanced", isEnabled: 1, alias: ALIAS },
    {
      id: 2, userId: OWNER_ID, name: "亚洲精选", token: TOKENS.scoped, defaultFormat: "singbox", rulePreset: "comprehensive", isEnabled: 1,
      scopeJson: JSON.stringify({ include: "香港|日本|新加坡|台湾", protocols: ["vless", "trojan", "shadowsocks", "hysteria2", "vmess"], regions: ["HK", "JP", "SG", "TW", "KR"] }),
      optionsJson: JSON.stringify({ flagEmoji: "on", regionGroups: "on", regionGroupType: "select", sortMode: "region", dedupe: true, nameTemplate: "{flag} {name}", renames: [{ from: "IPLC", to: "专线" }] }),
    },
    {
      id: 3, userId: OWNER_ID, name: "带模板", token: TOKENS.templated, defaultFormat: "clash", rulePreset: "balanced", isEnabled: 1, templateId: 1,
      optionsJson: JSON.stringify({ protocolPrefix: "on", sortMode: "name", categoryTargets: { ads: "REJECT", cn: "DIRECT" }, customRules: "DOMAIN-SUFFIX,example.com,DIRECT\nDOMAIN-KEYWORD,netflix,🎬 流媒体", skipCertVerify: "on" }),
    },
    {
      id: 4, userId: OWNER_ID, name: "信息节点", token: TOKENS.info, defaultFormat: "base64", rulePreset: "minimal", isEnabled: 1,
      scopeJson: JSON.stringify({ excludeDirect: true, exclude: "澳大利亚|加拿大" }),
      optionsJson: JSON.stringify({ infoNodes: "on", unlockGroups: true, prefix: "[NEX] ", udp: "off", sortMode: "protocol" }),
    },
  ];
  await insertRows("proxy_sub_tokens", tokens);

  const settings: Record<string, string> = {
    panelPublicUrl: PANEL_URL,
    siteTitle: "NEX 测试面板",
    "proxySub.rateLimitPerMinute": "0",
    "proxySub.ipRateLimitPerMinute": "0",
    "proxySub.cacheTtlSec": "0",
    "proxySub.announce": "节点每周二凌晨维护",
    "proxySub.customRulesPrepend": "DOMAIN-SUFFIX,corp.example,DIRECT\nIP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "proxySub.customRulesAppend": "GEOIP,CN,DIRECT",
  };
  for (const [key, value] of Object.entries(settings)) {
    await runtime.executeRaw(`INSERT INTO "system_settings" ("key", "value") VALUES (?, ?)`, [key, value]);
  }
  return { rules: rules.length, nodes: nodes.length, visibleTemplates: visibleTemplates.length };
}

async function startServer(port = 0) {
  const { proxySubscriptionRouter } = await import("./proxySubscriptionRoute");
  const app = express();
  // 和 server/index.ts 的 installCompression 一样：客户端带 Accept-Encoding 时正文是压过的。
  app.use(compression({ threshold: 1024 }));
  app.get("/__bench/stats", (_req, res) => {
    res.json({ cpu: process.cpuUsage(), memory: process.memoryUsage(), uptime: process.uptime() });
  });
  app.use(proxySubscriptionRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

type GoldenRequest = { label: string; path: string; userAgent: string };

function goldenRequests(): GoldenRequest[] {
  const requests: GoldenRequest[] = [];
  for (const key of Object.keys(TOKENS) as TokenKey[]) {
    for (const format of PROXY_SUBSCRIPTION_FORMATS) {
      for (const rules of [false, true]) {
        requests.push({
          label: `${key}/${format}/${rules ? "rules" : "nodes"}`,
          path: `/api/sub/${TOKENS[key]}/${format}${rules ? "?rules=1" : ""}`,
          userAgent: FORMAT_CLIENT[format],
        });
      }
    }
  }
  for (const [client, userAgent] of Object.entries(DETECTED_CLIENTS)) {
    requests.push({ label: `ua:${client}`, path: `/api/sub/${TOKENS.default}?rules=1`, userAgent });
  }
  requests.push({ label: "alias/mihomo", path: `/s/${ALIAS}?rules=1`, userAgent: DETECTED_CLIENTS.mihomo });
  requests.push({ label: "query/emoji-region", path: `/api/sub/${TOKENS.default}/clash?rules=1&emoji=1&sort=region&include=${encodeURIComponent("香港|日本")}`, userAgent: DETECTED_CLIENTS.mihomo });
  return requests;
}

type Fetched = { status: number; body: Buffer; type: string; etag: string; encoding: string };

async function get(port: number, path: string, userAgent: string, acceptEncoding = ""): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "user-agent": userAgent, host: "panel.example.test" };
    if (acceptEncoding) headers["accept-encoding"] = acceptEncoding;
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const encoding = String(res.headers["content-encoding"] || "");
        resolve({
          status: res.statusCode || 0,
          body: encoding === "gzip" ? gunzipSync(raw) : raw,
          type: String(res.headers["content-type"] || ""),
          etag: String(res.headers.etag || ""),
          encoding,
        });
      });
    });
    req.on("error", reject);
  });
}

const mode = process.argv[2];
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
await ensureDatabaseSchema();

if (mode === "golden") {
  const counts = await runtime.withDatabaseTransaction(() => seed(SCALES.golden));
  const { server, port } = await startServer();
  const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
  for (const request of goldenRequests()) {
    const plain = await get(port, request.path, request.userAgent);
    // 同一条再带 gzip 拉一次：解压后必须和不压的逐字节一样，头也一样。
    const gzipped = await get(port, request.path, request.userAgent, "gzip");
    const gzipSame = gzipped.encoding === "gzip" && sha(gzipped.body) === sha(plain.body) && gzipped.type === plain.type && gzipped.etag === plain.etag;
    process.stdout.write(`${JSON.stringify({ label: request.label, status: plain.status, bytes: plain.body.length, sha256: sha(plain.body), type: plain.type, etag: plain.etag, gzipSame })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ label: "counts", ...counts })}\n`);
  server.close();
  await runtime.closeDatabase();
  process.exit(0);
} else if (mode === "serve") {
  const existing = await runtime.queryRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM "proxy_sub_tokens"`);
  const counts = Number(existing[0]?.n || 0) > 0 ? null : await runtime.withDatabaseTransaction(() => seed(SCALES.bench));
  const ttl = String(Math.max(0, Number(process.env.BENCH_CACHE_TTL || 0)));
  await runtime.executeRaw(`UPDATE "system_settings" SET "value" = ? WHERE "key" = 'proxySub.cacheTtlSec'`, [ttl]);
  const { port } = await startServer(Number(process.env.PORT || 0));
  // --cpu-prof 只在正常退出时写文件：收到 SIGTERM 时走 process.exit。
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.stdout.write(`READY ${JSON.stringify({ port, pid: process.pid, tokens: TOKENS, alias: ALIAS, cacheTtlSec: Number(ttl), seeded: counts, formatClients: FORMAT_CLIENT, detectedClients: DETECTED_CLIENTS })}\n`);
} else {
  console.error("usage: node --import tsx server/proxySubBench.fixture.ts <golden|serve>");
  process.exit(2);
}
