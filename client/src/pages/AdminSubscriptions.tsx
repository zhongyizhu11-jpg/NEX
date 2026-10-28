/**
 * 订阅运营（管理员）：全站令牌、拉取统计与日志、模板、设置。
 *
 * 用户自己的订阅在「订阅管理」；这一页回答的是商家的问题：谁在拉、拉得怎么样、
 * 发出去的配置长什么样、整站怎么限。
 */

import DashboardLayout from "@/components/DashboardLayout";
import { PROXY_SUB_GROUP_MATCHES, PROXY_SUB_GROUP_MATCH_LABELS, normalizeProxySubGroupMatch, type ProxySubGroupMatch } from "@shared/proxySubGroupFilter";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { ProxySubTokenDevicesDialog, ProxySubTokenEditDialog, ProxySubTokenLogsDialog, type ProxySubTokenLike } from "@/components/proxy/ProxySubTokenDialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { PROXY_SUB_TOKEN_FAILURE_LABELS, proxySubTokenStatus } from "@shared/proxySubTokenStatus";
import { PROXY_SUB_DEFAULT_SETTINGS, type ProxySubSettings } from "@shared/proxySubSettings";
import { PROXY_SUB_TEMPLATE_TARGETS, PROXY_SUB_TEMPLATE_TARGET_LABELS, type ProxySubTemplate, type ProxySubTemplateTarget } from "@shared/proxySubTemplates";
import { parseProxySubTokenOptions, parseProxySubTokenScope } from "@shared/proxySubTokenScope";
import { Activity, FileCode2, KeyRound, Plus, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type AdminTab = "tokens" | "stats" | "templates" | "settings";
const TAB_ITEMS = [
  { value: "tokens", label: "令牌", icon: KeyRound },
  { value: "stats", label: "统计与日志", icon: Activity },
  { value: "templates", label: "模板", icon: FileCode2 },
  { value: "settings", label: "设置", icon: Settings2 },
] as const satisfies readonly SlidingTabItem<AdminTab>[];

function timeText(value: unknown): string {
  if (!value) return "—";
  const date = new Date(value as any);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "—";
}

const RESULT_LABELS: Record<string, string> = { ok: "成功", page: "落地页", ...PROXY_SUB_TOKEN_FAILURE_LABELS };

// ==================== 令牌 ====================

function TokensTab() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const query = trpc.proxySubscriptions.adminListTokens.useQuery({ search: search.trim() || undefined, page, pageSize });
  const settingsQuery = trpc.proxySubscriptions.adminGetSettings.useQuery();
  const [editing, setEditing] = useState<ProxySubTokenLike | null>(null);
  const [logsOf, setLogsOf] = useState<{ id: number; name: string } | null>(null);
  const [devicesOf, setDevicesOf] = useState<{ id: number; name: string } | null>(null);
  const refresh = () => { void utils.proxySubscriptions.adminListTokens.invalidate(); };
  const updateToken = trpc.proxySubscriptions.updateToken.useMutation({ onSuccess: refresh, onError: (error) => toast.error(error.message) });
  const rotateToken = trpc.proxySubscriptions.rotateToken.useMutation({ onSuccess: (result) => { if (result.warning) toast.warning(result.warning); else toast.success("已重置，旧地址和短链接失效"); refresh(); }, onError: (error) => toast.error(error.message) });
  const deleteToken = trpc.proxySubscriptions.deleteToken.useMutation({ onSuccess: () => { toast.success("已删除"); refresh(); }, onError: (error) => toast.error(error.message) });
  const items = (query.data?.items || []) as any[];
  const total = query.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="按用途、用户名、别名、备注搜" className="max-w-xs" />
        <span className="text-xs text-muted-foreground">共 {total} 条</span>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>用途</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近拉取</TableHead>
                <TableHead>客户端</TableHead>
                <TableHead>次数</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">{query.isLoading ? "加载中…" : "没有令牌"}</TableCell></TableRow>
              ) : items.map((row) => {
                const status = proxySubTokenStatus(row);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-sm">{row.username || `#${row.userId}`}</TableCell>
                    <TableCell className="text-sm">
                      <div className="flex flex-wrap items-center gap-1">
                        <span>{row.name}</span>
                        {row.alias ? <Badge variant="outline">/s/{row.alias}</Badge> : null}
                        {row.scoped ? <Badge variant="outline">有作用域</Badge> : null}
                        {!row.isEnabled ? <Badge variant="outline">已停用</Badge> : null}
                        {row.expiresAt && new Date(row.expiresAt).getTime() < Date.now() ? <Badge variant="destructive">已过期</Badge> : null}
                      </div>
                      {row.remark ? <p className="text-xs text-muted-foreground">{row.remark}</p> : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {status.kind === "failed" ? <Badge variant="destructive">{PROXY_SUB_TOKEN_FAILURE_LABELS[status.reason]}</Badge> : status.kind === "ok" ? <Badge variant="secondary">正常</Badge> : <span className="text-muted-foreground">从没拉过</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{timeText(row.lastAccessAt)}{row.lastAccessIp ? <span className="block font-mono text-muted-foreground">{row.lastAccessIp}</span> : null}</TableCell>
                    <TableCell className="text-xs">{row.lastClientLabel || "—"}{row.lastClientVersion ? ` ${row.lastClientVersion}` : ""}</TableCell>
                    <TableCell className="text-xs">{row.accessCount || 0}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ ...row, scope: parseProxySubTokenScope(row.scopeJson), options: parseProxySubTokenOptions(row.optionsJson) })}>编辑</Button>
                      <Button size="sm" variant="ghost" onClick={() => setLogsOf({ id: row.id, name: row.name })}>记录</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDevicesOf({ id: row.id, name: row.name })}>设备</Button>
                      <Button size="sm" variant="ghost" onClick={() => updateToken.mutate({ id: row.id, isEnabled: !row.isEnabled })}>{row.isEnabled ? "停用" : "启用"}</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: "重置这条地址？", description: "旧地址和短链接立即失效，设备列表清空。", confirmText: "重置" })) rotateToken.mutate({ id: row.id }); }}>重置</Button>
                      <Button size="sm" variant="ghost" className="text-[var(--fx-down-text)]" onClick={async () => { if (await confirm({ title: "删除这条地址？", description: "用它的客户端立即拉不到。", confirmText: "删除" })) deleteToken.mutate({ id: row.id }); }}>删除</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
          <span>{page} / {pages}</span>
          <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
        </div>
      ) : null}
      <ProxySubTokenEditDialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        token={editing}
        nodes={[]}
        settings={settingsQuery.data || null}
        isAdmin
        onSaved={refresh}
      />
      <ProxySubTokenLogsDialog open={!!logsOf} onOpenChange={(open) => !open && setLogsOf(null)} tokenId={logsOf?.id || null} tokenName={logsOf?.name || ""} admin />
      <ProxySubTokenDevicesDialog open={!!devicesOf} onOpenChange={(open) => !open && setDevicesOf(null)} tokenId={devicesOf?.id || null} tokenName={devicesOf?.name || ""} admin />
    </div>
  );
}

// ==================== 统计与日志 ====================

function StatsTab() {
  const [days, setDays] = useState(7);
  const stats = trpc.proxySubscriptions.adminAccessStats.useQuery({ days });
  const logs = trpc.proxySubscriptions.adminAccessLogs.useQuery({ limit: 100 });
  const data = stats.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">最近</span>
        <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
          <SelectTrigger aria-label="统计时间范围" className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[1, 7, 30, 90].map((value) => <SelectItem key={value} value={String(value)}>{value} 天</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">拉取次数</p><p className="text-2xl font-semibold">{data?.total ?? "—"}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">不同 IP</p><p className="text-2xl font-semibold">{data?.distinctIps ?? "—"}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">被拒</p><p className="text-2xl font-semibold">{data ? data.byResult.filter((item) => item.result !== "ok" && item.result !== "page").reduce((sum, item) => sum + item.count, 0) : "—"}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">客户端种类</p><p className="text-2xl font-semibold">{data?.byFamily.length ?? "—"}</p></CardContent></Card>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">按结果</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(data?.byResult || []).sort((a, b) => b.count - a.count).map((item) => (
              <div key={item.result} className="flex justify-between"><span>{RESULT_LABELS[item.result] || item.result}</span><span className="text-muted-foreground">{item.count}</span></div>
            ))}
            {data && data.byResult.length === 0 ? <p className="text-xs text-muted-foreground">没有记录。拉取日志保留天数为 0 时不记。</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">按客户端</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(data?.byFamily || []).sort((a, b) => b.count - a.count).map((item) => (
              <div key={item.family} className="flex justify-between"><span>{item.label}</span><span className="text-muted-foreground">{item.count}</span></div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">最近 100 次拉取</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>令牌</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>客户端</TableHead>
                <TableHead>格式</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(logs.data || []).map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs">{timeText(row.at)}</TableCell>
                  <TableCell className="text-xs">#{row.tokenId} · 用户 #{row.userId}</TableCell>
                  <TableCell className="text-xs"><Badge variant={row.result === "ok" || row.result === "page" ? "secondary" : "destructive"}>{RESULT_LABELS[row.result] || row.result}</Badge></TableCell>
                  <TableCell className="text-xs" title={row.userAgent || ""}>{row.clientLabel || "未识别"}{row.clientVersion ? ` ${row.clientVersion}` : ""}</TableCell>
                  <TableCell className="text-xs">{row.format || "—"}{row.profile ? "（规则）" : ""}</TableCell>
                  <TableCell className="font-mono text-xs">{row.ip || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== 模板 ====================

type GroupForm = { name: string; type: "select" | "url-test" | "fallback" | "load-balance"; filter: string; match: ProxySubGroupMatch; includeGroups: boolean };

function TemplatesTab() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const query = trpc.proxySubscriptions.adminListTemplates.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProxySubTemplate | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<ProxySubTemplateTarget>("clash");
  const [prelude, setPrelude] = useState("");
  const [groups, setGroups] = useState<GroupForm[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const refresh = () => { void utils.proxySubscriptions.adminListTemplates.invalidate(); };
  const create = trpc.proxySubscriptions.adminCreateTemplate.useMutation({ onSuccess: () => { toast.success("模板已创建"); setDialogOpen(false); refresh(); }, onError: (error) => toast.error(error.message) });
  const update = trpc.proxySubscriptions.adminUpdateTemplate.useMutation({ onSuccess: () => { toast.success("模板已保存"); setDialogOpen(false); refresh(); }, onError: (error) => toast.error(error.message) });
  const remove = trpc.proxySubscriptions.adminDeleteTemplate.useMutation({ onSuccess: () => { toast.success("已删除"); refresh(); }, onError: (error) => toast.error(error.message) });

  const openCreate = (preset?: ProxySubTemplateTarget) => {
    const nextTarget = preset || "clash";
    setEditing(null);
    setName("");
    setTarget(nextTarget);
    setPrelude(query.data?.builtin[nextTarget] || "");
    setGroups([]);
    setIsDefault(false);
    setDialogOpen(true);
  };
  const openEdit = (template: ProxySubTemplate) => {
    setEditing(template);
    setName(template.name);
    setTarget(template.target);
    setPrelude(template.prelude);
    setGroups(template.customGroups.map((group) => ({ name: group.name, type: group.type, filter: group.filter, match: normalizeProxySubGroupMatch(group.match), includeGroups: !!group.includeGroups })));
    setIsDefault(!!template.isDefault);
    setDialogOpen(true);
  };
  const submit = () => {
    if (!name.trim()) {
      toast.error("请填名字");
      return;
    }
    const customGroups = groups.filter((group) => group.name.trim());
    if (editing?.id) update.mutate({ id: editing.id, name: name.trim(), prelude, customGroups, isDefault });
    else create.mutate({ name: name.trim(), target, prelude, customGroups, isDefault });
  };
  const templates = query.data?.templates || [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p data-fx-help="" className="text-xs text-muted-foreground">
          模板只管「节点之外」的部分（端口、DNS、TUN、[General]……），节点、策略组、分流规则照旧由面板生成接在后面；只进规则订阅。
          分配顺序：令牌指定 → 用户指定 → 套餐指定 → 这种格式的默认模板 → 内置。
        </p>
        <Button size="sm" onClick={() => openCreate()}><Plus className="mr-1 h-4 w-4" />新建模板</Button>
      </div>
      {templates.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">还没有模板，所有人用内置的开头部分。</CardContent></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((template) => (
            <Card key={template.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{template.name}</span>
                  <Badge variant="outline">{PROXY_SUB_TEMPLATE_TARGET_LABELS[template.target]}</Badge>
                  {template.isDefault ? <Badge>默认</Badge> : null}
                  {template.customGroups.length > 0 ? <Badge variant="secondary">{template.customGroups.length} 个自定义组</Badge> : null}
                </div>
                <pre className="max-h-24 overflow-hidden whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">{template.prelude.slice(0, 400) || "（空）"}</pre>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(template)}>编辑</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: `删除模板「${template.name}」？`, description: "指向它的令牌、用户、套餐退回默认。", confirmText: "删除" })) remove.mutate({ id: template.id! }); }}>删除</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{editing ? "编辑模板" : "新建模板"}</DialogTitle>
            <DialogDescription className="text-xs">
              占位符：{"{{app_name}} {{panel_url}} {{sub_url}} {{username}} {{expire_date}} {{data_left}} {{test_url}} {{main_group}}"}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField className="space-y-1.5">
                <Label>名字</Label>
                <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
              </FormField>
              <FormField className="space-y-1.5">
                <Label>目标格式</Label>
                <Select value={target} onValueChange={(value) => { const next = value as ProxySubTemplateTarget; setTarget(next); if (!editing && !prelude.trim()) setPrelude(query.data?.builtin[next] || ""); }} disabled={!!editing}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROXY_SUB_TEMPLATE_TARGETS.map((item) => <SelectItem key={item} value={item}>{PROXY_SUB_TEMPLATE_TARGET_LABELS[item]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>开头部分</Label>
                <Button size="sm" variant="ghost" onClick={() => setPrelude(query.data?.builtin[target] || "")}>填入内置默认</Button>
              </div>
              <Textarea value={prelude} onChange={(event) => setPrelude(event.target.value)} rows={14} className="font-mono text-xs" />
              <p data-fx-help="" className="text-xs text-muted-foreground">
                {target === "clash" ? "放在 proxies: 前面的 YAML，不能含 proxies / proxy-groups / rule-providers / rules。" : target === "singbox" ? "一个 JSON 对象（log / dns / inbounds / experimental / route.rules……），面板把 outbounds 和 route 并进去。" : "整段 [General]（含那一行表头）。"}
              </p>
            </FormField>
            <FormField className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>自定义策略组</Label>
                <Button size="sm" variant="outline" onClick={() => setGroups((prev) => [...prev, { name: "", type: "url-test", filter: "", match: "any", includeGroups: false }])}><Plus className="mr-1 h-3.5 w-3.5" />加一组</Button>
              </div>
              <p data-fx-help="" className="text-xs text-muted-foreground">按节点名挑成员（留空 = 全部），订阅刷新进来的新节点自动归组。会出现在主选择器和各分类组里。</p>
              {groups.map((group, index) => (
                <div key={index} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_8rem_8.5rem_1fr_auto_auto]">
                  <Input value={group.name} placeholder="组名，如 🇭🇰 香港" onChange={(event) => setGroups((prev) => prev.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))} />
                  <Select value={group.type} onValueChange={(value) => setGroups((prev) => prev.map((item, i) => (i === index ? { ...item, type: value as GroupForm["type"] } : item)))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="select">手动选择</SelectItem>
                      <SelectItem value="url-test">自动选最快</SelectItem>
                      <SelectItem value="fallback">主备切换</SelectItem>
                      <SelectItem value="load-balance">负载均衡</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={group.match} onValueChange={(value) => setGroups((prev) => prev.map((item, i) => (i === index ? { ...item, match: normalizeProxySubGroupMatch(value) } : item)))}>
                    <SelectTrigger aria-label="匹配方式"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROXY_SUB_GROUP_MATCHES.map((match) => <SelectItem key={match} value={match}>{PROXY_SUB_GROUP_MATCH_LABELS[match].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input value={group.filter} placeholder={PROXY_SUB_GROUP_MATCH_LABELS[group.match].placeholder} title={PROXY_SUB_GROUP_MATCH_LABELS[group.match].hint} onChange={(event) => setGroups((prev) => prev.map((item, i) => (i === index ? { ...item, filter: event.target.value } : item)))} />
                  <label className="flex items-center gap-1 text-xs"><Checkbox checked={group.includeGroups} onCheckedChange={(checked) => setGroups((prev) => prev.map((item, i) => (i === index ? { ...item, includeGroups: checked === true } : item)))} />含自动组</label>
                  <Button size="sm" variant="ghost" onClick={() => setGroups((prev) => prev.filter((_item, i) => i !== index))}>删</Button>
                </div>
              ))}
            </FormField>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={isDefault} onCheckedChange={(checked) => setIsDefault(checked === true)} />设为这种格式的默认模板</label>
          </div>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={create.isPending || update.isPending}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ==================== 设置 ====================

function SettingsTab() {
  const utils = trpc.useUtils();
  const query = trpc.proxySubscriptions.adminGetSettings.useQuery();
  const [form, setForm] = useState<ProxySubSettings>({ ...PROXY_SUB_DEFAULT_SETTINGS });
  const [domainsText, setDomainsText] = useState("");
  useEffect(() => {
    if (query.data) {
      setForm(query.data);
      setDomainsText(query.data.domains.join("\n"));
    }
  }, [query.data]);
  const save = trpc.proxySubscriptions.adminUpdateSettings.useMutation({
    onSuccess: () => { toast.success("订阅设置已保存"); void utils.proxySubscriptions.adminGetSettings.invalidate(); void utils.proxySubscriptions.settingsPublic.invalidate(); },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const set = <K extends keyof ProxySubSettings>(key: K, value: ProxySubSettings[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const number = (key: keyof ProxySubSettings, label: string, hint?: string, min = 0) => (
    <FormField className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" min={min} value={String(form[key] as number)} onChange={(event) => set(key, Number(event.target.value) as any)} />
      {hint ? <p data-fx-help="" className="text-xs text-muted-foreground">{hint}</p> : null}
    </FormField>
  );
  const toggle = (key: keyof ProxySubSettings, label: string, hint?: string) => (
    <FormField className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint ? <p data-fx-help="" className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Checkbox aria-label={label} checked={!!form[key]} onCheckedChange={(checked) => set(key, (checked === true) as any)} />
    </FormField>
  );
  const section = (title: string, children: React.ReactNode) => (
    <Card><CardHeader><CardTitle className="text-sm">{title}</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{children}</CardContent></Card>
  );
  const submit = () => {
    save.mutate({ ...form, domains: domainsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) });
  };

  return (
    <div className="space-y-4">
      {section("地址与客户端", <>
        <FormField className="space-y-1.5 sm:col-span-2">
          <Label>备用域名（一行一个 origin）</Label>
          <Textarea value={domainsText} onChange={(event) => setDomainsText(event.target.value)} rows={3} placeholder={"https://sub2.example.com\nhttps://sub3.example.com:8443"} className="font-mono text-xs" />
          <p data-fx-help="" className="text-xs text-muted-foreground">一键导入面板上每个客户端都会列出全部地址，主域名被墙时用户换一条就行。主地址来自系统设置的面板公网地址。</p>
        </FormField>
        {number("updateIntervalHours", "客户端更新间隔（小时）", "Profile-Update-Interval 响应头，Surge 托管配置也按它。", 1)}
        {toggle("landingPageEnabled", "浏览器打开订阅地址给落地页", "用量、到期、一键导入按钮、二维码；不列节点。")}
        <FormField className="space-y-1.5"><Label>帮助地址（support-url）</Label><Input value={form.supportUrl} onChange={(event) => set("supportUrl", event.target.value)} placeholder="https://…" /></FormField>
        <FormField className="space-y-1.5 sm:col-span-2"><Label>公告</Label><Textarea value={form.announce} onChange={(event) => set("announce", event.target.value)} rows={2} /><p data-fx-help="" className="text-xs text-muted-foreground">写进 announce 响应头（Happ / v2RayTun 会显示）、落地页，信息节点开着时也插一条。</p></FormField>
      </>)}
      {section("节点外观默认值", <>
        <FormField className="space-y-1.5 sm:col-span-2"><Label>默认命名模板</Label><Input value={form.nameTemplateDefault} onChange={(event) => set("nameTemplateDefault", event.target.value)} /><p data-fx-help="" className="text-xs text-muted-foreground">{"变量：{flag} {country} {code} {host} {node} {rule} {protocol} {index}。令牌上可以单独改。"}</p></FormField>
        {toggle("flagEmojiDefault", "节点名加国旗", "地区来自机器位置、节点上手填的国家码或名字里的关键字。")}
        {toggle("regionGroupsDefault", "按地区生成策略组", "🇭🇰 香港、🇯🇵 日本……各一个自动选最快的组。")}
        {toggle("protocolPrefixDefault", "节点名加协议前缀", "[VLESS] [Hysteria2] 这种。")}
        {toggle("infoNodesDefault", "插入信息节点", "剩余流量 / 到期 / 公告，做成几条连不上的占位节点。")}
      </>)}
      {section("分流与规则集", <>
        <FormField className="space-y-1.5"><Label>测速地址</Label><Input value={form.testUrl} onChange={(event) => set("testUrl", event.target.value)} /></FormField>
        {number("testIntervalSec", "测速间隔（秒）", undefined, 30)}
        {number("toleranceMs", "切换容差（毫秒）", "自动选路组两条延迟接近时不来回跳。")}
        {number("rulesetIntervalSec", "规则集更新间隔（秒）", undefined, 3600)}
        <FormField className="space-y-1.5 sm:col-span-2">
          <Label>规则集镜像</Label>
          <Input value={form.rulesetMirror} onChange={(event) => set("rulesetMirror", event.target.value)} placeholder="留空直连 GitHub；填 panel 由面板托管；或填镜像前缀" />
          <p data-fx-help="" className="text-xs text-muted-foreground">填 <code>panel</code>：客户端从面板的 /api/sub/ruleset/… 取规则文件（面板按更新间隔缓存）。填 https://ghproxy.example.com 之类走镜像。</p>
        </FormField>
        <FormField className="space-y-1.5 sm:col-span-2"><Label>全局前置规则（排在预设规则前，命中即止）</Label><Textarea value={form.customRulesPrepend} onChange={(event) => set("customRulesPrepend", event.target.value)} rows={4} className="font-mono text-xs" placeholder={"DOMAIN-SUFFIX,example.com,DIRECT\nGEOIP,PRIVATE,DIRECT"} /></FormField>
        <FormField className="space-y-1.5 sm:col-span-2"><Label>全局后置规则（排在 MATCH 前）</Label><Textarea value={form.customRulesAppend} onChange={(event) => set("customRulesAppend", event.target.value)} rows={3} className="font-mono text-xs" /></FormField>
      </>)}
      {section("限流与缓存", <>
        {number("rateLimitPerMinute", "每条令牌每分钟最多拉取（0 = 不限）")}
        {number("ipRateLimitPerMinute", "每个 IP 每分钟最多拉取（0 = 不限）")}
        {number("cacheTtlSec", "正文缓存（秒，0 = 不缓存）", "缓存的只是渲染结果；停用 / 到期 / 超流量每次都判。")}
        {number("accessLogRetentionDays", "拉取日志保留天数（0 = 不记）")}
      </>)}
      {section("设备数限制", <>
        {toggle("deviceLimitEnabled", "开启设备数限制", "上限取令牌 / 用户 / 套餐 / 下面的兜底值里最严的。")}
        {toggle("deviceLimitStrict", "严格模式：不带设备标识的客户端一律拒绝", "只有 Happ、v2RayTun 等少数客户端会发 x-hwid。关着时按来源 IP 退化统计。")}
        {number("deviceLimitFallback", "兜底上限（0 = 不限）", "令牌、用户、套餐都没设时用它。")}
        {number("deviceIpWindowHours", "按 IP 统计的窗口（小时）", "多久没来的 IP 不再算一台设备。", 1)}
      </>)}
      {section("外部订阅", <>
        {toggle("externalSourcesEnabled", "允许用户添加外部订阅", "面板替用户去拉别处的订阅。还要套餐开了「允许添加外部订阅」，管理员不受限。")}
        {number("externalSourceMaxPerUser", "每个用户最多几个（0 = 不限）")}
      </>)}
      {section("通知（发给令牌主人，每种每条令牌每天最多一封）", <>
        {toggle("notifyFirstAccess", "第一次被拉取")}
        {toggle("notifyNewDevice", "出现新设备")}
        {toggle("notifyDeviceLimit", "设备数已满")}
        {toggle("notifyFailures", "拉取被拒（到期 / 超流量 / 权限收回）")}
      </>)}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={save.isPending}>保存设置</Button>
      </div>
    </div>
  );
}

export default function AdminSubscriptionsPage() {
  const [tab, setTab] = useState<AdminTab>("tokens");
  const items = useMemo(() => TAB_ITEMS, []);
  return (
    <DashboardLayout>
      <div className="space-y-4">
        <WorkspaceHeader title={<>订阅运营</>} description={<>全站的订阅地址、谁在拉、发出去的配置长什么样、整站怎么限。</>} />
        <Tabs value={tab} onValueChange={(value) => setTab(value as AdminTab)}>
          <SlidingTabsList items={items} activeValue={tab} ariaLabel="订阅运营" minItemWidthRem={8} />
          <TabsContent value="tokens" className="mt-3"><TokensTab /></TabsContent>
          <TabsContent value="stats" className="mt-3"><StatsTab /></TabsContent>
          <TabsContent value="templates" className="mt-3"><TemplatesTab /></TabsContent>
          <TabsContent value="settings" className="mt-3"><SettingsTab /></TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
