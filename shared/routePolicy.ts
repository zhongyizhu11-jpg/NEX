import { describeFailoverActiveLine, failoverLineEndpoints } from "./failoverActiveLine";
import type { FailoverPin } from "./failoverPin";
import { defaultHealthCheckTarget, normalizeForwardGroupHealthCheckMethod } from "./forwardGroupHealthCheck";
import {
  describeFailoverScheduleDays,
  failoverScheduleWindowIndexAt,
  parseScheduleMinutes,
} from "./failoverSchedule";
import type { NetworkHealth } from "./networkHealth";
import { normalizeForwardRuleProtocol } from "./forwardTypes";
import {
  ROUTE_GROUP_AGENT_VERSION,
  ROUTE_GROUP_UDP_AGENT_VERSION,
  ROUTE_SWITCH_MODE_INFO,
  ROUTE_SWITCH_MODE_SESSION_HINTS,
  describeRouteIssue,
  routeAgentStrategy,
  routeGroupForwardTypeSupported,
  routeGroupIsForwardXTunnel,
  routeGroupSchedulerAgentVersion,
  routePathLabel,
  routePathsOf,
  routePolicyOf,
  routeWeightShares,
  type RouteGroupRule,
  type RouteMode,
  type RouteSpread,
} from "./routeGroup";
import { timestampMillis } from "./timestamp";
import { isAgentVersionAtLeast } from "./version";

/**
 * 一条主备规则的「路由策略」：此刻按什么规矩、首选哪条、实际走哪条。全站唯一一份。
 *
 * 选路是 Agent 在本地做的，规矩写死在 agent/main.go 的 priorityOrderLocked 里：
 *
 *     人工指定 > 时段表 > 自动择优 > 出站顺序
 *
 * 哪一层先给出答案，哪一层就决定「首选是谁」；首选挂了照样往下找，那是健康检查的事，
 * 和选路是正交的。这里把同一套规矩在面板上再算一遍 —— 不是为了替 Agent 做决定，是为了
 * 把「为什么走这条」说出来：界面上每一层是一行条件，此刻起作用的那一行高亮。
 *
 * 两件事要分开说，不能混成一句「现在走 X」：
 *
 *   · 首选（preferred）：面板按规矩算出来的。自动择优那一层面板算不了 —— 谁更快是
 *     Agent 实测的 —— 这时候首选是 null，不瞎猜。
 *   · 实际（report）：Agent 报上来的。新版 Agent 每次心跳报一遍，才能叫「现在」；
 *     2.2.196 只报切换事件，只能叫「最近一次切换」；机器离线就什么都不说。
 *
 * 两者不一致不一定是故障（首选那条可能正挂着、刚恢复还在观察、「恢复后切回」关着），
 * 所以不一致时只说确实可能的原因，不下结论。
 *
 * 转发组的故障转移也用这一份模型说话（describeGroupRoutePolicy），见文件后半。
 */

/** 探测目标、时段表、人工指定、自动择优、切换事件：Agent 2.2.196 起。更老的只认出站顺序。 */
export const ROUTE_POLICY_AGENT_VERSION = "2.2.196";
/** 每次心跳报「现在走哪条」：Agent 2.2.197 起。 */
export const ACTIVE_LINE_SNAPSHOT_AGENT_VERSION = "2.2.197";

/** Agent 那边的分配策略名：主备（fallback）或权重负载的四种分法。 */
export type RoutePolicyStrategy = "fallback" | RouteSpread;

export type RoutePolicyLine = {
  /** 0 是主线路，1.. 是第几条备用线路 */
  index: number;
  /** 「主线路」「备用 1」 */
  label: string;
  endpoint: string;
  /** 按规矩此刻排在最前的那条。由自动择优决定时谁都不是 —— 面板不知道 Agent 测出来谁快。 */
  preferred: boolean;
  /** Agent 报的正在走的那条（报告能用时才有）。转发组：解析指向（或建议）的那个成员。 */
  active: boolean;
  /** 转发组成员的 id —— 「设为首选」要拿它重排。规则的出站没有。 */
  memberId?: number;
  /** 转发组成员启用着没有。停用的不参与挑选，也不该出现在「换一个首选」里。 */
  enabled?: boolean;
  /**
   * 转发组成员自己的健康，面板每轮检查写回库里的那份。规则的出站没有：那是 Agent 在
   * 本地探的，面板看不到每条出站的健康。
   */
  health?: NetworkHealth;
  /** 健康那一半的补充：「18ms」「不健康，21:30 起」「等检测结果」「已停用」。 */
  note?: string | null;
};

export type RoutePolicyConditionKind = "pin" | "schedule" | "fastest" | "order" | "spread";

export type RoutePolicyCondition = {
  kind: RoutePolicyConditionKind;
  key: string;
  /** 条件那一半：什么时候。 */
  when: string;
  /** 结果那一半：走哪条。 */
  then: string;
  /** 指向哪条出站；「按顺序」「择优」「分摊」这种不指向单独一条的是 null。 */
  targetIndex: number | null;
  /** 时段表那几行：它是配置里的第几个时段（编辑框要把「此刻」标在对应的那一行上）。 */
  windowIndex?: number;
  /**
   * - deciding：此刻就是它在决定首选
   * - overridden：此刻本该轮到它，但被更靠前的一层压着（钉着的时候时段表命中了）
   * - idle：此刻不适用（不在时段内），或者只是兜底的顺序
   */
  state: "deciding" | "overridden" | "idle";
};

export type RoutePolicyGuard = {
  /**
   * health 只有转发组有：它的健康是面板测的，得说清楚按什么算。switch 两边都有：转发组说的是
   * 「改哪条解析」，规则说的是「切换时旧连接怎么办」。prewarm 是计划切换的预热预检。
   */
  key: "failover" | "recover" | "hold" | "health" | "switch" | "prewarm";
  label: string;
  value: string;
};

export type RoutePolicyReport =
  /** 新版 Agent 每次心跳确认的「现在」 */
  | { kind: "current"; index: number; since: number | null }
  /** 2.2.196 只报切换事件：这是最近一次切换，之后换过规格或重启过的话已经回到主线路 */
  | { kind: "lastSwitch"; index: number; since: number | null }
  /** 报上来的地址不在线路清单里 —— 多半刚改过配置 */
  | { kind: "unlisted"; target: string }
  /** 新版 Agent，还没报上来（刚起来、刚改过） */
  | { kind: "pending" }
  /** 2.2.196，没有切换记录 —— 不能当成「一直走主线路」：这一版之前面板会丢事件 */
  | { kind: "noSwitch" }
  | { kind: "offline" }
  /** Agent 早于 2.2.196：不报告，也不执行时段表、人工指定、自动择优 */
  | { kind: "unsupported" }
  /**
   * 转发组：解析指向这个成员。writtenAt 是面板最近一次写解析的时刻（Unix 秒）——
   * **不是**「从什么时候起指向它」：手动同步、面板重启后的第一次核对都会原样重写一遍。
   */
  | { kind: "resolved"; index: number; writtenAt: number | null }
  /** 转发组：系统 DDNS 没开，面板照样挑，但只记成「建议入口」，解析不改 */
  | { kind: "suggested"; index: number }
  /** 转发组：没配 DDNS 域名 —— 只看成员健康，不切换 */
  | { kind: "noDomain" }
  /** 转发组停用：不检测、不切换 */
  | { kind: "groupDisabled" };

export type RoutePolicy = {
  /** 规则级主备（Agent 切出站），还是转发组（面板切解析）。说法不同的地方靠它分。 */
  subject: "rule" | "group";
  /** 纯 UDP 规则：调度按会话（同一个访客端口发来的包）而不是按连接，说法跟着换。 */
  perSession?: boolean;
  /** 线路组的调度模式（shared/routeGroup）。转发组只有一种：主备。 */
  mode: RouteMode;
  strategy: RoutePolicyStrategy;
  lines: RoutePolicyLine[];
  /** 从上往下就是优先级。 */
  conditions: RoutePolicyCondition[];
  guards: RoutePolicyGuard[];
  /** 按规矩此刻首选第几条；null = 由 Agent 按实测延迟定，或者本来就没有首选（轮询这类）。 */
  preferredIndex: number | null;
  deciding: RoutePolicyConditionKind | null;
  /** 此刻有效的人工指定（过期的、越界的不算）。 */
  pin: FailoverPin | null;
  report: RoutePolicyReport;
  /** 首选和实际走的不是同一条（转发组还包括：在用的那个眼看要被换走）时，一句话说原因。 */
  divergence: string | null;
  /** 配了、但在这台机器上不会生效的东西。 */
  warnings: string[];
};

export type RoutePolicyRule = RouteGroupRule & {
  forwardType?: unknown;
  protocol?: unknown;
  /** 走隧道的规则：调度器在隧道出口，看不到访客（除非 PROXY 头一路带过来）。 */
  tunnelId?: unknown;
  /** 隧道的类型（tls / wss / … / nginx_stream / forwardx）。Nginx 隧道传不了 PROXY 头，NEX 隧道要出口 Agent 2.2.199；不知道时按 GOST 隧道说。 */
  tunnelMode?: unknown;
  proxyProtocolSend?: unknown;
  proxyProtocolExitSend?: unknown;
  failoverActiveTarget?: unknown;
  failoverActiveAt?: unknown;
};

export type RoutePolicyHost = { isOnline?: unknown; agentVersion?: unknown } | null | undefined;

export type RoutePolicyOptions = {
  host?: RoutePolicyHost;
  nowMs?: number;
  /** 钟点怎么写。默认按运行环境的时区；测试里传固定的。 */
  timeZone?: string;
};


function truthy(value: unknown, fallback: boolean) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

/** 「60 秒」「2 分钟」「1.5 小时」这类说法。 */
export function formatPolicyDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (value < 120) return `${value} 秒`;
  if (value < 7200) return `${Math.round(value / 60)} 分钟`;
  const hours = value / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

/** 钟点：同一天只写「21:30」，不是同一天带上日期。 */
export function formatPolicyClock(ms: number, nowMs: number, timeZone?: string): string {
  const parts = (at: number) => {
    const formatted = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const pick = (type: string) => formatted.find((part) => part.type === type)?.value || "";
    return { y: pick("year"), m: pick("month"), d: pick("day"), clock: `${pick("hour")}:${pick("minute")}` };
  };
  const at = parts(ms);
  const now = parts(nowMs);
  if (at.y === now.y && at.m === now.m && at.d === now.d) return at.clock;
  return `${at.m}月${at.d}日 ${at.clock}`;
}

function describeReport(
  rule: RoutePolicyRule,
  host: RoutePolicyHost,
  lineCount: number,
): RoutePolicyReport {
  const version = String(host?.agentVersion || "");
  if (host && version && !isAgentVersionAtLeast(version, ROUTE_POLICY_AGENT_VERSION)) return { kind: "unsupported" };
  if (!host || !truthy(host.isOnline, false)) return { kind: "offline" };
  const snapshots = isAgentVersionAtLeast(version, ACTIVE_LINE_SNAPSHOT_AGENT_VERSION);
  const active = describeFailoverActiveLine({ ...rule, failoverEnabled: true });
  if (!active) return snapshots ? { kind: "pending" } : { kind: "noSwitch" };
  if (active.unknown || active.index >= lineCount) return { kind: "unlisted", target: active.target };
  return { kind: snapshots ? "current" : "lastSwitch", index: active.index, since: active.since };
}

export function describeRoutePolicy(rule: RoutePolicyRule, options: RoutePolicyOptions = {}): RoutePolicy | null {
  if (!truthy(rule?.failoverEnabled, false)) return null;
  const nowMs = options.nowMs ?? Date.now();
  const clock = (ms: number) => formatPolicyClock(ms, nowMs, options.timeZone);
  const paths = routePathsOf(rule);
  const endpoints = failoverLineEndpoints(rule);
  const lineCount = paths.length;
  const policy = routePolicyOf(rule, { nowMs, pathCount: lineCount });
  const mode = policy.mode;
  const strategy: RoutePolicyStrategy = routeAgentStrategy(policy);
  const label = (index: number) => routePathLabel(paths[index], index);
  const report = describeReport(rule, options.host, lineCount);
  const warnings: string[] = [];
  // 纯 UDP 没有连接：Agent 按会话挑路径，没有「拨不通」这回事，旧连接也叫旧会话。
  const perSession = normalizeForwardRuleProtocol(rule.protocol) === "udp";

  const { failoverSeconds, recoverSeconds, autoFailback, minHoldSeconds, failureThreshold } = policy;

  const conditions: RoutePolicyCondition[] = [];
  let preferredIndex: number | null = null;
  let deciding: RoutePolicyConditionKind | null = null;
  let pin: FailoverPin | null = null;

  if (mode === "weighted") {
    /*
      权重负载没有「首选是谁」：每条新连接各走各的，旧连接不动。人工指定、时段表、评分
      在这个模式下 Agent 都不看，保存时也会被清掉，所以这里只有一行。
    */
    const shares = routeWeightShares(paths);
    const spread: Record<RouteSpread, string> = {
      weighted: `按权重分：${paths.map((_, index) => `${label(index)} ${shares[index]}%`).join(" / ")}`,
      least_load: `给 ${lineCount} 条里现在${perSession ? "会话" : "连接"}最少的那条（按权重折算）`,
      round_robin: `轮流走这 ${lineCount} 条`,
      random: `从 ${lineCount} 条里随机挑一条`,
      ip_hash: perSession ? "按会话固定分到其中一条" : "按来源 IP 固定分到其中一条",
    };
    conditions.push({ kind: "spread", key: "spread", when: perSession ? "每个新会话" : "每条新连接", then: spread[policy.spread], targetIndex: null, state: "deciding" });
    deciding = "spread";
  } else {
    const supported = report.kind !== "unsupported";
    pin = policy.pin;
    const schedule = policy.schedule;
    const allWindows = schedule?.windows || [];
    // 指向不存在的路径的时段不算（服务端也存不进去），但序号按配置里的原样给，编辑框才对得上行。
    const validWindows = allWindows.map((window, index) => ({ window, index })).filter(({ window }) => window.targetIndex < lineCount);
    const matchedValid = schedule ? failoverScheduleWindowIndexAt({ ...schedule, windows: validWindows.map(({ window }) => window) }, new Date(nowMs)) : null;
    const matchedWindow = matchedValid === null ? null : validWindows[matchedValid].index;
    const bySchedule = mode === "scheduled" || mode === "hybrid";
    // 智能择优、混合策略都看评分：混合是「时段表定首选，时段外按评分」。
    const byScore = mode === "smart" || mode === "hybrid";

    // 按 Agent 的次序一层层往下找第一个给出答案的。Agent 太旧时人工指定以外的几层它都不认，只剩顺序。
    if (supported && pin) {
      deciding = "pin";
      preferredIndex = pin.index;
    } else if (supported && bySchedule && matchedWindow !== null) {
      deciding = "schedule";
      preferredIndex = allWindows[matchedWindow].targetIndex;
    } else if (supported && byScore) {
      deciding = "fastest";
      preferredIndex = null;
    } else {
      deciding = "order";
      preferredIndex = 0;
    }

    if (pin) {
      conditions.push({
        kind: "pin",
        key: "pin",
        when: mode === "manual"
          ? (pin.untilMs ? `手动指定，到 ${clock(pin.untilMs)}` : "手动指定")
          : (pin.untilMs ? `人工指定，到 ${clock(pin.untilMs)}` : "人工指定，一直"),
        then: `强制走 ${label(pin.index)}`,
        targetIndex: pin.index,
        state: deciding === "pin" ? "deciding" : "idle",
      });
    }
    if (bySchedule) {
      validWindows.forEach(({ window, index }) => {
        const crossesMidnight = (parseScheduleMinutes(window.to) ?? 0) <= (parseScheduleMinutes(window.from) ?? 0);
        const matched = index === matchedWindow;
        const precheck = mode === "hybrid" && policy.prewarmSeconds > 0
          ? `，到点前 ${formatPolicyDuration(policy.prewarmSeconds)}先预热预检，预检不过不切`
          : "";
        conditions.push({
          kind: "schedule",
          key: `schedule-${index}`,
          when: `${describeFailoverScheduleDays(window.days)} ${window.from}–${window.to}${crossesMidnight ? "（次日）" : ""}`,
          then: `首选 ${label(window.targetIndex)}${precheck}`,
          targetIndex: window.targetIndex,
          windowIndex: index,
          state: matched && deciding === "schedule" ? "deciding" : matched && supported ? "overridden" : "idle",
        });
      });
    }
    if (byScore) {
      conditions.push({
        kind: "fastest",
        key: "fastest",
        when: "按线路评分",
        // 延迟那两道门槛写死在 Agent 里（failoverFastestMarginMs / Ratio），这里照抄。
        then: `挑评分明显更高的那条（高出 ${policy.scoreMargin} 分，或快 20ms 且快 20%），连续 ${formatPolicyDuration(policy.scoreHoldSeconds)}才换`,
        targetIndex: null,
        state: deciding === "fastest" ? "deciding" : supported && (deciding === "pin" || deciding === "schedule") ? "overridden" : "idle",
      });
    }
    conditions.push({
      kind: "order",
      key: "order",
      when: conditions.length > 0 ? "其余时候" : "按顺序",
      then: paths.map((_, index) => label(index)).join(" → "),
      targetIndex: null,
      state: deciding === "order" ? "deciding" : "idle",
    });
    if (!supported && (pin || validWindows.length > 0 || byScore)) {
      warnings.push(`这台机器的 Agent 早于 ${ROUTE_POLICY_AGENT_VERSION}：人工指定、时段表、自动择优它都不认，只按路径顺序走。`);
    }
  }

  /*
    评分择优、权重、预热预检、连续失败次数、强制切换：Agent 2.2.198 起。更老的 Agent 拿到
    的仍是一份主备清单，照旧能切，但这些新东西它不认 —— 照实说，别让人以为配了就生效。
  */
  const version = String(options.host?.agentVersion || "");
  if (options.host && version && !isAgentVersionAtLeast(version, ROUTE_GROUP_AGENT_VERSION)) {
    const uses: string[] = [];
    if (mode === "smart") uses.push("评分择优");
    if (mode === "hybrid") uses.push("预热预检");
    if (mode === "weighted" && policy.spread === "weighted") uses.push("权重");
    if (policy.switchMode !== "smooth") uses.push("强制断旧连接");
    if (uses.length > 0) {
      warnings.push(`这台机器的 Agent 早于 ${ROUTE_GROUP_AGENT_VERSION}：${uses.join("、")}它不认，只按主备顺序切、切换时也不断旧连接。`);
    }
  }
  for (const [index, path] of paths.entries()) {
    if (path.issue) warnings.push(`「${label(index)}」眼下用不了：${describeRouteIssue(path.issue)}。`);
  }

  /*
    调度器插在前面那个用户态转发工具（gost / realm / socat / nginx）和路径之间，内核转发没有
    这一步（心跳下发时不带调度规格）。界面上存不出这种组合，但老数据里可能有 —— 照实说。
  */
  const forwardType = String(rule.forwardType ?? "gost");
  const protocol = normalizeForwardRuleProtocol(rule.protocol);
  if (!routeGroupForwardTypeSupported(forwardType)) {
    warnings.push("线路组只在 gost、realm、socat、nginx 转发上生效。这条规则是内核转发（iptables / nftables），机器上不会走线路组；保存一次时它会被关掉。");
  }
  const udpAgentReady = !version || isAgentVersionAtLeast(version, ROUTE_GROUP_UDP_AGENT_VERSION);
  /*
    NEX 隧道、UDP、TCP+UDP 要新 Agent 才调度（routeGroupSchedulerAgentVersion）。面板这时不
    下发调度，前面的转发工具直接拨路径 A（server 的 routePrimaryEndpoint）；NEX 隧道是出口的
    FXP 拨路径 A。
  */
  const forwardXTunnel = Number(rule.tunnelId || 0) > 0 && routeGroupIsForwardXTunnel(rule.tunnelMode);
  const schedulerAgentVersion = routeGroupSchedulerAgentVersion(protocol, forwardXTunnel ? rule.tunnelMode : null);
  const schedulerAgentReady = !schedulerAgentVersion || !version || isAgentVersionAtLeast(version, schedulerAgentVersion);
  if (schedulerAgentVersion && options.host && !schedulerAgentReady) {
    warnings.push(forwardXTunnel
      ? `隧道出口的 Agent 早于 ${schedulerAgentVersion}，还不会调度 NEX 隧道：升级之前这条规则全部走 ${label(0)}、不切换。`
      : `这台机器的 Agent 早于 ${schedulerAgentVersion}，还不会调度 UDP：升级之前这条规则全部走 ${label(0)}、不切换。`);
  }
  if (protocol === "udp" && paths.some((path) => !path.probe)) {
    warnings.push("UDP 没有握手可探：没填探测地址的路径靠 ping 拨号地址判断通不通。落地或第一跳中转禁 ping 的，给那条路径填一个 TCP 探测地址，不然会被当成挂了。");
  }
  if (strategy === "ip_hash") {
    if (protocol !== "tcp") {
      warnings.push("UDP 读不到访客地址：按访客固定对 UDP 是按会话固定，同一个会话一直走同一条，同一个访客的不同会话可能分到不同路径。");
    }
    const tunnelled = Number(rule.tunnelId || 0) > 0;
    const headerSent = truthy(tunnelled ? rule.proxyProtocolExitSend : rule.proxyProtocolSend, false);
    if (!schedulerAgentReady) {
      // 调度本身都没下发（上面那句已经说了全部走路径 A），按访客分不分无从谈起，不再多说一句。
    } else if (protocol !== "udp" && options.host && !udpAgentReady) {
      warnings.push(`这台机器的 Agent 早于 ${ROUTE_GROUP_UDP_AGENT_VERSION}：按访客固定读不到访客地址，所有访客都落在同一条路径上。升级 Agent 后才按访客分。`);
    } else if (protocol !== "udp" && !headerSent && (tunnelled || forwardType !== "gost")) {
      /*
        调度器只监听本机，访客地址只能从前面加的 PROXY 头里读。gost 端口转发由面板专门加一个
        只给调度器的头（读完就扔）；realm / socat / nginx 前置、走隧道时加不了，除非规则本来就发。
        Nginx 隧道连「发送 PROXY 协议」都没有。
      */
      const nginxTunnel = tunnelled && String(rule.tunnelMode ?? "").trim().toLowerCase() === "nginx_stream";
      if (nginxTunnel) {
        warnings.push("按访客固定要知道访客是谁：Nginx 隧道传不了访客地址，调度器只看得到本机，所有访客会落在同一条路径上。要按访客分，改用 GOST 隧道，并在隧道设置里打开「出口发送到目标」（落地得认 PROXY 头）。");
      } else if (tunnelled) {
        warnings.push("按访客固定要知道访客是谁：走隧道时调度器只看得到本机，所有访客会落在同一条路径上。在隧道设置里打开 PROXY Protocol 的「出口发送到目标」可以解决（落地得认 PROXY 头）。");
      } else {
        warnings.push(`按访客固定要知道访客是谁：${forwardType} 转发时调度器只看得到本机，所有访客会落在同一条路径上。改用 gost 转发就能按访客分：面板会让 gost 给调度器加一个 PROXY 头，读完就扔，落地收不到。`);
      }
    }
  }

  const guards: RoutePolicyGuard[] = [
    {
      key: "failover",
      label: "挂了就切",
      value: failureThreshold > 1
        ? `探测连续失败 ${failureThreshold} 次才算异常，异常持续 ${formatPolicyDuration(failoverSeconds)}就切走${perSession ? "" : "；新连接拨不通也算一次失败"}`
        : `探测连续失败 ${formatPolicyDuration(failoverSeconds)}${perSession ? "" : "，或新连接拨不通"}`,
    },
  ];
  if (mode !== "weighted") {
    guards.push(autoFailback
      ? { key: "recover", label: "切回首选", value: `首选那条恢复后稳定 ${formatPolicyDuration(recoverSeconds)}` }
      : { key: "recover", label: "不切回", value: "当前这条不出问题就一直走它" });
    if (minHoldSeconds > 0) {
      guards.push({ key: "hold", label: "最短驻留", value: `切过去之后至少走 ${formatPolicyDuration(minHoldSeconds)}，线路挂了不受它限制` });
    }
  } else {
    guards.push({ key: "recover", label: "恢复后回来", value: `出问题的路径恢复后稳定 ${formatPolicyDuration(recoverSeconds)}，重新参与分配` });
  }
  if ((mode === "scheduled" || mode === "hybrid") && policy.prewarmSeconds > 0) {
    guards.push({
      key: "prewarm",
      label: "计划切换预热",
      value: `到点前 ${formatPolicyDuration(policy.prewarmSeconds)}开始探测目标路径${mode === "hybrid" ? "，预检不过就不切，继续走当前这条" : "，到点直接切"}`,
    });
  }
  const switchHint = perSession ? ROUTE_SWITCH_MODE_SESSION_HINTS[policy.switchMode] : ROUTE_SWITCH_MODE_INFO[policy.switchMode].hint;
  guards.push({
    key: "switch",
    label: perSession ? "旧会话" : "旧连接",
    value: `${ROUTE_SWITCH_MODE_INFO[policy.switchMode].label}：${switchHint.replace("（推荐）", "")}`,
  });

  const activeIndex = mode !== "weighted" && (report.kind === "current" || report.kind === "lastSwitch") ? report.index : null;
  let divergence: string | null = null;
  if (mode !== "weighted" && activeIndex !== null && preferredIndex !== null && activeIndex !== preferredIndex) {
    if (!autoFailback) {
      divergence = `首选是 ${label(preferredIndex)}，但「恢复后切回」关着：${label(activeIndex)} 不出问题就不会换过去。`;
    } else {
      const reasons = ["正挂着", `刚恢复还在观察（${formatPolicyDuration(recoverSeconds)}）`];
      if (minHoldSeconds > 0) reasons.push(`刚切过还在最短驻留（${formatPolicyDuration(minHoldSeconds)}）里`);
      if (mode === "hybrid") reasons.push("计划切换的预检没过");
      divergence = `首选是 ${label(preferredIndex)}，没走它：它可能${reasons.join("、")}。`;
    }
  }

  return {
    subject: "rule",
    perSession,
    mode,
    strategy,
    lines: paths.map((path, index) => ({
      index,
      label: label(index),
      endpoint: endpoints[index] || "",
      preferred: mode !== "weighted" && preferredIndex === index,
      active: activeIndex === index,
      note: path.issue ? describeRouteIssue(path.issue) : null,
      health: path.issue ? "down" : undefined,
    })),
    conditions,
    guards,
    preferredIndex: mode !== "weighted" ? preferredIndex : null,
    deciding,
    pin,
    report,
    divergence,
    warnings,
  };
}
/*
  ───────────────────────────── 转发组 ─────────────────────────────

  转发组（故障转移模式）和规则级主备是两套机器，但回答的是同一个问题：现在用的是哪个、
  为什么是它、什么时候会换。所以用同一份模型、同一块面板说话：

    · 规则级主备：Agent 在本地探、本地切，切的是出站；面板只能等它报告。
    · 转发组：面板每轮检查成员健康，切的是 DDNS 解析 —— 用户连的那个域名指向哪个成员。
      判断和执行都在面板（server/repositories/forwardGroupRepository.ts 的
      runForwardGroupFailoverForGroups），这里读的是面板自己写下的结论，不用猜。

  规矩只有一层：按成员顺序，排在最前、而且健康的那个拿到解析。时段表、自动择优、人工
  钉住转发组都没有 —— 硬凑成同样的几行，只会让人以为能配。能手动做的是两件：把一个成员
  挪到第一位（改顺序，一直有效），和不等观察时间、立刻按顺序重选一次。
*/

export type RoutePolicyGroupMember = {
  id?: unknown;
  memberType?: unknown;
  hostId?: unknown;
  tunnelId?: unknown;
  priority?: unknown;
  isEnabled?: unknown;
  healthStatus?: unknown;
  lastLatencyMs?: unknown;
  failureSince?: unknown;
  healthySince?: unknown;
  /** 按组的记录类型取的地址（A 取 IPv4、AAAA 取 IPv6）；空串 = 这台没有这种地址。 */
  ddnsValue?: unknown;
  entryAddress?: unknown;
  host?: { name?: unknown } | null;
};

export type RoutePolicyGroup = {
  groupMode?: unknown;
  isEnabled?: unknown;
  domain?: unknown;
  recordType?: unknown;
  failoverSeconds?: unknown;
  recoverSeconds?: unknown;
  autoFailback?: unknown;
  chinaHealthCheckEnabled?: unknown;
  chinaHealthCheckTarget?: unknown;
  chinaHealthCheckMethod?: unknown;
  activeMemberId?: unknown;
  lastDdnsAt?: unknown;
  /** 有几条转发规则在用这个组。0 的时候面板不探转发（没东西可探），只看机器在不在线。 */
  templateRuleCount?: unknown;
  members?: unknown;
};

export type GroupRoutePolicyOptions = {
  nowMs?: number;
  timeZone?: string;
  /**
   * 系统 DDNS 开着没有（系统设置里 ddns.enabled，且服务商不是 disabled）。没开时面板照样
   * 按规矩挑成员，但只记成「建议入口」，解析不改。设置还没加载出来时不传，按开着说。
   */
  ddnsSwitching?: boolean;
  /** 成员怎么称呼。页面上有主机、隧道的名字表，用它；不给就用成员自带的主机名。 */
  memberLabel?: (member: RoutePolicyGroupMember) => string;
};

type GroupRecordType = "A" | "AAAA" | "CNAME";

/** 成员没有这种记录要的地址时，行上那句话。 */
const GROUP_MISSING_ADDRESS: Record<GroupRecordType, string> = {
  A: "没有 IPv4 地址",
  AAAA: "没有 IPv6 地址",
  CNAME: "没有入口域名",
};

function normalizeGroupRecordType(value: unknown): GroupRecordType {
  const text = String(value || "A").trim().toUpperCase();
  return text === "AAAA" || text === "CNAME" ? text : "A";
}

/** 和服务端 forwardGroupFailoverDelayMs / forwardGroupRecoverDelayMs 一样：空值用默认，最少 10 秒。 */
function groupDelaySeconds(value: unknown, fallback: number) {
  const seconds = Number(value || fallback);
  return Math.max(10, Number.isFinite(seconds) ? seconds : fallback);
}

function defaultGroupMemberLabel(member: RoutePolicyGroupMember) {
  if (member.memberType === "tunnel") return `隧道 #${member.tunnelId}`;
  return String(member.host?.name || "").trim() || `主机 #${member.hostId}`;
}

type GroupMemberState = {
  enabled: boolean;
  health: NetworkHealth;
  note: string | null;
  /** 不健康从什么时候起（毫秒）。 */
  failureMs: number | null;
  /** 健康从什么时候起（毫秒）。 */
  healthyMs: number | null;
};

export function describeGroupRoutePolicy(group: RoutePolicyGroup, options: GroupRoutePolicyOptions = {}): RoutePolicy | null {
  if (!group || String(group.groupMode || "failover") !== "failover") return null;
  const nowMs = options.nowMs ?? Date.now();
  const clock = (ms: number) => formatPolicyClock(ms, nowMs, options.timeZone);
  const groupEnabled = truthy(group.isEnabled, true);
  const domain = String(group.domain || "").trim();
  const recordType = normalizeGroupRecordType(group.recordType);
  const inUse = Number(group.templateRuleCount ?? 1) > 0;
  const ddnsSwitching = options.ddnsSwitching !== false;
  const failoverSeconds = groupDelaySeconds(group.failoverSeconds, 60);
  const recoverSeconds = groupDelaySeconds(group.recoverSeconds, 120);
  const autoFailback = truthy(group.autoFailback, true);
  const labelOf = options.memberLabel ?? defaultGroupMemberLabel;

  // 和服务端挑成员时一个次序：priority 小的在前，一样时 id 小的在前。
  const members = (Array.isArray(group.members) ? (group.members as RoutePolicyGroupMember[]) : [])
    .slice()
    .sort((left, right) => (Number(left.priority) || 0) - (Number(right.priority) || 0) || (Number(left.id) || 0) - (Number(right.id) || 0));
  const labels = members.map((member) => labelOf(member));

  const states: GroupMemberState[] = members.map((member) => {
    const enabled = truthy(member.isEnabled, true);
    if (!enabled) return { enabled, health: "standby", note: "已停用", failureMs: null, healthyMs: null };
    // 组停用了什么都不查；没有规则在用时不探转发，库里那份健康是旧的，不能拿来说事。
    if (!groupEnabled) return { enabled, health: "standby", note: null, failureMs: null, healthyMs: null };
    if (!inUse) return { enabled, health: "unknown", note: null, failureMs: null, healthyMs: null };
    const failureMs = timestampMillis(member.failureSince) || null;
    const healthyMs = timestampMillis(member.healthySince) || null;
    const status = String(member.healthStatus || "").trim().toLowerCase();
    if (status === "healthy") {
      const raw = member.lastLatencyMs;
      const latency = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
      return { enabled, health: "healthy", note: Number.isFinite(latency) ? `${Math.round(latency)}ms` : null, failureMs, healthyMs };
    }
    if (status === "unhealthy") {
      return { enabled, health: "down", note: failureMs ? `不健康，${clock(failureMs)} 起` : "不健康", failureMs, healthyMs };
    }
    return { enabled, health: "unknown", note: "等检测结果", failureMs, healthyMs };
  });

  const enabledIndexes = states.flatMap((state, index) => (state.enabled ? [index] : []));
  const preferredIndex = enabledIndexes[0] ?? null;
  const activeId = Number(group.activeMemberId) || 0;
  const activeFound = activeId > 0 ? members.findIndex((member) => Number(member.id) === activeId) : -1;
  const activeIndex = activeFound >= 0 ? activeFound : null;

  let report: RoutePolicyReport;
  if (!groupEnabled) report = { kind: "groupDisabled" };
  else if (!domain) report = { kind: "noDomain" };
  else if (activeIndex === null) report = { kind: "pending" };
  else if (!ddnsSwitching) report = { kind: "suggested", index: activeIndex };
  else {
    const writtenMs = timestampMillis(group.lastDdnsAt);
    report = { kind: "resolved", index: activeIndex, writtenAt: writtenMs ? Math.floor(writtenMs / 1000) : null };
  }
  const showsActive = report.kind === "resolved" || report.kind === "suggested";
  const switching = groupEnabled && !!domain && enabledIndexes.length > 0;

  const conditions: RoutePolicyCondition[] = [{
    kind: "order",
    key: "order",
    when: "按成员顺序",
    then: enabledIndexes.length > 0 ? enabledIndexes.map((index) => labels[index]).join(" → ") : "没有启用的成员",
    targetIndex: null,
    state: switching ? "deciding" : "idle",
  }];

  const probe = truthy(group.chinaHealthCheckEnabled, false)
    ? (() => {
      const method = normalizeForwardGroupHealthCheckMethod(group.chinaHealthCheckMethod);
      const target = String(group.chinaHealthCheckTarget || "").trim() || defaultHealthCheckTarget(method);
      return `，而且从成员上 ${method === "ping" ? "Ping" : "TCPing"} ${target} 能通`;
    })()
    : "";
  const guards: RoutePolicyGuard[] = [{
    key: "health",
    label: "怎么算健康",
    value: inUse ? `成员上的转发在跑、Agent 探测通过${probe}` : `机器在线${probe}（还没有规则用这个组，没有转发可探）`,
  }];
  if (domain) {
    /*
      「Agent 已判定」那半句不能省：Agent 自己报了失败 / 健康的，面板不再等观察时间（见
      evaluateMemberHealth 的 agentFailureFinal、allRuleHealthAgentFinal）。只写「满 60 秒」，
      人会以为切换总要等一分钟。
    */
    if (inUse) {
      guards.push({ key: "failover", label: "挂了就切", value: `在用的成员不健康满 ${formatPolicyDuration(failoverSeconds)}就换下一个健康的；Agent 已判定失败的不等` });
      guards.push(autoFailback
        ? { key: "recover", label: "切回首选", value: `更靠前的成员恢复了就切回：Agent 判定健康的马上切，否则等它稳定 ${formatPolicyDuration(recoverSeconds)}` }
        : { key: "recover", label: "不切回", value: "在用的成员不出问题就一直用它" });
    } else {
      // 没有规则时服务端每轮直接挑「排在最前、机器在线」的那个，不看「恢复后切回」。
      guards.push({ key: "failover", label: "挂了就切", value: `在用的成员机器离线满 ${formatPolicyDuration(failoverSeconds)}就换下一个在线的` });
      guards.push({ key: "recover", label: "切回首选", value: "一直挑排在最前、在线的那个：前面的一上线就换回去" });
    }
  }
  guards.push({
    key: "switch",
    label: "怎么切",
    value: !domain
      ? "没配 DDNS 域名，没有解析可切"
      : !ddnsSwitching
        ? `系统 DDNS 没开：挑出来的只记成建议入口，${domain} 的解析不会改`
        : `改 ${domain} 的 ${recordType} 记录，指向在用成员的地址`,
  });

  const since = (ms: number | null) => (ms ? `（${clock(ms)} 起）` : "");
  let divergence: string | null = null;
  if (showsActive && inUse && activeIndex !== null) {
    const active = states[activeIndex];
    const activeLabel = labels[activeIndex];
    const othersHealthy = states.some((state, index) => index !== activeIndex && state.enabled && state.health === "healthy");
    if (!active.enabled) {
      if (othersHealthy) divergence = `在用的 ${activeLabel} 已经停用，最晚满 ${formatPolicyDuration(failoverSeconds)}换走。`;
    } else if (active.health === "down") {
      if (othersHealthy) {
        const downSeconds = active.failureMs ? (nowMs - active.failureMs) / 1000 : null;
        divergence = downSeconds !== null && downSeconds < failoverSeconds
          ? `在用的 ${activeLabel} 不健康${since(active.failureMs)}，最晚满 ${formatPolicyDuration(failoverSeconds)}换到下一个健康的。`
          : `在用的 ${activeLabel} 不健康${since(active.failureMs)}，下一次检查就换走。`;
      }
    } else if (active.health === "unknown") {
      divergence = `在用的 ${activeLabel} 在等检测结果：解析先不动。`;
    } else if (preferredIndex !== null && preferredIndex !== activeIndex) {
      const preferred = states[preferredIndex];
      const preferredLabel = labels[preferredIndex];
      if (preferred.health === "down") {
        divergence = `首选 ${preferredLabel} 不健康${since(preferred.failureMs)}，所以用的是 ${activeLabel}。`;
      } else if (preferred.health === "unknown") {
        divergence = `首选 ${preferredLabel} 在等检测结果，先用着 ${activeLabel}。`;
      } else if (!autoFailback) {
        divergence = `首选 ${preferredLabel} 已经正常，但「恢复后切回」关着：${activeLabel} 不出问题就一直用它。`;
      } else {
        const upSeconds = preferred.healthyMs ? (nowMs - preferred.healthyMs) / 1000 : null;
        divergence = upSeconds !== null && upSeconds < recoverSeconds
          ? `首选 ${preferredLabel} 恢复了 ${formatPolicyDuration(upSeconds)}，最晚满 ${formatPolicyDuration(recoverSeconds)}切回。`
          : `首选 ${preferredLabel} 已经恢复，下一次检查就切回去。`;
      }
    }
  }

  const warnings: string[] = [];
  if (groupEnabled) {
    if (members.length === 0) warnings.push("还没有成员。");
    else if (enabledIndexes.length === 0) warnings.push("成员全停用了：没有能用的入口。");
    else if (!inUse) warnings.push("还没有转发规则用这个组：不探测转发，只看成员机器在不在线。");
    else if (enabledIndexes.every((index) => states[index].health === "down")) {
      warnings.push(domain ? "眼下没有健康的成员：解析先保持原样，等有成员恢复。" : "眼下没有健康的成员。");
    }
  }

  const missingAddress = GROUP_MISSING_ADDRESS[recordType];
  return {
    subject: "group",
    mode: "failover",
    strategy: "fallback",
    lines: members.map((member, index) => {
      // 列表接口按组的记录类型给了 ddnsValue：空串就是这台没有这种地址，解析指不过去。
      const hasDdnsValue = member.ddnsValue !== undefined && member.ddnsValue !== null;
      const endpoint = String((hasDdnsValue ? member.ddnsValue : member.entryAddress) || "").trim();
      const state = states[index];
      const notes = [state.note, !endpoint && state.enabled ? missingAddress : null].filter(Boolean);
      return {
        index,
        label: labels[index],
        endpoint,
        preferred: index === preferredIndex,
        active: showsActive && index === activeIndex,
        memberId: Number(member.id) || undefined,
        enabled: state.enabled,
        health: state.health,
        note: notes.length > 0 ? notes.join("，") : null,
      };
    }),
    conditions,
    guards,
    preferredIndex,
    deciding: switching ? "order" : null,
    pin: null,
    report,
    divergence,
    warnings,
  };
}

export type RoutePolicyReportText = {
  /** 「现在走 备用 1，21:30 起」 */
  text: string;
  /** 补一句这份报告能信到什么程度；没什么要补的是 null。 */
  note: string | null;
  /**
   * - normal：走的就是按规矩该走的那条（包括时段表、自动择优有意选的备用）
   * - deviated：没走首选 —— 多半首选那条出了事，值得看一眼
   * - warn：报上来的对不上清单；转发组解析指向的成员不健康
   * - muted：不知道
   *
   * 不按「是不是在备用上」定颜色：晚上按时段表走备用 1 是排好的，不是出事。
   */
  tone: "normal" | "deviated" | "warn" | "muted";
};

/** 「现在走哪条」那一句，给规则卡和策略面板共用。 */
export function describeRoutePolicyReport(policy: RoutePolicy, options: { nowMs?: number; timeZone?: string } = {}): RoutePolicyReportText {
  const nowMs = options.nowMs ?? Date.now();
  const since = (seconds: number | null) => seconds ? `，${formatPolicyClock(seconds * 1000, nowMs, options.timeZone)} 起` : "";
  const report = policy.report;
  const label = (index: number) => policy.lines[index]?.label || `第 ${index} 条`;
  const upgradeNote = `Agent 升级到 ${ACTIVE_LINE_SNAPSHOT_AGENT_VERSION} 后每次心跳确认。`;
  const lineTone = (index: number) => policy.preferredIndex !== null && index !== policy.preferredIndex ? "deviated" : "normal";
  // 轮询、随机、哈希没有「现在走哪条」：每条新连接各走各的，报一条出来只会误导。
  if (policy.mode === "weighted") {
    return { text: `${policy.perSession ? "每个新会话" : "每条新连接"}各走各的，共 ${policy.lines.length} 条`, note: null, tone: "normal" };
  }
  switch (report.kind) {
    case "current":
      return { text: `现在走 ${label(report.index)}${since(report.since)}`, note: null, tone: lineTone(report.index) };
    case "lastSwitch":
      return {
        text: `最近一次切到 ${label(report.index)}${since(report.since)}`,
        note: `这台 Agent 只在切换时报告：之后改过主备设置或重启过，就已经回到主线路了。${upgradeNote}`,
        tone: lineTone(report.index),
      };
    case "unlisted":
      return { text: `Agent 报的 ${report.target} 不在线路清单里`, note: "多半是刚改过配置，Agent 还没跟上。", tone: "warn" };
    case "pending":
      return policy.subject === "group"
        ? { text: "还没选出入口", note: null, tone: "muted" }
        : { text: "等 Agent 报告现在走哪条", note: null, tone: "muted" };
    case "noSwitch":
      return { text: "没有切换记录", note: upgradeNote, tone: "muted" };
    case "offline":
      return { text: "机器离线，不知道现在走哪条", note: null, tone: "muted" };
    case "unsupported":
      return { text: `Agent 早于 ${ROUTE_POLICY_AGENT_VERSION}，不报告现在走哪条`, note: null, tone: "muted" };
    case "resolved": {
      /*
        转发组的成员有自己的健康：解析指着的那个要是不健康（一个健康的都没有时，解析保持原样），
        不能因为「它就是首选」就标绿。
      */
      const health = policy.lines[report.index]?.health;
      return {
        text: `现在解析到 ${label(report.index)}`,
        // 不写成「21:30 起」：手动同步、面板重启后都会原样重写一遍，这个时刻只能说明「最近写过」。
        note: report.writtenAt ? `最近一次写入解析：${formatPolicyClock(report.writtenAt * 1000, nowMs, options.timeZone)}` : null,
        tone: health === "down" ? "warn" : health === "unknown" ? "muted" : health === "standby" ? "deviated" : lineTone(report.index),
      };
    }
    case "suggested":
      // 不染色：DDNS 没开多半是有意的（自己改解析），不是出事。
      return { text: `建议入口是 ${label(report.index)}`, note: "系统 DDNS 没开：面板只挑入口，不改解析。", tone: "muted" };
    case "noDomain":
      return { text: "只看成员健康，不切换", note: "没配 DDNS 域名。", tone: "muted" };
    case "groupDisabled":
      return { text: "转发组停用了：不检测、不切换", note: null, tone: "muted" };
  }
}

/** 钉住期限的几个常用选项（秒）。编辑框和策略面板共用，别各写一份。 */
export const PIN_DURATION_OPTIONS: Array<{ label: string; seconds: number | null }> = [
  { label: "30 分钟", seconds: 1800 },
  { label: "2 小时", seconds: 7200 },
  { label: "12 小时", seconds: 43200 },
  { label: "24 小时", seconds: 86400 },
  { label: "一直", seconds: null },
];

/** 钉住期限（Unix 秒）；null 是一直钉着。 */
export function pinUntilSeconds(durationSeconds: number | null, nowMs = Date.now()): number | null {
  if (durationSeconds === null) return null;
  return Math.floor(nowMs / 1000) + Math.max(60, Math.floor(durationSeconds));
}
