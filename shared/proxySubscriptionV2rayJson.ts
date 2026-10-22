/**
 * Xray JSON 订阅：v2rayN 6.40+、v2rayNG 1.8.29+、Happ 1.63+ 认的那种 ——
 * 一个 JSON 数组，每个元素是一份完整的 Xray 配置（remarks + outbounds + routing）。
 *
 * 和分享链接相比，JSON 能把 Xray 的每个参数都带上（XHTTP 的 extra、REALITY 的 spiderX、
 * mux……），客户端也不用再解析一遍 URI。分流规则一起写进 routing，导进去就能用。
 *
 * 只有 Xray 内核有的协议：VLESS / VMess / Trojan / Shadowsocks / SOCKS。Hysteria2 / TUIC /
 * AnyTLS / Snell 在 proxySubscription.ts 的格式能力表里就被挡掉了，这里不会收到。
 *
 * 写法依据 Xray 官方配置文档（xtls.github.io/config）和 Marzban 的 v2ray-json 产出。
 */

import { proxyNodeAlwaysTls, type ProxyNode } from "./proxyNode";
import { PROXY_PRIVATE_IP6_CIDRS, PROXY_PRIVATE_IP_CIDRS, PROXY_RULE_TARGET_DIRECT, PROXY_RULE_TARGET_REJECT, type ProxyRouteRule } from "./proxyRuleset";

type Json = Record<string, unknown>;

function streamSettings(node: ProxyNode): Json {
  const stream: Json = { network: node.transport === "http" ? "h2" : node.transport };
  if (node.transport === "ws") {
    stream.wsSettings = { ...(node.path ? { path: node.path } : {}), ...(node.host ? { host: node.host } : {}) };
  } else if (node.transport === "grpc") {
    stream.grpcSettings = { ...(node.path ? { serviceName: node.path } : {}) };
  } else if (node.transport === "http") {
    stream.httpSettings = { ...(node.path ? { path: node.path } : {}), ...(node.host ? { host: [node.host] } : {}) };
  } else if (node.transport === "httpupgrade") {
    stream.httpupgradeSettings = { ...(node.path ? { path: node.path } : {}), ...(node.host ? { host: node.host } : {}) };
  } else if (node.transport === "xhttp") {
    stream.xhttpSettings = {
      ...(node.path ? { path: node.path } : {}),
      ...(node.host ? { host: node.host } : {}),
      ...(node.xhttpMode ? { mode: node.xhttpMode } : {}),
    };
  }

  const tls = node.tls || proxyNodeAlwaysTls(node.protocol);
  if (node.realityPublicKey) {
    stream.security = "reality";
    stream.realitySettings = {
      ...(node.sni ? { serverName: node.sni } : {}),
      fingerprint: node.fingerprint || "chrome",
      publicKey: node.realityPublicKey,
      ...(node.realityShortId ? { shortId: node.realityShortId } : {}),
      spiderX: "",
    };
  } else if (tls) {
    stream.security = "tls";
    stream.tlsSettings = {
      ...(node.sni ? { serverName: node.sni } : {}),
      allowInsecure: !!node.allowInsecure,
      ...(node.alpn.length ? { alpn: [...node.alpn] } : {}),
      ...(node.fingerprint ? { fingerprint: node.fingerprint } : {}),
    };
  }
  return stream;
}

function proxyOutbound(node: ProxyNode): Json | null {
  const base: Json = { tag: "proxy" };
  if (node.protocol === "vless") {
    base.protocol = "vless";
    base.settings = {
      vnext: [{
        address: node.address,
        port: node.port,
        users: [{ id: node.uuid, encryption: "none", ...(node.flow ? { flow: node.flow } : {}) }],
      }],
    };
  } else if (node.protocol === "vmess") {
    base.protocol = "vmess";
    base.settings = {
      vnext: [{
        address: node.address,
        port: node.port,
        users: [{ id: node.uuid, alterId: node.alterId, security: node.method || "auto" }],
      }],
    };
  } else if (node.protocol === "trojan") {
    base.protocol = "trojan";
    base.settings = { servers: [{ address: node.address, port: node.port, password: node.password }] };
  } else if (node.protocol === "shadowsocks") {
    base.protocol = "shadowsocks";
    base.settings = {
      servers: [{ address: node.address, port: node.port, method: node.method, password: node.password, uot: true }],
    };
  } else if (node.protocol === "socks5") {
    base.protocol = "socks";
    base.settings = {
      servers: [{
        address: node.address,
        port: node.port,
        ...(node.username || node.password ? { users: [{ user: node.username, pass: node.password }] } : {}),
      }],
    };
  } else {
    return null;
  }
  base.streamSettings = streamSettings(node);
  // 前置代理：Xray 的 dialerProxy 挂在 streamSettings.sockopt 上，指向另一个出站的 tag。
  // 每份配置只有一个代理出站，所以前置在这里表达不了 —— 和 base64 一样靠名字提示。
  base.mux = { enabled: false };
  return base;
}

type RenderOptions = { testUrl: string };

export type V2rayRuleSetInfo = { geoKey: string; behavior: string };

/** 把订阅的分流规则转成 Xray 的 routing.rules；只认三种去向：proxy / direct / block。 */
function routingRules(rules: readonly ProxyRouteRule[], ruleSets: ReadonlyMap<string, V2rayRuleSetInfo>): Json[] {
  const outboundTag = (target: string) => (target === PROXY_RULE_TARGET_DIRECT ? "direct" : target === PROXY_RULE_TARGET_REJECT ? "block" : "proxy");
  const out: Json[] = [];
  for (const rule of rules) {
    if (rule.type === "ip-private") {
      out.push({ type: "field", ip: [...PROXY_PRIVATE_IP_CIDRS, ...PROXY_PRIVATE_IP6_CIDRS], outboundTag: outboundTag(rule.target) });
    } else if (rule.type === "rule-set") {
      // 预设规则集按 geosite / geoip 键还原：Xray 自带 geosite.dat / geoip.dat，键名和上游一致。
      const ref = ruleSets.get(rule.ruleSet);
      if (!ref || !ref.geoKey) continue;
      out.push(ref.behavior === "ipcidr"
        ? { type: "field", ip: [`geoip:${ref.geoKey}`], outboundTag: outboundTag(rule.target) }
        : { type: "field", domain: [`geosite:${ref.geoKey}`], outboundTag: outboundTag(rule.target) });
    } else if (rule.type === "domain") {
      const value = rule.match === "exact" ? `full:${rule.value}` : rule.match === "suffix" ? `domain:${rule.value}` : `keyword:${rule.value}`;
      out.push({ type: "field", domain: [value], outboundTag: outboundTag(rule.target) });
    } else if (rule.type === "ip-cidr") {
      out.push({ type: "field", ip: [rule.value], outboundTag: outboundTag(rule.target) });
    } else if (rule.type === "geoip") {
      out.push({ type: "field", ip: [`geoip:${rule.code === "PRIVATE" ? "private" : rule.code.toLowerCase()}`], outboundTag: outboundTag(rule.target) });
    } else if (rule.type === "geosite") {
      out.push({ type: "field", domain: [`geosite:${rule.key}`], outboundTag: outboundTag(rule.target) });
    }
  }
  return out;
}

export function renderV2rayJsonSubscription(
  nodes: readonly ProxyNode[],
  rules: readonly ProxyRouteRule[],
  _options: RenderOptions,
  ruleSets: ReadonlyMap<string, V2rayRuleSetInfo> = new Map(),
): string {
  const routing = routingRules(rules, ruleSets);
  const configs: Json[] = [];
  for (const node of nodes) {
    const outbound = proxyOutbound(node);
    if (!outbound) continue;
    configs.push({
      remarks: node.frontProxyName ? `${node.name}（需手动接 ${node.frontProxyName}）` : node.name,
      log: { loglevel: "warning" },
      dns: { servers: ["1.1.1.1", "8.8.8.8", { address: "223.5.5.5", domains: ["geosite:cn"], expectIPs: ["geoip:cn"] }] },
      inbounds: [
        { tag: "socks", port: 10808, listen: "127.0.0.1", protocol: "socks", settings: { udp: true, auth: "noauth" }, sniffing: { enabled: true, destOverride: ["http", "tls"] } },
        { tag: "http", port: 10809, listen: "127.0.0.1", protocol: "http", settings: {} },
      ],
      outbounds: [
        outbound,
        { tag: "direct", protocol: "freedom", settings: {} },
        { tag: "block", protocol: "blackhole", settings: { response: { type: "http" } } },
      ],
      routing: {
        domainStrategy: "IPIfNonMatch",
        rules: routing,
      },
    });
  }
  return `${JSON.stringify(configs, null, 2)}\n`;
}
