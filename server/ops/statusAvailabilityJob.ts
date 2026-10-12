/*
  公开状态页可用率（#1）的数据来源：每分钟看一眼每台主机在不在线，攒成每日表和断线事件。

  为什么不直接用现成的数据：
    - host_metrics 只留 72 小时，而且新 Agent 连着事件流时 5 分钟才一条完整心跳 ——
      拿它的空档算 30 天可用率既没有 30 天，也看不见 5 分钟以内的断线。
    - panel_events 的 host.offline / host.online 由别的功能在写，旧数据里没有；只靠它，
      功能刚上线时页面上全是「没有数据」。
    - 主机的在线状态（hosts.isOnline + 心跳新鲜度 + Agent 快速失联）是实时的、最准的，
      缺的只是历史 —— 所以每分钟采一次，自己攒历史。

  刚上线时没有历史：第一次运行时用 host_metrics 里还在的 72 小时心跳空档回填一次，
  页面立刻就有近 3 天的数，之后由实时采样接手。

  面板自己停机那段不算任何主机的在线或断线（observedSeconds 不增加），否则面板升级重启一次，
  所有主机都会白挨一次断线。
*/
import * as db from "../db";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier } from "../dbRuntime";
import { getSetting, setSetting } from "../repositories/settingsRepository";
import { createNonOverlappingScheduledTask } from "../scheduledTask";
import {
  advanceAvailabilityTick,
  coverageFromSamples,
  gapDownIntervals,
  intersectIntervals,
  mergeIntervals,
  shanghaiDayKey,
  splitByShanghaiDay,
  type Interval,
} from "./statusAvailabilityLogic";

const q = quoteDbIdentifier;
const DAYS_TABLE = "host_availability_days";
const INCIDENTS_TABLE = "host_availability_incidents";
const BACKFILL_SETTING = "ops.status.backfilledAt";
const TICK_MS = 60_000;
const FLUSH_INTERVAL_SECONDS = 5 * 60;
const RETAIN_DAYS = 40;

type HostTickState = { online: boolean; at: number };
type PendingDelta = { hostId: number; day: string; down: number; observed: number; samples: number };

const lastTick = new Map<number, HostTickState>();
/** hostId → 还没恢复的断线事件 { id, startedAt } */
const openIncidents = new Map<number, { id: number; startedAt: number }>();
const pending = new Map<string, PendingDelta>();
let initialized = false;
let lastFlushAt = 0;
let lastPruneAt = 0;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function epochSeconds(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Number(value) > 10_000_000_000 ? Number(value) : Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

/** 从来没连上过的主机（装好了还没跑 Agent）不算「断线」，不进统计。 */
function hasEverConnected(host: any) {
  return epochSeconds(host?.lastHeartbeat) !== null;
}

function addPending(hostId: number, from: number, to: number, down: boolean) {
  const parts = splitByShanghaiDay(from, to);
  parts.forEach((part, index) => {
    const key = `${hostId}|${part.day}`;
    const entry = pending.get(key) || { hostId, day: part.day, down: 0, observed: 0, samples: 0 };
    entry.observed += part.seconds;
    if (down) entry.down += part.seconds;
    // 一次采样只记在它落的那一天
    if (index === parts.length - 1) entry.samples += 1;
    pending.set(key, entry);
  });
}

/** 还没写进库的增量。读接口把它叠上去，页面上的数不必等 5 分钟一次的落库。 */
export function pendingAvailabilityDeltas(): PendingDelta[] {
  return Array.from(pending.values()).map((entry) => ({ ...entry }));
}

async function upsertDay(hostId: number, day: string, delta: { down: number; observed: number; samples: number }) {
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("downSeconds")}, ${q("observedSeconds")}, ${q("samples")} FROM ${q(DAYS_TABLE)} WHERE ${q("hostId")} = ? AND ${q("day")} = ? LIMIT 1`,
    [hostId, day],
  );
  const now = nowSeconds();
  if (rows[0]) {
    await executeRaw(
      `UPDATE ${q(DAYS_TABLE)} SET ${q("downSeconds")} = ?, ${q("observedSeconds")} = ?, ${q("samples")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`,
      [
        Math.round(Number(rows[0].downSeconds || 0) + delta.down),
        Math.round(Number(rows[0].observedSeconds || 0) + delta.observed),
        Math.round(Number(rows[0].samples || 0) + delta.samples),
        now,
        Number(rows[0].id),
      ],
    );
  } else {
    await insertAndGetId(DAYS_TABLE, {
      hostId,
      day,
      downSeconds: Math.round(delta.down),
      observedSeconds: Math.round(delta.observed),
      samples: Math.round(delta.samples),
      updatedAt: now,
    });
  }
}

async function flushPending() {
  for (const [key, entry] of Array.from(pending.entries())) {
    // 先摘掉再写：写的时候新来的增量进新的一份，失败了再并回去。
    pending.delete(key);
    try {
      await upsertDay(entry.hostId, entry.day, entry);
    } catch (error) {
      const back = pending.get(key) || { ...entry, down: 0, observed: 0, samples: 0 };
      back.down += entry.down;
      back.observed += entry.observed;
      back.samples += entry.samples;
      pending.set(key, back);
      throw error;
    }
  }
  lastFlushAt = nowSeconds();
}

async function openIncident(hostId: number, startedAt: number) {
  const id = await insertAndGetId(INCIDENTS_TABLE, { hostId, startedAt, endedAt: null, durationSeconds: 0 });
  openIncidents.set(hostId, { id, startedAt });
}

async function closeIncident(hostId: number, endedAt: number) {
  const open = openIncidents.get(hostId);
  if (!open) return;
  openIncidents.delete(hostId);
  const end = Math.max(open.startedAt, endedAt);
  await executeRaw(
    `UPDATE ${q(INCIDENTS_TABLE)} SET ${q("endedAt")} = ?, ${q("durationSeconds")} = ? WHERE ${q("id")} = ?`,
    [end, end - open.startedAt, open.id],
  );
}

async function loadOpenIncidents() {
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("hostId")}, ${q("startedAt")} FROM ${q(INCIDENTS_TABLE)} WHERE ${q("endedAt")} IS NULL ORDER BY ${q("startedAt")} ASC`,
  );
  for (const row of rows) {
    const startedAt = epochSeconds(row.startedAt) ?? nowSeconds();
    // 同一台有多条没收尾的（异常情况），留最新的那条
    openIncidents.set(Number(row.hostId), { id: Number(row.id), startedAt });
  }
}

/**
 * 第一次运行时，用 host_metrics 里还在的心跳空档回填前 72 小时。
 * 只做一次（设置里记一个时间戳）；之后全靠实时采样。
 */
async function backfillFromHostMetrics(hosts: any[], now: number) {
  const windowFrom = now - 72 * 3600 + 600;
  const samplesByHost = new Map<number, number[]>();
  for (const host of hosts) {
    const hostId = Number(host.id);
    const rows = await queryRaw<any>(
      `SELECT ${q("recordedAt")} FROM ${q("host_metrics")} WHERE ${q("hostId")} = ? AND ${q("recordedAt")} >= ? ORDER BY ${q("recordedAt")} ASC`,
      [hostId, windowFrom],
    );
    const samples = rows.map((row) => epochSeconds(row.recordedAt)).filter((value): value is number => value !== null);
    if (samples.length > 0) samplesByHost.set(hostId, samples);
  }
  const coverageByHost = new Map<number, Interval[]>();
  for (const [hostId, samples] of samplesByHost) coverageByHost.set(hostId, coverageFromSamples(samples));
  const allCoverage = mergeIntervals(Array.from(coverageByHost.values()).flat());

  for (const host of hosts) {
    const hostId = Number(host.id);
    const samples = samplesByHost.get(hostId);
    if (!samples) continue;
    const online = !!host.isOnline;
    let down = gapDownIntervals(samples, { until: now, currentlyOnline: online });
    // 有别的主机可作参照时，扣掉「大家一起没心跳」那段 —— 那是面板自己停了。
    const others = mergeIntervals(Array.from(coverageByHost.entries()).filter(([id]) => id !== hostId).flatMap(([, value]) => value));
    if (others.length > 0) down = intersectIntervals(down, others);
    const observed = mergeIntervals([...intersectIntervals([[samples[0], now]], allCoverage), ...down]);

    const perDay = new Map<string, { down: number; observed: number; samples: number }>();
    const bump = (day: string, field: "down" | "observed" | "samples", value: number) => {
      const entry = perDay.get(day) || { down: 0, observed: 0, samples: 0 };
      entry[field] += value;
      perDay.set(day, entry);
    };
    for (const [a, b] of observed) for (const part of splitByShanghaiDay(a, b)) bump(part.day, "observed", part.seconds);
    for (const [a, b] of down) for (const part of splitByShanghaiDay(a, b)) bump(part.day, "down", part.seconds);
    for (const t of samples) bump(shanghaiDayKey(t), "samples", 1);
    for (const [day, entry] of perDay) {
      const existing = await queryRaw<any>(
        `SELECT ${q("id")} FROM ${q(DAYS_TABLE)} WHERE ${q("hostId")} = ? AND ${q("day")} = ? LIMIT 1`,
        [hostId, day],
      );
      if (existing.length === 0) await upsertDay(hostId, day, entry);
    }

    for (const [a, b] of down) {
      const ongoing = !online && b >= now;
      if (ongoing) {
        if (!openIncidents.has(hostId)) await openIncident(hostId, a);
      } else {
        await insertAndGetId(INCIDENTS_TABLE, { hostId, startedAt: a, endedAt: b, durationSeconds: b - a });
      }
    }
  }
}

/** 返回 true 表示这一轮做了回填（回填已经算到了现在，这一轮不再重复记）。 */
async function initialize(hosts: any[], now: number): Promise<boolean> {
  await loadOpenIncidents();
  let backfilled = false;
  if (!(await getSetting(BACKFILL_SETTING))) {
    try {
      await backfillFromHostMetrics(hosts, now);
    } catch (error) {
      console.warn(`[StatusAvailability] backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 失败了也不再试：回填只是锦上添花，反复跑一个会失败的大查询不值得。
    await setSetting(BACKFILL_SETTING, String(now));
    // 回填已经算到了现在，实时采样从这一刻接着算。
    for (const host of hosts) lastTick.set(Number(host.id), { online: !!host.isOnline, at: now });
    backfilled = true;
  }
  initialized = true;
  return backfilled;
}

async function pruneOld(now: number) {
  if (now - lastPruneAt < 3600) return;
  lastPruneAt = now;
  const cutoffDay = shanghaiDayKey(now - RETAIN_DAYS * 86400);
  await executeRaw(`DELETE FROM ${q(DAYS_TABLE)} WHERE ${q("day")} < ?`, [cutoffDay]);
  await executeRaw(
    `DELETE FROM ${q(INCIDENTS_TABLE)} WHERE ${q("endedAt")} IS NOT NULL AND ${q("endedAt")} < ?`,
    [now - RETAIN_DAYS * 86400],
  );
}

/** 一次采样。导出给测试 / 手动触发用。 */
export async function runStatusAvailabilityTick() {
  const now = nowSeconds();
  const hosts = ((await db.getHosts()) as any[]).filter(hasEverConnected);
  if (!initialized && (await initialize(hosts, now))) return;
  let transitioned = false;
  const seen = new Set<number>();
  for (const host of hosts) {
    const hostId = Number(host.id);
    if (!Number.isInteger(hostId) || hostId <= 0) continue;
    seen.add(hostId);
    const online = !!host.isOnline;
    const prev = lastTick.get(hostId) ?? null;
    const step = advanceAvailabilityTick(prev, { online, at: now });
    addPending(hostId, step.from, step.to, step.down);
    if (step.transition === "down") {
      if (!openIncidents.has(hostId)) await openIncident(hostId, step.from);
      transitioned = true;
    } else if (step.transition === "up") {
      await closeIncident(hostId, step.from);
      transitioned = true;
    } else if (!prev) {
      // 面板刚启动：断着的接上已有的事件或新开一条（从最后一次心跳算），在线的把遗留事件收尾。
      if (!online && !openIncidents.has(hostId)) {
        const lastBeat = epochSeconds(host.lastHeartbeat) ?? now;
        await openIncident(hostId, Math.min(now, lastBeat));
        transitioned = true;
      } else if (online && openIncidents.has(hostId)) {
        await closeIncident(hostId, step.from);
        transitioned = true;
      }
    }
    lastTick.set(hostId, { online, at: now });
  }
  // 删掉的主机：状态清掉，没收尾的事件收个尾。
  for (const hostId of Array.from(lastTick.keys())) {
    if (seen.has(hostId)) continue;
    lastTick.delete(hostId);
    if (openIncidents.has(hostId)) await closeIncident(hostId, now);
  }
  if (transitioned || now - lastFlushAt >= FLUSH_INTERVAL_SECONDS) await flushPending();
  await pruneOld(now);
}

let started = false;

/** 由 server/scheduler.ts 的 startScheduler() 调一次。 */
export function startStatusAvailabilityJob() {
  if (started) return;
  started = true;
  const task = createNonOverlappingScheduledTask("status availability sampling", runStatusAvailabilityTick, { slowTaskMs: 20_000 });
  // 启动后先等 3 分钟：面板刚起来时 Agent 还没重连，心跳都是旧的，这时采样会把所有主机记成断线。
  const startTimer = setTimeout(() => {
    void task();
    const timer = setInterval(() => { void task(); }, TICK_MS);
    timer.unref?.();
  }, 3 * 60_000);
  startTimer.unref?.();
}
