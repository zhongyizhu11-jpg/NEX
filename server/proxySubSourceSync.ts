/**
 * 外部订阅的拉取与对账。
 *
 * 面板替用户去拉别处的订阅地址，解析成节点，写进他的 proxy_nodes（带 sourceId），
 * 下次拉取按「协议 + 地址 + 端口 + 凭据」对账：还在的更新、新来的插入、没了的删掉。
 * 正文没变（哈希一样）就什么都不动。
 *
 * 这是面板主动往公网发请求，所以：
 *   - 只收 http(s)，解析出来的目标不能是私网 / 环回 / 链路本地 / 唯一本地地址
 *     （DNS 解析之后再查一遍，防 DNS 重绑定到内网）；
 *   - 不跟随跨主机跳转；同主机最多跟 3 次；
 *   - 正文最多 2 MB，15 秒超时；
 *   - 同一时间最多 3 路在拉。
 */

import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

import * as db from "./db";
import { classifyIpAddress } from "../shared/ipAddress";
import { parseProxySubSourceContent, parseSubscriptionUserinfoHeader } from "../shared/proxySubSource";
import { invalidateProxySubCacheForUser } from "./proxySubCache";
import type { ProxyNode } from "../shared/proxyNode";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const DEFAULT_UA = "NEX-Subscription-Sync/1.0 (+clash.meta; mihomo)";

export class ProxySubSourceFetchError extends Error {}

/** 这个主机名解析出来的地址是不是全在公网上。 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (!host) throw new ProxySubSourceFetchError("地址缺少主机名");
  // 只给测试用：让子进程里起的本地「机场」能被拉到。生产环境没有这个变量。
  if (process.env.FORWARDX_TEST_ALLOW_PRIVATE_SUB_SOURCE === "1" && process.env.NODE_ENV !== "production") return;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ProxySubSourceFetchError("不能拉取内网地址");
  }
  const addresses: string[] = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((item) => item.address);
  if (addresses.length === 0) throw new ProxySubSourceFetchError(`解析不了 ${host}`);
  for (const address of addresses) {
    if (classifyIpAddress(address) !== "public") throw new ProxySubSourceFetchError("不能拉取内网地址");
  }
}

export type FetchedSubscription = {
  body: string;
  userinfo: string;
  contentHash: string;
};

export async function fetchExternalSubscription(url: string, userAgent: string): Promise<FetchedSubscription> {
  let current = new URL(url);
  if (current.protocol !== "http:" && current.protocol !== "https:") throw new ProxySubSourceFetchError("只支持 http(s) 地址");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        headers: { "user-agent": userAgent || DEFAULT_UA, accept: "*/*" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new ProxySubSourceFetchError(error instanceof Error && error.name === "AbortError" ? "拉取超时（15 秒）" : `拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ProxySubSourceFetchError(`上游返回 ${response.status} 但没有跳转地址`);
        const next = new URL(location, current);
        if (next.host !== current.host) throw new ProxySubSourceFetchError("上游跳转到了另一个主机，不跟随");
        current = next;
        continue;
      }
      if (!response.ok) throw new ProxySubSourceFetchError(`上游返回 ${response.status}`);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_BYTES) throw new ProxySubSourceFetchError("正文超过 2 MB");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BYTES) throw new ProxySubSourceFetchError("正文超过 2 MB");
      const body = buffer.toString("utf8");
      return {
        body,
        userinfo: response.headers.get("subscription-userinfo") || "",
        contentHash: createHash("sha256").update(buffer).digest("hex"),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProxySubSourceFetchError("跳转次数过多");
}

function identityKey(node: ProxyNode): string {
  return `${node.protocol}|${node.address.toLowerCase()}|${node.port}|${node.uuid || node.password}|${node.transport}|${node.path}`;
}

function nodeToRow(node: ProxyNode) {
  return {
    protocol: node.protocol,
    address: node.address,
    port: node.port,
    uuid: node.uuid || null,
    password: node.password || null,
    method: node.method || null,
    alterId: node.alterId,
    flow: node.flow || null,
    transport: node.transport,
    path: node.path || null,
    host: node.host || null,
    tls: node.tls,
    sni: node.sni || null,
    alpn: node.alpn.length ? node.alpn.join(",") : null,
    fingerprint: node.fingerprint || null,
    allowInsecure: node.allowInsecure,
    realityPublicKey: node.realityPublicKey || null,
    realityShortId: node.realityShortId || null,
    udp: node.udp,
    obfs: node.obfs || null,
    obfsPassword: node.obfsPassword || null,
    upMbps: node.upMbps || 0,
    downMbps: node.downMbps || 0,
    congestionControl: node.congestionControl || null,
    udpRelayMode: node.udpRelayMode || null,
    disableSni: node.disableSni,
    snellVersion: node.snellVersion,
    snellMode: node.snellMode || null,
    xhttpMode: node.xhttpMode || null,
  };
}

export type ProxySubSourceSyncResult = {
  ok: boolean;
  error?: string;
  added: number;
  updated: number;
  removed: number;
  unchanged: boolean;
  nodeCount: number;
  parseErrors: number;
};

/** 拉一次、对账一次。来源行的状态也在这里写。 */
export async function syncProxySubSource(sourceId: number, options: { force?: boolean } = {}): Promise<ProxySubSourceSyncResult> {
  const source = await db.getProxySubSourceById(sourceId) as any;
  if (!source) return { ok: false, error: "来源不存在", added: 0, updated: 0, removed: 0, unchanged: false, nodeCount: 0, parseErrors: 0 };
  const userId = Number(source.userId);
  const fail = async (error: string): Promise<ProxySubSourceSyncResult> => {
    await db.updateProxySubSource(sourceId, { lastFetchAt: new Date(), lastStatus: "error", lastError: error.slice(0, 500) } as any);
    return { ok: false, error, added: 0, updated: 0, removed: 0, unchanged: false, nodeCount: Number(source.nodeCount || 0), parseErrors: 0 };
  };

  let fetched: FetchedSubscription;
  try {
    fetched = await fetchExternalSubscription(String(source.url), String(source.userAgent || ""));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const userinfo = parseSubscriptionUserinfoHeader(fetched.userinfo);
  if (!options.force && source.lastContentHash && source.lastContentHash === fetched.contentHash && source.lastStatus === "ok") {
    await db.updateProxySubSource(sourceId, {
      lastFetchAt: new Date(),
      lastStatus: "ok",
      lastError: null,
      upstreamUserinfo: userinfo ? JSON.stringify(userinfo) : null,
    } as any);
    return { ok: true, added: 0, updated: 0, removed: 0, unchanged: true, nodeCount: Number(source.nodeCount || 0), parseErrors: 0 };
  }

  // provider 模式不存节点：只验证能拉到、记录上游用量。
  if (String(source.mode) === "provider") {
    const parsed = parseProxySubSourceContent(fetched.body);
    await db.updateProxySubSource(sourceId, {
      lastFetchAt: new Date(),
      lastStatus: "ok",
      lastError: parsed.errors.length > 0 ? `${parsed.errors.length} 条解析不了（透传模式下不影响）` : null,
      upstreamUserinfo: userinfo ? JSON.stringify(userinfo) : null,
      nodeCount: parsed.nodes.length,
      lastContentHash: fetched.contentHash,
    } as any);
    return { ok: true, added: 0, updated: 0, removed: 0, unchanged: false, nodeCount: parsed.nodes.length, parseErrors: parsed.errors.length };
  }

  const parsed = parseProxySubSourceContent(fetched.body);
  if (parsed.nodes.length === 0) {
    return fail(parsed.errors[0]?.error || "订阅里没有能识别的节点");
  }

  const existing = await db.listProxyNodesBySource(sourceId) as any[];
  const existingByKey = new Map<string, any>();
  for (const row of existing) if (row.sourceKey) existingByKey.set(String(row.sourceKey), row);

  let added = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const node of parsed.nodes) {
    const key = identityKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = node.name || `${node.address}:${node.port}`;
    const current = existingByKey.get(key);
    if (current) {
      await db.updateProxyNode(Number(current.id), { ...nodeToRow(node), name } as any);
      updated += 1;
    } else {
      await db.createProxyNode({
        userId,
        name,
        ...nodeToRow(node),
        sourceId,
        sourceKey: key,
        // 外部节点就是落地本身，直连进订阅；多台中转指向它时照常可以绑转发。
        includeDirect: true,
        autoGroup: "off",
      } as any);
      added += 1;
    }
  }
  let removed = 0;
  for (const row of existing) {
    if (row.sourceKey && seen.has(String(row.sourceKey))) continue;
    await db.deleteProxyNode(Number(row.id));
    removed += 1;
  }

  await db.updateProxySubSource(sourceId, {
    lastFetchAt: new Date(),
    lastStatus: "ok",
    lastError: parsed.errors.length > 0 ? `${parsed.errors.length} 条解析不了：${parsed.errors[0].error}` : null,
    upstreamUserinfo: userinfo ? JSON.stringify(userinfo) : null,
    nodeCount: seen.size,
    lastContentHash: fetched.contentHash,
  } as any);
  invalidateProxySubCacheForUser(userId);
  return { ok: true, added, updated, removed, unchanged: false, nodeCount: seen.size, parseErrors: parsed.errors.length };
}

let running = 0;

/** 定时任务：把到点的来源拉一遍，最多并发 3 路。 */
export async function runProxySubSourceSync(now = Date.now()): Promise<number> {
  const due = await db.listDueProxySubSources(now, 20) as any[];
  if (due.length === 0) return 0;
  let done = 0;
  const queue = [...due];
  const worker = async () => {
    while (queue.length > 0) {
      const source = queue.shift();
      if (!source) break;
      running += 1;
      try {
        const result = await syncProxySubSource(Number(source.id));
        if (!result.ok) console.warn(`[proxy-subscription] 外部订阅 #${source.id} 拉取失败: ${result.error}`);
        else if (!result.unchanged) console.info(`[proxy-subscription] 外部订阅 #${source.id} 同步: +${result.added} ~${result.updated} -${result.removed}`);
        done += 1;
      } finally {
        running -= 1;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return done;
}
