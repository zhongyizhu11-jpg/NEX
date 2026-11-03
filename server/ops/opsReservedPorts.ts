/*
  第五套主题那批功能自己在主机上占用的端口（目前只有「经其他主机连面板」的中转端口）。

  端口冲突检查（tunnelRepository 的 isPortUsedOnHost / getUsedPortsOnHost）只认规则、隧道、
  落地入站、入口桥接 —— 不告诉它，新建规则时就可能随机到中转正在听的端口，两个进程抢一个
  端口，后起的那个起不来。所以那两个函数各加了一行，来这里问一声。

  这里只引 dbRuntime（tunnelRepository 引它，不能引仓库层，否则成环）；数据由功能模块用
  registerOpsReservedPortsLoader 提供，结果缓存 30 秒，改动后调 invalidateOpsReservedPorts。
  读失败一律当作「没有额外占用」：宁可漏挡一次，也不能让建规则因为这里报错而失败。
*/

import { isDatabaseTransactionActive } from "../dbRuntime";

export type OpsReservedPort = { hostId: number; port: number };

type Loader = () => Promise<OpsReservedPort[]>;

const loaders = new Map<string, Loader>();
let cache: Map<number, Set<number>> | null = null;
let cacheAt = 0;
let pending: Promise<Map<number, Set<number>>> | null = null;
const CACHE_MS = 30_000;

export function registerOpsReservedPortsLoader(name: string, loader: Loader) {
  loaders.set(name, loader);
  invalidateOpsReservedPorts();
}

export function invalidateOpsReservedPorts() {
  cache = null;
  cacheAt = 0;
  pending = null;
}

async function loadAll(): Promise<Map<number, Set<number>>> {
  const map = new Map<number, Set<number>>();
  for (const [name, loader] of loaders) {
    try {
      for (const item of await loader()) {
        const hostId = Number(item.hostId);
        const port = Number(item.port);
        if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
        let ports = map.get(hostId);
        if (!ports) {
          ports = new Set();
          map.set(hostId, ports);
        }
        ports.add(port);
      }
    } catch (error) {
      console.warn(`[OpsReservedPorts] loader ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return map;
}

/** 这台主机上被这批功能占着的端口。 */
export async function opsReservedPortsOnHost(hostId: number): Promise<number[]> {
  if (loaders.size === 0) return [];
  try {
    /*
      事务里不去等别人正在跑的那次加载（pending）：那次加载是事务外发起的，SQLite 下它的查询
      排在连接锁后面，而锁就在本事务手里 —— 本事务等它、它等本事务，整个面板的数据库访问一起
      卡死（转发组同步在事务里给每个成员查端口占用，走的就是这里）。缓存够新就用缓存，不够新
      就在本事务里自己读一遍；读到的是还没提交的状态，不写回缓存、也不登记给别人复用。
    */
    if (isDatabaseTransactionActive()) {
      const map = cache && Date.now() - cacheAt <= CACHE_MS ? cache : await loadAll();
      return Array.from(map.get(Number(hostId)) || []);
    }
    if (!cache || Date.now() - cacheAt > CACHE_MS) {
      if (!pending) {
        pending = loadAll().then((map) => {
          cache = map;
          cacheAt = Date.now();
          pending = null;
          return map;
        }, (error) => {
          pending = null;
          throw error;
        });
      }
      await pending;
    }
    return Array.from(cache?.get(Number(hostId)) || []);
  } catch {
    return [];
  }
}
