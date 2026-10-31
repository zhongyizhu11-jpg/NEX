import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Trash2 } from "lucide-react";

import { EntityTag } from "@/components/entity/EntityCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  ROUTE_GUARD_LIMITS,
  ROUTE_SPREADS,
  ROUTE_SPREAD_LABELS,
  ROUTE_SPREAD_SESSION_HINTS,
  ROUTE_SWITCH_MODES,
  ROUTE_SWITCH_MODE_INFO,
  ROUTE_SWITCH_MODE_SESSION_HINTS,
  applyRouteMode,
  routePathLabel,
  routeSwitchWithinSeconds,
  routePathLetter,
  routeTemplateGuards,
  type RouteEndpoint,
  type RouteGroup,
  type RouteGroupPolicy,
  type RouteMode,
} from "@shared/routeGroup";
import { PIN_DURATION_OPTIONS, formatPolicyClock, formatPolicyDuration, type RoutePolicy } from "@shared/routePolicy";
import { ConditionBlock, PolicyGroup } from "./PolicyBlocks";
import { LinkSpreadPicker, linkChoiceClass } from "@/features/links/LinkSpreadPicker";
import { RouteLinesEditor, expandForPreview, type RouteLineHost, type RouteLinePool, type RouteLineTunnel } from "./RouteLinesEditor";
import { LineCard, LineHint, LineSec, LineSegmented } from "@/features/lines/LineUi";
import { ROUTE_DELIVERY_INFO, normalizeRouteDelivery, type RouteDelivery } from "@shared/routeGroup";
import { newRouteLine, routeLinesFromPaths, serializeRouteLines, type RouteLine } from "@shared/routeLines";

/*
  编辑线路组（效果图 ②）的整块：线路详情第一页的线路（RouteLineInlineEditor.tsx，直接在详情里改）和
  规则表单里的线路组（RuleLineGroupField.tsx，直接摆在表单里）都是这一个。

  从上往下：
    1. 线路（RouteLinesEditor）：主线路一张卡（入口 / 一层层中转候选 / 落地），下面有序的备用。
       中转机上的中继规则由面板按需生成，用户不用管。
    2. 怎么切：四格（稳定优先 / 整链最优 / 按权重 / 按时段）+ 一句它会怎么做。稳定优先下可以人工
       指定走哪条（手动主备），按时段下可以时段外择优（混合）；时段表、分法、每条线路的权重就地配。
       「切换不断连」= 热备。
    3. 高级策略：几条一起用、切换保护（连续失败次数、持续多久、恢复稳定多久、最短驻留、切不切回）、
       择优门槛、计划切换预热、旧连接怎么办、应急人工指定、每条线路的探测地址。
       折起来时折叠条上列出改过模板值的项；有改过的，打开编辑框直接展开。

  2.3.497 起只认线路：老草稿只有路径的，打开时按路径还原成线路（routeLinesFromPaths），改了就按线路存。
*/

export type RouteHostOption = {
  id: number;
  name: string;
  isOnline?: boolean | null;
  agentVersion?: string | null;
};

/** 编辑框里的线路组：在 RouteGroup 之外带着线路定义（paths 是线路在本地的预览展开：钉子、时段表按它数）。 */
export type RouteGroupDraft = RouteGroup & { lines?: RouteLine[] | null };

export type RouteGroupFieldsProps = {
  value: RouteGroupDraft;
  onChange: (next: RouteGroupDraft) => void;
  /** 线路编辑要的：节点池、能当一段的隧道、入口叫什么、隧道规则入口前面那段。 */
  pools?: RouteLinePool[];
  tunnels?: RouteLineTunnel[];
  entryName?: string;
  entryPrefix?: string | null;
  /** 能不能在线路里放隧道段（隧道规则不行：它的调度在隧道出口之后）。 */
  allowTunnels?: boolean;
  ruleId?: number | null;
  /** 入口前面的机器（隧道规则的隧道入口）：不拿来当中转建议。 */
  upstreamHostIds?: number[];
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
  /** 「我的节点」：线路的落地可以直接选一个，地址端口由面板从节点解析、节点地址变了跟着改。 */
  nodeOptions?: RouteNodeOption[];
  /** 线路详情里直接改时：每条线路此刻的状态和立刻生效的暂停（见 RouteLinesEditor）。 */
  renderLineStatus?: (line: RouteLine, index: number) => ReactNode;
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

/**
 * 数字格：打字时只把合法的数写回去，离开这一格时夹到 [min, max]。以前打什么都照收，「异常多久切」填 3 要到
 * 保存时才被服务端拒（「不能小于 10」）；现在下限写在提示里，填出界的离开就改成边界值，保存不会失败。
 */
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
  const [text, setText] = useState<string | null>(null);
  const commit = (raw: string) => {
    const parsed = parseInt(raw, 10);
    onChange(Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : min)));
    setText(null);
  };
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
          value={text ?? (Number.isFinite(value) ? value : "")}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = parseInt(event.target.value, 10);
            if (Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed);
          }}
          onBlur={(event) => commit(event.target.value)}
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
export function routeGroupPayload(group: RouteGroupDraft) {
  const { policy } = group;
  const usesSchedule = policy.mode === "scheduled" || policy.mode === "hybrid";
  const lines = group.lines && group.lines.length > 0 ? JSON.parse(serializeRouteLines(group.lines) || "[]") : undefined;
  return {
    ...(lines ? { lines } : {}),
    delivery: normalizeRouteDelivery(policy.delivery),
    paths: group.paths.map((path) => ({
      key: path.key,
      name: path.name.trim(),
      hops: path.hops,
      dest: path.dest,
      weight: path.weight,
      probe: path.probe,
      // 按线路提交时服务端重新展开；带上 lineKey，钉子 / 时段表指的是哪条线路才对得上。
      ...(path.lineKey ? { lineKey: path.lineKey } : {}),
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

/** 「怎么切」四格：稳定优先 / 整链最优 / 按权重 / 按时段（混合也落在按时段，人工指定落在稳定优先）。 */
const LINE_MODE_SEGMENTS: ReadonlyArray<{ value: RouteMode; label: string }> = [
  { value: "failover", label: "稳定优先" },
  { value: "smart", label: "整链最优" },
  { value: "weighted", label: "按权重" },
  { value: "scheduled", label: "按时段" },
];

function lineModeSegment(mode: RouteMode): RouteMode {
  if (mode === "hybrid") return "scheduled";
  if (mode === "manual") return "failover";
  return mode;
}

function lineDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

/** 「怎么切」下面那一句：平时走哪条、坏了几秒内切走、恢复多久切回。 */
export function lineModeHint(policy: RouteGroupPolicy, perSession = false) {
  const switchSeconds = routeSwitchWithinSeconds(policy);
  const back = policy.autoFailback ? `主线路恢复稳定 ${lineDuration(policy.recoverSeconds)}后切回` : "主线路恢复后不自动切回";
  switch (policy.mode) {
    case "smart": return `平时走整条链最快的；坏了 ${switchSeconds} 秒内切走，${back}。`;
    case "weighted": return `${perSession ? "新会话" : "新连接"}按权重分到各条线路；坏了的先跳过，恢复稳定 ${lineDuration(policy.recoverSeconds)}后重新参与。`;
    case "scheduled": return `按时段表定首选，时段外走主线路；坏了 ${switchSeconds} 秒内切走，${back}。`;
    case "hybrid": return `按时段表定首选（到点前先预热预检），时段外走整条链最快的；坏了 ${switchSeconds} 秒内切走。`;
    case "manual": return `一直走你指定的那条；它坏了 ${switchSeconds} 秒内临时切走，恢复后回来。`;
    default: return `平时只走主线路；坏了 ${switchSeconds} 秒内切走，${back}。`;
  }
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
  pools = [],
  tunnels = [],
  entryName,
  entryPrefix = null,
  allowTunnels = false,
  ruleId = null,
  upstreamHostIds = [],
  renderLineStatus,
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
  const label = (index: number) => routePathLabel(paths[index], index);
  const deciding = policy?.deciding ?? null;
  const conditionFor = (windowIndex: number) => policy?.conditions.find((condition) => condition.windowIndex === windowIndex);
  // 存着的线路；老草稿只有路径的按路径还原（展开回去还是同样的路径），一条都没有就一条空的主线路
  const storedLines = value.lines && value.lines.length > 0 ? value.lines : null;
  const restoredLines = useMemo(() => {
    if (storedLines) return null;
    const fromPaths = routeLinesFromPaths(paths);
    return fromPaths.length > 0 ? fromPaths : [newRouteLine(0)];
  }, [storedLines, paths]);
  const lines = storedLines || restoredLines || [];
  const probes = lines.filter((line) => !!line.probe).length;
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
  const changeMode = (next: RouteMode) => onChange({
    ...value,
    policy: applyRouteMode(routePolicy, next, { timezone: scheduleTimeZone, pathCount: paths.length }),
  });
  const setWindows = (next: FailoverScheduleWindow[]) => setPolicy({
    schedule: next.length > 0 ? { timezone: scheduleTimeZone, windows: next } : null,
  });
  /** 线路改了：同一套函数在本地展开一遍，paths 就是预览（钉子、时段表都按它数）。 */
  const setLines = (next: RouteLine[]) => {
    const preview = expandForPreview(next, { entryHostId, pools, tunnels });
    const count = Math.max(1, preview.paths.length);
    const clamp = (index: number) => Math.min(index, count - 1);
    onChange({
      ...value,
      lines: next,
      paths: preview.paths,
      policy: {
        ...routePolicy,
        pin: routePolicy.pin ? { ...routePolicy.pin, index: clamp(routePolicy.pin.index) } : null,
        schedule: routePolicy.schedule ? { ...routePolicy.schedule, windows: routePolicy.schedule.windows.map((window) => ({ ...window, targetIndex: clamp(window.targetIndex) })) } : null,
      },
    });
  };
  const delivery = normalizeRouteDelivery(routePolicy.delivery);
  const mainTunnels = (lines[0]?.layers || []).flatMap((layer) => layer.tunnelIds).map((id) => tunnels.find((tunnel) => tunnel.id === id)).filter((tunnel): tunnel is RouteLineTunnel => !!tunnel);
  const replicateReady = mainTunnels.some((tunnel) => String(tunnel.mode || "").toLowerCase() === "forwardx");
  const seamlessTunnelReady = mainTunnels.some((tunnel) => String(tunnel.mode || "").toLowerCase() === "forwardx" && String(tunnel.relayMode || "") === "hot_standby");
  const mainNexTunnel = mainTunnels.find((tunnel) => String(tunnel.mode || "").toLowerCase() === "forwardx") || null;
  const changeDelivery = (next: RouteDelivery) => {
    // 热备：一坏就切、旧连接马上重连；冷备回到平滑切换。其余参数照旧。
    const patch: Partial<RouteGroupPolicy> = next === "hot"
      ? { delivery: next, failureThreshold: Math.min(routePolicy.failureThreshold, 2), failoverSeconds: Math.min(routePolicy.failoverSeconds, 10), switchMode: "fast" }
      : next === "cold" ? { delivery: next, switchMode: "smooth" } : { delivery: next };
    setPolicy(patch);
  };
  const lineTitle = (line: RouteLine, index: number) => (index === 0 ? "主线路" : line.name || `备 ${index}`);

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
          <div key={index} className="flex min-w-0 flex-col gap-1" data-state={condition?.state || "idle"} data-testid="route-schedule-window">
            {/* 手机上两行：星期 + 几点到几点一行，首选哪条 + 删除一行；宽屏一行放下 */}
            <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center">
              <div className="flex min-w-0 items-center gap-1.5">
                <Select value={dayPresetOf(window.days)} onValueChange={(preset) => patch({ days: DAY_PRESETS[preset as keyof typeof DAY_PRESETS] })}>
                  <SelectTrigger size="sm" className="w-[5.5rem] shrink-0" aria-label={`第 ${index + 1} 个时段：星期`}><SelectValue /></SelectTrigger>
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
                  className="h-8 min-w-0 flex-1 text-xs sm:w-28 sm:flex-none"
                  aria-label={`第 ${index + 1} 个时段：开始时间`}
                />
                <span className="shrink-0 text-xs text-muted-foreground">至</span>
                <Input
                  type="time"
                  value={window.to}
                  onChange={(event) => patch({ to: event.target.value })}
                  className="h-8 min-w-0 flex-1 text-xs sm:w-28 sm:flex-none"
                  aria-label={`第 ${index + 1} 个时段：结束时间`}
                />
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <Select value={String(window.targetIndex)} onValueChange={(target) => patch({ targetIndex: Number(target) })}>
                  <SelectTrigger size="sm" className="min-w-0 flex-1 sm:w-32 sm:flex-none" aria-label={`第 ${index + 1} 个时段：首选哪条路径`}><SelectValue /></SelectTrigger>
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
      <RouteLinesEditor
        lines={lines}
        onChange={setLines}
        hosts={hosts as RouteLineHost[]}
        pools={pools}
        tunnels={tunnels}
        nodeOptions={nodeOptions}
        entryHostId={entryHostId}
        entryName={entryName || (entryHostId ? hostName(entryHostId) : "入口")}
        entryPrefix={entryPrefix}
        mainAddress={mainAddress}
        allowHops={allowHops}
        allowTunnels={allowTunnels}
        previewPaths={paths}
        ruleId={ruleId}
        upstreamHostIds={upstreamHostIds}
        renderLineStatus={renderLineStatus}
      />
      <div className="fx-line-ui flex min-w-0 flex-col" data-testid="route-line-mode">
        <LineSec left="怎么切" />
        <LineCard>
          <LineSegmented
            ariaLabel="怎么切"
            value={lineModeSegment(mode)}
            options={LINE_MODE_SEGMENTS}
            onChange={(next) => changeMode(next === "scheduled" && mode === "hybrid" ? "hybrid" : next)}
          />
          <LineHint>{lineModeHint(routePolicy, udpOnly)}</LineHint>
          {/* 四格之外的两种：稳定优先下「人工指定」= 手动主备，按时段下「时段外择优」= 混合（保存才生效，用 Checkbox） */}
          {lineModeSegment(mode) === "failover" ? (
            <label className="mt-[10px] flex w-fit items-center gap-2 text-[11.5px] text-muted-foreground">
              <Checkbox checked={mode === "manual"} onCheckedChange={(checked) => changeMode(checked ? "manual" : "failover")} aria-label="人工指定走哪条" data-testid="route-line-manual" />
              人工指定走哪条（手动主备）
            </label>
          ) : null}
          {lineModeSegment(mode) === "scheduled" ? (
            <label className="mt-[10px] flex w-fit items-center gap-2 text-[11.5px] text-muted-foreground">
              <Checkbox checked={mode === "hybrid"} onCheckedChange={(checked) => changeMode(checked ? "hybrid" : "scheduled")} aria-label="时段外走整条链最快的" data-testid="route-line-hybrid" />
              时段外走整条链最快的
            </label>
          ) : null}
          {mode === "manual" ? <div className="mt-2" data-state={deciding === "pin" ? "deciding" : "idle"} data-testid="policy-pin">{pinPicker(false)}</div> : null}
          {usesSchedule ? <div className="mt-3" data-state={deciding === "schedule" ? "deciding" : "idle"} data-testid="policy-schedule">{scheduleEditor}</div> : null}
          {weighted ? (
            <div className="mt-3">
              <LinkSpreadPicker
                value={routePolicy.spread}
                options={ROUTE_SPREADS}
                labels={ROUTE_SPREAD_LABELS}
                onChange={(spread) => setPolicy({ spread })}
                ariaLabel={udpOnly ? "新会话怎么分" : "新连接怎么分"}
                hint={udpOnly ? ROUTE_SPREAD_SESSION_HINTS[routePolicy.spread] : ROUTE_SPREAD_LABELS[routePolicy.spread].hint}
              />
            </div>
          ) : null}
          {weighted && routePolicy.spread === "weighted" ? (
            /* 按权重：一条线路一个数（展开出来的几条路径一起分它那一份） */
            <div className="mt-3 flex flex-col gap-1.5" data-testid="route-line-weights">
              {lines.map((line, index) => {
                const total = lines.reduce((sum, item) => sum + Math.max(1, item.weight), 0);
                const share = total > 0 ? Math.round((Math.max(1, line.weight) / total) * 100) : 0;
                const name = lineTitle(line, index);
                return (
                  <div key={line.key} className="flex min-w-0 items-center justify-between gap-2 text-[12.5px]">
                    <span className="min-w-0 truncate">{name}</span>
                    <div className="relative w-[4.5rem] shrink-0">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={ROUTE_GUARD_LIMITS.weight.min}
                        max={ROUTE_GUARD_LIMITS.weight.max}
                        value={line.weight}
                        onChange={(event) => {
                          const weight = Math.min(ROUTE_GUARD_LIMITS.weight.max, Math.max(ROUTE_GUARD_LIMITS.weight.min, parseInt(event.target.value) || 1));
                          setLines(lines.map((item, position) => (position === index ? { ...item, weight } : item)));
                        }}
                        aria-label={`${name} 的权重`}
                        className="h-8 pr-9 text-sm"
                      />
                      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-meta text-muted-foreground">{share}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          <label className="mt-[10px] flex w-fit items-center gap-2 text-[11.5px] text-muted-foreground">
            <Checkbox
              checked={delivery === "hot"}
              onCheckedChange={(checked) => changeDelivery(checked ? "hot" : "cold")}
              aria-label="切换不断连（NEX 隧道热备）"
              data-testid="route-line-seamless"
            />
            切换不断连（NEX 隧道热备）
          </label>
          {delivery === "hot" && !seamlessTunnelReady ? (
            <LineHint className="mt-1">
              握手慢了同时拨下一条、坏了马上切，旧连接断开让客户端马上重连。要换中转也不断连：主线路里放一段 NEX 隧道，隧道的中转方式设成「热备」（至少两台中转）。
              {/* 主线路里已经有 NEX 隧道、只是没开热备：直接去改它（新标签页打开，这里没存的不丢） */}
              {mainNexTunnel ? (
                <>
                  {" "}
                  <a href={`/tunnels?tab=tunnels&edit=${mainNexTunnel.id}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground" data-testid="route-line-hot-tunnel">
                    去改隧道「{mainNexTunnel.name}」
                  </a>
                </>
              ) : null}
            </LineHint>
          ) : null}
        </LineCard>
      </div>
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
          <div className="fx-line-ui flex min-w-0 flex-col gap-4 pb-1 pt-2">
            <PolicyGroup
              title="几条一起用"
              note="默认一次只走一条。聚合：主线路那组的几条按连接分担（单个连接仍走一条）；复制：主线路走的 NEX 叠加隧道里同一份数据几条腿一起发，一条腿断了连接不断。"
            >
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="几条一起用" data-testid="route-delivery">
                {(["single", "aggregate", "replicate"] as const).map((choice) => {
                  const active = choice === "single" ? delivery === "cold" || delivery === "hot" : delivery === choice;
                  const disabled = choice === "replicate" && !replicateReady;
                  return (
                    <button
                      key={choice}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={disabled}
                      title={disabled ? "复制要主线路走 NEX 隧道（单连接叠加、开了复制）" : undefined}
                      className={cn(templateChoiceClass(active), disabled && "cursor-not-allowed opacity-45")}
                      onClick={() => {
                        if (choice === "single") { if (delivery === "aggregate" || delivery === "replicate") changeDelivery("cold"); }
                        else changeDelivery(choice);
                      }}
                    >
                      <span className="text-sm font-medium">{choice === "single" ? "一次走一条" : ROUTE_DELIVERY_INFO[choice].label}</span>
                    </button>
                  );
                })}
              </div>
              {delivery === "aggregate" || delivery === "replicate" ? <p className="text-meta leading-5 text-muted-foreground">{ROUTE_DELIVERY_INFO[delivery].hint}</p> : null}
            </PolicyGroup>
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
                  hint={`持续异常多久才切走，最少 ${ROUTE_GUARD_LIMITS.failoverSeconds.min} 秒；现在约 ${routeSwitchWithinSeconds(routePolicy)} 秒内切走`}
                  unit="秒"
                  value={routePolicy.failoverSeconds}
                  min={ROUTE_GUARD_LIMITS.failoverSeconds.min}
                  max={ROUTE_GUARD_LIMITS.failoverSeconds.max}
                  onChange={(failoverSeconds) => setPolicy({ failoverSeconds })}
                />
                <NumberField
                  label="恢复观察"
                  hint={`恢复后要稳定多久，最少 ${ROUTE_GUARD_LIMITS.recoverSeconds.min} 秒`}
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
                    hint={`明显更好要持续多久才换，最少 ${ROUTE_GUARD_LIMITS.scoreHoldSeconds.min} 秒；快一半以上的 10 秒就换`}
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
                {/* 探测地址填在线路上：展开出来的每条路径都用它 */}
                {lines.map((line, index) => {
                  const field = `probe-${line.key}`;
                  const text = draftOf(field, line.probe ?? null);
                  const error = shownError(field, text);
                  const commit = () => {
                    const parsed = parseRouteEndpoint(text);
                    // 写错的先留在框里（框上会报错），线路里的值不动：别把一个坏地址存进去。
                    if (parsed && "error" in parsed) return;
                    setLines(lines.map((item, position) => (position === index ? { ...item, probe: parsed } : item)));
                  };
                  return (
                    <FormField key={line.key} className="contents">
                      <Label className="text-meta font-normal text-muted-foreground">{lineTitle(line, index)}</Label>
                      <div className="flex min-w-0 flex-col gap-1">
                        <Input
                          value={text}
                          onChange={(event) => setDrafts({ ...drafts, [field]: event.target.value.replace(/\s+/g, "") })}
                          onFocus={() => setEditingField(field)}
                          onBlur={() => { setEditingField(null); commit(); }}
                          placeholder={udpOnly ? "留空就 ping 拨号地址" : "留空就探拨号地址"}
                          aria-label={`${lineTitle(line, index)} 的探测地址`}
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
