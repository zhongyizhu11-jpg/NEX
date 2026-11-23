import crypto from "node:crypto";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { PANEL_KEYED_LOCK_ROW_PREFIX, SqlPanelLeaseStore, panelBackgroundLeaseStatus, panelHasOtherLiveInstances, type PanelLeaseStore } from "./panelLease";

/*
  跨面板实例的「按 key 串行」锁（评审 F4）。

  withKeyedTaskLock 只管本进程：多实例部署（server/panelLease.ts）时，非持有实例上删 / 改一个转发组，和持有实例上
  正在跑的评估、发布、按时段启停成员互相看不见 —— 删组清解析的同时，持有者那边正在把解析写回去；按时段启停拿旧的
  成员清单整份写回，盖掉别的实例刚保存的改动。

  做法：先拿本进程的锁；有别的活着的实例时，再在 panel_leases 里抢一行 name = "lock:<key>"（和租约同一套原子的
  条件 UPDATE / INSERT，时刻按库的时钟），拿到才跑，跑完删掉。持有这一行时每 30 秒续一次；进程没了，这一行最迟
  2 分钟后过期，别人接着拿。只有一个实例（或 SQLite 单实例部署）时只是本进程的锁，不碰库。
  同一组的两把锁（编辑 forward-group:<id>、评估 forward-group-failover:<id>）总是先编辑后评估，不会交叉等。
*/

const PANEL_KEYED_LOCK_PREFIX = PANEL_KEYED_LOCK_ROW_PREFIX;
export const PANEL_KEYED_LOCK_TTL_MS = 120_000;
const RENEW_INTERVAL_MS = 30_000;
const DEFAULT_WAIT_MS = 90_000;

let store: PanelLeaseStore = new SqlPanelLeaseStore();

/** 测试用：换掉存锁的表。传 null 恢复默认。 */
export function setPanelKeyedLockStoreForTests(next: PanelLeaseStore | null) {
  store = next ?? new SqlPanelLeaseStore();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

async function acquireRow(name: string, token: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  let delay = 50;
  for (;;) {
    if (await store.tryAcquire(name, token, PANEL_KEYED_LOCK_TTL_MS)) return;
    if (Date.now() >= deadline) throw new Error(`另一个面板实例正在处理同一件事（${name.slice(PANEL_KEYED_LOCK_PREFIX.length)}），稍后再试`);
    await sleep(delay);
    delay = Math.min(500, delay * 2);
  }
}

async function withPanelKeyedLock<T>(keyValue: unknown, task: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const key = String(keyValue || "").trim();
  if (!key) return task();
  return withKeyedTaskLock(key, async () => {
    if (!panelHasOtherLiveInstances()) return task();
    const name = `${PANEL_KEYED_LOCK_PREFIX}${key}`;
    const token = `${panelBackgroundLeaseStatus()?.instanceId || "panel"}:${crypto.randomBytes(4).toString("hex")}`;
    await acquireRow(name, token, Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS));
    const renew = setInterval(() => {
      void store.tryAcquire(name, token, PANEL_KEYED_LOCK_TTL_MS).catch(() => false);
    }, RENEW_INTERVAL_MS);
    (renew as { unref?: () => void }).unref?.();
    try {
      return await task();
    } finally {
      clearInterval(renew);
      await store.release(name, token).catch(() => undefined);
    }
  });
}

/** 转发组的编辑锁：保存、删除、跟随节点池、按时段启停成员。 */
export function withForwardGroupEditLock<T>(groupId: unknown, task: () => Promise<T>) {
  return withPanelKeyedLock(`forward-group:${Number(groupId)}`, task);
}

/** 转发组的评估锁：评估 / 发布一个组、删组时清它的解析。 */
export function withForwardGroupEvaluationLock<T>(groupId: unknown, task: () => Promise<T>) {
  return withPanelKeyedLock(`forward-group-failover:${Number(groupId)}`, task);
}
