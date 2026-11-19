/*
  转发组 / 入口组评估里的几条纯判定（不查库、不发请求、不读时钟，全靠参数），单测直接测这里：

    · decideExternalHealth        —— 别的机器（观察点）看这个成员通不通，怎么并进「成员是否可用」
    · readinessGrace              —— 面板刚启动 / 数据库刚恢复时，哪些成员主机还说不准
    · entryMemberInclusion        —— 入口组的一个成员这一轮进不进解析（恢复要稳一阵才加回来）
    · planEntryGroupRecordSet     —— 入口组这一轮发哪些值（全挂时保留上一轮的整组）

  evaluateDriver.ts / ddnsEntryGroup.ts 照这些结论去读写库、发布解析。
*/

/** 一个观察点此刻对一个成员的看法。 */
export type PeerObserverView = {
  hostId: number;
  /** 观察点自己的 Agent 在线（面板的存活判定）。离线的观察点说的不算。 */
  online: boolean;
  /** 最近一次还新鲜的结果：true 连得上 / false 连不上 / null 没有新鲜结果。 */
  reachable: boolean | null;
  /** 现在这个结果从什么时候开始的（毫秒）。 */
  since: number | null;
  /** 这个观察点连通过这个成员。只放行特定来源的防火墙下，从没连通过的观察点「连不上」不算数。 */
  everReached: boolean;
  /** 观察点此刻连得上别的成员或参照目标：自己网络坏了的观察点「连不上」不算数。 */
  crossCheckOk: boolean;
};

export type ExternalHealthState =
  /** 没有可用的观察点（单成员组、Agent 太旧、观察点都离线）：和以前一样只看成员自己的报告。 */
  | "none"
  /** 有观察点连得上，没有凑够「连不上」的票。 */
  | "reachable"
  /** 凑够票了，但还没持续满 failoverMs（观察期）。 */
  | "failing"
  /** 凑够票并且持续满 failoverMs：判定不可用。 */
  | "down"
  /** 有结果，但既没有连得上的、「连不上」的票也不作数（或者不够）：说不准，按成员自己的报告。 */
  | "inconclusive";

export type ExternalHealthDecision = {
  state: ExternalHealthState;
  /** 外部判定这个成员不可用（含「之前判了不可用、观察点还没重新连上」的保持）。 */
  down: boolean;
  /** 成员自己的 Agent 面板连不上，但观察点连得上：继续留在解析里。 */
  reachableWhileAgentOffline: boolean;
  /** 此刻连得上的观察点数 / 有新鲜结果的观察点数 / 分配的观察点数。 */
  reachableCount: number;
  usableCount: number;
  assignedCount: number;
  /** 作数的「连不上」票数，和凑够票需要几票（0 = 没有可用观察点）。 */
  failingVotes: number;
  votesNeeded: number;
  /** 凑够票的时刻（毫秒）；没凑够是 null。评估拿它当「异常开始」算观察时间。 */
  failingSince: number | null;
};

/**
 * 观察点的结论怎么并进成员健康。
 *
 * 规则：
 *   (a) 成员自己的 Agent 离线，而且没有观察点此刻连得上它 —— 按原来的离线处理（这里不改结论，
 *       reachableWhileAgentOffline = false，调用方照旧走离线那条路）；有观察点连得上就继续发布。
 *   (b) 至少 2 个观察点（在线的观察点不足 2 个时是全部在线的）持续 failoverMs 连不上 —— 判不可用。每一票都要求：
 *       观察点在线、结果新鲜、以前连通过这个成员、此刻连得上别的成员或参照目标。
 *   恢复：判了不可用之后，要等观察点重新连上（state 回到 reachable）才解除；之后由调用方的
 *   healthySince + recoverMs 管「稳够久才加回来」。观察点一个都不可用时解除保持，退回只看成员自己。
 */
export function decideExternalHealth(input: {
  agentOnline: boolean;
  observers: readonly PeerObserverView[];
  failoverMs: number;
  now: number;
  /** 上一轮外部判定是不可用（成员行里存着，面板重启不丢）。 */
  previouslyDown?: boolean;
}): ExternalHealthDecision {
  const observers = input.observers || [];
  const usable = observers.filter((observer) => observer.online && observer.reachable !== null);
  const reachers = usable.filter((observer) => observer.reachable === true);
  const validFailers = usable.filter((observer) => observer.reachable === false && observer.everReached && observer.crossCheckOk);
  /*
    票数门槛按「安排了、而且在线」的观察点算，不按「这一刻有结果」的算（评审 F3）：在线观察点的结果缺了
    （还没报、过期了、多实例时报在了别的实例上）只能让结论更难成立，不能把门槛降成 1 票。
  */
  const assignedOnline = observers.filter((observer) => observer.online).length;
  const votesNeeded = assignedOnline >= 2 ? 2 : assignedOnline;
  const base = {
    reachableCount: reachers.length,
    usableCount: usable.length,
    assignedCount: observers.length,
    failingVotes: validFailers.length,
    votesNeeded,
  };
  if (usable.length === 0) {
    // 没有任何观察点说得上话：之前的外部判定也不再保持（否则观察点全下线后这个成员永远回不来）。
    return { ...base, state: "none", down: false, reachableWhileAgentOffline: false, failingSince: null };
  }
  const quorum = votesNeeded > 0 && validFailers.length >= votesNeeded;
  if (quorum) {
    // 「凑够票」的时刻：按各自开始连不上的时间从早到晚排，第 votesNeeded 个开始的那一刻。
    const starts = validFailers
      .map((observer) => Number(observer.since ?? input.now))
      .map((since) => (Number.isFinite(since) ? Math.min(since, input.now) : input.now))
      .sort((left, right) => left - right);
    const failingSince = starts[votesNeeded - 1];
    const failedLongEnough = input.now - failingSince >= Math.max(0, input.failoverMs);
    const down = failedLongEnough || !!input.previouslyDown;
    return { ...base, state: down ? "down" : "failing", down, reachableWhileAgentOffline: false, failingSince };
  }
  if (reachers.length > 0) {
    return { ...base, state: "reachable", down: false, reachableWhileAgentOffline: !input.agentOnline, failingSince: null };
  }
  // 有结果但都是不作数的「连不上」：之前判了不可用的继续保持（还没人重新连上它），否则不下结论。
  return { ...base, state: input.previouslyDown ? "down" : "inconclusive", down: !!input.previouslyDown, reachableWhileAgentOffline: false, failingSince: null };
}

/** 状态消息 / 界面上的那句「外部观察 N/M 可达」。没有观察点时是空串。 */
export function externalHealthLabel(decision: Pick<ExternalHealthDecision, "reachableCount" | "usableCount" | "assignedCount">) {
  if (decision.assignedCount <= 0) return "";
  if (decision.usableCount <= 0) return "外部观察暂无结果";
  return `外部观察 ${decision.reachableCount}/${decision.usableCount} 可达`;
}

export type ReadinessHost = {
  hostId: number;
  /** 这台机器最近一次到面板的时刻（毫秒）；没见过是 null / 0。 */
  lastSeenAt: number | null;
  /** 多久不来算离线（带快速存活上报的主机 90 秒）；0 = 这台不参与宽限（从没连过面板的机器）。 */
  offlineThresholdMs: number;
};

export type ReadinessGrace = {
  /** 还有成员主机「说不准」：这一轮不许自动把解析从现在的成员 / 集合上换走。 */
  active: boolean;
  /** 最晚到什么时候就都说得准了（毫秒）；不在宽限里是 0。 */
  until: number;
  waitingHostIds: number[];
};

/**
 * 面板就绪（进程启动、或者数据库故障恢复）之后的宽限。
 *
 * 面板停了一阵再起来、或者数据库断了一阵再恢复时，内存里所有主机看着都像离线；谁先重新上报，谁就
 * 「在线」。这时候评估，解析会被第一个回来的成员抢走。所以：一台成员主机在「就绪之后来过」或者
 * 「从就绪算起沉默满了离线阈值」之前都算说不准；组里还有说不准的主机时，不自动换走。
 */
export function readinessGrace(input: { readyAt: number; now: number; hosts: readonly ReadinessHost[] }): ReadinessGrace {
  const waiting: number[] = [];
  let until = 0;
  for (const host of input.hosts) {
    if (readinessHostWaiting(input.readyAt, input.now, host)) {
      waiting.push(host.hostId);
      until = Math.max(until, input.readyAt + Math.max(0, host.offlineThresholdMs));
    }
  }
  return { active: waiting.length > 0, until, waitingHostIds: waiting };
}

/** 单台主机是不是还在就绪宽限里说不准。 */
export function readinessHostWaiting(readyAt: number, now: number, host: Pick<ReadinessHost, "lastSeenAt" | "offlineThresholdMs">) {
  if (!(readyAt > 0)) return false;
  const seenAt = Number(host.lastSeenAt || 0);
  if (seenAt >= readyAt) return false;
  return now < readyAt + Math.max(0, Number(host.offlineThresholdMs) || 0);
}

export type EntryMemberHealth = "healthy" | "unhealthy";

export type EntryMemberInclusion = {
  include: boolean;
  failureSince: number | null;
  healthySince: number | null;
  failedLongEnough: boolean;
  recoveredLongEnough: boolean;
  /** 健康但还在等恢复观察时间 / 抖动抑制：到这个时刻再评估（毫秒）；没有是 null。 */
  recheckAt: number | null;
  /** 为什么健康却没加回来：recovering = 还没稳够久；flap = 抖动抑制。 */
  holdReason: "recovering" | "flap" | null;
};

/**
 * 入口组的一个成员这一轮进不进解析。
 *
 *   · 不健康：已经在解析里的，异常持续满 failoverMs 才拿掉（这段时间照旧留着）；不在的不加。
 *   · 健康：已经在解析里的留着；不在的要「面板看到它连续健康」满 recoverMs 才加回来，从 healthySince
 *     和 restoredAt（机器刚从离线回来的时刻）里晚的那个起算；抖动抑制（flapHoldUntil）还要再压一阵。
 *   · 从没出过问题的新成员（neverFailed）不用等：新建的组、刚加进来的机器马上发布。
 */
export function entryMemberInclusion(input: {
  health: EntryMemberHealth;
  previouslyIncluded: boolean;
  /** 成员行里没有任何故障 / 恢复记录（新成员）。 */
  neverFailed: boolean;
  previousFailureSince: number | null;
  previousHealthySince: number | null;
  observedFailureSince: number | null;
  /** 机器最近一次从离线回到在线的时刻（面板看到的）。 */
  restoredAt?: number | null;
  /** 抖动抑制压到什么时候（毫秒）；没压是 0 / null。 */
  flapHoldUntil?: number | null;
  /** 外部观察已经持续判了不可用：不再等 failoverMs。 */
  failureFinal?: boolean;
  failoverMs: number;
  recoverMs: number;
  now: number;
}): EntryMemberInclusion {
  const { now } = input;
  if (input.health === "healthy") {
    const healthySince = input.previousHealthySince ?? (input.neverFailed ? now - Math.max(0, input.recoverMs) : now);
    const recoverySince = Math.min(now, Math.max(healthySince, Number(input.restoredAt || 0)));
    const recoveredLongEnough = now - recoverySince >= Math.max(0, input.recoverMs);
    if (input.previouslyIncluded) {
      return { include: true, failureSince: null, healthySince, failedLongEnough: false, recoveredLongEnough, recheckAt: null, holdReason: null };
    }
    if (!recoveredLongEnough) {
      return { include: false, failureSince: null, healthySince, failedLongEnough: false, recoveredLongEnough, recheckAt: recoverySince + Math.max(0, input.recoverMs), holdReason: "recovering" };
    }
    const flapHoldUntil = Number(input.flapHoldUntil || 0);
    if (flapHoldUntil > now) {
      return { include: false, failureSince: null, healthySince, failedLongEnough: false, recoveredLongEnough, recheckAt: flapHoldUntil, holdReason: "flap" };
    }
    return { include: true, failureSince: null, healthySince, failedLongEnough: false, recoveredLongEnough, recheckAt: null, holdReason: null };
  }
  let failureSince = input.previousFailureSince ?? input.observedFailureSince ?? now;
  if (input.observedFailureSince !== null && input.observedFailureSince < failureSince) failureSince = input.observedFailureSince;
  const failedLongEnough = !!input.failureFinal || now - failureSince >= Math.max(0, input.failoverMs);
  return {
    include: input.previouslyIncluded && !failedLongEnough,
    failureSince,
    healthySince: null,
    failedLongEnough,
    recoveredLongEnough: false,
    recheckAt: null,
    holdReason: null,
  };
}

export type EntryRecordSetPlan = {
  /** 这一轮要发布的值（去重，保持传入顺序）。 */
  values: string[];
  /**
   * healthy   —— 有健康成员，发健康的那些
   * hold-all  —— 一个健康的都没有：保留上一轮发布的整组（不缩成一条）
   * empty     —— 成员全被管理动作排除（流量到阈值 / 维护）：清掉记录
   * none      —— 没有健康成员，也没有上一轮可保留
   */
  mode: "healthy" | "hold-all" | "empty" | "none";
};

/**
 * 入口组这一轮发哪些值。
 *
 * 全挂时保留上一轮的整组：以前缩成 lastDdnsValue 里的第一条 —— 全部入口同时判坏多半是检测那一侧的
 * 问题（面板到 Agent 的路断了、健康检查目标挂了），缩成一条等于把所有访客压到一台上，恢复时还要
 * 再全量改一次记录。被管理动作排除的值（流量到阈值的主机）不保留。
 */
export function planEntryGroupRecordSet(input: {
  healthyValues: readonly string[];
  previousValues: readonly string[];
  /** 管理动作排除掉的值：不能留在解析里。 */
  administrativelyExcludedValues?: readonly string[];
  /** 启用的成员里，能给出值的全部被管理动作排除了。 */
  allAdministrativelyExcluded?: boolean;
}): EntryRecordSetPlan {
  const unique = (values: readonly string[]) => Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  const healthy = unique(input.healthyValues);
  if (healthy.length > 0) return { values: healthy, mode: "healthy" };
  if (input.allAdministrativelyExcluded) return { values: [], mode: "empty" };
  const excluded = new Set(unique(input.administrativelyExcludedValues || []));
  const retained = unique(input.previousValues).filter((value) => !excluded.has(value));
  if (retained.length > 0) return { values: retained, mode: "hold-all" };
  return { values: [], mode: excluded.size > 0 ? "empty" : "none" };
}
