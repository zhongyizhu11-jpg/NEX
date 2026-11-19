import crypto from "node:crypto";
import { executeRaw, getDatabaseKind, queryRaw, rawAffectedRows } from "./dbRuntime";
import { quoteIdentifier } from "./dbCompat";

/*
  面板后台任务租约：几个面板进程连同一个库（MySQL / PostgreSQL）时，只有拿着租约的那一个跑「写共享状态」的
  后台任务；别的实例照常接网页 / API 请求和 Agent 连接，只是不跑下面标「持有者」的那些。

  租约是 panel_leases 里的一行（name = "background"）：holder = 实例启动时随机生成的 id，expiresAt = 到期时刻（毫秒）。
  抢 / 续是一条带条件的 UPDATE（自己拿着，或者已经过期），没有这一行时再 INSERT（name 上的唯一索引冲突就算没抢到），
  三种库上都是原子的，过期判断和写进去的到期时刻都按库的时钟（不受各实例时钟差影响）。TTL 30 秒、大约每 10 秒
  续一次（慢的续约之后按有效期提前续）；持有者自己只信到「这次续约开始 + TTL − 5 秒」，
  续不上（库连不上）就先自己停手，不等别人来抢。持有者停了（进程退出 / 卡死 / 连不上库），
  另一个实例最迟在「TTL + 一个续约间隔」（40 秒）内接手；正常退出时主动放掉，下一轮续约就接上。

  实例登记：每个实例同样续一行 name = "instance:<id>"。有别的活着的实例时：
    · Agent 只连其中一个实例，在线判断要把「别的实例看到过它」算进来（agentPresenceElsewhere.ts 读
      hosts.lastHeartbeat，各实例约每 90 秒写一次）；
    · 非持有者要做的转发组评估交给持有者（panelWorkRequests.ts）。
  只有一个实例时这两样都不启用，行为和以前一样。

  SQLite：租约照样工作（同一台机器上两个进程抢同一个文件），但 SQLite 部署不支持多实例 —— 单个文件、
  单写连接，第二个进程只会和第一个抢锁。多实例请用 MySQL / PostgreSQL。

  各后台任务归谁跑（server/scheduler.ts 里的定时任务和别处的常驻循环）：

  | 任务                                          | 谁跑      | 为什么 |
  |-----------------------------------------------|-----------|--------|
  | 转发组 / DDNS 巡检（forward-group and DDNS）  | 持有者    | 判断依赖内存里的存活状态，两边各写一份就是两个评估器抢解析 |
  | 转发组评估队列 / 发布队列（forwardGroups/publish.ts） | 持有者 | 同上；非持有者的评估请求经 panel_work_requests 交给持有者 |
  | 主机 DDNS 补漏（reconcileHostDdnsRecords）     | 持有者    | 写服务商；Agent 报新地址时的单台更新仍由收到上报的实例做（值只取决于库里的地址） |
  | 规则专属域名补漏                               | 持有者    | 写服务商、删待删记录 |
  | 落地池健康 + 直连域名                          | 持有者    | 按存活状态写 DNS；非持有者保存池时不写 DNS，由持有者一分钟内补上 |
  | 主机掉线巡检（host status sweep）+ 启动时的离线标记 | 持有者 | 写 hosts.isOnline、清运行状态、发掉线通知 |
  | 快速离线判定落库（hostStatusNotifier）         | 持有者    | 非持有者只改自己内存里的状态，不写库、不发通知 |
  | 线路按时间段启用（member schedule）            | 持有者    | 改成员状态 |
  | 每月流量重置 / 账户与套餐到期 / 主机账期顺延   | 持有者    | 扣费、清零类写入，跑两遍会重复 |
  | 规则额度与到期 / 自动停用规则恢复 / 临时桥接到期 | 持有者  | 改规则、推 Agent |
  | 自动换 IP                                      | 持有者    | 调云厂商接口 |
  | 支付订单对账 / 过期                            | 持有者    | 查单、关单 |
  | 邮件 / Telegram / Discord 提醒、每日简报        | 持有者    | 去重标记是先读后写，两边同时跑会发两遍 |
  | 历史清理 / 延迟按天汇总 / 用户流量日历史        | 持有者    | 大批量 DELETE / 带水位的汇总，跑两遍白占库 |
  | 外部订阅拉取 / 主机定位补漏                    | 持有者    | 外部请求有限流 |
  | 事件时间线维护 / 状态页可用率采样 / 异地备份 / 解锁检测排期 / 流量异常检测 | 持有者 | 写共享状态或往外发东西 |
  | Telegram 机器人轮询（getUpdates）              | 持有者    | 同一个 Token 两边一起轮询，Telegram 回 409 |
  | 自测超时清扫                                   | 每个实例  | 逐行条件更新，只有改成功的实例做后续；「有没有在跑的自测」是本进程记的 |
  | 面板更新检查                                   | 每个实例  | 结果缓存在本进程 |
  | 数据库连接池大小 / SQLite optimize             | 每个实例  | 只管本进程的连接 |
  | 主机快速存活状态预热                           | 每个实例  | 本进程内存 |
  | 链路整形默认关（一次性迁移）                   | 每个实例  | 带完成标记，重复跑无害 |
*/

export const PANEL_LEASE_TTL_MS = 30_000;
export const PANEL_LEASE_RENEW_INTERVAL_MS = 10_000;
/** 持有者只信到「续约开始 + TTL − 这么多」：留出时钟误差和慢请求的余量，别人接手前自己先停。 */
export const PANEL_LEASE_FENCE_MS = 5_000;
export const PANEL_BACKGROUND_LEASE = "background";
export const PANEL_INSTANCE_LEASE_PREFIX = "instance:";
/** 实例登记过期多久后由持有者删掉（留着几分钟方便排查）。 */
const INSTANCE_ROW_RETENTION_MS = 10 * 60_000;

export type PanelLeaseRecord = {
  name: string;
  holder: string;
  /** 到期时刻（毫秒，数据库的时钟）。 */
  expiresAt: number;
  updatedAt: number;
};

/*
  租约的时刻一律用数据库的时钟（评审 F6）：抢 / 续的条件「已经过期」以前拿调用方自己的时钟算，两个实例的
  时钟差几十秒时，快的那个会在持有者还在有效期里就把租约抢走（两边同时跑后台任务）。现在过期判断、写进去的
  到期时刻都在同一条 SQL 里按库的时钟算，各实例的时钟差多少都没关系。
  实例自己「信到什么时候」仍按本机时钟、从这次续约开始算（validUntil）：只要求本机时钟走得不比库快，不要求对得上。
*/
export type PanelLeaseStore = {
  /** 自己拿着或者已过期（按库的时钟）就拿下 / 续上，返回拿没拿到。必须是原子的。 */
  tryAcquire(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** 库现在的时刻（毫秒）：拿来判断别的行过没过期。 */
  now(): Promise<number>;
  read(name: string): Promise<PanelLeaseRecord | null>;
  list(prefix: string): Promise<PanelLeaseRecord[]>;
  release(name: string, holder: string): Promise<void>;
  /** 删掉 prefix 下按库的时钟已经过期超过 olderThanMs 的行。 */
  prune(prefix: string, olderThanMs: number): Promise<number>;
};

function leaseRow(row: Record<string, unknown> | undefined): PanelLeaseRecord {
  return {
    name: String(row?.name ?? ""),
    holder: String(row?.holder ?? ""),
    expiresAt: Number(row?.expiresAt ?? 0) || 0,
    updatedAt: Number(row?.updatedAt ?? 0) || 0,
  };
}

/**
 * 数据库现在的时刻（毫秒，整数）的 SQL 表达式：
 *   SQLite      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
 *   MySQL       CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)
 *   PostgreSQL  CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)（clock_timestamp 不是事务开始的时刻）
 */
export function databaseNowMsSql(kind = getDatabaseKind()) {
  if (kind === "mysql") return "CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)";
  if (kind === "postgresql") return "CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)";
  return "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
}

export type SqlPanelLeaseStoreOptions = {
  /** 测试用：在库的时钟上加一个偏移（毫秒），模拟时间过去。生产里不传。 */
  clockOffsetMs?: () => number;
};

/** 存在面板主库的 panel_leases 表里（三种库通用的 SQL，时刻用库的时钟）。 */
export class SqlPanelLeaseStore implements PanelLeaseStore {
  constructor(private readonly options: SqlPanelLeaseStoreOptions = {}) {}

  private table() {
    return quoteIdentifier("panel_leases");
  }

  /** 库的时钟（加上测试偏移）；偏移作为参数传，SQL 不随它变。 */
  private clock(): [string, number] {
    return [`(${databaseNowMsSql()} + ?)`, Math.round(Number(this.options.clockOffsetMs?.() ?? 0)) || 0];
  }

  async now() {
    const [clock, offset] = this.clock();
    const rows = await queryRaw<{ now: unknown }>(`SELECT ${clock} AS ${quoteIdentifier("now")}`, [offset]);
    return Number(rows[0]?.now ?? 0) || 0;
  }

  async tryAcquire(name: string, holder: string, ttlMs: number) {
    const q = quoteIdentifier;
    const [clock, offset] = this.clock();
    const ttl = Math.max(1, Math.round(ttlMs));
    const updated = await executeRaw(
      `UPDATE ${this.table()} SET ${q("holder")} = ?, ${q("expiresAt")} = ${clock} + ?, ${q("updatedAt")} = ${clock}
        WHERE ${q("name")} = ? AND (${q("holder")} = ? OR ${q("expiresAt")} <= ${clock})`,
      [holder, offset, ttl, offset, name, holder, offset],
    );
    if (rawAffectedRows(updated) > 0) return true;
    const kind = getDatabaseKind();
    const columns = `(${q("name")}, ${q("holder")}, ${q("expiresAt")}, ${q("updatedAt")})`;
    const values = `VALUES (?, ?, ${clock} + ?, ${clock})`;
    const insertSql = kind === "mysql"
      ? `INSERT IGNORE INTO ${this.table()} ${columns} ${values}`
      : `INSERT INTO ${this.table()} ${columns} ${values} ON CONFLICT (${q("name")}) DO NOTHING`;
    const inserted = await executeRaw(insertSql, [name, holder, offset, ttl, offset]);
    return rawAffectedRows(inserted) > 0;
  }

  async read(name: string) {
    const q = quoteIdentifier;
    const rows = await queryRaw(
      `SELECT ${q("name")}, ${q("holder")}, ${q("expiresAt")}, ${q("updatedAt")} FROM ${this.table()} WHERE ${q("name")} = ?`,
      [name],
    );
    return rows[0] ? leaseRow(rows[0]) : null;
  }

  async list(prefix: string) {
    const q = quoteIdentifier;
    const rows = await queryRaw(
      `SELECT ${q("name")}, ${q("holder")}, ${q("expiresAt")}, ${q("updatedAt")} FROM ${this.table()} WHERE ${q("name")} LIKE ?`,
      [`${prefix}%`],
    );
    return rows.map(leaseRow);
  }

  async release(name: string, holder: string) {
    const q = quoteIdentifier;
    await executeRaw(`DELETE FROM ${this.table()} WHERE ${q("name")} = ? AND ${q("holder")} = ?`, [name, holder]);
  }

  async prune(prefix: string, olderThanMs: number) {
    const q = quoteIdentifier;
    const [clock, offset] = this.clock();
    const result = await executeRaw(
      `DELETE FROM ${this.table()} WHERE ${q("name")} LIKE ? AND ${q("expiresAt")} < ${clock} - ?`,
      [`${prefix}%`, offset, Math.max(0, Math.round(olderThanMs))],
    );
    return rawAffectedRows(result);
  }
}

export type PanelLeaseRole = "starting" | "holder" | "standby" | "stopped";

export type PanelLeaseStatus = {
  instanceId: string;
  role: PanelLeaseRole;
  /** 现在拿着租约的实例（null = 没人拿着 / 还没读到）。 */
  holderId: string | null;
  holderExpiresAt: number | null;
  /** 别的还活着的实例（按登记行，最近 TTL 内续过）。 */
  otherInstanceIds: string[];
  lastRenewedAt: number | null;
  lastError: string | null;
  ttlMs: number;
  renewIntervalMs: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type PanelLeaseOptions = {
  store: PanelLeaseStore;
  instanceId?: string;
  name?: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  fenceMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  logger?: Pick<typeof console, "info" | "warn">;
};

export function generatePanelInstanceId() {
  return crypto.randomBytes(6).toString("hex");
}

export class PanelLease {
  readonly instanceId: string;
  private readonly store: PanelLeaseStore;
  private readonly name: string;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly fenceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly logger: Pick<typeof console, "info" | "warn">;
  private readonly listeners = new Set<(holder: boolean) => void>();
  private validUntil = 0;
  private started = false;
  private stopped = false;
  private timer: TimerHandle | null = null;
  /** 到 validUntil 那一刻响一次：续约卡着没回时，丢了持有也马上说（不等那一轮结束）。 */
  private expiryTimer: TimerHandle | null = null;
  private ticking: Promise<void> | null = null;
  private lastHolderState = false;
  private holderId: string | null = null;
  private holderExpiresAt: number | null = null;
  private otherInstances: string[] = [];
  private lastRenewedAt: number | null = null;
  private lastError: string | null = null;
  private tickCount = 0;

  constructor(options: PanelLeaseOptions) {
    this.store = options.store;
    this.instanceId = options.instanceId || generatePanelInstanceId();
    this.name = options.name || PANEL_BACKGROUND_LEASE;
    this.ttlMs = Math.max(1, Number(options.ttlMs ?? PANEL_LEASE_TTL_MS));
    this.renewIntervalMs = Math.max(1, Number(options.renewIntervalMs ?? PANEL_LEASE_RENEW_INTERVAL_MS));
    this.fenceMs = Math.max(0, Math.min(this.ttlMs - 1, Number(options.fenceMs ?? PANEL_LEASE_FENCE_MS)));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.logger = options.logger ?? console;
  }

  /** 先续一轮（等它完成），之后按有效期排下一轮（见 schedule）。 */
  async start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await this.tick();
    this.schedule();
  }

  async stop(options: { release?: boolean } = {}) {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    if (this.ticking) await this.ticking.catch(() => undefined);
    this.validUntil = 0;
    if (options.release) {
      await this.store.release(this.name, this.instanceId).catch(() => undefined);
      await this.store.release(`${PANEL_INSTANCE_LEASE_PREFIX}${this.instanceId}`, this.instanceId).catch(() => undefined);
    }
    this.publishChange();
  }

  isHolder() {
    return !this.stopped && this.validUntil > this.now();
  }

  /** 有别的实例在最近一个 TTL 里续过登记。 */
  hasOtherInstances() {
    return this.otherInstances.length > 0;
  }

  onChange(listener: (holder: boolean) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  status(): PanelLeaseStatus {
    const holder = this.isHolder();
    return {
      instanceId: this.instanceId,
      role: this.stopped ? "stopped" : holder ? "holder" : this.lastRenewedAt === null && this.tickCount === 0 ? "starting" : "standby",
      holderId: holder ? this.instanceId : this.holderId,
      holderExpiresAt: this.holderExpiresAt,
      otherInstanceIds: [...this.otherInstances],
      lastRenewedAt: this.lastRenewedAt,
      lastError: this.lastError,
      ttlMs: this.ttlMs,
      renewIntervalMs: this.renewIntervalMs,
    };
  }

  /** 续一轮。并发调进来的共用同一轮。 */
  tick() {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => { this.ticking = null; });
    }
    return this.ticking;
  }

  /*
    下一轮什么时候续（评审 F5）：持有着的时候按这次续上的有效期排 —— 最晚在 validUntil 前留出一段余量开始，
    平时还是每 renewIntervalMs 一次。以前是「上一轮结束后再等一个间隔」：一次续约卡了十几秒，下一轮就排到了
    有效期之后，中间有一段谁都不是持有者（后台任务停了又起、在途的活被丢掉）。没持有时照常每个间隔试一次。
  */
  private nextDelayMs() {
    if (!this.isHolder()) return this.renewIntervalMs;
    const margin = Math.max(this.fenceMs, Math.floor(this.renewIntervalMs / 5));
    return Math.max(0, Math.min(this.renewIntervalMs, this.validUntil - this.now() - margin));
  }

  private schedule() {
    if (this.stopped) return;
    const timer = this.setTimer(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, this.nextDelayMs());
    (timer as { unref?: () => void } | null)?.unref?.();
    this.timer = timer;
  }

  /** 有效期到点时把「不再持有」说出来；每次续上重新排。 */
  private armExpiry() {
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    if (this.stopped || !this.isHolder()) return;
    const timer = this.setTimer(() => {
      if (this.expiryTimer !== timer) return;
      this.expiryTimer = null;
      this.publishChange();
    }, Math.max(0, this.validUntil - this.now()));
    (timer as { unref?: () => void } | null)?.unref?.();
    this.expiryTimer = timer;
  }

  private async runTick() {
    if (this.stopped) return;
    const startedAt = this.now();
    this.tickCount += 1;
    try {
      const acquired = await this.store.tryAcquire(this.name, this.instanceId, this.ttlMs);
      if (this.stopped) return;
      // 别的行过没过期按库的时钟看（各实例的时钟可能差很多）。
      const databaseNow = await this.store.now();
      if (acquired) {
        // 本机只信到「这次续约开始 + TTL − 余量」：请求在路上花的时间都算进去了。
        this.validUntil = startedAt + this.ttlMs - this.fenceMs;
        this.holderId = this.instanceId;
        this.holderExpiresAt = databaseNow + this.ttlMs;
      } else {
        this.validUntil = 0;
        const record = await this.store.read(this.name);
        const live = record && record.expiresAt > databaseNow ? record : null;
        this.holderId = live?.holder || null;
        this.holderExpiresAt = live?.expiresAt ?? null;
      }
      await this.store.tryAcquire(`${PANEL_INSTANCE_LEASE_PREFIX}${this.instanceId}`, this.instanceId, this.ttlMs);
      const instances = await this.store.list(PANEL_INSTANCE_LEASE_PREFIX);
      this.otherInstances = instances
        .filter((row) => row.holder !== this.instanceId && row.expiresAt > databaseNow)
        .map((row) => row.holder)
        .sort();
      if (acquired && this.tickCount % 30 === 1) {
        await this.store.prune(PANEL_INSTANCE_LEASE_PREFIX, INSTANCE_ROW_RETENTION_MS).catch(() => 0);
      }
      this.lastRenewedAt = startedAt;
      if (this.lastError) this.logger.info(`[PanelLease] renewed again instance=${this.instanceId}`);
      this.lastError = null;
    } catch (error) {
      // 续不上：validUntil 不动，到点自己就不算持有者了（不等别人来抢；expiryTimer 到点会说出来）。
      const message = error instanceof Error ? error.message : String(error);
      if (this.lastError !== message) this.logger.warn(`[PanelLease] renew failed instance=${this.instanceId}: ${message}`);
      this.lastError = message;
    } finally {
      this.armExpiry();
      this.publishChange();
    }
  }

  /** 持有状态变了就通知（唯一的通知点：续约结束、有效期到点、停下）。 */
  private publishChange() {
    const holder = this.isHolder();
    if (holder === this.lastHolderState) return;
    this.emit(holder);
  }

  private emit(holder: boolean) {
    this.lastHolderState = holder;
    this.logger.info(holder
      ? `[PanelLease] 本实例开始执行后台任务 instance=${this.instanceId}`
      : `[PanelLease] 本实例不再执行后台任务 instance=${this.instanceId}${this.holderId ? ` holder=${this.holderId}` : ""}`);
    for (const listener of this.listeners) {
      try {
        listener(holder);
      } catch (error) {
        this.logger.warn(`[PanelLease] change listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/*
  进程里那一份。没启动过（单元测试、命令行工具）时当作单实例：isPanelBackgroundLeaseHolder() 为 true，
  所有后台任务照旧在本进程跑。
*/
let activeLease: PanelLease | null = null;
const pendingListeners = new Set<(holder: boolean) => void>();

export function startPanelBackgroundLease(options: Partial<PanelLeaseOptions> = {}) {
  if (activeLease) return activeLease.start().then(() => activeLease!);
  const lease = new PanelLease({ store: options.store ?? new SqlPanelLeaseStore(), ...options });
  activeLease = lease;
  for (const listener of pendingListeners) lease.onChange(listener);
  if (getDatabaseKind() === "sqlite") {
    console.info(`[PanelLease] SQLite 部署只支持单个面板实例；租约照常续（instance=${lease.instanceId}）`);
  }
  return lease.start().then(() => lease);
}

export async function stopPanelBackgroundLease(options: { release?: boolean } = {}) {
  const lease = activeLease;
  if (!lease) return;
  await lease.stop(options);
}

/** 测试用：换掉 / 清掉进程里那一份。 */
export function setPanelBackgroundLeaseForTests(lease: PanelLease | null) {
  activeLease = lease;
  if (lease) for (const listener of pendingListeners) lease.onChange(listener);
}

/** 本实例现在该不该跑「只由持有者跑」的后台任务。没启动租约（单进程 / 测试 / 命令行）时为 true。 */
export function isPanelBackgroundLeaseHolder() {
  return activeLease ? activeLease.isHolder() : true;
}

/** 有没有别的活着的面板实例（没启动租约时为 false）。 */
export function panelHasOtherLiveInstances() {
  return activeLease ? activeLease.hasOtherInstances() : false;
}

export function panelBackgroundLeaseStatus(): PanelLeaseStatus | null {
  return activeLease ? activeLease.status() : null;
}

/** 持有状态变化（拿到 / 丢了）时回调；租约还没启动时先记着，启动后接上。 */
export function onPanelBackgroundLeaseChange(listener: (holder: boolean) => void) {
  pendingListeners.add(listener);
  const unsubscribe = activeLease?.onChange(listener);
  return () => {
    pendingListeners.delete(listener);
    unsubscribe?.();
  };
}

/** 给 createNonOverlappingScheduledTask 的 shouldRun 用。 */
export const leaseHolderOnly = () => isPanelBackgroundLeaseHolder();

/** 给界面 / 健康检查看的一句话。 */
export function describePanelBackgroundLease(status: PanelLeaseStatus | null) {
  if (!status) return "后台任务由本实例执行";
  if (status.role === "holder") {
    return status.otherInstanceIds.length > 0
      ? `后台任务由本实例执行（另有 ${status.otherInstanceIds.length} 个实例待命）`
      : "后台任务由本实例执行";
  }
  if (status.role === "starting") return "后台任务租约正在获取";
  if (status.role === "stopped") return "后台任务已停止";
  if (status.holderId) return `后台任务由另一实例 ${status.holderId} 执行`;
  return status.lastError ? "后台任务暂停：续不上租约（数据库连不上）" : "后台任务暂无实例执行，正在接手";
}
