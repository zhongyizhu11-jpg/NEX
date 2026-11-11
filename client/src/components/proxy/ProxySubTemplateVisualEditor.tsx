/**
 * 订阅模板的可视化编辑：策略组、分流规则、Loon 插件一张张卡片地改，旁边实时出一份按示例节点
 * 渲染的配置。「高级 / 代码」里还是原来那几段文本（开头部分、规则文本、组的 JSON），两边改的是
 * 同一份数据，随时切换：
 *
 *   - 规则：存的就是文本，卡片由 shared/proxySubTemplateEditor.ts 拆出来，没动过的行原样写回；
 *   - 策略组：存的是 JSON，卡片只改认得的字段，别的字段（别处导入的、以后版本加的）跟着对象走；
 *   - 预览：shared/proxySubTemplatePreview.ts 走的是服务端同一条流水线，看到的就是客户端拉到的样子。
 */

import { useDeferredValue, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PROXY_SUB_GROUP_MATCHES, PROXY_SUB_GROUP_MATCH_LABELS, normalizeProxySubGroupMatch } from "@shared/proxySubGroupFilter";
import type { ProxySubCustomGroup } from "@shared/proxySubscriptionPlan";
import { PROXY_SUBSCRIPTION_GROUP_NAME } from "@shared/proxySubscription";
import { PROXY_RULE_CATEGORIES, proxyRuleCategoryGroupName } from "@shared/proxyRuleset";
import { proxySubModuleProblem, PROXY_SUB_TEMPLATE_MODULE_LIMITS, type ProxySubTemplateModule } from "@shared/proxySubModules";
import {
  formatProxySubRuleRows,
  moveProxySubRow,
  newProxySubRuleRow,
  parseProxySubRuleRows,
  patchProxySubRuleRow,
  proxySubRuleRowProblem,
  PROXY_CUSTOM_RULE_TYPE_INFO,
  PROXY_CUSTOM_RULE_TYPES,
  type ProxySubRuleRow,
} from "@shared/proxySubTemplateEditor";
import { findProxySubCustomGroupCycle, normalizeProxySubCustomGroups, PROXY_SUB_TEMPLATE_MODULE_TARGETS, PROXY_SUB_TEMPLATE_TARGET_LABELS, type ProxySubTemplateTarget } from "@shared/proxySubTemplates";
import { renderProxySubTemplatePreview } from "@shared/proxySubTemplatePreview";
import type { ProxyCustomRuleType } from "@shared/proxySubCustomRules";

type RuleRow = Extract<ProxySubRuleRow, { kind: "rule" }>;
type GroupType = ProxySubCustomGroup["type"];

const GROUP_TYPE_LABELS: Record<GroupType, string> = {
  select: "手动选择",
  "url-test": "自动选最快",
  fallback: "主备切换",
  "load-balance": "负载均衡",
};

export type ProxySubTemplateEditorValue = {
  prelude: string;
  customGroups: ProxySubCustomGroup[];
  customRules: string;
  modules: ProxySubTemplateModule[];
};

type Props = {
  target: ProxySubTemplateTarget;
  value: ProxySubTemplateEditorValue;
  onChange: (patch: Partial<ProxySubTemplateEditorValue>) => void;
  /** 「填入内置默认」用的开头部分。 */
  builtinPrelude: string;
};

type Mode = "visual" | "code";

export default function ProxySubTemplateVisualEditor({ target, value, onChange, builtinPrelude }: Props) {
  const [mode, setMode] = useState<Mode>("visual");
  const groupNames = useMemo(() => value.customGroups.map((group) => String(group.name || "").trim()).filter(Boolean), [value.customGroups]);
  // 规则去向的候选：内置三个、模板里的组、预设规则的分类组（规则订阅里一定有它们，指过去不会回落）。
  const targetOptions = useMemo(() => Array.from(new Set([
    "PROXY", "DIRECT", "REJECT",
    ...groupNames,
    ...PROXY_RULE_CATEGORIES.map(proxyRuleCategoryGroupName),
  ])), [groupNames]);

  return (
    <div className="space-y-3">
      <SegmentedControl<Mode>
        ariaLabel="模板编辑方式"
        value={mode}
        onChange={setMode}
        options={[{ value: "visual", label: "可视化" }, { value: "code", label: "高级 / 代码" }]}
      />
      {mode === "visual" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
          <div className="min-w-0 space-y-4">
            <GroupsEditor groups={value.customGroups} onChange={(customGroups) => onChange({ customGroups })} />
            <RulesEditor text={value.customRules} onChange={(customRules) => onChange({ customRules })} targetOptions={targetOptions} />
            {PROXY_SUB_TEMPLATE_MODULE_TARGETS.includes(target) ? (
              <ModulesEditor modules={value.modules} onChange={(modules) => onChange({ modules })} />
            ) : null}
          </div>
          <PreviewPane target={target} value={value} />
        </div>
      ) : (
        <CodeEditor target={target} value={value} onChange={onChange} builtinPrelude={builtinPrelude} />
      )}
    </div>
  );
}

// ==================== 策略组 ====================

function GroupsEditor({ groups, onChange }: { groups: ProxySubCustomGroup[]; onChange: (groups: ProxySubCustomGroup[]) => void }) {
  const update = (index: number, patch: Partial<ProxySubCustomGroup>) => onChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
  const names = groups.map((group) => String(group.name || "").trim()).filter(Boolean);
  const cycle = findProxySubCustomGroupCycle(groups);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>自定义策略组</Label>
        <Button size="sm" variant="outline" onClick={() => onChange([...groups, { name: "", type: "url-test", filter: "", match: "any", includeGroups: false }])}>
          <Plus className="mr-1 h-3.5 w-3.5" />加一组
        </Button>
      </div>
      <p data-fx-help="" className="text-xs text-muted-foreground">
        每个组会出现在主选择器「{PROXY_SUBSCRIPTION_GROUP_NAME}」和各分类组里。成员可以点名（别的组、自动 / 地区组、DIRECT、某个节点），也可以按名字挑节点 —— 订阅里新进来的节点自动归组。
      </p>
      {cycle ? <p className="text-xs text-[var(--fx-down-text)]">组互相引用成了环：{cycle.join(" → ")}，保存不了。</p> : null}
      {groups.length === 0 ? <p className="py-1 text-xs text-muted-foreground">还没有自定义组。</p> : null}
      {groups.map((group, index) => (
        <GroupCard
          key={index}
          group={group}
          otherGroups={names.filter((name) => name !== String(group.name || "").trim())}
          onChange={(patch) => update(index, patch)}
          onMove={(delta) => onChange(moveProxySubRow(groups, index, delta))}
          onRemove={() => onChange(groups.filter((_item, i) => i !== index))}
          first={index === 0}
          last={index === groups.length - 1}
        />
      ))}
    </section>
  );
}

function GroupCard({ group, otherGroups, onChange, onMove, onRemove, first, last }: {
  group: ProxySubCustomGroup;
  otherGroups: string[];
  onChange: (patch: Partial<ProxySubCustomGroup>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
}) {
  const [draft, setDraft] = useState("");
  const members = Array.isArray(group.members) ? group.members : [];
  const match = normalizeProxySubGroupMatch(group.match);
  const includeNodes = group.includeNodes !== false;
  const addMember = (raw: string) => {
    const member = raw.trim();
    if (!member || members.includes(member)) return;
    onChange({ members: [...members, member] });
    setDraft("");
  };
  const listId = useId();
  const extraKeys = Object.keys(group).filter((key) => !["name", "type", "filter", "match", "includeGroups", "members", "includeNodes"].includes(key));
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
        <Input aria-label="组名" value={String(group.name || "")} placeholder="组名，如 🇭🇰 香港" maxLength={64} onChange={(event) => onChange({ name: event.target.value })} />
        <Select value={group.type} onValueChange={(next) => onChange({ type: next as GroupType })}>
          <SelectTrigger aria-label="组的类型"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(GROUP_TYPE_LABELS) as GroupType[]).map((type) => <SelectItem key={type} value={type}>{GROUP_TYPE_LABELS[type]}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="上移" disabled={first} onClick={() => onMove(-1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="下移" disabled={last} onClick={() => onMove(1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="删除这个组" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">点名的成员（排在最前，按这个顺序）</span>
        <div className="flex flex-wrap items-center gap-1">
          {members.map((member, index) => (
            <Badge key={member} variant="secondary" className="gap-1 font-normal">
              {member}
              <button type="button" aria-label={`左移 ${member}`} className="opacity-60 hover:opacity-100 disabled:opacity-20" disabled={index === 0} onClick={() => onChange({ members: moveProxySubRow(members, index, -1) })}>‹</button>
              <button type="button" aria-label={`去掉 ${member}`} className="opacity-60 hover:opacity-100" onClick={() => onChange({ members: members.filter((item) => item !== member) })}><X className="h-3 w-3" /></button>
            </Badge>
          ))}
          <Input
            aria-label="加一个成员"
            className="h-7 w-44 text-xs"
            list={listId}
            value={draft}
            placeholder="组名 / 节点名 / DIRECT，回车"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMember(draft); } }}
            onBlur={() => addMember(draft)}
          />
          <datalist id={listId}>
            {["DIRECT", ...otherGroups].filter((item) => !members.includes(item)).map((item) => <option key={item} value={item} />)}
          </datalist>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={includeNodes} onCheckedChange={(checked) => onChange({ includeNodes: checked === true ? undefined : false })} />按名字挑节点</label>
        <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={!!group.includeGroups} onCheckedChange={(checked) => onChange({ includeGroups: checked === true })} />带上全部自动组 / 地区组</label>
      </div>
      {includeNodes ? (
        <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <Select value={match} onValueChange={(next) => onChange({ match: normalizeProxySubGroupMatch(next) })}>
            <SelectTrigger aria-label="匹配方式"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROXY_SUB_GROUP_MATCHES.map((item) => <SelectItem key={item} value={item}>{PROXY_SUB_GROUP_MATCH_LABELS[item].label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input aria-label="节点名筛选" value={String(group.filter || "")} maxLength={200} placeholder={`${PROXY_SUB_GROUP_MATCH_LABELS[match].placeholder}（留空 = 全部节点）`} title={PROXY_SUB_GROUP_MATCH_LABELS[match].hint} onChange={(event) => onChange({ filter: event.target.value })} />
        </div>
      ) : null}
      {extraKeys.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">另有 {extraKeys.join("、")} 字段，这里不改、保存时原样留着（在「高级 / 代码」里能看到）。</p>
      ) : null}
    </div>
  );
}

// ==================== 分流规则 ====================

function RulesEditor({ text, onChange, targetOptions }: { text: string; onChange: (text: string) => void; targetOptions: string[] }) {
  /*
    卡片的 id 要稳定（输入框不能每敲一个字就重新挂载、丢焦点），所以拆出来的行放在 state 里，
    只有外面的文本不是自己刚拼出来的那份时（切到代码里改过、换了一个模板）才重新拆。
  */
  const [rows, setRows] = useState<ProxySubRuleRow[]>(() => parseProxySubRuleRows(text));
  const [lastEmitted, setLastEmitted] = useState(text);
  useEffect(() => {
    if (text !== lastEmitted) {
      setRows(parseProxySubRuleRows(text));
      setLastEmitted(text);
    }
  }, [text, lastEmitted]);
  const commit = (next: ProxySubRuleRow[]) => {
    const formatted = formatProxySubRuleRows(next);
    setRows(next);
    setLastEmitted(formatted);
    onChange(formatted);
  };
  const updateRule = (id: string, patch: Parameters<typeof patchProxySubRuleRow>[1]) => commit(rows.map((row) => (row.id === id && row.kind === "rule" ? patchProxySubRuleRow(row, patch) : row)));
  const listId = useId();
  const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => !(row.kind === "raw" && !row.text.trim()));
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>分流规则</Label>
        <Button size="sm" variant="outline" onClick={() => commit([...rows, newProxySubRuleRow()])}><Plus className="mr-1 h-3.5 w-3.5" />加一条</Button>
      </div>
      <p data-fx-help="" className="text-xs text-muted-foreground">
        从上往下命中即止，排在全局前置规则之后、预设规则之前。去向写 PROXY 就是主选择器；写的组名订阅里没有时回落到主选择器。关掉的规则存成注释，随时能开回来。
      </p>
      <datalist id={listId}>{targetOptions.map((item) => <option key={item} value={item} />)}</datalist>
      {visible.length === 0 ? <p className="py-1 text-xs text-muted-foreground">还没有规则。</p> : null}
      {visible.map(({ row, index }, position) => {
        const move = (delta: -1 | 1) => {
          // 隐藏的空行不算位置：和看得见的上 / 下一条交换。
          const neighbour = visible[position + delta];
          if (!neighbour) return;
          const next = [...rows];
          [next[index], next[neighbour.index]] = [next[neighbour.index], next[index]];
          commit(next);
        };
        const controls = (
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="上移" disabled={position === 0} onClick={() => move(-1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="下移" disabled={position === visible.length - 1} onClick={() => move(1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="删除这条" onClick={() => commit(rows.filter((item) => item.id !== row.id))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        );
        if (row.kind === "raw") {
          return (
            <div key={row.id} className="flex items-center gap-2 rounded-md border border-dashed px-2 py-1">
              <Badge variant="outline" className="shrink-0 font-normal">{/^\s*(#|;|\/\/)/.test(row.text) ? "注释" : "原样保留"}</Badge>
              <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={row.text}>{row.text}</code>
              {controls}
            </div>
          );
        }
        return <RuleCard key={row.id} row={row} listId={listId} controls={controls} onPatch={(patch) => updateRule(row.id, patch)} />;
      })}
      {rows.some((row) => row.kind === "raw" && row.text.trim() && !/^\s*(#|;|\/\/)/.test(row.text)) ? (
        <p className="text-[11px] text-muted-foreground">「原样保留」的是这里认不出的写法（类型不支持或写错了）：渲染时跳过，文本照存，去「高级 / 代码」里改。</p>
      ) : null}
    </section>
  );
}

function RuleCard({ row, listId, controls, onPatch }: { row: RuleRow; listId: string; controls: ReactNode; onPatch: (patch: Parameters<typeof patchProxySubRuleRow>[1]) => void }) {
  const info = PROXY_CUSTOM_RULE_TYPE_INFO[row.type];
  const problem = row.value.trim() ? proxySubRuleRowProblem(row) : "要填匹配值";
  return (
    <div className={`space-y-1.5 rounded-md border p-2 ${row.enabled ? "" : "opacity-60"}`}>
      <div className="grid items-center gap-2 sm:grid-cols-[auto_10rem_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
        <Switch aria-label={row.enabled ? "停用这条" : "启用这条"} size="sm" checked={row.enabled} onCheckedChange={(checked) => onPatch({ enabled: checked })} />
        <Select value={row.type} onValueChange={(next) => onPatch({ type: next as ProxyCustomRuleType })}>
          <SelectTrigger aria-label="规则类型" className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PROXY_CUSTOM_RULE_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input aria-label="匹配值" className="h-8 font-mono text-xs" value={row.value} placeholder={info.placeholder} onChange={(event) => onPatch({ value: event.target.value })} />
        <Input aria-label="去向" className="h-8 text-xs" list={listId} value={row.target} placeholder="去向" onChange={(event) => onPatch({ target: event.target.value })} />
        {controls}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{info.hint}</span>
        {info.noResolve ? (
          <label className="flex items-center gap-1.5 text-[11px]"><Checkbox checked={row.noResolve} onCheckedChange={(checked) => onPatch({ noResolve: checked === true })} />不解析域名（no-resolve）</label>
        ) : null}
      </div>
      {problem ? <p className="text-[11px] text-[var(--fx-down-text)]">{problem}</p> : null}
    </div>
  );
}

// ==================== Loon 插件 ====================

function ModulesEditor({ modules, onChange }: { modules: ProxySubTemplateModule[]; onChange: (modules: ProxySubTemplateModule[]) => void }) {
  const update = (index: number, patch: Partial<ProxySubTemplateModule>) => onChange(modules.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Loon 插件</Label>
        <Button size="sm" variant="outline" disabled={modules.length >= PROXY_SUB_TEMPLATE_MODULE_LIMITS.count} onClick={() => onChange([...modules, { url: "", enabled: true, tag: "", argument: "" }])}>
          <Plus className="mr-1 h-3.5 w-3.5" />加一个
        </Button>
      </div>
      <p data-fx-help="" className="text-xs text-muted-foreground">
        写进规则订阅的 [Plugin] 段，插件本身由 Loon 下载和更新。只收 http / https 地址，最多 {PROXY_SUB_TEMPLATE_MODULE_LIMITS.count} 个；关掉的照样写进去（enabled=false），用户在 Loon 里能自己打开。
      </p>
      {modules.map((module, index) => {
        const problem = module.url.trim() ? proxySubModuleProblem(module, index) : null;
        return (
          <div key={index} className={`space-y-1.5 rounded-md border p-2 ${module.enabled ? "" : "opacity-60"}`}>
            <div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
              <Switch aria-label={module.enabled ? "停用这个插件" : "启用这个插件"} size="sm" checked={module.enabled} onCheckedChange={(checked) => update(index, { enabled: checked })} />
              <Input aria-label="插件地址" className="h-8 font-mono text-xs" value={module.url} maxLength={PROXY_SUB_TEMPLATE_MODULE_LIMITS.url} placeholder="https://example.com/xxx.plugin" onChange={(event) => update(index, { url: event.target.value })} />
              <div className="flex items-center gap-0.5">
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="上移" disabled={index === 0} onClick={() => onChange(moveProxySubRow(modules, index, -1))}><ArrowUp className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="下移" disabled={index === modules.length - 1} onClick={() => onChange(moveProxySubRow(modules, index, 1))}><ArrowDown className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="删除这个插件" onClick={() => onChange(modules.filter((_item, i) => i !== index))}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="插件名字" className="h-8 text-xs" value={module.tag} maxLength={PROXY_SUB_TEMPLATE_MODULE_LIMITS.tag} placeholder="名字（tag，可不填）" onChange={(event) => update(index, { tag: event.target.value })} />
              <Input aria-label="插件参数" className="h-8 font-mono text-xs" value={module.argument} maxLength={PROXY_SUB_TEMPLATE_MODULE_LIMITS.argument} placeholder="参数（argument，可不填）" onChange={(event) => update(index, { argument: event.target.value })} />
            </div>
            {problem ? <p className="text-[11px] text-[var(--fx-down-text)]">{problem}</p> : null}
          </div>
        );
      })}
    </section>
  );
}

// ==================== 预览 ====================

function PreviewPane({ target, value }: { target: ProxySubTemplateTarget; value: ProxySubTemplateEditorValue }) {
  const [as, setAs] = useState<"clash" | ProxySubTemplateTarget>("clash");
  // 敲字时先让输入框跟上，预览晚一拍再算（整条流水线跑一遍，几毫秒到十几毫秒）。
  const deferred = useDeferredValue(value);
  const preview = useMemo(() => {
    try {
      // 卡片里正在填、还没起名的组先不算（服务端保存时也是这么筛的）。
      const customGroups = normalizeProxySubCustomGroups(deferred.customGroups.filter((group) => String(group.name || "").trim()));
      return { ok: true as const, ...renderProxySubTemplatePreview({ target, prelude: deferred.prelude, customGroups, customRules: deferred.customRules, modules: deferred.modules }, as) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [deferred, target, as]);
  const options = target === "clash"
    ? [{ value: "clash" as const, label: "Clash YAML" }]
    : [{ value: "clash" as const, label: "Clash YAML" }, { value: target, label: PROXY_SUB_TEMPLATE_TARGET_LABELS[target] }];
  return (
    <section className="min-w-0 space-y-2 lg:sticky lg:top-0 lg:self-start">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>实时预览</Label>
        {options.length > 1 ? <SegmentedControl ariaLabel="预览格式" value={as} onChange={setAs} options={options} /> : null}
      </div>
      <p data-fx-help="" className="text-xs text-muted-foreground">
        示例节点（香港 IPLC 01、香港 BGP 02、日本 IEPL 01、新加坡、台湾、美国）按「精简」预设走一遍真正的订阅生成。
        {as === "clash" && target !== "clash" ? "这是别的格式的模板，Clash 预览里不套开头部分。" : ""}
      </p>
      {preview.ok && preview.ruleErrors.length > 0 ? (
        <div className="rounded-md border border-[var(--fx-warn)] p-2 text-[11px]">
          {preview.ruleErrors.slice(0, 5).map((item) => <p key={item.line}>规则第 {item.line} 行：{item.message}（跳过）</p>)}
        </div>
      ) : null}
      <pre className="max-h-[60svh] overflow-auto whitespace-pre rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">
        {preview.ok ? preview.text : `预览失败：${preview.error}`}
      </pre>
    </section>
  );
}

// ==================== 高级 / 代码 ====================

function CodeEditor({ target, value, onChange, builtinPrelude }: Props) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>开头部分</Label>
          <Button size="sm" variant="ghost" onClick={() => onChange({ prelude: builtinPrelude })}>填入内置默认</Button>
        </div>
        <Textarea aria-label="开头部分" value={value.prelude} onChange={(event) => onChange({ prelude: event.target.value })} rows={14} className="font-mono text-xs" />
        <p data-fx-help="" className="text-xs text-muted-foreground">
          {target === "clash" ? "放在 proxies: 前面的 YAML，不能含 proxies / proxy-groups / rule-providers / rules。" : target === "singbox" ? "一个 JSON 对象（log / dns / inbounds / experimental / route.rules……），面板把 outbounds 和 route 并进去。" : "整段 [General]（含那一行表头）。"}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>分流规则（文本）</Label>
        <Textarea aria-label="分流规则文本" value={value.customRules} onChange={(event) => onChange({ customRules: event.target.value })} rows={8} className="font-mono text-xs" placeholder={"DOMAIN-SUFFIX,openai.com,🤖 AI 服务\nIP-CIDR,10.0.0.0/8,DIRECT,no-resolve"} />
        <p data-fx-help="" className="text-xs text-muted-foreground">一行一条，写法照 Clash：DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / IP-CIDR6 / GEOIP / GEOSITE。# 开头是注释（可视化里停用的规则就是注释行）。</p>
      </div>
      <JsonField
        label="自定义策略组（JSON）"
        hint="可视化里不显示的字段在这里能看到、能改；保存时认不出的字段原样留着。"
        value={value.customGroups}
        onValid={(parsed) => {
          if (!Array.isArray(parsed)) return "要是一个数组";
          onChange({ customGroups: parsed as ProxySubCustomGroup[] });
          return null;
        }}
      />
      {PROXY_SUB_TEMPLATE_MODULE_TARGETS.includes(target) ? (
        <JsonField
          label="Loon 插件（JSON）"
          hint={'每项 {"url": "https://…", "enabled": true, "tag": "", "argument": ""}。'}
          value={value.modules}
          onValid={(parsed) => {
            if (!Array.isArray(parsed)) return "要是一个数组";
            onChange({
              modules: (parsed as Array<Record<string, unknown> | null>).map((item) => ({
                url: String(item?.url ?? ""),
                enabled: item?.enabled !== false,
                tag: String(item?.tag ?? ""),
                argument: String(item?.argument ?? ""),
              })),
            });
            return null;
          }}
        />
      ) : null}
    </div>
  );
}

/** JSON 文本框：本地留着正在敲的那份，能解析时才往外交（写到一半不该把组清空）。 */
function JsonField({ label, hint, value, onValid }: { label: string; hint: string; value: unknown; onValid: (parsed: unknown) => string | null }) {
  const serialized = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [lastSerialized, setLastSerialized] = useState(serialized);
  useEffect(() => {
    // 外面变了（可视化里改过、换了模板）且不是自己刚交出去的那份：跟上。
    if (serialized !== lastSerialized) {
      setLastSerialized(serialized);
      setDraft(serialized);
      setError(null);
    }
  }, [serialized, lastSerialized]);
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Textarea
        aria-label={label}
        value={draft}
        rows={8}
        className="font-mono text-xs"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            const parsed: unknown = JSON.parse(next || "[]");
            const problem = onValid(parsed);
            setError(problem);
            if (!problem) setLastSerialized(JSON.stringify(parsed, null, 2));
          } catch (problem) {
            setError(`不是合法的 JSON：${problem instanceof Error ? problem.message : String(problem)}`);
          }
        }}
      />
      {error ? <p className="text-xs text-[var(--fx-down-text)]">{error}（没生效）</p> : <p data-fx-help="" className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
