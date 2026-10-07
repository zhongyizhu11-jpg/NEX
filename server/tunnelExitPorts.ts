import { getSettingsByPrefix, RUNTIME_CACHE_SETTING_PREFIX, setSetting } from "./repositories/settingsRepository";

/*
  隧道规则里有两个出口上的端口是入口替出口填的：线路组的调度器，和出口桥的协议守卫。GOST 隧道由
  入口在 relay 请求里告诉出口拨哪儿，NEX 隧道写在握手里，出口照着拨 127.0.0.1:端口。这两个端口
  却是每台机器按自己的规则集分的（agentHeartbeatRoute 的 allocateProtocolGuardPorts：被占了往后顺延），
  入口和出口上的规则、保留端口不一样，顺延出来的就可能不一样 —— 入口让出口拨的端口上可能什么都没有，
  也可能是另一条规则的调度器，流量跑进别人的线路。

  所以出口每次生成配置时把它真正用的端口记在这里，入口按出口记的填。端口有变化就推一次入口
  （recordTunnelExitPorts 返回要推的入口）。出口报过、但还没有这条规则时（规则刚建、出口还没重算）
  怎么填由调用方定：调度器拨路径 A，等出口报上来；守卫没有能绕过它的退路，按入口自己算的填。出口
  一次都没报过（面板刚升级到这一版）时都按入口自己算的填，和升级前一样。

  记下来的端口同时存进设置表（运行时缓存，不是设置）：面板重启后不用等出口来心跳，入口的配置
  也不会先变一次再变回来。
*/

export type TunnelExitPortKind = "scheduler" | "guard";

export type TunnelExitPortEntry = {
  ruleId: number;
  kind: TunnelExitPortKind;
  port: number;
  /** 这条规则所在隧道的入口机（含入口组的成员）：端口变了要推它们重算。 */
  entryHostIds: number[];
};

type RecordedPort = { port: number; entryHostIds: number[] };

export const TUNNEL_EXIT_PORTS_SETTING_PREFIX = `${RUNTIME_CACHE_SETTING_PREFIX}tunnelExitPorts:`;

const reportsByHost = new Map<number, Map<string, RecordedPort>>();
/** 每台出口存进库里的那一份（序列化后），没存过当作空表。 */
const persistedByHost = new Map<number, string>();
let loadPromise: Promise<void> | null = null;
/** 写库排成一队：同一台出口连着变两次时，后写的不会被先写的盖掉。 */
let persistQueue: Promise<unknown> = Promise.resolve();

const reportKey = (kind: TunnelExitPortKind, ruleId: number) => `${kind}:${ruleId}`;

const validId = (value: unknown) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
};

const validPort = (value: unknown) => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
};

function normalizeEntries(entries: unknown): TunnelExitPortEntry[] {
  const byKey = new Map<string, TunnelExitPortEntry>();
  for (const entry of Array.isArray(entries) ? entries as any[] : []) {
    const ruleId = validId(entry?.ruleId);
    const port = validPort(entry?.port);
    const kind: TunnelExitPortKind | null = entry?.kind === "scheduler" || entry?.kind === "guard" ? entry.kind : null;
    if (!ruleId || !port || !kind) continue;
    const rawEntryHostIds: unknown[] = Array.isArray(entry.entryHostIds) ? entry.entryHostIds : [];
    const entryHostIds = Array.from(new Set(rawEntryHostIds.map(validId)))
      .filter((id) => id > 0)
      .sort((left, right) => left - right);
    byKey.set(reportKey(kind, ruleId), { ruleId, kind, port, entryHostIds });
  }
  return Array.from(byKey.values()).sort((left, right) => left.ruleId - right.ruleId || left.kind.localeCompare(right.kind));
}

const toReport = (entries: TunnelExitPortEntry[]) => new Map(entries.map((entry) => [
  reportKey(entry.kind, entry.ruleId),
  { port: entry.port, entryHostIds: entry.entryHostIds },
]));

/**
 * 面板启动后第一次用之前，把出口上次报的端口从库里读回来。读失败就当没有（下次心跳再读），
 * 已经在这次运行里报过的出口以内存里的为准。
 */
export function loadTunnelExitPorts(): Promise<void> {
  if (!loadPromise) {
    loadPromise = getSettingsByPrefix(TUNNEL_EXIT_PORTS_SETTING_PREFIX)
      .then((rows) => {
        for (const [key, value] of Object.entries(rows)) {
          const hostId = validId(key.slice(TUNNEL_EXIT_PORTS_SETTING_PREFIX.length));
          if (!hostId || reportsByHost.has(hostId)) continue;
          let parsed: unknown = [];
          try {
            parsed = JSON.parse(String(value || "[]"));
          } catch {
            continue;
          }
          const entries = normalizeEntries(parsed);
          reportsByHost.set(hostId, toReport(entries));
          persistedByHost.set(hostId, JSON.stringify(entries));
        }
      })
      .catch(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

/**
 * 记下一台出口这次生成的配置里用到的全部端口（整份换掉上一份），返回端口有变化的规则的入口机：
 * 新报的、改了的、不再报的都算，调用方推它们重算。出口自己不在返回里。
 */
export function recordTunnelExitPorts(hostId: number, entries: TunnelExitPortEntry[]): number[] {
  const exitHostId = validId(hostId);
  if (!exitHostId) return [];
  const normalized = normalizeEntries(entries);
  const next = toReport(normalized);
  const previous = reportsByHost.get(exitHostId);
  reportsByHost.set(exitHostId, next);
  const touched = new Set<number>();
  for (const [key, recorded] of next) {
    if (previous?.get(key)?.port === recorded.port) continue;
    for (const entryHostId of recorded.entryHostIds) touched.add(entryHostId);
  }
  for (const [key, recorded] of previous || []) {
    if (next.has(key)) continue;
    for (const entryHostId of recorded.entryHostIds) touched.add(entryHostId);
  }
  touched.delete(exitHostId);

  const serialized = JSON.stringify(normalized);
  if ((persistedByHost.get(exitHostId) ?? "[]") !== serialized) {
    persistedByHost.set(exitHostId, serialized);
    persistQueue = persistQueue
      .then(() => setSetting(`${TUNNEL_EXIT_PORTS_SETTING_PREFIX}${exitHostId}`, normalized.length > 0 ? serialized : null))
      .catch(() => {
        if (persistedByHost.get(exitHostId) === serialized) persistedByHost.delete(exitHostId);
      });
  }
  return Array.from(touched).sort((left, right) => left - right);
}

/**
 * 入口该让出口拨的端口。exitHostIds 是这条规则用到的出口；入口自己（selfHostId，入口同时也是出口时）
 * 用的就是本机这次算的 localPort。
 *
 * 出口一次都没报过（面板刚升级到有这个功能的版本，库里也没有）时按 localPort 算：和升级前一样，入口
 * 的配置不会先变一次再变回来。出口报过、但报的里面没有这条规则（规则刚建，出口还没重算）时看
 * whenRuleMissing："local" 按 localPort 算，"none" 整个返回 null。所有出口的端口一样就是它，不一样
 * 返回 null。
 */
export function tunnelExitPortFor(
  kind: TunnelExitPortKind,
  ruleId: number,
  exitHostIds: number[],
  localPort: number,
  options: { selfHostId?: number; whenRuleMissing: "local" | "none" },
): number | null {
  const id = validId(ruleId);
  const selfHostId = validId(options.selfHostId);
  let agreed: number | null = null;
  for (const exitHostId of new Set(exitHostIds.map(validId).filter((hostId) => hostId > 0))) {
    let port = localPort;
    const report = exitHostId === selfHostId ? undefined : reportsByHost.get(exitHostId);
    if (report) {
      const reported = report.get(reportKey(kind, id))?.port;
      if (reported === undefined && options.whenRuleMissing === "none") return null;
      port = reported ?? localPort;
    }
    if (agreed === null) agreed = port;
    else if (agreed !== port) return null;
  }
  return agreed ?? localPort;
}

/** 这台出口有没有报过这条规则（没报过的，入口催它来一次心跳）。 */
export function hasTunnelExitPort(hostId: number, kind: TunnelExitPortKind, ruleId: number) {
  return reportsByHost.get(validId(hostId))?.has(reportKey(kind, validId(ruleId))) === true;
}

const REPORT_REQUEST_INTERVAL_MS = 60_000;
const reportRequestedAt = new Map<number, number>();

/**
 * 入口要催一台还没报这条规则的出口来一次心跳时先问这里：同一台出口一分钟最多催一次。出口要是一直
 * 不报（比如它那边不跑这条规则的调度器），入口每次重算都催会让出口跟着一遍遍重算。
 */
export function claimTunnelExitReportRequest(hostId: number, now = Date.now()) {
  const id = validId(hostId);
  if (!id || now - (reportRequestedAt.get(id) || 0) < REPORT_REQUEST_INTERVAL_MS) return false;
  reportRequestedAt.set(id, now);
  return true;
}

/**
 * 测试用：清掉内存里所有出口报过的端口。reload 为真时下一次 loadTunnelExitPorts 重新从库里读（模拟
 * 面板重启），否则不再读库。
 */
export async function resetTunnelExitPortsForTest(options: { reload?: boolean } = {}) {
  await persistQueue;
  reportsByHost.clear();
  persistedByHost.clear();
  reportRequestedAt.clear();
  loadPromise = options.reload ? null : Promise.resolve();
}
