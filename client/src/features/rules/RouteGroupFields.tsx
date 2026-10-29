import { useState } from "react";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";

import { EntityTag } from "@/components/entity/EntityCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatFailoverEndpoint, parseFailoverEndpoint } from "@shared/failoverTargets";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import {
  MAX_FAILOVER_SCHEDULE_WINDOWS,
  describeFailoverScheduleWindow,
  type FailoverScheduleWindow,
} from "@shared/failoverSchedule";
import {
  MAX_ROUTE_HOPS,
  MAX_ROUTE_PATHS,
  ROUTE_GUARD_LIMITS,
  ROUTE_MODES,
  ROUTE_MODE_INFO,
  ROUTE_SPREADS,
  ROUTE_SPREAD_LABELS,
  ROUTE_SPREAD_SESSION_HINTS,
  ROUTE_SWITCH_MODES,
  ROUTE_SWITCH_MODE_INFO,
  ROUTE_SWITCH_MODE_SESSION_HINTS,
  applyRouteMode,
  describeRouteIssue,
  newRoutePath,
  routePathLabel,
  routePathLetter,
  routeTemplateGuards,
  routeModeHint,
  routeWeightShares,
  type RouteEndpoint,
  type RouteGroup,
  type RouteGroupPolicy,
  type RouteMode,
  type RoutePath,
} from "@shared/routeGroup";
import { PIN_DURATION_OPTIONS, formatPolicyClock, formatPolicyDuration, type RoutePolicy } from "@shared/routePolicy";
import { ConditionBlock, PolicyGroup } from "./PolicyBlocks";
import { RoutePathCards, buildRoutePreviewStatus } from "./RouteBoard";
import { LinkSpreadPicker, linkChoiceClass } from "@/features/links/LinkSpreadPicker";

/*
  编辑框里「线路组」勾上之后的那一块：一个入口 + 多条路径 + 一个调度策略。

  上一版的「主备线路」切的是落地地址：备用只是一个 host:port，要走中转得另建一条转发再把
  地址抄进来。这里一条线是一条**路径**：入口 → 中转 → … → 落地，中转从主机列表里挑，落地
  留空就是上面填的目标。中转机上的中继规则由面板按需生成，用户不用管。

  从上往下：
    1. 线路：每条路径一行 —— 字母、名字、经过哪几台中转、落地。
    2. 怎么用这些线路：六种策略模板，选一种，切换保护的参数按推荐值预填。定时 / 混合
       在这里直接配时段表，手动在这里直接选走哪条，权重负载在这里选分法、填权重。
    3. 一句话：按现在这套设置，流量会怎么走。
    4. 高级策略：切换保护（连续失败次数、持续多久、恢复稳定多久、最短驻留、切不切回）、
       择优门槛、计划切换预热、旧连接怎么办、应急人工指定、每条路径的探测地址。
       折起来时折叠条上列出改过模板值的项；有改过的，打开编辑框直接展开。
*/

export type RouteHostOption = {
  id: number;
  name: string;
  isOnline?: boolean | null;
  agentVersion?: string | null;
};

export type RouteGroupFieldsProps = {
  value: RouteGroup;
  onChange: (next: RouteGroup) => void;
  /** 能当中转的主机（用户看得见的）；入口机器自己会被排除。 */
  hosts: RouteHostOption[];
  /** 能不能加中转；转发组上的规则这一版不行（中继要按入口机各建一份）。 */
  allowHops?: boolean;
  entryHostId: number | null;
  /** 规则自己的目标（`地址:端口`）；没写落地的路径走它。还没填是空串。 */
  mainAddress: string;
  /** 拿当前表单算出来的策略（此刻哪层在决定）；算不出是 null。 */
  policy: RoutePolicy | null;
  /** 时段表按哪个时区计时。 */
  scheduleTimeZone: string;
  nowMs?: number;
  /** 钉住期限按哪个时区显示；默认看的人自己的时区。 */
  timeZone?: string;
  /** 「高级策略」一开始展不展开；不给就看有没有改过模板值。 */
  defaultAdvancedOpen?: boolean;
  /** 规则的协议（tcp / udp / both）：只转 UDP 的路径没有握手可探，健康检查的说法不一样。 */
  protocol?: string;
  /** 「我的节点」：路径的落地可以直接选一个，地址端口由面板从节点解析、节点地址变了跟着改。 */
  nodeOptions?: RouteNodeOption[];
  /** 规则的源端口：预览里入口节点写它。 */
  entrySourcePort?: number;
};

export type RouteNodeOption = { id: number; name: string; address: string; port: number; protocol?: string };

/** 小块选择：选中是整块反白，和策略面板、主机分组同一套（样式在 features/links/LinkSpreadPicker.tsx）。 */
const choiceClass = linkChoiceClass;

/** 策略模板 / 旧连接：名字下面带一句它会怎么做，选中同样整块反白。 */
function templateChoiceClass(active: boolean) {
  return cn(
    "flex min-w-0 flex-col items-start gap-0.5 rounded-[var(--fx-radius-control)] px-3 py-2 text-left transition-colors",
    active
      ? "bg-[var(--fx-text)] text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-foreground hover:border-[var(--fx-stroke)]",
  );
}

function NumberField({
  label,
  hint,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <FormField className="flex min-w-0 flex-col gap-1">
      <Label className="text-meta font-medium">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(parseInt(event.target.value) || 0)}
          className="h-9 pr-7"
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-meta text-muted-foreground">{unit}</span>
      </div>
      <span className="text-meta leading-4 text-muted-foreground">{hint}</span>
    </FormField>
  );
}

/** `地址:端口` 输入框的当场校验；空串是「留空」，不报错。 */
export function routeEndpointError(text: string): string | null {
  const parsed = parseRouteEndpoint(text);
  if (parsed === null) return null;
  return "error" in parsed ? parsed.error : null;
}

/** `地址:端口` → 端点；空串是 null，写坏了带 error。 */
function parseRouteEndpoint(text: string): RouteEndpoint | { error: string } | null {
  const parsed = parseFailoverEndpoint(text);
  if (!parsed) return null;
  if ("error" in parsed) return parsed;
  if (!(parsed.port >= 1 && parsed.port <= 65535)) return { error: "端口必须在 1-65535 之间" };
  return { ip: parsed.host, port: parsed.port };
}

function endpointText(endpoint: RouteEndpoint | null): string {
  return endpoint ? formatFailoverEndpoint(endpoint.ip, endpoint.port) : "";
}

/**
 * 界面上的线路组 → 提交给服务端的那份。
 *
 * 只带用户能改的字段：dial / issue 是面板解析出来的，界面只读，传上去也会被重算。时段表只在
 * 定时 / 混合下带，指定只在非权重负载下带 —— 换了模式之后界面上那份还留着（改回来就在），
 * 但发上去会被服务端拒绝，所以这里按模式归零。
 */
export function routeGroupPayload(group: RouteGroup) {
  const { policy } = group;
  const usesSchedule = policy.mode === "scheduled" || policy.mode === "hybrid";
  return {
    paths: group.paths.map((path) => ({
      key: path.key,
      name: path.name.trim(),
      hops: path.hops,
      dest: path.dest,
      weight: path.weight,
      probe: path.probe,
    })),
    mode: policy.mode,
    spread: policy.spread,
    schedule: usesSchedule && policy.schedule && policy.schedule.windows.length > 0 ? policy.schedule : null,
    pin: policy.mode === "weighted" || !policy.pin ? null : { index: policy.pin.index, untilMs: policy.pin.untilMs },
    failureThreshold: policy.failureThreshold,
    failoverSeconds: policy.failoverSeconds,
    recoverSeconds: policy.recoverSeconds,
    minHoldSeconds: policy.minHoldSeconds,
    autoFailback: policy.autoFailback,
    scoreMargin: policy.scoreMargin,
    scoreHoldSeconds: policy.scoreHoldSeconds,
    prewarmSeconds: policy.prewarmSeconds,
    switchMode: policy.switchMode,
  };
}

export type RoutePlainOptions = {
  /** 纯 UDP 规则：Agent 按会话挑路径，没有「连接」，说法换成会话。 */
  perSession?: boolean;
};

/** 一两句大白话：按现在这套设置，流量会怎么走。 */
export function describeRouteGroupPlainly(group: RouteGroup, options: RoutePlainOptions = {}): string {
  const { paths, policy } = group;
  const perSession = options.perSession === true;
  const label = (index: number) => routePathLabel(paths[index], index);
  if (paths.length < 2) return "还没有第二条路径。至少加一条，主线路出问题时才有地方可换。";
  const failover = policy.failureThreshold > 1
    ? `连续 ${policy.failureThreshold} 次探测不通、持续 ${formatPolicyDuration(policy.failoverSeconds)}`
    : `连续 ${formatPolicyDuration(policy.failoverSeconds)}探测不通`;
  const recover = formatPolicyDuration(policy.recoverSeconds);
  const hold = policy.minHoldSeconds > 0 ? `切过去至少走 ${formatPolicyDuration(policy.minHoldSeconds)}，` : "";
  const back = policy.autoFailback ? `首选恢复并稳定 ${recover}后自动切回。` : "首选恢复了也不切回，当前这条不出问题就一直走它。";
  const old = perSession
    ? policy.switchMode === "force"
      ? "每次切换都丢掉旧会话，下一个包改走新路径。"
      : policy.switchMode === "fast"
        ? "路径挂了会丢掉它上面的会话，下一个包改走新路径；其余切换不动旧会话。"
        : "切换只影响新会话，已有的会话留在原路径。"
    : policy.switchMode === "force"
      ? "每次切换都断开旧连接。"
      : policy.switchMode === "fast"
        ? "线路挂了会断开它上面的旧连接让客户端重连，其余切换不动旧连接。"
        : "切换只影响新连接，旧连接留在原线路。";
  switch (policy.mode) {
    case "failover":
      return `平时都走 ${label(0)}；${failover}就换到下一条，${hold}${back}${old}`;
    case "scheduled": {
      const windows = policy.schedule?.windows.length || 0;
      return `按时段表定首选（${windows} 段），时段外回 ${label(0)}；首选${failover}就往下换，${back}${old}`;
    }
    case "manual": {
      const pinned = policy.pin ? label(policy.pin.index) : "你指定的那条";
      return `一直走 ${pinned}，直到你换；它${failover}才临时往下换，恢复并稳定 ${recover}后回来。${old}`;
    }
    case "smart":
      return `按评分（延迟、丢包、抖动、可用率）走最好的一条：候选高出当前 ${policy.scoreMargin} 分、连续 ${formatPolicyDuration(policy.scoreHoldSeconds)}才换，不来回漂；${failover}照样立刻往下换。${old}`;
    case "hybrid": {
      const windows = policy.schedule?.windows.length || 0;
      const prewarm = policy.prewarmSeconds > 0 ? `到点前 ${formatPolicyDuration(policy.prewarmSeconds)}先预热预检，预检不过就不切；` : "";
      return `时段表定首选（${windows} 段），${prewarm}时段外按评分走最好的一条；${failover}照样立刻往下换。${old}`;
    }
    case "weighted": {
      const skip = `哪条${failover}就先跳过它，恢复并稳定 ${recover}后重新参与。`;
      // UDP 读不到访客地址：「按访客固定」在这里是按会话固定，单独说清楚。
      if (perSession && policy.spread === "ip_hash") {
        return `UDP 分不出访客，按访客固定在这里是按会话固定：每个会话一直走同一条，同一个访客的不同会话可能分到不同路径；${skip}`;
      }
      const shares = routeWeightShares(paths);
      const spread = policy.spread === "weighted"
        ? `按权重分（${paths.map((_, index) => `${label(index)} ${shares[index]}%`).join(" / ")}）`
        : policy.spread === "round_robin"
          ? "轮流走每一条"
          : policy.spread === "random"
            ? "随机挑一条能用的"
            : "按来源 IP 固定走一条";
      return perSession ? `每个新会话${spread}，旧会话不动；${skip}` : `每条新连接${spread}，旧连接不动；${skip}`;
    }
  }
}

export type RouteAdvancedSummaryInput = {
  policy: RouteGroupPolicy;
  probes: number;
};

/** 「高级策略」折起来时挂在折叠条上的摘要：只列和模板值不一样的。 */
export function summarizeRouteAdvanced({ policy, probes }: RouteAdvancedSummaryInput): string[] {
  const template = routeTemplateGuards(policy.mode);
  const items: string[] = [];
  if (policy.failureThreshold !== template.failureThreshold) items.push(`连续失败 ${policy.failureThreshold} 次`);
  if (policy.failoverSeconds !== template.failoverSeconds) items.push(`异常 ${formatPolicyDuration(policy.failoverSeconds)}就切`);
  if (policy.recoverSeconds !== template.recoverSeconds) items.push(`恢复观察 ${formatPolicyDuration(policy.recoverSeconds)}`);
  if (policy.mode !== "weighted") {
    if (policy.minHoldSeconds !== template.minHoldSeconds) items.push(policy.minHoldSeconds > 0 ? `最短驻留 ${formatPolicyDuration(policy.minHoldSeconds)}` : "不限驻留");
    if (policy.autoFailback !== template.autoFailback) items.push(policy.autoFailback ? "恢复后切回" : "恢复后不切回");
  }
  if ((policy.mode === "smart" || policy.mode === "hybrid") && (policy.scoreMargin !== template.scoreMargin || policy.scoreHoldSeconds !== template.scoreHoldSeconds)) {
    items.push(`择优门槛 ${policy.scoreMargin} 分 / ${formatPolicyDuration(policy.scoreHoldSeconds)}`);
  }
  if ((policy.mode === "scheduled" || policy.mode === "hybrid") && policy.prewarmSeconds !== template.prewarmSeconds) {
    items.push(policy.prewarmSeconds > 0 ? `预热 ${formatPolicyDuration(policy.prewarmSeconds)}` : "不预热");
  }
  if (policy.switchMode !== "smooth") items.push(ROUTE_SWITCH_MODE_INFO[policy.switchMode].label);
  if (policy.mode !== "manual" && policy.mode !== "weighted" && policy.pin) items.push("人工指定");
  if (probes > 0) items.push(`探测地址 ${probes} 条`);
  return items;
}

const DAY_PRESETS = {
  all: [] as number[],
  weekday: [1, 2, 3, 4, 5],
  weekend: [0, 6],
};

function dayPresetOf(days: number[]): keyof typeof DAY_PRESETS {
  if (days.length === 0) return "all";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "weekend";
  return "weekday";
}

export function RouteGroupFields({
  value,
  onChange,
  hosts,
  allowHops = true,
  entryHostId,
  mainAddress,
  policy,
  scheduleTimeZone,
  nowMs,
  timeZone,
  defaultAdvancedOpen,
  protocol = "tcp",
  nodeOptions = [],
  entrySourcePort,
}: RouteGroupFieldsProps) {
  const now = nowMs ?? Date.now();
  const udpOnly = normalizeForwardRuleProtocol(protocol) === "udp";
  const { paths, policy: routePolicy } = value;
  const mode = routePolicy.mode;
  const usesSchedule = mode === "scheduled" || mode === "hybrid";
  const usesScore = mode === "smart" || mode === "hybrid";
  const weighted = mode === "weighted";
  const windows = routePolicy.schedule?.windows || [];
  const hostName = (hostId: number) => hosts.find((host) => Number(host.id) === hostId)?.name || `主机 ${hostId}`;
  const shares = routeWeightShares(paths);
  const label = (index: number) => routePathLabel(paths[index], index);
  const deciding = policy?.deciding ?? null;
  const conditionFor = (windowIndex: number) => policy?.conditions.find((condition) => condition.windowIndex === windowIndex);
  const probes = paths.filter((path) => !!path.probe).length;
  const advancedSummary = summarizeRouteAdvanced({ policy: routePolicy, probes });
  const [advancedOpen, setAdvancedOpen] = useState(() => defaultAdvancedOpen ?? advancedSummary.length > 0);
  /*
    这一次打开编辑框里选过的钉住时长。只用来标出选中的是哪一块：期限本身存的是一个时刻，
    过一秒就和任何一个「现在 + N」对不上。
  */
  const [pinChoice, setPinChoice] = useState<number | null | undefined>(undefined);
  /*
    正在输入的那一格先不报错：敲到「10.0.0.2」还没敲冒号就跳出一句「格式不对」，是在
    打断人。离开这一格（或者本来就填着）再说。地址框里存的是文本，离开时才解析成端点。
  */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingField, setEditingField] = useState<string | null>(null);
  const draftOf = (field: string, endpoint: RouteEndpoint | null) => (field in drafts ? drafts[field] : endpointText(endpoint));
  const shownError = (field: string, text: string) => (editingField === field ? null : routeEndpointError(text));

  const setPolicy = (patch: Partial<RouteGroupPolicy>) => onChange({ ...value, policy: { ...routePolicy, ...patch } });
  const setPaths = (next: RoutePath[]) => onChange({ ...value, paths: next });
  const patchPath = (index: number, patch: Partial<RoutePath>) => setPaths(paths.map((path, position) => (position === index ? { ...path, ...patch } : path)));
  const removePath = (index: number) => {
    const next = paths.filter((_, position) => position !== index);
    // 时段表、指定里指着后面那几条的序号跟着往前挪；指着被删的那条的退回主线路。
    const remap = (target: number) => (target === index ? 0 : target > index ? target - 1 : target);
    const schedule = routePolicy.schedule
      ? { ...routePolicy.schedule, windows: routePolicy.schedule.windows.map((window) => ({ ...window, targetIndex: remap(window.targetIndex) })) }
      : null;
    const pin = routePolicy.pin ? { ...routePolicy.pin, index: remap(routePolicy.pin.index) } : null;
    onChange({ paths: next, policy: { ...routePolicy, schedule, pin } });
  };
  const changeMode = (next: RouteMode) => onChange({
    ...value,
    policy: applyRouteMode(routePolicy, next, { timezone: scheduleTimeZone, pathCount: paths.length }),
  });
  const setWindows = (next: FailoverScheduleWindow[]) => setPolicy({
    schedule: next.length > 0 ? { timezone: scheduleTimeZone, windows: next } : null,
  });
  const commitEndpoint = (index: number, field: "dest" | "probe", text: string) => {
    const parsed = parseRouteEndpoint(text);
    // 写错的先留在框里（框上会报错），路径里的值不动：别把一个坏地址存进去。
    if (parsed && "error" in parsed) return;
    patchPath(index, { [field]: parsed } as Partial<RoutePath>);
  };
  const hopCandidates = (path: RoutePath) => hosts.filter((host) => Number(host.id) !== Number(entryHostId || 0) && !path.hops.includes(Number(host.id)));

  const pinPicker = (advanced: boolean) => (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="强制走哪条路径">
        {advanced ? (
          <button
            type="button"
            aria-pressed={!routePolicy.pin}
            className={choiceClass(!routePolicy.pin)}
            onClick={() => { setPinChoice(undefined); setPolicy({ pin: null }); }}
          >
            自动
          </button>
        ) : null}
        {paths.map((path, index) => (
          <button
            key={path.key}
            type="button"
            aria-pressed={routePolicy.pin?.index === index}
            className={choiceClass(routePolicy.pin?.index === index)}
            onClick={() => {
              if (routePolicy.pin) {
                setPolicy({ pin: { ...routePolicy.pin, index } });
                return;
              }
              // 应急指定默认 2 小时，不默认「一直」：处理完没人记得关。手动主备本来就是一直。
              setPinChoice(advanced ? 7200 : null);
              setPolicy({ pin: { index, untilMs: advanced ? now + 7200 * 1000 : null } });
            }}
          >
            {label(index)}
          </button>
        ))}
      </div>
      {routePolicy.pin && advanced ? (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="强制走多久">
            {PIN_DURATION_OPTIONS.map((option) => {
              const active = option.seconds === null ? routePolicy.pin!.untilMs === null : pinChoice === option.seconds;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  className={choiceClass(active)}
                  onClick={() => {
                    setPinChoice(option.seconds);
                    setPolicy({ pin: { index: routePolicy.pin!.index, untilMs: option.seconds === null ? null : now + Math.max(60, option.seconds) * 1000 } });
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs leading-5 text-[var(--fx-warn-text)]">
            {routePolicy.pin.untilMs === null
              ? "一直钉着：时段表和评分都不会再改变首选，直到你在这里改回「自动」。"
              : `到 ${formatPolicyClock(routePolicy.pin.untilMs, now, timeZone)} 自动交回。指定的那条要是挂了，仍然会往下切。`}
          </p>
        </>
      ) : null}
    </div>
  );

  const scheduleEditor = (
    <div className="flex min-w-0 flex-col gap-2" data-testid="route-schedule">
      {windows.map((window, index) => {
        const condition = conditionFor(index);
        const patch = (next: Partial<FailoverScheduleWindow>) => setWindows(windows.map((item, position) => (
          position === index ? { ...item, ...next } : item
        )));
        return (
          <div key={index} className="flex min-w-0 flex-col gap-1" data-state={condition?.state || "idle"}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Select value={dayPresetOf(window.days)} onValueChange={(preset) => patch({ days: DAY_PRESETS[preset as keyof typeof DAY_PRESETS] })}>
                <SelectTrigger className="h-8 w-24 text-xs" aria-label={`第 ${index + 1} 个时段：星期`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">每天</SelectItem>
                  <SelectItem value="weekday">工作日</SelectItem>
                  <SelectItem value="weekend">周末</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="time"
                value={window.from}
                onChange={(event) => patch({ from: event.target.value })}
                className="h-8 w-36 text-xs sm:w-28"
                aria-label={`第 ${index + 1} 个时段：开始时间`}
              />
              <span className="text-xs text-muted-foreground">至</span>
              <Input
                type="time"
                value={window.to}
                onChange={(event) => patch({ to: event.target.value })}
                className="h-8 w-36 text-xs sm:w-28"
                aria-label={`第 ${index + 1} 个时段：结束时间`}
              />
              <Select value={String(window.targetIndex)} onValueChange={(target) => patch({ targetIndex: Number(target) })}>
                <SelectTrigger className="h-8 w-32 text-xs" aria-label={`第 ${index + 1} 个时段：首选哪条路径`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {paths.map((path, position) => (
                    <SelectItem key={path.key} value={String(position)}>{routePathLetter(position)} {label(position)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={`删除第 ${index + 1} 个时段`}
                onClick={() => setWindows(windows.filter((_, position) => position !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              {condition?.state === "deciding" ? <EntityTag tone="path">此刻</EntityTag> : null}
            </div>
            {/* 配好之后用一句话复述一遍：跨午夜那一段最容易理解反。 */}
            <p className="text-xs leading-5 text-muted-foreground">
              {describeFailoverScheduleWindow(window, label(Math.min(window.targetIndex, paths.length - 1)))}
              {condition?.state === "overridden" ? <span className="text-[var(--fx-warn-text)]">　此刻本该轮到它，被人工指定压着</span> : null}
            </p>
          </div>
        );
      })}
      {windows.length < MAX_FAILOVER_SCHEDULE_WINDOWS ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-fit text-xs"
          onClick={() => setWindows([...windows, { days: [1, 2, 3, 4, 5], from: "18:00", to: "01:00", targetIndex: Math.min(1, paths.length - 1) }])}
        >
          添加时段
        </Button>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">按 {scheduleTimeZone} 计时。时段只决定首选，切不切得过去仍然看健康检查。</p>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section className="flex min-w-0 flex-col gap-2" aria-label="线路" data-testid="route-paths">
        {paths.map((path, index) => {
          const destField = `dest-${path.key}`;
          const destText = draftOf(destField, path.dest);
          const destError = shownError(destField, destText);
          const candidates = hopCandidates(path);
          return (
            <div key={path.key} className="flex min-w-0 flex-col gap-1.5 rounded-[var(--fx-radius-control)] bg-[var(--fx-l1-surface)] px-3 py-2.5" data-testid="route-path">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--fx-path-soft)] text-xs font-semibold text-[var(--fx-path)]" aria-hidden="true">
                  {routePathLetter(index)}
                </span>
                <Input
                  value={path.name}
                  onChange={(event) => patchPath(index, { name: event.target.value.slice(0, 40) })}
                  placeholder={index === 0 ? "主线路" : `备用 ${index}`}
                  aria-label={`路径 ${routePathLetter(index)} 的名字`}
                  className="h-8 min-w-0 flex-1 text-sm"
                />
                {weighted && routePolicy.spread === "weighted" ? (
                  <div className="relative w-[4.5rem] shrink-0">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={ROUTE_GUARD_LIMITS.weight.min}
                      max={ROUTE_GUARD_LIMITS.weight.max}
                      value={path.weight}
                      onChange={(event) => patchPath(index, { weight: Math.min(ROUTE_GUARD_LIMITS.weight.max, Math.max(ROUTE_GUARD_LIMITS.weight.min, parseInt(event.target.value) || 1)) })}
                      aria-label={`路径 ${routePathLetter(index)} 的权重`}
                      className="h-8 pr-9 text-sm"
                    />
                    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-meta text-muted-foreground">{shares[index]}%</span>
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="fx-compact-touch h-8 w-8 shrink-0 text-muted-foreground"
                  aria-label={`删掉路径 ${routePathLetter(index)}`}
                  disabled={paths.length <= 2}
                  title={paths.length <= 2 ? "线路组至少要两条路径" : undefined}
                  onClick={() => removePath(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {/* 入口 → 中转 → … → 落地：路径本身。中转是一个个可摘掉的小块，落地是一格。 */}
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">入口</span>
                {path.hops.map((hopId, hopIndex) => (
                  <span key={`${hopId}-${hopIndex}`} className="flex items-center gap-1">
                    <span aria-hidden="true" className="text-muted-foreground">→</span>
                    <span className="inline-flex h-7 items-center gap-1 rounded-[var(--fx-radius-control)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l2-group)] pl-2 pr-1">
                      {hostName(hopId)}
                      <button
                        type="button"
                        className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                        aria-label={`从路径 ${routePathLetter(index)} 里去掉中转 ${hostName(hopId)}`}
                        onClick={() => patchPath(index, { hops: path.hops.filter((_, position) => position !== hopIndex) })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </span>
                ))}
                {allowHops && path.hops.length < MAX_ROUTE_HOPS && candidates.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="sm" className="fx-compact-touch h-7 gap-1 px-2 text-xs">
                        <Plus className="h-3 w-3" />
                        {path.hops.length === 0 ? "经过中转" : "再加一跳"}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                      {candidates.map((host) => (
                        <DropdownMenuItem key={host.id} onSelect={() => patchPath(index, { hops: [...path.hops, Number(host.id)] })}>
                          {host.name}
                          {host.isOnline === false ? <span className="ml-1 text-muted-foreground">（离线）</span> : null}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                <span aria-hidden="true" className="text-muted-foreground">→</span>
                {/* 「落地」和输入框绑在一起换行：窄屏上不会出现「落地」两个字留在上一行。 */}
                <span className="flex min-w-[12rem] flex-1 items-center gap-1">
                  <span className="shrink-0 text-muted-foreground">落地</span>
                  {path.destNodeId ? (
                    /* 选的是我的节点：画成一块，地址只读；× 回到手填。 */
                    <span className="inline-flex h-7 min-w-0 items-center gap-1 rounded-[var(--fx-radius-control)] bg-[var(--fx-healthy-soft)] pl-2 pr-1 text-xs text-[var(--fx-healthy-text)]" data-testid="route-dest-node">
                      <span className="truncate">{nodeOptions.find((node) => node.id === path.destNodeId)?.name || `节点 #${path.destNodeId}`}</span>
                      {path.dest ? <span className="truncate font-mono opacity-75">{formatFailoverEndpoint(path.dest.ip, path.dest.port)}</span> : null}
                      <button
                        type="button"
                        className="rounded-full p-0.5 hover:bg-black/10"
                        aria-label={`路径 ${routePathLetter(index)} 的落地不再跟随节点`}
                        onClick={() => { const { [destField]: _dropped, ...rest } = drafts; setDrafts(rest); patchPath(index, { destNodeId: null, dest: null }); }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : (
                    <FormField className="contents">
                      <Input
                        value={destText}
                        onChange={(event) => setDrafts({ ...drafts, [destField]: event.target.value.replace(/\s+/g, "") })}
                        onFocus={() => setEditingField(destField)}
                        onBlur={() => { setEditingField(null); commitEndpoint(index, "dest", destText); }}
                        // 越短越好：手机上框很窄，长了就被截成半句。不填就走规则的目标地址（在上面）。
                        placeholder="IP:端口，留空同目标"
                        aria-label={`路径 ${routePathLetter(index)} 的落地`}
                        className="h-7 min-w-0 flex-1 font-mono text-xs"
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={destError ? true : undefined}
                      />
                    </FormField>
                  )}
                  {!path.destNodeId && nodeOptions.length > 0 ? (
                    <Select
                      value=""
                      onValueChange={(selected) => {
                        const node = nodeOptions.find((item) => String(item.id) === selected);
                        if (!node) return;
                        const { [destField]: _dropped, ...rest } = drafts;
                        setDrafts(rest);
                        patchPath(index, { destNodeId: node.id, dest: { ip: node.address, port: node.port } });
                      }}
                    >
                      <SelectTrigger className="h-7 w-auto shrink-0 gap-1 border-dashed px-2 text-xs" aria-label={`路径 ${routePathLetter(index)} 的落地选我的节点`}>
                        <SelectValue placeholder="选节点" />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {nodeOptions.map((node) => (
                          <SelectItem key={node.id} value={String(node.id)}>
                            {node.name}{node.protocol ? ` · ${node.protocol}` : ""} · {node.address}:{node.port}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </span>
              </div>
              {destError ? <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{destError}</p> : null}
              {path.issue ? <p className="text-meta leading-5 text-[var(--fx-warn-text)]">眼下用不了：{describeRouteIssue(path.issue)}</p> : null}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="fx-compact-touch h-8 gap-1 text-meta"
            disabled={paths.length >= MAX_ROUTE_PATHS}
            onClick={() => setPaths([...paths, newRoutePath(paths.length)])}
          >
            <Plus className="h-3.5 w-3.5" />
            {paths.length >= MAX_ROUTE_PATHS ? `最多 ${MAX_ROUTE_PATHS} 条` : "添加路径"}
          </Button>
          <span className="text-meta text-muted-foreground">{allowHops ? "中转机上的中继由面板自动建，不用手配。" : "转发组上的规则暂不支持经过中转。"}</span>
        </div>
      </section>

      <PolicyGroup title="怎么用这些线路">
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="怎么用这些线路">
          {ROUTE_MODES.map((candidate) => {
            const info = ROUTE_MODE_INFO[candidate];
            const active = mode === candidate;
            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={active}
                className={templateChoiceClass(active)}
                onClick={() => changeMode(candidate)}
              >
                <span className="flex items-center gap-1.5 text-secondary-type font-medium">
                  {info.template}
                  <span className={cn("text-meta font-normal", active ? "opacity-80" : "text-muted-foreground")}>{info.label}</span>
                </span>
                <span className={cn("text-meta leading-4", active ? "opacity-80" : "text-muted-foreground")}>{routeModeHint(candidate, udpOnly)}</span>
              </button>
            );
          })}
        </div>
        {mode === "manual" ? (
          <ConditionBlock title="走哪条" detail="一直走它，直到你换；它挂了才临时往下切" deciding={deciding === "pin"} testId="policy-pin">
            {pinPicker(false)}
          </ConditionBlock>
        ) : null}
        {usesSchedule ? (
          <ConditionBlock
            title="时段表"
            detail={mode === "hybrid" ? "时段内按它定首选，时段外按评分走最好的一条" : "时段内按它定首选，时段外回主线路"}
            deciding={deciding === "schedule"}
            showTag={false}
            testId="policy-schedule"
          >
            {scheduleEditor}
          </ConditionBlock>
        ) : null}
        {weighted ? (
          <LinkSpreadPicker
            value={routePolicy.spread}
            options={ROUTE_SPREADS}
            labels={ROUTE_SPREAD_LABELS}
            onChange={(spread) => setPolicy({ spread })}
            ariaLabel={udpOnly ? "新会话怎么分" : "新连接怎么分"}
            hint={<>
              {udpOnly ? ROUTE_SPREAD_SESSION_HINTS[routePolicy.spread] : ROUTE_SPREAD_LABELS[routePolicy.spread].hint}
              {routePolicy.spread === "weighted" ? "；权重在上面每条路径的右边填。" : "。"}
            </>}
          />
        ) : null}
      </PolicyGroup>

      {/* 它会这样跑：拿还没保存的路径画成线路板那种链，下面一句大白话说策略。填着填着就看得见。 */}
      {policy && paths.length >= 2 ? (
        <section className="flex min-w-0 flex-col gap-1.5" data-testid="route-preview" aria-label="它会这样跑">
          <div className="text-meta text-muted-foreground">它会这样跑</div>
          <RoutePathCards
            preview
            policy={policy}
            status={buildRoutePreviewStatus({ paths, hosts, entryHostId, sourcePort: entrySourcePort, mainAddress })}
          />
        </section>
      ) : null}
      <p className="text-secondary-type leading-relaxed text-foreground" data-testid="route-plain" aria-live="polite">
        {describeRouteGroupPlainly(value, { perSession: udpOnly })}
      </p>
      <p className="text-xs leading-5 text-muted-foreground" data-testid="route-seamless-tip">
        线路组是按连接换路径，换的时候旧连接按上面说的处理。要连接不断的毫秒级切换：建一条 NEX 隧道，把几台中转的中转方式设成「热备」，每条连接同时连着全部中转，主的停了备用立刻接手。
      </p>
      {(policy?.warnings || []).map((warning) => (
        <p key={warning} className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
          {warning}
        </p>
      ))}

      <div className="flex min-w-0 flex-col border-t border-[var(--fx-stroke-weak)] pt-1">
        <button
          type="button"
          className="flex min-h-9 w-full min-w-0 items-center gap-2 text-left"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <span className="shrink-0 text-secondary-type font-medium">高级策略</span>
          {/* 折起来也得看得见里面动过什么 —— 收纳不是藏。 */}
          <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground" data-testid="route-advanced-summary">
            {advancedSummary.length > 0 ? advancedSummary.join(" · ") : "按模板预填，一般不用动"}
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
        </button>

        {advancedOpen ? (
          <div className="flex min-w-0 flex-col gap-4 pb-1 pt-2">
            <PolicyGroup
              title="切换保护"
              note="拦的是网络抖一下引起的 A → B → A → B：失败一次不切，连续几次才算异常，异常持续够久才切，恢复后稳定够久才切回，刚切过去至少驻留一阵。当前这条挂了时驻留不生效 —— 守着死路比抖动更糟。"
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <NumberField
                  label="连续失败"
                  hint="几次探测不通才算异常"
                  unit="次"
                  value={routePolicy.failureThreshold}
                  min={ROUTE_GUARD_LIMITS.failureThreshold.min}
                  max={ROUTE_GUARD_LIMITS.failureThreshold.max}
                  onChange={(failureThreshold) => setPolicy({ failureThreshold })}
                />
                <NumberField
                  label="异常多久切"
                  hint="持续异常多久才切走"
                  unit="秒"
                  value={routePolicy.failoverSeconds}
                  min={ROUTE_GUARD_LIMITS.failoverSeconds.min}
                  max={ROUTE_GUARD_LIMITS.failoverSeconds.max}
                  onChange={(failoverSeconds) => setPolicy({ failoverSeconds })}
                />
                <NumberField
                  label="恢复观察"
                  hint="恢复后要稳定多久"
                  unit="秒"
                  value={routePolicy.recoverSeconds}
                  min={ROUTE_GUARD_LIMITS.recoverSeconds.min}
                  max={ROUTE_GUARD_LIMITS.recoverSeconds.max}
                  onChange={(recoverSeconds) => setPolicy({ recoverSeconds })}
                />
                {!weighted ? (
                  <NumberField
                    label="最短驻留"
                    hint="切过去至少走多久，0 不限"
                    unit="秒"
                    value={routePolicy.minHoldSeconds}
                    min={ROUTE_GUARD_LIMITS.minHoldSeconds.min}
                    max={ROUTE_GUARD_LIMITS.minHoldSeconds.max}
                    onChange={(minHoldSeconds) => setPolicy({ minHoldSeconds })}
                  />
                ) : null}
              </div>
              {!weighted ? (
                <label className="flex w-fit items-start gap-2 text-sm">
                  <Checkbox
                    checked={routePolicy.autoFailback}
                    onCheckedChange={(checked) => setPolicy({ autoFailback: checked === true })}
                    aria-label="恢复后切回"
                    className="mt-0.5"
                  />
                  <span className="flex flex-col">
                    恢复后切回首选
                    <span className="text-xs text-muted-foreground">关着的话，当前这条不出问题就一直走它</span>
                  </span>
                </label>
              ) : null}
            </PolicyGroup>

            {usesScore ? (
              <PolicyGroup
                title="择优门槛"
                note="评分 0–100，由延迟、丢包、抖动、建连成功率、可用率算出（90 起是优、80 起是良、其余较差）。候选要比当前明显更好、而且持续一阵，才换 —— 不然线路会来回漂。"
              >
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="高出多少分"
                    hint="候选比当前至少高这么多"
                    unit="分"
                    value={routePolicy.scoreMargin}
                    min={ROUTE_GUARD_LIMITS.scoreMargin.min}
                    max={ROUTE_GUARD_LIMITS.scoreMargin.max}
                    onChange={(scoreMargin) => setPolicy({ scoreMargin })}
                  />
                  <NumberField
                    label="持续多久"
                    hint="明显更好要持续多久才换"
                    unit="秒"
                    value={routePolicy.scoreHoldSeconds}
                    min={ROUTE_GUARD_LIMITS.scoreHoldSeconds.min}
                    max={ROUTE_GUARD_LIMITS.scoreHoldSeconds.max}
                    onChange={(scoreHoldSeconds) => setPolicy({ scoreHoldSeconds })}
                  />
                </div>
              </PolicyGroup>
            ) : null}

            {usesSchedule ? (
              <PolicyGroup
                title="计划切换预热"
                note={mode === "hybrid"
                  ? "到点前先探测目标路径。预检不过就不切，继续走当前这条，并记一条「计划切换未执行」。"
                  : "到点前先探测目标路径，让它带着最新的健康状态上场；定时主备到点仍然按表切。"}
              >
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="提前多久"
                    hint="0 = 不预热"
                    unit="秒"
                    value={routePolicy.prewarmSeconds}
                    min={ROUTE_GUARD_LIMITS.prewarmSeconds.min}
                    max={ROUTE_GUARD_LIMITS.prewarmSeconds.max}
                    onChange={(prewarmSeconds) => setPolicy({ prewarmSeconds })}
                  />
                </div>
              </PolicyGroup>
            ) : null}

            <PolicyGroup title={udpOnly ? "切换时旧会话怎么办" : "切换时旧连接怎么办"}>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label={udpOnly ? "切换时旧会话怎么办" : "切换时旧连接怎么办"}>
                {ROUTE_SWITCH_MODES.map((switchMode) => {
                  const info = ROUTE_SWITCH_MODE_INFO[switchMode];
                  const hint = udpOnly ? ROUTE_SWITCH_MODE_SESSION_HINTS[switchMode] : info.hint;
                  const active = routePolicy.switchMode === switchMode;
                  return (
                    <button
                      key={switchMode}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={templateChoiceClass(active)}
                      onClick={() => setPolicy({ switchMode })}
                    >
                      <span className="text-secondary-type font-medium">{info.label}</span>
                      <span className={cn("text-meta leading-4", active ? "opacity-80" : "text-muted-foreground")}>{hint}</span>
                    </button>
                  );
                })}
              </div>
            </PolicyGroup>

            {mode !== "manual" && !weighted ? (
              <PolicyGroup title="应急人工指定">
                <ConditionBlock
                  title="人工指定"
                  detail={routePolicy.pin ? undefined : "强制走一条，到点自动交回；压过时段表和评分"}
                  deciding={deciding === "pin"}
                  testId="policy-pin"
                >
                  {pinPicker(true)}
                </ConditionBlock>
              </PolicyGroup>
            ) : null}

            <PolicyGroup
              title="健康检查"
              note={
                /*
                  这段必须说，而且必须说得具体：中转是 gost、realm 这类用户态转发时，连得上只说明
                  中转活着 —— 上游断了不会切，面板上一切正常。走中转的路径，面板会让每台中转机
                  自己探它的下一跳，所以中转到落地那段也看得见；直连的路径要探到落地本身。
                */
                udpOnly
                  // 只转 UDP：拨号地址上多半只有 UDP 服务，连 TCP 只会一直失败（agent 的 failoverProbeTarget）。
                  ? "每 5 秒探一次每条路径，同时每台中转探它的下一跳。UDP 没有握手：留空就 ping 路径的拨号地址，"
                    + "填了就连它的 TCP 端口。落地或第一跳中转禁 ping 的，一定要填一个。"
                  : "每 5 秒对每条路径连一次 TCP，同时每台中转探它的下一跳。留空就探路径的拨号地址；"
                    + "直连落地是用户态转发（gost、realm）时，给它填一个能反映整条路径的探测地址。"
              }
            >
              <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
                {paths.map((path, index) => {
                  const field = `probe-${path.key}`;
                  const text = draftOf(field, path.probe);
                  const error = shownError(field, text);
                  return (
                    <FormField key={path.key} className="contents">
                      <Label className="text-meta font-normal text-muted-foreground">{routePathLetter(index)} {label(index)}</Label>
                      <div className="flex min-w-0 flex-col gap-1">
                        <Input
                          value={text}
                          onChange={(event) => setDrafts({ ...drafts, [field]: event.target.value.replace(/\s+/g, "") })}
                          onFocus={() => setEditingField(field)}
                          onBlur={() => { setEditingField(null); commitEndpoint(index, "probe", text); }}
                          placeholder={udpOnly ? "留空就 ping 拨号地址" : "留空就探拨号地址"}
                          className="h-9 font-mono text-sm"
                          spellCheck={false}
                          autoComplete="off"
                          aria-invalid={error ? true : undefined}
                        />
                        {error ? <p className="text-meta leading-5 text-[var(--fx-warn-text)]">{error}</p> : null}
                      </div>
                    </FormField>
                  );
                })}
              </div>
            </PolicyGroup>
          </div>
        ) : null}
      </div>
    </div>
  );
}
