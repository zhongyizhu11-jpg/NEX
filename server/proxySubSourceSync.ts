/**
 * 外部订阅的拉取与对账。
 *
 * 面板替用户去拉别处的订阅地址，解析成节点，写进他的 proxy_nodes（带 sourceId），
 * 下次拉取按「协议 + 地址 + 端口 + 凭据」对账：还在的更新、新来的插入、没了的删掉。
 * 正文没变（哈希一样）就什么都不动。
 *
 * 这是面板主动往公网发请求，所以：
 *   - 只收 http(s)，解析出来的目标不能是私网 / 环回 / 链路本地 / 唯一本地地址；
 *     检查放在连接用的 lookup 里，连接只落在检查过的地址上（防 DNS 重绑定到内网，见 ssrf.ts）；
 *   - 不跟随跨主机跳转；同主机最多跟 3 次；
 *   - 正文最多 2 MB，边读边数、超了就断，15 秒超时；DNS 解析 3 秒超时；
 *   - 定时任务同一时间最多 3 路在拉，界面上的「立即同步」最多 2 路；
 *   - 同一个来源的同步排队跑（面板是单进程，内存里的队列就够）：原来定时任务和「立即同步」撞上时
 *     两边都看到同一份「现有节点」、都插一遍，节点就重了。对账在一个事务里，没变的节点不写。
 */

import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

import * as db from "./db";
import { classifyIpAddress } from "../shared/ipAddress";
import { parseProxySubSourceContent, parseSubscriptionUserinfoHeader } from "../shared/proxySubSource";
import { withDatabaseTransaction } from "./dbRuntime";
import { createKeyedSerial } from "./keyedSerial";
import { invalidateProxySubCacheForUser } from "./proxySubCache";
import { loadProxySubSettings } from "./proxySubSettings";
import { SafeOutboundError, safeHttpGet } from "./ssrf";
import type { ProxyNode } from "../shared/proxyNode";
import type { InsertProxyNode } from "../drizzle/schema";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const DNS_TIMEOUT_MS = 3_000;
const MAX_REDIRECTS = 3;
const DEFAULT_UA = "NEX-Subscription-Sync/1.0 (+clash.meta; mihomo)";

class ProxySubSourceFetchError extends Error {}

/** 这个主机名解析出来的地址是不是全在公网上。 */
/** 只给测试用：让子进程里起的本地「机场」能被拉到。生产环境没有这个变量。 */
function testAllowsPrivateSource() {
  return process.env.FORWARDX_TEST_ALLOW_PRIVATE_SUB_SOURCE === "1" && process.env.NODE_ENV !== "production";
}

/** @public 测试经 import(url(...)) 动态引用，knip 看不见 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (!host) throw new ProxySubSourceFetchError("地址缺少主机名");
  if (testAllowsPrivateSource()) return;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ProxySubSourceFetchError("不能拉取内网地址");
  }
  const addresses: string[] = net.isIP(host) ? [host] : await lookupAddresses(host);
  if (addresses.length === 0) throw new ProxySubSourceFetchError(`解析不了 ${host}`);
  for (const address of addresses) {
    if (classifyIpAddress(address) !== "public") throw new ProxySubSourceFetchError("不能拉取内网地址");
  }
}

/**
 * 解析主机名，最多等 3 秒。dns.lookup 走系统解析器、自己没有超时：上游 DNS 挂了，「立即同步」的
 * 请求就一直吊在那里。解析不出来（含超时）当成没有地址，上面统一报「解析不了」。
 */
async function lookupAddresses(host: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS);
  });
  try {
    const records = await Promise.race([dns.lookup(host, { all: true }), timeout]);
    return records.map((item) => item.address);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

type FetchedSubscription = {
  body: string;
  userinfo: string;
  contentHash: string;
};

function headerText(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] : value || "");
}

async function fetchExternalSubscription(url: string, userAgent: string): Promise<FetchedSubscription> {
  let current = new URL(url);
  if (current.protocol !== "http:" && current.protocol !== "https:") throw new ProxySubSourceFetchError("只支持 http(s) 地址");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // 先查一遍给出明白的报错；真正挡住的是连接时 lookup 里的那一遍（防重绑定）。
    await assertPublicHost(current.hostname);
    let response: Awaited<ReturnType<typeof safeHttpGet>>;
    try {
      response = await safeHttpGet(current.toString(), {
        headers: { "user-agent": userAgent || DEFAULT_UA, accept: "*/*" },
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        purpose: "外部订阅",
        isBlockedAddress: (address) => !testAllowsPrivateSource() && classifyIpAddress(address) !== "public",
      });
    } catch (error) {
      if (error instanceof SafeOutboundError) {
        if (error.code === "timeout") throw new ProxySubSourceFetchError("拉取超时（15 秒）");
        if (error.code === "too-large") throw new ProxySubSourceFetchError("正文超过 2 MB");
        if (error.code === "blocked") throw new ProxySubSourceFetchError("不能拉取内网地址");
      }
      throw new ProxySubSourceFetchError(`拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = headerText(response.headers.location);
      if (!location) throw new ProxySubSourceFetchError(`上游返回 ${response.status} 但没有跳转地址`);
      const next = new URL(location, current);
      if (next.host !== current.host) throw new ProxySubSourceFetchError("上游跳转到了另一个主机，不跟随");
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new ProxySubSourceFetchError(`上游返回 ${response.status}`);
    const buffer = response.body;
    return {
      body: buffer.toString("utf8"),
      userinfo: headerText(response.headers["subscription-userinfo"]),
      contentHash: createHash("sha256").update(buffer).digest("hex"),
    };
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

type ProxySubSourceSyncStatus = "done" | "queued" | "running";

export type ProxySubSourceSyncResult = {
  ok: boolean;
  error?: string;
  added: number;
  /** 这次真改了字段的节点数（没变的不写、也不算）。 */
  updated: number;
  removed: number;
  unchanged: boolean;
  nodeCount: number;
  parseErrors: number;
  /** 「立即同步」走队列：queued = 并发满了、排上了稍后跑；running = 这个来源正有一次在跑，没有再排。没带 = 这次跑完了。 */
  status?: ProxySubSourceSyncStatus;
};

/** 同一个来源的同步一个接一个跑（见文件头）。 */
const sourceSyncSerial = createKeyedSerial<number>();
/** 正在跑或排着的同步，按来源计数：「立即同步」据此直接回「正在跑」而不是再排一次。 */
const inFlight = new Map<number, number>();

function isProxySubSourceSyncInFlight(sourceId: number): boolean {
  return (inFlight.get(Number(sourceId)) || 0) > 0;
}

/**
 * 拉一次、对账一次。来源行的状态也在这里写。同一个来源同时只跑一次，后来的排在后面。
 * 定时任务直接调它；界面走 requestProxySubSourceSync。
 * @public 测试经 import(url(...)) 动态引用，knip 看不见
 */
export async function syncProxySubSource(sourceId: number, options: { force?: boolean } = {}): Promise<ProxySubSourceSyncResult> {
  const id = Number(sourceId);
  inFlight.set(id, (inFlight.get(id) || 0) + 1);
  try {
    return await sourceSyncSerial(id, () => syncProxySubSourceNow(id, options));
  } finally {
    const left = (inFlight.get(id) || 0) - 1;
    if (left > 0) inFlight.set(id, left);
    else inFlight.delete(id);
  }
}

/** 节点行上的一个字段和解析出来的值是不是一样（库里的布尔在 MySQL 下是 0 / 1，空字符串和 null 同义）。 */
function sameNodeValue(current: unknown, next: unknown): boolean {
  if (typeof next === "boolean") return !!current === next;
  if (typeof next === "number") return Number(current ?? 0) === next;
  return String(current ?? "") === String(next ?? "");
}

function nodeRowChanged(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.entries(next).some(([key, value]) => !sameNodeValue(current[key], value));
}

async function syncProxySubSourceNow(sourceId: number, options: { force?: boolean }): Promise<ProxySubSourceSyncResult> {
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
    // 透传来源进订阅的 proxy-providers（按用户缓存在组装上下文里）：刚建的那一次要让它出现。
    invalidateProxySubCacheForUser(userId);
    return { ok: true, added: 0, updated: 0, removed: 0, unchanged: false, nodeCount: parsed.nodes.length, parseErrors: parsed.errors.length };
  }

  const parsed = parseProxySubSourceContent(fetched.body);
  if (parsed.nodes.length === 0) {
    return fail(parsed.errors[0]?.error || "订阅里没有能识别的节点");
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const seen = new Set<string>();
  const changedIds: number[] = [];
  /*
    对账一个事务：读现有、改、插、删、写来源状态要么全成要么全不成。原来每条一个事务，
    中途断了就留下一半新一半旧，下一次按哈希一比「没变」还不再对账。
  */
  await withDatabaseTransaction(async () => {
    const existing = await db.listProxyNodesBySource(sourceId) as any[];
    const existingByKey = new Map<string, any>();
    const staleIds: number[] = [];
    for (const row of existing) {
      const key = row.sourceKey ? String(row.sourceKey) : "";
      // 没有身份键的、或者同一个身份有两行（串行化之前并发同步留下的）：多出来的当成上游去掉的，留 id 最小的那一条。
      const kept = key ? existingByKey.get(key) : undefined;
      if (!key || (kept && Number(kept.id) <= Number(row.id))) {
        staleIds.push(Number(row.id));
        continue;
      }
      if (kept) staleIds.push(Number(kept.id));
      existingByKey.set(key, row);
    }

    const toInsert: InsertProxyNode[] = [];
    for (const node of parsed.nodes) {
      const key = identityKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      const name = node.name || `${node.address}:${node.port}`;
      const current = existingByKey.get(key);
      if (current) {
        // 字段一样就不写：上游每次给的几十条大多没变，原来每条一次 UPDATE。
        const next = { ...nodeToRow(node), name };
        if (nodeRowChanged(current, next)) {
          await db.updateProxyNodeFields(Number(current.id), next);
          changedIds.push(Number(current.id));
          updated += 1;
        }
      } else {
        toInsert.push({
          userId,
          name,
          ...nodeToRow(node),
          sourceId,
          sourceKey: key,
          // 外部节点就是落地本身，直连进订阅；多台中转指向它时照常可以绑转发。
          includeDirect: true,
          autoGroup: "off",
        });
        added += 1;
      }
    }
    await db.createProxyNodes(toInsert);
    const stale = new Set(staleIds);
    for (const row of existing) {
      if (row.sourceKey && seen.has(String(row.sourceKey)) && existingByKey.get(String(row.sourceKey)) === row) continue;
      stale.add(Number(row.id));
    }
    removed = stale.size;
    // 一条 IN 删完，缓存等事务提交后作废一次（deleteProxyNodes 里 afterDatabaseCommit）。
    await db.deleteProxyNodes([...stale]);

    await db.updateProxySubSource(sourceId, {
      lastFetchAt: new Date(),
      lastStatus: "ok",
      lastError: parsed.errors.length > 0 ? `${parsed.errors.length} 条解析不了：${parsed.errors[0].error}` : null,
      upstreamUserinfo: userinfo ? JSON.stringify(userinfo) : null,
      nodeCount: seen.size,
      lastContentHash: fetched.contentHash,
    } as any);
  });
  // 主人作废一次；改过的节点若分享给了别人，收件人也作废一次（原来 updateProxyNode 按节点各查一遍）。
  invalidateProxySubCacheForUser(userId);
  if (changedIds.length > 0) {
    for (const recipients of (await db.getProxyNodeShareUserIds(changedIds)).values()) {
      for (const recipient of recipients) invalidateProxySubCacheForUser(recipient);
    }
  }
  return { ok: true, added, updated, removed, unchanged: false, nodeCount: seen.size, parseErrors: parsed.errors.length };
}

/*
  界面上的「立即同步」：最多 2 路同时拉，再来的排队、请求立刻回「已排队」；这个来源正有一次在跑
  （定时任务的或别人点的）就回「正在跑」，不再排一次。原来请求里同步等最多 4 跳 × 15 秒，
  几个人同时点就是几路公网请求一起吊着。
*/
const MANUAL_SYNC_CONCURRENCY = 2;
let manualActive = 0;
const manualWaiting: Array<() => void> = [];
const manualQueued = new Set<number>();

async function acquireManualSlot(): Promise<void> {
  if (manualActive < MANUAL_SYNC_CONCURRENCY) {
    manualActive += 1;
    return;
  }
  // 释放的那一方把名额直接交给排队的第一个（不先减再加，免得中间被新来的插队到 3 路）。
  await new Promise<void>((resolve) => manualWaiting.push(resolve));
}

function releaseManualSlot() {
  const next = manualWaiting.shift();
  if (next) next();
  else manualActive -= 1;
}

async function runManualSync(sourceId: number, options: { force?: boolean }): Promise<ProxySubSourceSyncResult> {
  await acquireManualSlot();
  try {
    return await syncProxySubSource(sourceId, options);
  } finally {
    releaseManualSlot();
  }
}

async function placeholderResult(sourceId: number, status: ProxySubSourceSyncStatus): Promise<ProxySubSourceSyncResult> {
  const source = await db.getProxySubSourceById(sourceId) as any;
  return { ok: true, status, added: 0, updated: 0, removed: 0, unchanged: false, nodeCount: Number(source?.nodeCount || 0), parseErrors: 0 };
}

/** 「立即同步」/ 新建来源后的第一次拉取走这里（见上面的说明）。 */
export async function requestProxySubSourceSync(sourceId: number, options: { force?: boolean } = {}): Promise<ProxySubSourceSyncResult> {
  const id = Number(sourceId);
  if (manualQueued.has(id)) return placeholderResult(id, "queued");
  if (isProxySubSourceSyncInFlight(id)) return placeholderResult(id, "running");
  if (manualActive >= MANUAL_SYNC_CONCURRENCY) {
    manualQueued.add(id);
    void runManualSync(id, options)
      .then((result) => {
        if (!result.ok) console.warn(`[proxy-subscription] 外部订阅 #${id} 排队同步失败: ${result.error}`);
      })
      .catch((error) => console.warn(`[proxy-subscription] 外部订阅 #${id} 排队同步出错:`, error instanceof Error ? error.message : error))
      .finally(() => manualQueued.delete(id));
    return placeholderResult(id, "queued");
  }
  return runManualSync(id, options);
}

let running = 0;

/**
 * 定时拉取前的资格：和「改源 / 立即同步」两个接口同一套（全局开关 + 管理员或套餐允许）。
 * 不够格的不拉，但把这一轮记成失败（写上原因、刷新拉取时间）：不刷新的话它们一直排在
 * 到点队列最前面，把够格的挤出去。
 */
async function sourceOwnerAllowed(userId: number, cache: Map<number, boolean>): Promise<boolean> {
  if (cache.has(userId)) return cache.get(userId)!;
  let allowed = false;
  try {
    const owner = await db.getUserById(userId) as any;
    if (owner) {
      allowed = String(owner.role) === "admin" || !!(await db.getUserPlanSubscriptionInfo(userId)).allowExternalSubSources;
    }
  } catch {
    allowed = false;
  }
  cache.set(userId, allowed);
  return allowed;
}

/** 定时任务：把到点的来源拉一遍，最多并发 3 路。 */
export async function runProxySubSourceSync(now = Date.now()): Promise<number> {
  const due = await db.listDueProxySubSources(now, 20) as any[];
  if (due.length === 0) return 0;
  const settings = await loadProxySubSettings();
  const owners = new Map<number, boolean>();
  const eligible: any[] = [];
  for (const source of due) {
    const reason = !settings.externalSourcesEnabled
      ? "管理员没有开放外部订阅，暂停拉取"
      : (await sourceOwnerAllowed(Number(source.userId), owners) ? "" : "当前套餐不包含外部订阅，暂停拉取");
    if (!reason) {
      eligible.push(source);
      continue;
    }
    await db.updateProxySubSource(Number(source.id), { lastFetchAt: new Date(now), lastStatus: "error", lastError: reason } as any).catch(() => undefined);
  }
  let done = 0;
  const queue = [...eligible];
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
