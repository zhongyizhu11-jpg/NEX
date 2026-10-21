import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CloudCog, History, KeyRound, Pencil, Plus, Puzzle, RefreshCw, RotateCcw, Server, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import {
  IP_CHANGE_DEFAULTS,
  IP_CHANGE_EVENT_STATUS_LABELS,
  IP_CHANGE_LIMITS,
  IP_CHANGE_STATE_LABELS,
  IP_CHANGE_STATE_TONES,
  IP_CHANGE_TRIGGER_LABELS,
  normalizeIpChangeState,
  parseIpChangeCheckTargets,
  type IpChangeEventStatus,
  type IpChangeTrigger,
} from "@shared/ipChange";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { IpChangeFields, missingRequiredFields, type IpChangeProviderView } from "@/components/ipChange/IpChangeFields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";

/*
  自动换 IP（插件 auto-ip-change 的界面，核心页面）。

  三块：云账号（按云厂商声明的字段动态画表单）、主机（检测和更换的配置 + 当前状态 + 立即更换 / 重置状态）、
  更换记录。云厂商列表来自接口，新加一个厂商这里一行都不用改；列表为空时显示空状态。
*/

type TabKey = "hosts" | "accounts" | "events";

function formatTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(value as any);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

const TONE_CLASS: Record<string, string> = {
  healthy: "border-transparent bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  warn: "border-transparent bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  down: "border-transparent bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
  standby: "border-transparent bg-[var(--fx-standby-soft)] text-muted-foreground",
};

export function IpChangeStateBadge({ state }: { state: unknown }) {
  const normalized = normalizeIpChangeState(state);
  return <Badge className={TONE_CLASS[IP_CHANGE_STATE_TONES[normalized]]}>{IP_CHANGE_STATE_LABELS[normalized]}</Badge>;
}

function EventStatusBadge({ status }: { status: IpChangeEventStatus }) {
  const tone = status === "succeeded" ? "healthy" : status === "running" ? "warn" : "down";
  return <Badge className={TONE_CLASS[tone]}>{IP_CHANGE_EVENT_STATUS_LABELS[status] || status}</Badge>;
}

function InactiveNotice({ status }: { status: { pluginsEnabled: boolean; installed: boolean; enabled: boolean } }) {
  const description = !status.pluginsEnabled
    ? "插件功能总开关没有打开。请到「系统设置」里打开插件功能，再到「插件管理」安装并启用「自动换 IP」。"
    : !status.installed
      ? "还没有安装「自动换 IP」插件。请到「插件管理」的插件商店里安装并启用它。"
      : "「自动换 IP」插件已安装但没有启用。请到「插件管理」里启用它。";
  return (
    <EmptyState
      icon={<Puzzle className="h-6 w-6" />}
      title="需要先启用「自动换 IP」插件"
      description={description}
      actions={
        <Button asChild>
          <Link href={status.pluginsEnabled ? "/plugins" : "/settings"}>{status.pluginsEnabled ? "前往插件管理" : "前往系统设置"}</Link>
        </Button>
      }
    />
  );
}

export default function IpChangePage() {
  const statusQuery = trpc.ipChange.status.useQuery(undefined, { refetchOnWindowFocus: true });
  const [tab, setTab] = useState<TabKey>("hosts");
  const active = statusQuery.data?.active === true;

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <WorkspaceHeader
          title="自动换 IP"
          description="主机的公网 IP 被墙（连不上大陆）时，调用云厂商接口更换 IP，入口地址和 DNS 跟着改。"
          actions={(
            <Button variant="outline" asChild>
              <a href="https://github.com/zhongyizhu11-jpg/NEX/blob/main/docs/guide/auto-ip-change.md" target="_blank" rel="noreferrer">使用说明</a>
            </Button>
          )}
        />
        {statusQuery.isLoading ? (
          <DataSectionLoading label="正在加载自动换 IP" />
        ) : statusQuery.error ? (
          <DataSectionError label="自动换 IP 状态" error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
        ) : !active ? (
          <InactiveNotice status={statusQuery.data!} />
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-3 gap-1 rounded-md bg-muted/50 p-1 sm:w-auto sm:inline-grid">
              <TabsTrigger value="hosts" className="gap-1.5 px-3 py-1.5 text-sm"><Server className="h-4 w-4" />主机</TabsTrigger>
              <TabsTrigger value="accounts" className="gap-1.5 px-3 py-1.5 text-sm"><KeyRound className="h-4 w-4" />云账号</TabsTrigger>
              <TabsTrigger value="events" className="gap-1.5 px-3 py-1.5 text-sm"><History className="h-4 w-4" />更换记录</TabsTrigger>
            </TabsList>
            <TabsContent value="hosts" className="m-0"><HostsSection /></TabsContent>
            <TabsContent value="accounts" className="m-0"><AccountsSection /></TabsContent>
            <TabsContent value="events" className="m-0"><EventsSection /></TabsContent>
          </Tabs>
        )}
      </div>
    </DashboardLayout>
  );
}

// ───────────────────────── 云账号 ─────────────────────────

type AccountForm = { id: number | null; name: string; provider: string; credentials: Record<string, string> };

function AccountsSection() {
  const utils = trpc.useUtils();
  const providersQuery = trpc.ipChange.providers.useQuery();
  const accountsQuery = trpc.ipChange.accounts.list.useQuery();
  const confirmDialog = useConfirmDialog();
  const [form, setForm] = useState<AccountForm | null>(null);
  const [testing, setTesting] = useState<{ accountId: number; provider: string; target: Record<string, string>; result: string | null } | null>(null);
  const providers = (providersQuery.data || []) as IpChangeProviderView[];
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const invalidate = () => Promise.all([utils.ipChange.accounts.list.invalidate(), utils.ipChange.hosts.list.invalidate()]);
  const createAccount = trpc.ipChange.accounts.create.useMutation({
    onSuccess: async () => { await invalidate(); setForm(null); toast.success("云账号已添加"); },
    onError: (error) => toast.error(error.message || "添加失败"),
  });
  const updateAccount = trpc.ipChange.accounts.update.useMutation({
    onSuccess: async () => { await invalidate(); setForm(null); toast.success("云账号已保存"); },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const deleteAccount = trpc.ipChange.accounts.delete.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("云账号已删除"); },
    onError: (error) => toast.error(error.message || "删除失败"),
  });
  const testAccount = trpc.ipChange.accounts.test.useMutation({
    onSuccess: (data) => {
      setTesting((current) => current ? { ...current, result: data.currentIp ? `连接正常，当前公网 IP：${data.currentIp}` : "连接正常，云厂商没有返回公网 IP" } : current);
    },
    onError: (error) => setTesting((current) => current ? { ...current, result: error.message || "测试失败" } : current),
  });

  if (providersQuery.isLoading || accountsQuery.isLoading) return <DataSectionLoading label="正在加载云账号" />;
  if (providersQuery.error || accountsQuery.error) {
    return <DataSectionError label="云账号" error={providersQuery.error || accountsQuery.error} onRetry={() => { void providersQuery.refetch(); void accountsQuery.refetch(); }} />;
  }
  const accounts = accountsQuery.data || [];
  const formProvider = form ? providerById.get(form.provider) : undefined;

  const submit = () => {
    if (!form) return;
    if (!form.name.trim()) return void toast.error("请填写账号名称");
    if (!formProvider) return void toast.error("请选择云厂商");
    const missing = missingRequiredFields(formProvider.credentialFields, form.credentials);
    if (missing.length) return void toast.error(`请填写：${missing.join("、")}`);
    if (form.id) updateAccount.mutate({ id: form.id, name: form.name.trim(), credentials: form.credentials });
    else createAccount.mutate({ name: form.name.trim(), provider: form.provider, credentials: form.credentials });
  };

  const confirmDelete = async (account: { id: number; name: string }) => {
    if (deleteAccount.isPending) return;
    const confirmed = await confirmDialog({
      title: "删除云账号",
      description: `确认删除云账号「${account.name}」？面板里保存的凭据会一起删掉，云厂商那边不受影响。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (confirmed) deleteAccount.mutate({ id: account.id });
  };

  return (
    <div className="space-y-4">
      {providers.length === 0 ? (
        <EmptyState
          icon={<CloudCog className="h-6 w-6" />}
          title="还没有可用的云厂商"
          description="这个版本的面板还没有内置任何云厂商接口，暂时不能添加云账号。检测和主机配置可以先设好，等升级到带云厂商的版本后再接上账号。"
        />
      ) : (
        <div className="flex justify-end">
          <Button className="gap-2" onClick={() => setForm({ id: null, name: "", provider: providers[0].id, credentials: {} })}>
            <Plus className="h-4 w-4" />添加云账号
          </Button>
        </div>
      )}

      {accounts.length === 0 ? (
        providers.length > 0 ? <EmptyState icon={<KeyRound className="h-6 w-6" />} title="还没有云账号" description="先添加一个云账号，再到「主机」里给主机选上它。" /> : null
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader className="pb-2">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{account.name}</CardTitle>
                    <CardDescription keep>{account.providerLabel}{account.providerAvailable ? "" : "（这个版本不可用）"}</CardDescription>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`测试云账号 ${account.name}`}
                      disabled={!account.providerAvailable}
                      onClick={() => setTesting({ accountId: account.id, provider: account.provider, target: {}, result: null })}
                    >
                      <Zap className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`编辑云账号 ${account.name}`}
                      onClick={() => setForm({ id: account.id, name: account.name, provider: account.provider, credentials: { ...account.credentials } })}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      aria-label={`删除云账号 ${account.name}`}
                      disabled={deleteAccount.isPending}
                      onClick={() => void confirmDelete(account)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-1 text-meta text-muted-foreground">
                {account.credentialsError ? <p className="text-[var(--fx-down-text)]">{account.credentialsError}</p> : null}
                <p>使用中的主机：{account.usedByHosts.length} 台</p>
                <p>更新时间：{formatTime(account.updatedAt)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!form} onOpenChange={(open) => { if (!open) setForm(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{form?.id ? "编辑云账号" : "添加云账号"}</DialogTitle>
            {/* 权限说明里有很长的接口名（vpc:AllocateEipAddress/…），手机上不折行会顶出屏幕 */}
            <DialogDescription className="[overflow-wrap:anywhere]">{formProvider?.docsHint || "凭据加密保存在面板数据库里，任何接口都不会回显原文。"}</DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="dialog-scroll-area max-h-[65vh] space-y-3 overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField className="space-y-1">
                  <Label className="text-sm">账号名称 *</Label>
                  <Input value={form.name} placeholder="例如：AWS 东京" onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </FormField>
                <FormField className="space-y-1">
                  <Label className="text-sm">云厂商</Label>
                  <Select value={form.provider} disabled={!!form.id} onValueChange={(provider) => setForm({ ...form, provider, credentials: {} })}>
                    <SelectTrigger aria-label="云厂商"><SelectValue placeholder="选择云厂商" /></SelectTrigger>
                    <SelectContent>
                      {providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
              {formProvider ? (
                <IpChangeFields
                  fields={formProvider.credentialFields}
                  values={form.credentials}
                  secretHint={!!form.id}
                  onChange={(key, value) => setForm({ ...form, credentials: { ...form.credentials, [key]: value } })}
                />
              ) : <p className="text-meta text-muted-foreground">这个云厂商在当前版本不可用，只能改名称或删除。</p>}
              {formProvider?.requiresDowntime ? (
                <p className="text-meta text-[var(--fx-warn-text)]">注意：这个云厂商换 IP 时实例会关机或断网一段时间。</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>取消</Button>
            <Button onClick={submit} disabled={createAccount.isPending || updateAccount.isPending}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!testing} onOpenChange={(open) => { if (!open) { setTesting(null); testAccount.reset(); } }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>测试云账号</DialogTitle>
            <DialogDescription>填一台实例的信息，面板会用这个账号查一次它当前的公网 IP。不会改动任何东西。</DialogDescription>
          </DialogHeader>
          {testing ? (
            <div className="space-y-3">
              <IpChangeFields
                fields={providerById.get(testing.provider)?.targetFields || []}
                values={testing.target}
                onChange={(key, value) => setTesting({ ...testing, target: { ...testing.target, [key]: value }, result: null })}
              />
              {testing.result ? <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">{testing.result}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTesting(null)}>关闭</Button>
            <Button
              className="gap-2"
              disabled={testAccount.isPending}
              onClick={() => testing && testAccount.mutate({ accountId: testing.accountId, target: testing.target })}
            >
              <RefreshCw className={testAccount.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────────────────── 主机 ─────────────────────────

type HostForm = {
  isNew: boolean;
  hostId: number | null;
  enabled: boolean;
  autoEnabled: boolean;
  cloudAccountId: number | null;
  target: Record<string, string>;
  checkTargets: string;
  checkMethod: "tcp" | "ping";
  failureThreshold: string;
  checkIntervalSeconds: string;
  cooldownMinutes: string;
  maxChangesPerDay: string;
  releaseOldIp: boolean;
};

function emptyHostForm(): HostForm {
  return {
    isNew: true,
    hostId: null,
    enabled: true,
    autoEnabled: false,
    cloudAccountId: null,
    target: {},
    checkTargets: IP_CHANGE_DEFAULTS.checkTargets,
    checkMethod: IP_CHANGE_DEFAULTS.checkMethod,
    failureThreshold: String(IP_CHANGE_DEFAULTS.failureThreshold),
    checkIntervalSeconds: String(IP_CHANGE_DEFAULTS.checkIntervalSeconds),
    cooldownMinutes: String(IP_CHANGE_DEFAULTS.cooldownMinutes),
    maxChangesPerDay: String(IP_CHANGE_DEFAULTS.maxChangesPerDay),
    releaseOldIp: IP_CHANGE_DEFAULTS.releaseOldIp,
  };
}

function savePayload(form: {
  hostId: number;
  enabled: boolean;
  autoEnabled: boolean;
  cloudAccountId: number | null;
  target: Record<string, string>;
  checkTargets: string;
  checkMethod: "tcp" | "ping";
  failureThreshold: number | string;
  checkIntervalSeconds: number | string;
  cooldownMinutes: number | string;
  maxChangesPerDay: number | string;
  releaseOldIp: boolean;
}) {
  const clamp = (value: number | string, range: { min: number; max: number }, fallback: number) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.max(range.min, Math.min(range.max, n)) : fallback;
  };
  return {
    hostId: form.hostId,
    enabled: form.enabled,
    autoEnabled: form.autoEnabled,
    cloudAccountId: form.cloudAccountId,
    target: form.target,
    checkTargets: form.checkTargets,
    checkMethod: form.checkMethod,
    failureThreshold: clamp(form.failureThreshold, IP_CHANGE_LIMITS.failureThreshold, IP_CHANGE_DEFAULTS.failureThreshold),
    checkIntervalSeconds: clamp(form.checkIntervalSeconds, IP_CHANGE_LIMITS.checkIntervalSeconds, IP_CHANGE_DEFAULTS.checkIntervalSeconds),
    cooldownMinutes: clamp(form.cooldownMinutes, IP_CHANGE_LIMITS.cooldownMinutes, IP_CHANGE_DEFAULTS.cooldownMinutes),
    maxChangesPerDay: clamp(form.maxChangesPerDay, IP_CHANGE_LIMITS.maxChangesPerDay, IP_CHANGE_DEFAULTS.maxChangesPerDay),
    releaseOldIp: form.releaseOldIp,
  };
}

function HostsSection() {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const configsQuery = trpc.ipChange.hosts.list.useQuery(undefined, { refetchInterval: 15_000 });
  const optionsQuery = trpc.ipChange.hosts.options.useQuery();
  const accountsQuery = trpc.ipChange.accounts.list.useQuery();
  const providersQuery = trpc.ipChange.providers.useQuery();
  const [form, setForm] = useState<HostForm | null>(null);
  const providerById = useMemo(
    () => new Map(((providersQuery.data || []) as IpChangeProviderView[]).map((provider) => [provider.id, provider])),
    [providersQuery.data],
  );
  const accounts = accountsQuery.data || [];

  const invalidate = () => Promise.all([
    utils.ipChange.hosts.list.invalidate(),
    utils.ipChange.hosts.options.invalidate(),
    utils.ipChange.events.invalidate(),
    utils.ipChange.hostStatus.invalidate(),
  ]);
  const saveHost = trpc.ipChange.hosts.save.useMutation({
    onSuccess: async () => { await invalidate(); setForm(null); toast.success("已保存"); },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const deleteHost = trpc.ipChange.hosts.delete.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("已移除"); },
    onError: (error) => toast.error(error.message || "移除失败"),
  });
  const changeNow = trpc.ipChange.changeNow.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("已开始更换，进度看「更换记录」"); },
    onError: (error) => toast.error(error.message || "没有开始更换"),
  });
  const resetState = trpc.ipChange.resetState.useMutation({
    onSuccess: async () => { await invalidate(); toast.success("状态已重置"); },
    onError: (error) => toast.error(error.message || "重置失败"),
  });

  if (configsQuery.isLoading) return <DataSectionLoading label="正在加载主机配置" />;
  if (configsQuery.error) return <DataSectionError label="主机配置" error={configsQuery.error} onRetry={() => void configsQuery.refetch()} />;
  const configs = configsQuery.data || [];
  const unconfiguredHosts = (optionsQuery.data || []).filter((host) => !host.configured);
  const formAccount = form?.cloudAccountId ? accounts.find((account) => account.id === form.cloudAccountId) : undefined;
  const formProvider = formAccount ? providerById.get(formAccount.provider) : undefined;

  const submit = () => {
    if (!form) return;
    if (!form.hostId) return void toast.error("请选择主机");
    const parsed = parseIpChangeCheckTargets(form.checkTargets, form.checkMethod);
    if (parsed.errors.length) return void toast.error(parsed.errors.join("；"));
    if (form.enabled && parsed.targets.length === 0) return void toast.error("至少填一个探测目标");
    if (form.autoEnabled && formProvider) {
      const missing = missingRequiredFields(formProvider.targetFields, form.target);
      if (missing.length) return void toast.error(`请填写：${missing.join("、")}`);
    }
    saveHost.mutate(savePayload({ ...form, hostId: form.hostId }));
  };

  const confirmChange = async (config: (typeof configs)[number]) => {
    if (changeNow.isPending) return;
    const confirmed = await confirmDialog({
      title: "立即更换 IP",
      description: `确认马上给「${config.hostName}」更换公网 IP？会调用${config.providerLabel || "云厂商"}接口${config.requiresDowntime ? "，期间实例会关机或断网" : ""}；新 IP 可能产生费用。手动更换不受冷却时间限制。`,
      confirmText: "立即更换",
      tone: "destructive",
    });
    if (confirmed) changeNow.mutate({ hostId: config.hostId });
  };

  const confirmDelete = async (config: (typeof configs)[number]) => {
    if (deleteHost.isPending) return;
    const confirmed = await confirmDialog({
      title: "移除主机配置",
      description: `确认移除「${config.hostName}」的自动换 IP 配置？检测会停止，更换记录保留。`,
      confirmText: "移除",
      tone: "destructive",
    });
    if (confirmed) deleteHost.mutate({ hostId: config.hostId });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-muted-foreground">
          由主机自己的 Agent 探测大陆目标；所有目标连续 N 轮都不通、且主机对面板在线时，才算被墙。
        </p>
        <Button className="gap-2" disabled={unconfiguredHosts.length === 0} onClick={() => setForm(emptyHostForm())}>
          <Plus className="h-4 w-4" />添加主机
        </Button>
      </div>

      {configs.length === 0 ? (
        <EmptyState icon={<Server className="h-6 w-6" />} title="还没有主机启用自动换 IP" description="点「添加主机」，选一台主机、设好探测目标和云账号。" />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {configs.map((config) => {
            const state = normalizeIpChangeState(config.state);
            return (
              <Card key={config.hostId}>
                <CardHeader className="pb-2">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-base">
                        <span className="truncate">{config.hostName}</span>
                        <IpChangeStateBadge state={state} />
                        {!config.hostOnline ? <Badge variant="secondary">离线</Badge> : null}
                      </CardTitle>
                      <CardDescription keep className="truncate">
                        {config.hostAddress || "—"} · {config.accountName ? `${config.accountName}（${config.providerLabel}）` : "未选云账号"}
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        aria-label={`${config.hostName} 自动更换`}
                        checked={config.autoEnabled}
                        disabled={saveHost.isPending || !config.enabled || !config.cloudAccountId}
                        onCheckedChange={(checked) => saveHost.mutate(savePayload({ ...config, autoEnabled: checked }))}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[var(--fx-stroke-weak)] pt-2 text-meta">
                    <dt className="text-muted-foreground">检测</dt>
                    <dd className="text-right">
                      {config.enabled ? `${config.checkMethod === "ping" ? "Ping" : "TCP"} · 每 ${config.checkIntervalSeconds} 秒` : "未启用"}
                    </dd>
                    <dt className="text-muted-foreground">连续失败</dt>
                    <dd className="text-right tabular-nums">{config.consecutiveFailures} / {config.failureThreshold} 轮</dd>
                    <dt className="text-muted-foreground">上次检测</dt>
                    <dd className="text-right">{config.lastCheckAt ? formatTime(config.lastCheckAt) : config.enabled ? "等待 Agent 上报" : "—"}</dd>
                    <dt className="text-muted-foreground">上次更换</dt>
                    <dd className="text-right">{formatTime(config.lastChangeAt)}</dd>
                    <dt className="text-muted-foreground">24 小时内</dt>
                    <dd className="text-right tabular-nums">{config.attemptsLast24h} / {config.maxChangesPerDay} 次{config.cooldownUntil ? ` · 冷却到 ${formatTime(config.cooldownUntil)}` : ""}</dd>
                  </dl>
                  {config.lastError ? <p className="rounded-md bg-[var(--fx-down-soft)] px-3 py-2 text-meta text-[var(--fx-down-text)]">{config.lastError}</p> : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      aria-label={`移除 ${config.hostName} 的配置`}
                      disabled={deleteHost.isPending || config.inFlight}
                      onClick={() => void confirmDelete(config)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    {state === "uncertain" || state === "error" || state === "failing" || state === "cooldown" ? (
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={resetState.isPending || config.inFlight} onClick={() => resetState.mutate({ hostId: config.hostId })}>
                        <RotateCcw className="h-4 w-4" />重置状态
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => setForm({
                        isNew: false,
                        hostId: config.hostId,
                        enabled: config.enabled,
                        autoEnabled: config.autoEnabled,
                        cloudAccountId: config.cloudAccountId,
                        target: { ...(config.target as Record<string, string>) },
                        checkTargets: config.checkTargets,
                        checkMethod: config.checkMethod,
                        failureThreshold: String(config.failureThreshold),
                        checkIntervalSeconds: String(config.checkIntervalSeconds),
                        cooldownMinutes: String(config.cooldownMinutes),
                        maxChangesPerDay: String(config.maxChangesPerDay),
                        releaseOldIp: config.releaseOldIp,
                      })}
                    >
                      <Pencil className="h-4 w-4" />编辑
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={changeNow.isPending || config.inFlight || state === "changing" || state === "uncertain" || !config.providerAvailable}
                      onClick={() => void confirmChange(config)}
                    >
                      <Zap className="h-4 w-4" />立即更换
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!form} onOpenChange={(open) => { if (!open) setForm(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form?.isNew ? "添加主机" : "编辑主机配置"}</DialogTitle>
            <DialogDescription>探测由这台主机的 Agent 执行，不需要升级 Agent。</DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="dialog-scroll-area max-h-[65vh] space-y-4 overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField className="space-y-1">
                  <Label className="text-sm">主机</Label>
                  <Select
                    value={form.hostId ? String(form.hostId) : ""}
                    disabled={!form.isNew}
                    onValueChange={(value) => setForm({ ...form, hostId: Number(value) })}
                  >
                    <SelectTrigger aria-label="主机"><SelectValue placeholder="选择主机" /></SelectTrigger>
                    <SelectContent>
                      {(form.isNew ? unconfiguredHosts : optionsQuery.data || []).map((host) => (
                        <SelectItem key={host.id} value={String(host.id)}>{host.name}{host.address ? `（${host.address}）` : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField className="space-y-1">
                  <Label className="text-sm">云账号</Label>
                  <Select
                    value={form.cloudAccountId ? String(form.cloudAccountId) : "none"}
                    onValueChange={(value) => setForm({ ...form, cloudAccountId: value === "none" ? null : Number(value), target: {}, autoEnabled: value === "none" ? false : form.autoEnabled })}
                  >
                    <SelectTrigger aria-label="云账号"><SelectValue placeholder="选择云账号" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">暂不选择（只检测、只提醒）</SelectItem>
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={String(account.id)}>{account.name}（{account.providerLabel}）</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              {formProvider ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">实例信息（{formProvider.label}）</h3>
                  <IpChangeFields
                    fields={formProvider.targetFields}
                    values={form.target}
                    onChange={(key, value) => setForm({ ...form, target: { ...form.target, [key]: value } })}
                  />
                </section>
              ) : formAccount ? (
                <p className="text-meta text-[var(--fx-warn-text)]">这个账号的云厂商在当前版本不可用，只能检测和提醒。</p>
              ) : null}

              <section className="space-y-3 border-t border-[var(--fx-stroke-weak)] pt-3">
                <h3 className="text-sm font-medium">检测</h3>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <FormField className="flex items-center gap-2">
                    <Checkbox aria-label="启用检测" checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked, autoEnabled: checked ? form.autoEnabled : false })} />
                    <Label className="text-sm">启用检测</Label>
                  </FormField>
                  <FormField className="flex items-center gap-2">
                    <Checkbox
                      aria-label="到阈值后自动更换"
                      checked={form.autoEnabled}
                      disabled={!form.enabled || !form.cloudAccountId}
                      onCheckedChange={(checked) => setForm({ ...form, autoEnabled: checked })}
                    />
                    <Label className="text-sm">到阈值后自动更换</Label>
                  </FormField>
                  <FormField className="flex items-center gap-2">
                    <Checkbox aria-label="换完释放旧 IP" checked={form.releaseOldIp} onCheckedChange={(checked) => setForm({ ...form, releaseOldIp: checked })} />
                    <Label className="text-sm">换完释放旧 IP</Label>
                  </FormField>
                </div>
                <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <FormField className="space-y-1">
                    <Label className="text-sm">探测方式</Label>
                    <Select value={form.checkMethod} onValueChange={(value) => setForm({ ...form, checkMethod: value === "ping" ? "ping" : "tcp" })}>
                      <SelectTrigger aria-label="探测方式"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">TCP 连接</SelectItem>
                        <SelectItem value="ping">Ping</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField className="space-y-1">
                    <Label className="text-sm">大陆探测目标（一行一个）</Label>
                    <Textarea
                      rows={3}
                      className="font-mono text-xs"
                      value={form.checkTargets}
                      placeholder={IP_CHANGE_DEFAULTS.checkTargets}
                      onChange={(event) => setForm({ ...form, checkTargets: event.target.value })}
                    />
                    <p className="text-meta text-muted-foreground">只填只在大陆有节点的目标；海外有 CDN 节点的大站（qq.com、baidu.com 这类）被墙了照样通，会让检测失效。</p>
                  </FormField>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <FormField className="space-y-1">
                    <Label className="text-sm">连续失败几轮</Label>
                    <Input type="number" min={IP_CHANGE_LIMITS.failureThreshold.min} max={IP_CHANGE_LIMITS.failureThreshold.max} value={form.failureThreshold} onChange={(event) => setForm({ ...form, failureThreshold: event.target.value })} />
                  </FormField>
                  <FormField className="space-y-1">
                    <Label className="text-sm">检测间隔（秒）</Label>
                    <Input type="number" min={IP_CHANGE_LIMITS.checkIntervalSeconds.min} max={IP_CHANGE_LIMITS.checkIntervalSeconds.max} value={form.checkIntervalSeconds} onChange={(event) => setForm({ ...form, checkIntervalSeconds: event.target.value })} />
                  </FormField>
                  <FormField className="space-y-1">
                    <Label className="text-sm">冷却（分钟）</Label>
                    <Input type="number" min={IP_CHANGE_LIMITS.cooldownMinutes.min} max={IP_CHANGE_LIMITS.cooldownMinutes.max} value={form.cooldownMinutes} onChange={(event) => setForm({ ...form, cooldownMinutes: event.target.value })} />
                  </FormField>
                  <FormField className="space-y-1">
                    <Label className="text-sm">每天最多（次）</Label>
                    <Input type="number" min={IP_CHANGE_LIMITS.maxChangesPerDay.min} max={IP_CHANGE_LIMITS.maxChangesPerDay.max} value={form.maxChangesPerDay} onChange={(event) => setForm({ ...form, maxChangesPerDay: event.target.value })} />
                  </FormField>
                </div>
                <p className="text-meta text-muted-foreground">冷却和每日上限只约束自动更换；「立即更换」不看冷却。新的弹性 IP 可能收费，旧 IP 不释放也可能继续计费。</p>
              </section>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>取消</Button>
            <Button onClick={submit} disabled={saveHost.isPending}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────────────────── 更换记录 ─────────────────────────

function EventsSection() {
  const [page, setPage] = useState(1);
  const [hostId, setHostId] = useState<number | null>(null);
  const optionsQuery = trpc.ipChange.hosts.options.useQuery();
  const eventsQuery = trpc.ipChange.events.useQuery({ page, pageSize: 20, hostId: hostId || undefined }, { refetchInterval: 10_000 });
  const data = eventsQuery.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FormField className="flex items-center gap-2">
          <Label className="text-sm">主机</Label>
          <Select value={hostId ? String(hostId) : "all"} onValueChange={(value) => { setHostId(value === "all" ? null : Number(value)); setPage(1); }}>
            <SelectTrigger aria-label="按主机筛选" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部主机</SelectItem>
              {(optionsQuery.data || []).map((host) => <SelectItem key={host.id} value={String(host.id)}>{host.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      {eventsQuery.isLoading ? (
        <DataSectionLoading label="正在加载更换记录" />
      ) : eventsQuery.error ? (
        <DataSectionError label="更换记录" error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={<History className="h-6 w-6" />} title="还没有更换记录" description="手动或自动更换 IP、测试云账号都会记在这里。" />
      ) : (
        <div className="space-y-2">
          {data.items.map((event) => (
            <div key={event.id} className="rounded-[var(--fx-radius-surface)] bg-[var(--fx-l1-surface)] px-3 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{event.hostName}</span>
                <EventStatusBadge status={event.status} />
                <Badge variant="secondary">{IP_CHANGE_TRIGGER_LABELS[event.trigger as IpChangeTrigger] || event.trigger}</Badge>
                {event.ipRole === "entry" ? <Badge variant="secondary">新入口</Badge> : null}
                <span className="ml-auto text-meta text-muted-foreground">{formatTime(event.startedAt)}</span>
              </div>
              <p className="mt-1 break-all text-meta tabular-nums">
                {event.providerLabel || "—"} · {event.oldIp || "—"} → {event.newIp || "—"}
              </p>
              {event.error ? <p className="mt-1 break-words text-meta text-[var(--fx-down-text)]">{event.error}</p> : null}
              {event.notes.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-meta text-muted-foreground">
                  {event.notes.map((note, index) => <li key={index} className="break-words">{note}</li>)}
                </ul>
              ) : null}
            </div>
          ))}
          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="text-meta text-muted-foreground">第 {data.page} / {totalPages} 页 · 共 {data.total} 条</span>
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>
        </div>
      )}
    </div>
  );
}
