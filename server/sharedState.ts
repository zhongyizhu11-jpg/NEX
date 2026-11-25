import crypto from "node:crypto";
import { getDatabaseKind } from "./dbRuntime";
import { isPanelBackgroundLeaseHolder, panelHasOtherLiveInstances } from "./panelLease";

/*
  多实例共享的「短命状态」用内存还是用库（评审 D2）。

  登录失败锁定、验证码挑战、接口限流原来都是本进程的 Map：几个面板实例连同一个库、前面放负载均衡时，
  攻击者的请求轮着落到各实例上，每个实例各数各的 —— 8 次锁定变成 8 × 实例数；在 A 实例要的验证码
  在 B 实例对不上。这里只决定「现在该用哪一套」，各模块（apiRateLimit.ts、authRateLimit.ts、
  authCaptcha.ts）按它选：

    memory  本进程的 Map，和以前一样。SQLite 部署（单文件、单写连接）只能单实例，永远是这个；
    db      库里的行（sharedStateStore.ts），各实例共享，原子的 upsert 计数，时刻按库的时钟。

  FORWARDX_SHARED_STATE=auto（默认）时：库是 MySQL / PostgreSQL 并且 panel_leases 里登记着别的活着的实例
  （panelLease.ts 的 instance:<id> 行）才用 db —— 单实例的 MySQL / PostgreSQL 部署不多花一次库往返。
  第二个实例起来后最多一个续约间隔（10 秒）两边都切到 db；它停了再切回 memory。切换那一刻两套之间的计数
  不互通（最多让攻击者多试一轮），不值得为它做同步。
  =memory 强制用内存（明知多实例也不共享，比如前面有按 IP 粘性的负载均衡）；=db 强制用库（测试、
  或者想在单实例上提前验证）。

  db 模式下各模块的调用接口还是同步的（限流判断在每个 tRPC 过程前，登录流程里也是同步判断）：
  判断看本进程的缓存，写入同步记在缓存里、同时异步写库，写库的结果（全体实例的总数）回来就覆盖缓存；
  读的时候顺手异步刷新一次缓存。所以每个实例对同一个键最多「多放一次」—— 另一个实例刚计满的那一刻，
  本实例还没收到。锁定阈值 8 次、限流每分钟上千次，多一次无妨；换来的是热路径不等库。

  库里的行由持有后台任务租约的实例每 5 分钟清一次（registerSharedStateCleanup）。
*/

export type SharedStateSetting = "auto" | "memory" | "db";
export type SharedStateMode = "memory" | "db";

let settingCache: SharedStateSetting | null = null;
let modeOverride: SharedStateMode | null = null;

/** 环境变量里选的（只读一次：和别的启动前配置一样，改了要重启）。 */
export function sharedStateSetting(): SharedStateSetting {
  if (!settingCache) {
    const raw = String(process.env.FORWARDX_SHARED_STATE || "auto").trim().toLowerCase();
    settingCache = raw === "memory" || raw === "db" ? raw : "auto";
  }
  return settingCache;
}

/** 现在该用哪一套。每次调用都算（别的实例随时会起来 / 停掉），只是几次函数调用。 */
export function sharedStateMode(): SharedStateMode {
  if (modeOverride) return modeOverride;
  const setting = sharedStateSetting();
  if (setting !== "auto") return setting;
  const kind = getDatabaseKind();
  return (kind === "mysql" || kind === "postgresql") && panelHasOtherLiveInstances() ? "db" : "memory";
}

/** 测试用：强制一种模式；传 null 恢复按环境变量 / 实例数判断（并重新读环境变量）。 */
export function setSharedStateModeForTests(mode: SharedStateMode | null) {
  modeOverride = mode;
  settingCache = null;
}

/** 库里 key 列最长 191：太长的（邮箱账号拼 IP）换成摘要，不让 MySQL 严格模式报错。 */
export function sharedStateKey(key: string) {
  const value = String(key);
  return value.length <= 191 ? value : `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

/*
  写库失败（库连不上、表还没建）不能影响登录 / 接口：调用方捕获后记一次，各模块回退到本进程的计数。
  同一处一分钟只记一行日志，免得库挂了的那几分钟每个请求刷一行。
*/
const ERROR_LOG_INTERVAL_MS = 60_000;
const lastErrorLogAt = new Map<string, number>();

export function noteSharedStateError(where: string, error: unknown, now = Date.now()) {
  const last = lastErrorLogAt.get(where) || 0;
  if (now - last < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt.set(where, now);
  console.warn(`[SharedState] ${where} 写库失败，这个实例先按本进程的计数：${error instanceof Error ? error.message : String(error)}`);
}

/*
  过期行的清理：各模块把自己那张表的清理登记进来，由持有后台任务租约的实例每 5 分钟跑一遍
  （和别的「大批量 DELETE 跑两遍白占库」的任务一样只由持有者跑，见 panelLease.ts 的表）。
  只要库是 MySQL / PostgreSQL（或者强制 db）就清：即使现在只剩一个实例，前阵子多实例时写的行也该删掉。
*/
type CleanupTask = () => Promise<number>;
const cleanupTasks = new Map<string, CleanupTask>();
const CLEANUP_INTERVAL_MS = 5 * 60_000;

export function registerSharedStateCleanup(name: string, task: CleanupTask) {
  cleanupTasks.set(name, task);
}

function sharedStateRowsPossible() {
  const setting = sharedStateSetting();
  if (setting === "memory") return false;
  const kind = getDatabaseKind();
  return setting === "db" || kind === "mysql" || kind === "postgresql";
}

/** 跑一遍登记的清理，返回每张表删了几行。force = 测试用，不看租约。 */
export async function runSharedStateCleanup(options: { force?: boolean } = {}) {
  const deleted: Record<string, number> = {};
  if (!options.force && !(sharedStateRowsPossible() && isPanelBackgroundLeaseHolder())) return deleted;
  for (const [name, task] of cleanupTasks) {
    try {
      deleted[name] = await task();
    } catch (error) {
      noteSharedStateError(`cleanup ${name}`, error);
    }
  }
  return deleted;
}

const cleanupTimer = setInterval(() => { void runSharedStateCleanup(); }, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();
