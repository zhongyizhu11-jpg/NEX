/**
 * 订阅链接的几个弹窗：编辑（作用域 / 外观 / 高级）、拉取记录、设备、预览。
 *
 * 用户页和管理员页共用：管理员多了「指定模板」一项。
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import DatePickerInput, { formatDateInputValue } from "@/components/DatePickerInput";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { PROXY_NODE_PROTOCOLS, PROXY_NODE_PROTOCOL_LABELS, type ProxyNodeProtocol } from "@shared/proxyNode";
import { PROXY_RULE_CATEGORIES, PROXY_RULE_PRESETS, PROXY_RULE_PRESET_LABELS, type ProxyRulePreset } from "@shared/proxyRuleset";
import { PROXY_SUBSCRIPTION_FORMATS, PROXY_SUBSCRIPTION_FORMAT_LABELS, type ProxySubscriptionFormat } from "@shared/proxySubscription";
import { PROXY_SUB_TOKEN_FAILURE_LABELS } from "@shared/proxySubTokenStatus";
import {
  PROXY_SUB_DEFAULT_TOKEN_OPTIONS,
  PROXY_SUB_EMPTY_SCOPE,
  PROXY_SUB_NAME_TEMPLATE_VARIABLES,
  PROXY_SUB_SORT_MODES,
  PROXY_SUB_SORT_MODE_LABELS,
  type ProxySubSortMode,
  type ProxySubTokenOptions,
  type ProxySubTokenScope,
  type TriState,
} from "@shared/proxySubTokenScope";
import { proxySubRegionLabel } from "@shared/proxySubRegion";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

export type ProxySubTokenLike = {
  id: number;
  name: string;
  remark?: string | null;
  alias?: string | null;
  expiresAt?: unknown;
  maxDevices?: number | null;
  templateId?: number | null;
  defaultFormat?: string | null;
  rulePreset?: string | null;
  scope?: ProxySubTokenScope;
  options?: ProxySubTokenOptions;
  scopeJson?: string | null;
  optionsJson?: string | null;
  token?: string;
};

export type ProxySubSettingsPublic = {
  infoNodesDefault: boolean;
  nameTemplateDefault: string;
  flagEmojiDefault: boolean;
  regionGroupsDefault: boolean;
  protocolPrefixDefault: boolean;
  deviceLimitEnabled: boolean;
};

function dateInputValue(value: unknown): string {
  if (!value) return "";
  const date = new Date(value as any);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTime(value: unknown): string {
  if (!value) return "—";
  const date = new Date(value as any);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 分区：一个灰色小标题 + 一句说明 + 字段。四个页签都按这个节奏排，眼睛才找得到东西。 */
function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="space-y-0.5">
        <h3 className="fx-list-section-header !pb-0">{title}</h3>
        {hint ? <p data-fx-help="" className="px-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** 开关类设置排成 iOS 分组列表：左边名字（和一句小字），右边控件。 */
function OptionGroup({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]">{children}</div>;
}

function OptionRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <FormField className="fx-list-row flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-sm">{label}</Label>
        {hint ? <p className="text-xs leading-snug text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </FormField>
  );
}

function TriStateSelect({ value, onChange, fallback, label, hint }: { value: TriState; onChange: (value: TriState) => void; fallback: boolean; label: string; hint?: ReactNode }) {
  return (
    <OptionRow label={label} hint={hint}>
      <Select value={value} onValueChange={(next) => onChange(next as TriState)}>
        <SelectTrigger aria-label={label} className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">跟随默认（{fallback ? "开" : "关"}）</SelectItem>
          <SelectItem value="on">开</SelectItem>
          <SelectItem value="off">关</SelectItem>
        </SelectContent>
      </Select>
    </OptionRow>
  );
}

/** 可点选的小药丸（和列表页的筛选药丸同款）：选中 = 主色，没选 = 白底描边。 */
function ToggleChip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" aria-pressed={active} title={title} onClick={onClick} className={cn("fx-chip h-8 px-3 text-xs", active && "fx-chip-on")}>
      {children}
    </button>
  );
}

/** 改名规则在界面上一行一条「原文 => 替换」，存成数组。 */
function renamesToText(renames: ProxySubTokenOptions["renames"]): string {
  return renames.map((rule) => `${rule.from} => ${rule.to}`).join("\n");
}

function textToRenames(text: string): ProxySubTokenOptions["renames"] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=>");
      if (index < 0) return { from: line, to: "" };
      return { from: line.slice(0, index).trim(), to: line.slice(index + 2).trim() };
    })
    .filter((rule) => rule.from);
}

function parseRegionsText(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,，]+/).map((item) => item.trim().toUpperCase()).filter((item) => /^[A-Z]{2}$/.test(item))));
}

/** 「到期」旁边的快捷项：从今天起加几个月。 */
function dateMonthsFromNow(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return formatDateInputValue(date);
}

/**
 * 内容范围页顶上那一句：把当前的筛选条件念出来。
 * 条件散在节点 / 协议 / 地区 / 名字 / 直连中转几处，不念一遍，用户得自己一处处对。
 */
export function describeProxySubScope(scope: ProxySubTokenScope, regions: string[]): string[] {
  const parts: string[] = [];
  if (scope.templateIds.length > 0) parts.push(`只要 ${scope.templateIds.length} 个节点`);
  if (scope.excludeTemplateIds.length > 0) parts.push(`排除 ${scope.excludeTemplateIds.length} 个节点`);
  if (scope.protocols.length > 0) parts.push(`协议 ${scope.protocols.map((item) => PROXY_NODE_PROTOCOL_LABELS[item] || item).join("、")}`);
  if (regions.length > 0) parts.push(`地区 ${regions.map((code) => proxySubRegionLabel(code) || code).join("、")}`);
  if (scope.include.trim()) parts.push(`名字含「${scope.include.trim()}」`);
  if (scope.exclude.trim()) parts.push(`名字不含「${scope.exclude.trim()}」`);
  if (scope.excludeDirect) parts.push("不要直连");
  if (scope.excludeRelay) parts.push("不要中转");
  return parts;
}

export function ProxySubTokenEditDialog({
  open,
  onOpenChange,
  token,
  nodes,
  settings,
  isAdmin,
  onSaved,
  onPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: ProxySubTokenLike | null;
  nodes: Array<{ id: number; name: string; protocol?: string; sharedFrom?: boolean }>;
  settings: ProxySubSettingsPublic | null | undefined;
  isAdmin: boolean;
  onSaved?: () => void;
  /** 给了就多一个「保存并预览」：改完范围 / 外观马上看客户端会拿到什么。 */
  onPreview?: (token: { id: number; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [remark, setRemark] = useState("");
  const [alias, setAlias] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxDevices, setMaxDevices] = useState("0");
  const [templateId, setTemplateId] = useState("0");
  const [defaultFormat, setDefaultFormat] = useState<ProxySubscriptionFormat>("base64");
  const [rulePreset, setRulePreset] = useState<ProxyRulePreset>("balanced");
  const [scope, setScope] = useState<ProxySubTokenScope>({ ...PROXY_SUB_EMPTY_SCOPE });
  const [options, setOptions] = useState<ProxySubTokenOptions>({ ...PROXY_SUB_DEFAULT_TOKEN_OPTIONS });
  const [renamesText, setRenamesText] = useState("");
  const [regionsText, setRegionsText] = useState("");

  const templatesQuery = trpc.proxySubscriptions.adminListTemplates.useQuery(undefined, { enabled: isAdmin && open });
  const validateQuery = trpc.proxySubscriptions.validateCustomRules.useQuery(
    { text: options.customRules },
    { enabled: open && options.customRules.trim().length > 0 },
  );

  useEffect(() => {
    if (!open || !token) return;
    setName(String(token.name || ""));
    setRemark(String(token.remark || ""));
    setAlias(String(token.alias || ""));
    setExpiresAt(dateInputValue(token.expiresAt));
    setMaxDevices(Number(token.maxDevices || 0) > 0 ? String(Number(token.maxDevices)) : "");
    setTemplateId(String(Number(token.templateId || 0)));
    setDefaultFormat((PROXY_SUBSCRIPTION_FORMATS as readonly string[]).includes(String(token.defaultFormat)) ? token.defaultFormat as ProxySubscriptionFormat : "base64");
    setRulePreset((PROXY_RULE_PRESETS as readonly string[]).includes(String(token.rulePreset)) ? token.rulePreset as ProxyRulePreset : "balanced");
    const nextScope = token.scope || { ...PROXY_SUB_EMPTY_SCOPE };
    const nextOptions = token.options || { ...PROXY_SUB_DEFAULT_TOKEN_OPTIONS };
    setScope(nextScope);
    setOptions(nextOptions);
    setRenamesText(renamesToText(nextOptions.renames));
    setRegionsText(nextScope.regions.join(" "));
  }, [open, token]);

  const updateToken = trpc.proxySubscriptions.updateToken.useMutation({
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const ownNodes = useMemo(() => nodes.filter((node) => !node.sharedFrom), [nodes]);
  const protocolSet = new Set<string>(scope.protocols);
  const regions = useMemo(() => parseRegionsText(regionsText), [regionsText]);
  const scopeParts = useMemo(() => describeProxySubScope(scope, regions), [scope, regions]);

  const toggleTemplate = (id: number, list: "templateIds" | "excludeTemplateIds") => {
    setScope((prev) => {
      const current = new Set(prev[list]);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      return { ...prev, [list]: Array.from(current) };
    });
  };

  const save = (thenPreview = false) => {
    if (!token) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("用途不能为空");
      return;
    }
    const saved = { id: token.id, name: trimmed };
    updateToken.mutate({
      id: token.id,
      name: trimmed,
      remark: remark.trim() || null,
      alias: alias.trim() || null,
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      maxDevices: Math.max(0, Math.floor(Number(maxDevices) || 0)),
      ...(isAdmin ? { templateId: Math.max(0, Math.floor(Number(templateId) || 0)) } : {}),
      defaultFormat,
      rulePreset,
      scope: { ...scope, regions },
      options: { ...options, renames: textToRenames(renamesText) },
    }, {
      onSuccess: () => {
        toast.success("订阅链接已保存");
        onOpenChange(false);
        onSaved?.();
        if (thenPreview) onPreview?.(saved);
      },
    });
  };

  const categoryTargetsEntries = PROXY_RULE_CATEGORIES.filter((category) => category.outbound !== "reject");
  // 桌面上分两列，各自一个分组列表；手机上两组上下排。
  const categoryColumns = [categoryTargetsEntries.slice(0, Math.ceil(categoryTargetsEntries.length / 2)), categoryTargetsEntries.slice(Math.ceil(categoryTargetsEntries.length / 2))].filter((column) => column.length > 0);
  const expiryPicks: Array<{ label: string; months: number }> = [{ label: "1 个月", months: 1 }, { label: "3 个月", months: 3 }, { label: "1 年", months: 12 }];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>编辑订阅链接</DialogTitle>
          <DialogDescription className="text-xs">
            这条地址给谁、给哪些节点、长什么样。改完所有已导入的客户端下次刷新就拿到。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="basic" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="grid w-full shrink-0 grid-cols-4">
            <TabsTrigger value="basic">基本</TabsTrigger>
            <TabsTrigger value="scope">内容范围</TabsTrigger>
            <TabsTrigger value="look">外观</TabsTrigger>
            <TabsTrigger value="advanced">高级</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1 pr-1">
            <TabsContent value="basic" className="mt-4 space-y-5">
              <Section title="这条地址">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField className="space-y-1.5">
                    <Label>用途</Label>
                    <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="例如 我的手机" />
                  </FormField>
                  <FormField className="space-y-1.5">
                    <Label>备注</Label>
                    <Input value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={200} placeholder="只有自己看得到" />
                  </FormField>
                </div>
              </Section>

              <Section title="谁能拉、拉到什么时候">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField className="space-y-1.5">
                    <Label>短链别名</Label>
                    <div className="relative">
                      <Input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={32} placeholder="my-phone" className="pl-9 font-mono" />
                      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 z-10 flex items-center font-mono text-xs text-muted-foreground">/s/</span>
                    </div>
                    <p data-fx-help="" className="text-xs text-muted-foreground">和长地址等价，能手打。4–32 位小写字母、数字、连字符。</p>
                  </FormField>
                  <FormField className="space-y-1.5">
                    <Label>到期</Label>
                    <DatePickerInput value={expiresAt} onChange={setExpiresAt} placeholder="跟着账号走" />
                    <div className="flex flex-wrap items-center gap-1.5">
                      {expiryPicks.map((pick) => (
                        <button key={pick.months} type="button" className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setExpiresAt(dateMonthsFromNow(pick.months))}>
                          {pick.label}
                        </button>
                      ))}
                      {expiresAt ? (
                        <button type="button" className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setExpiresAt("")}>清除</button>
                      ) : null}
                    </div>
                    <p data-fx-help="" className="text-xs text-muted-foreground">到期后只有这条地址 404，账号不受影响。</p>
                  </FormField>
                </div>
                <FormField className="space-y-1.5">
                  <Label>设备数上限</Label>
                  <Input type="number" min={0} value={maxDevices} onChange={(event) => setMaxDevices(event.target.value)} placeholder="0 = 不单独限制" className="sm:max-w-[calc(50%-6px)]" />
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    0 = 不单独限制；设了和账号 / 全局上限取最严。{settings?.deviceLimitEnabled ? "" : "管理员还没开设备数限制，这里只是预设。"}
                  </p>
                </FormField>
              </Section>

              <Section title="客户端拿到什么" hint="从图标一键导入的地址已经钉死格式；这两项管的是手动粘贴、认不出客户端的情况。">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField className="space-y-1.5">
                    <Label>认不出客户端时的格式</Label>
                    <Select value={defaultFormat} onValueChange={(value) => setDefaultFormat(value as ProxySubscriptionFormat)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PROXY_SUBSCRIPTION_FORMATS.map((format) => (
                          <SelectItem key={format} value={format}>{PROXY_SUBSCRIPTION_FORMAT_LABELS[format]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField className="space-y-1.5">
                    <Label>规则订阅的分流预设</Label>
                    <Select value={rulePreset} onValueChange={(value) => setRulePreset(value as ProxyRulePreset)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PROXY_RULE_PRESETS.filter((item) => item !== "off").map((item) => (
                          <SelectItem key={item} value={item}>{PROXY_RULE_PRESET_LABELS[item]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  {isAdmin ? (
                    <FormField className="space-y-1.5">
                      <Label>指定模板</Label>
                      <Select value={templateId} onValueChange={setTemplateId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">不指定（用户 → 套餐 → 默认）</SelectItem>
                          {(templatesQuery.data?.templates || []).map((template) => (
                            <SelectItem key={template.id} value={String(template.id)}>{template.name}（{template.target}）</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  ) : null}
                </div>
              </Section>
            </TabsContent>

            <TabsContent value="scope" className="mt-4 space-y-5">
              <div data-testid="sub-scope-summary" className="rounded-lg border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] px-3 py-2 text-sm">
                {scopeParts.length === 0 ? (
                  <span>现在给<b className="font-medium">全部节点</b>。下面任何一项设了，就只给符合的那些。</span>
                ) : (
                  <span>现在只给：<b className="font-medium">{scopeParts.join(" · ")}</b></span>
                )}
              </div>

              <Section title="按节点挑" hint={ownNodes.length === 0 && isAdmin ? "按节点挑要在用户自己的订阅页做；这里能按协议 / 地区 / 名字筛。" : "不点 = 全部。点亮的才给。"}>
                {ownNodes.length === 0 ? (
                  isAdmin ? null : <p className="px-1 text-xs text-muted-foreground">还没有节点。</p>
                ) : (
                  <>
                    <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                      {ownNodes.map((node) => (
                        <ToggleChip key={node.id} active={scope.templateIds.includes(node.id)} onClick={() => toggleTemplate(node.id, "templateIds")} title={PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol}>
                          <span className="max-w-[12rem] truncate">{node.name}</span>
                          <span className="text-[11px] opacity-70">{PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol}</span>
                        </ToggleChip>
                      ))}
                    </div>
                    <details className="group" open={scope.excludeTemplateIds.length > 0}>
                      <summary className="cursor-pointer select-none px-1 text-xs text-muted-foreground hover:text-foreground">
                        再排除几个{scope.excludeTemplateIds.length > 0 ? `（已排除 ${scope.excludeTemplateIds.length} 个）` : ""}
                      </summary>
                      <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                        {ownNodes.map((node) => (
                          <ToggleChip key={node.id} active={scope.excludeTemplateIds.includes(node.id)} onClick={() => toggleTemplate(node.id, "excludeTemplateIds")}>
                            <span className="max-w-[12rem] truncate">{node.name}</span>
                          </ToggleChip>
                        ))}
                      </div>
                    </details>
                  </>
                )}
              </Section>

              <Section title="按条件筛">
                <FormField className="space-y-1.5">
                  <Label>只要这些协议</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {PROXY_NODE_PROTOCOLS.map((protocol) => (
                      <ToggleChip
                        key={protocol}
                        active={protocolSet.has(protocol)}
                        onClick={() => setScope((prev) => ({
                          ...prev,
                          protocols: protocolSet.has(protocol) ? prev.protocols.filter((item) => item !== protocol) : Array.from(new Set([...prev.protocols, protocol])),
                        }))}
                      >
                        {PROXY_NODE_PROTOCOL_LABELS[protocol]}
                      </ToggleChip>
                    ))}
                  </div>
                </FormField>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField className="space-y-1.5">
                    <Label>只要这些地区</Label>
                    <Input value={regionsText} onChange={(event) => setRegionsText(event.target.value)} placeholder="国家码，空格分隔：HK JP SG" />
                    <p data-fx-help="" className="text-xs text-muted-foreground">
                      {regions.length > 0 ? regions.map((code) => proxySubRegionLabel(code) || code).join("、") : "节点的地区来自机器位置或名字里的关键字。"}
                    </p>
                  </FormField>
                  <div className="grid gap-3">
                    <FormField className="space-y-1.5">
                      <Label>名字包含（正则）</Label>
                      <Input value={scope.include} onChange={(event) => setScope((prev) => ({ ...prev, include: event.target.value }))} placeholder="例如 香港|HK" />
                    </FormField>
                    <FormField className="space-y-1.5">
                      <Label>名字排除（正则）</Label>
                      <Input value={scope.exclude} onChange={(event) => setScope((prev) => ({ ...prev, exclude: event.target.value }))} placeholder="例如 测试" />
                    </FormField>
                  </div>
                </div>
                <OptionGroup>
                  <OptionRow label="不要直连条目" hint="只给走中转的，比如给路由器那条。">
                    <Checkbox aria-label="不要直连条目" checked={scope.excludeDirect} onCheckedChange={(checked) => setScope((prev) => ({ ...prev, excludeDirect: checked === true }))} />
                  </OptionRow>
                  <OptionRow label="不要中转条目">
                    <Checkbox aria-label="不要中转条目" checked={scope.excludeRelay} onCheckedChange={(checked) => setScope((prev) => ({ ...prev, excludeRelay: checked === true }))} />
                  </OptionRow>
                </OptionGroup>
              </Section>
            </TabsContent>

            <TabsContent value="look" className="mt-4 space-y-5">
              <Section title="命名">
                <FormField className="space-y-1.5">
                  <Label>节点命名模板</Label>
                  <Input value={options.nameTemplate} onChange={(event) => setOptions((prev) => ({ ...prev, nameTemplate: event.target.value }))} placeholder={settings?.nameTemplateDefault || "{host} → {node}"} />
                  <div className="flex flex-wrap gap-1">
                    {PROXY_SUB_NAME_TEMPLATE_VARIABLES.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                        title={item.label}
                        onClick={() => setOptions((prev) => ({ ...prev, nameTemplate: `${prev.nameTemplate || settings?.nameTemplateDefault || "{host} → {node}"}${item.key}` }))}
                      >
                        {item.key}
                      </button>
                    ))}
                  </div>
                  <p data-fx-help="" className="text-xs text-muted-foreground">留空用全局默认。转发上手填过显示名的，默认模板下保留手填的名字。</p>
                </FormField>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField className="space-y-1.5">
                    <Label>前缀</Label>
                    <Input value={options.prefix} onChange={(event) => setOptions((prev) => ({ ...prev, prefix: event.target.value }))} maxLength={32} placeholder="例如 [NEX] " />
                  </FormField>
                  <FormField className="space-y-1.5">
                    <Label>后缀</Label>
                    <Input value={options.suffix} onChange={(event) => setOptions((prev) => ({ ...prev, suffix: event.target.value }))} maxLength={32} />
                  </FormField>
                </div>
                <FormField className="space-y-1.5">
                  <Label>正则改名（一行一条，原文 =&gt; 替换）</Label>
                  <Textarea value={renamesText} onChange={(event) => setRenamesText(event.target.value)} rows={3} className="font-mono text-xs" placeholder={"BGP => IEPL\n\\s*\\(.*\\) =>"} />
                </FormField>
              </Section>

              <Section title="附加">
                <OptionGroup>
                  <TriStateSelect label="节点名加国旗" value={options.flagEmoji} fallback={!!settings?.flagEmojiDefault} onChange={(value) => setOptions((prev) => ({ ...prev, flagEmoji: value }))} />
                  <TriStateSelect label="节点名加协议前缀" hint="像 [VLESS] 香港 01" value={options.protocolPrefix} fallback={!!settings?.protocolPrefixDefault} onChange={(value) => setOptions((prev) => ({ ...prev, protocolPrefix: value }))} />
                  <TriStateSelect label="按地区生成策略组" value={options.regionGroups} fallback={!!settings?.regionGroupsDefault} onChange={(value) => setOptions((prev) => ({ ...prev, regionGroups: value }))} />
                  <TriStateSelect label="插入信息节点" hint="剩余流量 / 到期 / 公告。它们指向本机、永远连不上，客户端测速会标红。" value={options.infoNodes} fallback={!!settings?.infoNodesDefault} onChange={(value) => setOptions((prev) => ({ ...prev, infoNodes: value }))} />
                </OptionGroup>
              </Section>

              <Section title="顺序">
                <OptionGroup>
                  <OptionRow label="排序">
                    <Select value={options.sortMode} onValueChange={(value) => setOptions((prev) => ({ ...prev, sortMode: value as ProxySubSortMode }))}>
                      <SelectTrigger aria-label="排序" className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PROXY_SUB_SORT_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>{PROXY_SUB_SORT_MODE_LABELS[mode]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </OptionRow>
                  <OptionRow label="去掉重复节点" hint="地址、端口、协议都一样的只留一条。">
                    <Checkbox aria-label="去掉重复节点" checked={options.dedupe} onCheckedChange={(checked) => setOptions((prev) => ({ ...prev, dedupe: checked === true }))} />
                  </OptionRow>
                </OptionGroup>
              </Section>
            </TabsContent>

            <TabsContent value="advanced" className="mt-4 space-y-5">
              <Section title="节点参数" hint="「跟随默认」= 按节点自己的设置。只在明确要改时才动。">
                <OptionGroup>
                  <TriStateSelect label="节点的 UDP" value={options.udp} fallback onChange={(value) => setOptions((prev) => ({ ...prev, udp: value }))} />
                  <TriStateSelect label="跳过证书校验" hint="skip-cert-verify" value={options.skipCertVerify} fallback={false} onChange={(value) => setOptions((prev) => ({ ...prev, skipCertVerify: value }))} />
                </OptionGroup>
              </Section>

              <Section title="分流去向覆盖" hint="只对规则订阅生效；没改的分类按预设走。">
                <div className="grid gap-3 sm:grid-cols-2">
                  {categoryColumns.map((column, columnIndex) => (
                  <OptionGroup key={columnIndex}>
                  {column.map((category) => (
                    <OptionRow key={category.key} label={`${category.emoji} ${category.label}`}>
                      <Select
                        value={options.categoryTargets[category.key] || "default"}
                        onValueChange={(value) => setOptions((prev) => {
                          const next = { ...prev.categoryTargets };
                          if (value === "default") delete next[category.key];
                          else next[category.key] = value;
                          return { ...prev, categoryTargets: next };
                        })}
                      >
                        <SelectTrigger aria-label={`${category.label} 的去向`} className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">默认（{category.outbound === "direct" ? "直连" : "代理"}）</SelectItem>
                          <SelectItem value="PROXY">走代理</SelectItem>
                          <SelectItem value="DIRECT">直连</SelectItem>
                          <SelectItem value="REJECT">拦截</SelectItem>
                        </SelectContent>
                      </Select>
                    </OptionRow>
                  ))}
                  </OptionGroup>
                  ))}
                </div>
              </Section>

              <Section title="自定义规则" hint="排在预设规则前面，只对这条地址生效。">
                <FormField className="space-y-1.5">
                  <Textarea
                    aria-label="这条地址的自定义规则"
                    value={options.customRules}
                    onChange={(event) => setOptions((prev) => ({ ...prev, customRules: event.target.value }))}
                    rows={5}
                    className="font-mono text-xs"
                    placeholder={"DOMAIN-SUFFIX,example.com,DIRECT\nDOMAIN-KEYWORD,google,PROXY\nIP-CIDR,10.0.0.0/8,DIRECT,no-resolve\nGEOIP,JP,PROXY"}
                  />
                  {validateQuery.data ? (
                    validateQuery.data.errors.length > 0 ? (
                      <ul className="space-y-0.5 text-xs text-[var(--fx-down-text)]">
                        {validateQuery.data.errors.slice(0, 5).map((error) => (
                          <li key={error.line}>第 {error.line} 行：{error.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">{validateQuery.data.count} 条规则，写法正确。</p>
                    )
                  ) : (
                    <p data-fx-help="" className="text-xs text-muted-foreground">支持 DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / IP-CIDR6 / GEOIP / GEOSITE；去向 DIRECT / REJECT / PROXY 或策略组名。</p>
                  )}
                </FormField>
              </Section>
            </TabsContent>
          </div>
        </Tabs>
        <DialogFooter className="shrink-0 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          {onPreview ? <Button variant="secondary" onClick={() => save(true)} disabled={updateToken.isPending}>保存并预览</Button> : null}
          <Button onClick={() => save()} disabled={updateToken.isPending}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RESULT_LABELS: Record<string, string> = {
  ok: "成功",
  page: "打开了落地页",
  ...PROXY_SUB_TOKEN_FAILURE_LABELS,
};

export function ProxySubTokenLogsDialog({ open, onOpenChange, tokenId, tokenName, admin }: { open: boolean; onOpenChange: (open: boolean) => void; tokenId: number | null; tokenName: string; admin?: boolean }) {
  const userQuery = trpc.proxySubscriptions.tokenAccessLogs.useQuery({ id: tokenId || 0, limit: 100 }, { enabled: open && !!tokenId && !admin });
  const adminQuery = trpc.proxySubscriptions.adminAccessLogs.useQuery({ tokenId: tokenId || undefined, limit: 200 }, { enabled: open && !!tokenId && !!admin });
  const rows = (admin ? adminQuery.data : userQuery.data) || [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>拉取记录 · {tokenName}</DialogTitle>
          <DialogDescription className="text-xs">最近的拉取，成功和被拒都在。保留天数由管理员设置。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>客户端</TableHead>
                  <TableHead>格式</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row: any) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs">{formatTime(row.at)}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant={row.result === "ok" || row.result === "page" ? "secondary" : "destructive"}>{RESULT_LABELS[row.result] || row.result}</Badge>
                    </TableCell>
                    <TableCell className="text-xs" title={row.userAgent || ""}>{row.clientLabel || "未识别"}{row.clientVersion ? ` ${row.clientVersion}` : ""}</TableCell>
                    <TableCell className="text-xs">{row.format || "—"}{row.profile ? "（规则）" : ""}</TableCell>
                    <TableCell className="font-mono text-xs">{row.ip || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProxySubTokenDevicesDialog({ open, onOpenChange, tokenId, tokenName, admin }: { open: boolean; onOpenChange: (open: boolean) => void; tokenId: number | null; tokenName: string; admin?: boolean }) {
  const utils = trpc.useUtils();
  const userQuery = trpc.proxySubscriptions.tokenDevices.useQuery({ id: tokenId || 0 }, { enabled: open && !!tokenId && !admin });
  const adminQuery = trpc.proxySubscriptions.adminTokenDevices.useQuery({ tokenId: tokenId || 0 }, { enabled: open && !!tokenId && !!admin });
  const rows = (admin ? adminQuery.data : userQuery.data) || [];
  const remove = trpc.proxySubscriptions.deleteDevice.useMutation({
    onSuccess: () => {
      toast.success("已移除这台设备");
      void utils.proxySubscriptions.tokenDevices.invalidate();
      void utils.proxySubscriptions.adminTokenDevices.invalidate();
      void utils.proxySubscriptions.listTokens.invalidate();
    },
    onError: (error) => toast.error(error.message || "移除失败"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>设备 · {tokenName}</DialogTitle>
          <DialogDescription className="text-xs">
            带设备标识（x-hwid）的客户端按设备记；不带的按来源 IP 记，前缀 ip:。移除后那台设备下次拉取重新登记。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有设备来拉过。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备</TableHead>
                  <TableHead>系统 / 型号</TableHead>
                  <TableHead>最近</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row: any) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{String(row.hwid).startsWith("ip:") ? <span title={row.hwid}>按 IP</span> : String(row.hwid).slice(0, 16)}</TableCell>
                    <TableCell className="text-xs">{[row.deviceOs, row.osVersion, row.model].filter(Boolean).join(" ") || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatTime(row.lastSeenAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{row.lastIp || "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => remove.mutate({ id: row.id })} disabled={remove.isPending}>移除</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProxySubTokenPreviewDialog({ open, onOpenChange, tokenId, tokenName }: { open: boolean; onOpenChange: (open: boolean) => void; tokenId: number | null; tokenName: string }) {
  const [format, setFormat] = useState<ProxySubscriptionFormat>("clash");
  const query = trpc.proxySubscriptions.tokenPreview.useQuery({ id: tokenId || 0, format }, { enabled: open && !!tokenId });
  const data = query.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>预览 · {tokenName}</DialogTitle>
          <DialogDescription className="text-xs">这条地址实际发出去的节点名和策略组（作用域、命名、旗帜、信息节点都算上了）。</DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">按模板</span>
          <Select value={format} onValueChange={(value) => setFormat(value as ProxySubscriptionFormat)}>
            <SelectTrigger aria-label="预览用的订阅格式" className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROXY_SUBSCRIPTION_FORMATS.map((item) => (
                <SelectItem key={item} value={item}>{PROXY_SUBSCRIPTION_FORMAT_LABELS[item]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {data?.templateName ? <Badge variant="outline">模板：{data.templateName}</Badge> : null}
          {data && data.deviceLimit > 0 ? <Badge variant="outline">设备上限 {data.deviceLimit}</Badge> : null}
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain text-sm">
          {query.isLoading ? <p className="text-muted-foreground">计算中…</p> : null}
          {data?.customRuleErrors.length ? (
            <div className="rounded-md border border-[var(--fx-warn)] p-2 text-xs">
              <p className="font-medium">自定义规则里有写坏的行（已跳过）：</p>
              {data.customRuleErrors.slice(0, 5).map((error, index) => (
                <p key={index}>{error.scope} 第 {error.line} 行：{error.message}</p>
              ))}
            </div>
          ) : null}
          {data?.infoNodes.length ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">信息节点</p>
              <ul className="space-y-0.5 text-xs">{data.infoNodes.map((name) => <li key={name}>{name}</li>)}</ul>
            </div>
          ) : null}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">节点（{data?.nodes.length || 0}）</p>
            {data && data.nodes.length === 0 ? <p className="text-xs text-muted-foreground">没有节点会进这条地址。看看作用域是不是设得太窄。</p> : null}
            <ul className="space-y-0.5 text-xs">
              {(data?.nodes || []).map((node, index) => (
                <li key={`${node.name}-${index}`} className="flex items-center gap-2">
                  <span className="truncate">{node.name}</span>
                  <span className="shrink-0 text-muted-foreground">{PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol} · {node.address}:{node.port}</span>
                </li>
              ))}
            </ul>
          </div>
          {data && data.groups.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">策略组</p>
              <ul className="space-y-0.5 text-xs">
                {data.groups.map((group) => (
                  <li key={group.name}><span className="font-medium">{group.name}</span> <span className="text-muted-foreground">{group.type} · {group.members.length} 个成员</span></li>
                ))}
              </ul>
            </div>
          ) : null}
          {data && data.skipped.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">没进订阅的转发</p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {data.skipped.map((item) => <li key={`${item.ruleId}-${item.reason}`}>{item.ruleName}：{item.label}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
