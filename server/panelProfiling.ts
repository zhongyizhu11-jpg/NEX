/**
 * 面板自己的性能剖析：采一段 CPU 剖析、拍一张堆快照，从「设置 › 面板日志」下载回去看
 * （Chrome DevTools 的 Performance / Memory 面板直接打开）。
 *
 * 默认关着，只有管理员能开，开一次只管一小时（到点自己关）。原因写在这里：
 *
 * - 堆快照是整个面板进程内存的原样拷贝 —— 会话、数据库密码、Agent 令牌、解密后的设置全在里面。
 *   它比面板备份还敏感，所以下载走单独的 Express 路由，只认网页上的管理员会话，API 令牌一律不给
 *   （ops.profiling.* 也在令牌禁止名单里）。
 * - 拍快照会把面板卡住几秒（V8 要停下来遍历整个堆），内存峰值也会再涨一截；CPU 剖析只是采样，
 *   开销小，但也不该一直开着。
 *
 * 文件放在系统临时目录下自己的子目录里（0700 / 0600），最多留 {@link MAX_CAPTURES} 份，
 * 30 分钟后删掉；进程启动后第一次用到时把上次留下的也清掉。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";

import { getSetting, setSetting } from "./repositories/settingsRepository";

const ENABLED_UNTIL_KEY = "panelProfiling.enabledUntil";
export const PANEL_PROFILING_ENABLE_MINUTES = 60;
export const PANEL_PROFILING_CPU_MIN_SECONDS = 5;
export const PANEL_PROFILING_CPU_MAX_SECONDS = 120;
const RETENTION_MS = 30 * 60_000;
const MAX_CAPTURES = 4;
/** CPU 剖析正常是几 MB；超过这个多半是采样间隔被改得太小，不留。 */
const MAX_CPU_PROFILE_BYTES = 64 * 1024 * 1024;
/** 堆已经这么大时不拍：快照文件和内存峰值都会是它的一两倍。 */
const MAX_HEAP_USED_FOR_SNAPSHOT = 1024 * 1024 * 1024;
/** 拍完超过这个就删掉不给下载（浏览器也打不开这么大的）。 */
const MAX_HEAP_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;

export type PanelProfilingKind = "cpu" | "heap";

export type PanelProfilingCapture = {
  id: string;
  kind: PanelProfilingKind;
  status: "running" | "ready" | "failed";
  startedAt: number;
  finishedAt: number | null;
  /** CPU 剖析采了多少秒。 */
  seconds: number | null;
  bytes: number;
  filename: string;
  error: string | null;
};

type CaptureRecord = PanelProfilingCapture & { file: string };

const captures = new Map<string, CaptureRecord>();
let busy: PanelProfilingKind | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
let directoryReady = false;

const DIRECTORY_PREFIX = `forwardx-panel-profiling-${process.getuid?.() ?? "user"}-`;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 每个进程一个目录（同一台机器上可能跑着两个面板）。第一次用到时建好，顺手把已经退出的进程
 * 留下的目录清掉 —— 那些文件已经没有记录，也没人能下载了。
 */
function ensureDirectory(): string {
  const dir = path.join(os.tmpdir(), `${DIRECTORY_PREFIX}${process.pid}`);
  if (!directoryReady) {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith(DIRECTORY_PREFIX)) continue;
      const pid = Number(name.slice(DIRECTORY_PREFIX.length));
      if (pid === process.pid || (Number.isInteger(pid) && pid > 0 && processAlive(pid))) continue;
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    directoryReady = true;
  }
  return dir;
}

function removeCapture(record: CaptureRecord) {
  captures.delete(record.id);
  fs.rmSync(record.file, { force: true });
}

/** 过期的、超出份数的删掉（最老的先走；正在采的不动）。 */
export function prunePanelProfilingCaptures(now = Date.now()) {
  for (const record of captures.values()) {
    if (record.status !== "running" && now - (record.finishedAt ?? record.startedAt) > RETENTION_MS) removeCapture(record);
  }
  const finished = [...captures.values()].filter((record) => record.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  while (finished.length > 0 && captures.size > MAX_CAPTURES) removeCapture(finished.shift()!);
  if (captures.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => prunePanelProfilingCaptures(), 60_000);
  cleanupTimer.unref();
}

export async function getPanelProfilingEnabledUntil(now = Date.now()): Promise<number> {
  const until = Number(await getSetting(ENABLED_UNTIL_KEY).catch(() => null)) || 0;
  return until > now ? until : 0;
}

/** 开（一小时后自己关）或马上关。关的时候把已经采好的文件一并删掉。 */
export async function setPanelProfilingEnabled(enabled: boolean, now = Date.now()): Promise<number> {
  const until = enabled ? now + PANEL_PROFILING_ENABLE_MINUTES * 60_000 : 0;
  await setSetting(ENABLED_UNTIL_KEY, String(until));
  if (!enabled) for (const record of [...captures.values()]) if (record.status !== "running") removeCapture(record);
  return until;
}

async function assertEnabled() {
  if (!(await getPanelProfilingEnabledUntil())) throw new PanelProfilingError("性能剖析没有开启：先在设置里打开（一小时后自动关闭）");
}

export class PanelProfilingError extends Error {}

function newCapture(kind: PanelProfilingKind, seconds: number | null): CaptureRecord {
  const dir = ensureDirectory();
  const id = randomBytes(12).toString("hex");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const filename = kind === "cpu" ? `nex-panel-${stamp}.cpuprofile` : `nex-panel-${stamp}.heapsnapshot`;
  const record: CaptureRecord = { id, kind, status: "running", startedAt: Date.now(), finishedAt: null, seconds, bytes: 0, filename, error: null, file: path.join(dir, `${id}.${kind}`) };
  captures.set(id, record);
  scheduleCleanup();
  return record;
}

function finish(record: CaptureRecord, error: string | null) {
  record.finishedAt = Date.now();
  if (error) {
    record.status = "failed";
    record.error = error;
    fs.rmSync(record.file, { force: true });
    record.bytes = 0;
  } else {
    record.status = "ready";
    record.bytes = fs.statSync(record.file).size;
  }
  prunePanelProfilingCaptures();
}

function post<T = unknown>(session: Session, method: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result as T)));
  });
}

/**
 * 采 seconds 秒 CPU 剖析。立刻返回记录，后台采完写文件（界面轮询 status 看什么时候能下载）。
 * 同一时间只采一份。
 */
export async function startPanelCpuProfile(seconds: number): Promise<PanelProfilingCapture> {
  await assertEnabled();
  if (busy) throw new PanelProfilingError(busy === "cpu" ? "已经在采一份 CPU 剖析" : "正在拍堆快照，等它完了再采");
  // 界面上最短 5 秒（PANEL_PROFILING_CPU_MIN_SECONDS，在路由的入参里卡）；这里只兜底到 1 秒，测试用得着。
  const duration = Math.min(PANEL_PROFILING_CPU_MAX_SECONDS, Math.max(1, Math.round(Number(seconds) || 30)));
  busy = "cpu";
  const record = newCapture("cpu", duration);
  const session = new Session();
  session.connect();
  const run = async () => {
    try {
      await post(session, "Profiler.enable");
      // 1 ms 采一次：DevTools 的默认值。再密文件会大很多，看起来也没多大差别。
      await post(session, "Profiler.setSamplingInterval", { interval: 1000 });
      await post(session, "Profiler.start");
      await new Promise((resolve) => setTimeout(resolve, duration * 1000));
      const { profile } = await post<{ profile: unknown }>(session, "Profiler.stop");
      const text = JSON.stringify(profile);
      if (Buffer.byteLength(text) > MAX_CPU_PROFILE_BYTES) throw new PanelProfilingError("剖析文件太大，没有保存");
      fs.writeFileSync(record.file, text, { mode: 0o600 });
      finish(record, null);
    } catch (error) {
      finish(record, error instanceof Error ? error.message : String(error));
    } finally {
      session.disconnect();
      busy = null;
    }
  };
  void run();
  return publicCapture(record);
}

/**
 * 拍一张堆快照（会卡住面板几秒）。堆太大、临时目录空间不够时不拍。
 */
export async function takePanelHeapSnapshot(): Promise<PanelProfilingCapture> {
  await assertEnabled();
  if (busy) throw new PanelProfilingError(busy === "heap" ? "已经在拍一张堆快照" : "正在采 CPU 剖析，等它完了再拍");
  const { heapUsed } = process.memoryUsage();
  if (heapUsed > MAX_HEAP_USED_FOR_SNAPSHOT) {
    throw new PanelProfilingError(`现在堆已经用了 ${Math.round(heapUsed / 1048576)} MB，拍快照可能把面板撑爆，不拍`);
  }
  const dir = ensureDirectory();
  const free = await fs.promises.statfs(dir).then((stat) => stat.bavail * stat.bsize).catch(() => Number.POSITIVE_INFINITY);
  if (free < heapUsed * 3) throw new PanelProfilingError("临时目录剩余空间不够放一张堆快照");
  busy = "heap";
  const record = newCapture("heap", null);
  // 让这次请求先回去（界面上先看到「正在拍」），下一轮事件循环再拍：拍的时候整个进程是停住的。
  setImmediate(() => {
    try {
      v8.writeHeapSnapshot(record.file);
      fs.chmodSync(record.file, 0o600);
      if (fs.statSync(record.file).size > MAX_HEAP_SNAPSHOT_BYTES) throw new PanelProfilingError("堆快照太大，没有保存");
      finish(record, null);
    } catch (error) {
      finish(record, error instanceof Error ? error.message : String(error));
    } finally {
      busy = null;
    }
  });
  return publicCapture(record);
}

function publicCapture(record: CaptureRecord): PanelProfilingCapture {
  const { file: _file, ...rest } = record;
  return { ...rest };
}

export async function getPanelProfilingStatus() {
  prunePanelProfilingCaptures();
  return {
    enabledUntil: await getPanelProfilingEnabledUntil(),
    busy,
    heapUsedBytes: process.memoryUsage().heapUsed,
    captures: [...captures.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicCapture),
    limits: {
      cpuMinSeconds: PANEL_PROFILING_CPU_MIN_SECONDS,
      cpuMaxSeconds: PANEL_PROFILING_CPU_MAX_SECONDS,
      maxCaptures: MAX_CAPTURES,
      retentionMinutes: RETENTION_MS / 60_000,
      maxHeapUsedForSnapshotBytes: MAX_HEAP_USED_FOR_SNAPSHOT,
    },
  };
}

export function deletePanelProfilingCapture(id: string): boolean {
  const record = captures.get(id);
  if (!record || record.status === "running") return false;
  removeCapture(record);
  return true;
}

/** 下载用：能下的那份的文件路径和文件名。 */
export function panelProfilingDownload(id: string): { file: string; filename: string; bytes: number; kind: PanelProfilingKind } | null {
  const record = captures.get(id);
  if (!record || record.status !== "ready" || !fs.existsSync(record.file)) return null;
  return { file: record.file, filename: record.filename, bytes: record.bytes, kind: record.kind };
}

export function resetPanelProfilingForTests() {
  for (const record of [...captures.values()]) fs.rmSync(record.file, { force: true });
  captures.clear();
  busy = null;
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  directoryReady = false;
}
