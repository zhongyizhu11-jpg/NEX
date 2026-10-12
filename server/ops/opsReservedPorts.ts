/*
  第五套主题那批功能自己在主机上占用的端口（目前只有「经其他主机连面板」的中转端口）。

  端口冲突检查（tunnelRepository 的 isPortUsedOnHost / getUsedPortsOnHost）只认规则、隧道、
  落地入站、入口桥接 —— 不告诉它，新建规则时就可能随机到中转正在听的端口，两个进程抢一个
  端口，后起的那个起不来。所以那两个函数各加了一行，来这里问一声。

  这里不 import 任何东西（tunnelRepository 引它，不能成环）；数据由功能模块用
  registerOpsReservedPortsLoader 提供，结果缓存 30 秒，改动后调 invalidateOpsReservedPorts。
  读失败一律当作「没有额外占用」：宁可漏挡一次，也不能让建规则因为这里报错而失败。
*/

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
