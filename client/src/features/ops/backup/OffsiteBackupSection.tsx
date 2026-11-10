import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Check, CloudUpload, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { AppRouter } from "../../../../../server/routers";

/**
 * 设置 › 备份恢复 › 异地自动备份（#10）。
 *
 * 和上面的手动导出是同一份加密备份，只是定时自动传到别处：机器整台没了，备份还在。
 * 口令存在面板里，定时任务才能加密；恢复时要再输一次 —— 那是一件会替换全部数据的事。
 *
 * 目的地可以同时开几个，所以是三行复选框而不是单选；都没勾就是关闭。勾选要点保存才生效，
 * 所以用复选框不用开关（见 client/src/switchVsCheckbox.test.ts）。
 * 远端有哪些备份要去请求对方服务器，只在点了「从远端恢复」之后才查。
 * 已经配好的目的地只露一行摘要，点「修改」才展开那些输入框 —— 两个都开时卡片不至于拉成两屏。
 */

type BackupData = inferRouterOutputs<AppRouter>["ops"]["offsiteBackup"]["get"];
type RemoteGroup = inferRouterOutputs<AppRouter>["ops"]["offsiteBackup"]["list"][number];
type Target = BackupData["destinations"][number];
type ScheduleMode = BackupData["schedule"]["mode"];

const TARGET_LABELS: Record<Target, string> = { webdav: "WebDAV", s3: "S3", telegram: "Telegram" };
const TARGET_ROWS: Array<{ target: Target; key: "webdavOn" | "s3On" | "telegramOn"; label: string; description: string }> = [
  { target: "webdav", key: "webdavOn", label: "WebDAV", description: "坚果云、Nextcloud、群晖、Alist 等。填一个专用目录。" },
  { target: "s3", key: "s3On", label: "S3 兼容存储", description: "AWS S3、Cloudflare R2、MinIO、阿里云 OSS 等。" },
  { target: "telegram", key: "telegramOn", label: "Telegram", description: "以文件发给绑定了 Telegram 的管理员。" },
];
const SCHEDULE_MODES: Array<{ value: ScheduleMode; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "interval", label: "每隔" },
];
/** 周一排第一个；值和服务端一样是 0 = 周日。 */
const WEEKDAYS = [
  { value: "1", label: "周一" },
  { value: "2", label: "周二" },
  { value: "3", label: "周三" },
  { value: "4", label: "周四" },
  { value: "5", label: "周五" },
  { value: "6", label: "周六" },
  { value: "0", label: "周日" },
];
const DEFAULT_KEEP = 14;
/** 「最近结果」默认露出几条，其余点「全部」再看。 */
const HISTORY_PREVIEW = 4;

type Form = {
  webdavOn: boolean;
  s3On: boolean;
  telegramOn: boolean;
  webdavUrl: string;
  webdavUser: string;
  webdavPassword: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3PathStyle: boolean;
  passphrase: string;
  passphraseConfirm: string;
  scheduleMode: ScheduleMode;
  scheduleHour: string;
  scheduleWeekday: string;
  everyHours: string;
  keep: string;
};

function formFrom(data: BackupData | undefined): Form {
  const schedule = data?.schedule;
  return {
    webdavOn: !!data?.destinations.includes("webdav"),
    s3On: !!data?.destinations.includes("s3"),
    telegramOn: !!data?.destinations.includes("telegram"),
    webdavUrl: data?.webdav.url || "",
    webdavUser: data?.webdav.user || "",
    webdavPassword: "",
    s3Endpoint: data?.s3.endpoint || "",
    s3Region: data?.s3.region || "",
    s3Bucket: data?.s3.bucket || "",
    s3Prefix: data?.s3.prefix || "",
    s3AccessKey: data?.s3.accessKeyId || "",
    s3SecretKey: "",
    s3PathStyle: data?.s3.pathStyle !== false,
    passphrase: "",
    passphraseConfirm: "",
    scheduleMode: schedule?.mode || "daily",
    scheduleHour: String(schedule && schedule.mode !== "interval" ? schedule.hour : 4),
    scheduleWeekday: String(schedule?.mode === "weekly" ? schedule.weekday : 1),
    everyHours: String(schedule?.mode === "interval" ? schedule.everyHours : 12),
    keep: String(data?.keep || DEFAULT_KEEP),
  };
}

function formatSize(bytes: number) {
  if (!bytes) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatTime(ms: number | null | undefined) {
  if (!ms) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 已保存的目的地的一行摘要（地址去掉 https://）。还没配好返回空串：那就直接展开输入框。 */
function targetSummary(target: Target, data: BackupData): string {
  if (!data.destinations.includes(target)) return "";
  if (target === "webdav") return data.webdav.url.replace(/^https?:\/\//, "");
  if (target === "s3") return data.s3.endpoint && data.s3.bucket ? `${data.s3.bucket} · ${data.s3.endpoint.replace(/^https?:\/\//, "")}` : "";
  return "";
}

function clampInt(text: string, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(text));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export default function OffsiteBackupSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.offsiteBackup.get.useQuery(undefined, { refetchOnWindowFocus: false });
  const data = query.data;
  const [form, setForm] = useState<Form>(() => formFrom(undefined));
  const [editingPassphrase, setEditingPassphrase] = useState(false);
  const [editingTarget, setEditingTarget] = useState<Partial<Record<Target, boolean>>>({});
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePick, setRestorePick] = useState<{ destination: Target; name: string } | null>(null);
  const [restorePassword, setRestorePassword] = useState("");

  useEffect(() => {
    if (data) setForm(formFrom(data));
  }, [data]);

  const savedOn = (data?.destinations.length || 0) > 0;
  const listQuery = trpc.ops.offsiteBackup.list.useQuery(undefined, {
    enabled: restoreOpen && savedOn,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const save = trpc.ops.offsiteBackup.save.useMutation();
  const testConnection = trpc.ops.offsiteBackup.testConnection.useMutation();
  const runNow = trpc.ops.offsiteBackup.runNow.useMutation();
  const restore = trpc.ops.offsiteBackup.restore.useMutation();

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const anyOn = form.webdavOn || form.s3On || form.telegramOn;
  const needsPassphrase = !data?.hasPassphrase || editingPassphrase;
  const busy = save.isPending || testConnection.isPending || runNow.isPending;

  const dirty = useMemo(() => {
    if (!data) return false;
    const base = formFrom(data);
    return (Object.keys(base) as Array<keyof Form>).some((key) => base[key] !== form[key]);
  }, [data, form]);

  const persist = async () => {
    if (needsPassphrase && (form.passphrase || anyOn)) {
      if (form.passphrase.length < 8) throw new Error("备份口令至少 8 位");
      if (form.passphrase !== form.passphraseConfirm) throw new Error("两次输入的口令不一样");
    }
    const hour = clampInt(form.scheduleHour, 4, 0, 23);
    await save.mutateAsync({
      destinations: TARGET_ROWS.filter((row) => form[row.key]).map((row) => row.target),
      webdav: { url: form.webdavUrl, user: form.webdavUser, password: form.webdavPassword || undefined },
      s3: {
        endpoint: form.s3Endpoint,
        region: form.s3Region,
        bucket: form.s3Bucket,
        prefix: form.s3Prefix,
        accessKeyId: form.s3AccessKey,
        secretAccessKey: form.s3SecretKey || undefined,
        pathStyle: form.s3PathStyle,
      },
      passphrase: needsPassphrase && form.passphrase ? form.passphrase : undefined,
      schedule: form.scheduleMode === "interval"
        ? { mode: "interval", everyHours: clampInt(form.everyHours, 12, 1, 168) }
        : form.scheduleMode === "weekly"
          ? { mode: "weekly", weekday: clampInt(form.scheduleWeekday, 1, 0, 6), hour }
          : { mode: "daily", hour },
      keep: clampInt(form.keep, DEFAULT_KEEP, 1, 100),
    });
    setEditingPassphrase(false);
    setEditingTarget({});
    await utils.ops.offsiteBackup.get.invalidate();
  };

  const onSave = async () => {
    try {
      await persist();
      toast.success("已保存");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  /** 测试和立即备份用的是已保存的设置：有改动先保存。 */
  const withSaved = async (action: () => Promise<void>) => {
    try {
      if (dirty || (needsPassphrase && form.passphrase)) await persist();
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const onTest = () => withSaved(async () => {
    const result = await testConnection.mutateAsync();
    toast.success(result.message);
  });

  const onRunNow = () => withSaved(async () => {
    try {
      const result = await runNow.mutateAsync();
      toast.success(result.message);
    } finally {
      void utils.ops.offsiteBackup.get.invalidate();
    }
  });

  const closeRestore = () => {
    if (restore.isPending) return;
    setRestoreOpen(false);
    setRestorePick(null);
    setRestorePassword("");
  };

  const onRestore = async () => {
    if (!restorePick) return;
    try {
      const result = await restore.mutateAsync({ ...restorePick, password: restorePassword, confirmed: true });
      const alreadyImported = "alreadyImported" in result && result.alreadyImported === true;
      setRestoreOpen(false);
      setRestorePick(null);
      setRestorePassword("");
      toast.success(alreadyImported ? "这份备份之前已经恢复过" : "已恢复，页面即将刷新");
      if (!alreadyImported) window.setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  if (query.isLoading) return <DataSectionLoading />;
  if (query.error || !data) return <DataSectionError label="异地备份设置" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;

  const history = data.history;
  const shownHistory = showAllHistory ? history : history.slice(0, HISTORY_PREVIEW);
  const remoteGroups: RemoteGroup[] = listQuery.data || [];

  const targetFields: Record<Target, ReactNode> = {
    webdav: (
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">目录地址</Label>
          <Input value={form.webdavUrl} onChange={(event) => set("webdavUrl", event.target.value)} placeholder="https://dav.jianguoyun.com/dav/nex-backup/" inputMode="url" />
        </FormField>
        <FormField className="space-y-1.5">
          <Label className="text-xs">用户名</Label>
          <Input value={form.webdavUser} onChange={(event) => set("webdavUser", event.target.value)} autoComplete="off" />
        </FormField>
        <FormField className="space-y-1.5">
          <Label className="text-xs">密码</Label>
          <PasswordInput
            value={form.webdavPassword}
            onChange={(event) => set("webdavPassword", event.target.value)}
            placeholder={data.webdav.hasPassword ? "已设置，留空不改" : "应用密码"}
            autoComplete="new-password"
          />
        </FormField>
      </div>
    ),
    s3: (
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">地址（Endpoint）</Label>
          <Input value={form.s3Endpoint} onChange={(event) => set("s3Endpoint", event.target.value)} placeholder="https://<账号>.r2.cloudflarestorage.com" inputMode="url" />
        </FormField>
        <FormField className="space-y-1.5">
          <Label className="text-xs">存储桶</Label>
          <Input value={form.s3Bucket} onChange={(event) => set("s3Bucket", event.target.value)} />
        </FormField>
        <FormField className="space-y-1.5">
          <Label className="text-xs">区域</Label>
          <Input value={form.s3Region} onChange={(event) => set("s3Region", event.target.value)} placeholder="us-east-1（R2 填 auto）" />
        </FormField>
        <FormField className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">目录前缀</Label>
          <Input value={form.s3Prefix} onChange={(event) => set("s3Prefix", event.target.value)} placeholder="nex/（可留空）" />
        </FormField>
        <FormField className="space-y-1.5">
          <Label className="text-xs">Access Key</Label>
          <Input value={form.s3AccessKey} onChange={(event) => set("s3AccessKey", event.target.value)} autoComplete="off" />
        </FormField>
        <FormField className="space-y-1.5">
          <Label className="text-xs">Secret Key</Label>
          <PasswordInput
            value={form.s3SecretKey}
            onChange={(event) => set("s3SecretKey", event.target.value)}
            placeholder={data.s3.hasSecretKey ? "已设置，留空不改" : ""}
            autoComplete="new-password"
          />
        </FormField>
        <label className="flex cursor-pointer items-center justify-between gap-3 sm:col-span-2">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm">路径风格地址</span>
            <span className="text-meta text-muted-foreground">MinIO、R2 等要勾上；阿里云 OSS 要去掉。</span>
          </span>
          <Checkbox aria-label="路径风格地址" checked={form.s3PathStyle} onCheckedChange={(checked) => set("s3PathStyle", checked === true)} />
        </label>
      </div>
    ),
    telegram: null,
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudUpload className="h-4 w-4 text-primary" />
          异地自动备份
        </CardTitle>
        <CardDescription>按计划把加密备份传到别处，面板所在的机器整台没了也能恢复。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingList>
          {TARGET_ROWS.map((row) => (
            <SettingRow
              key={row.target}
              asLabel
              label={row.label}
              description={row.description}
              control={<Checkbox aria-label={`备份到 ${row.label}`} checked={form[row.key]} onCheckedChange={(checked) => set(row.key, checked === true)} />}
            >
              {!form[row.key] || !targetFields[row.target] ? null : targetSummary(row.target, data) && !editingTarget[row.target] ? (
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-meta text-muted-foreground">{targetSummary(row.target, data)}</span>
                  <Button variant="link" size="sm" className="h-auto shrink-0 p-0 text-meta" onClick={() => setEditingTarget((prev) => ({ ...prev, [row.target]: true }))}>修改</Button>
                </div>
              ) : targetFields[row.target]}
            </SettingRow>
          ))}

          {anyOn ? (
            <>
              <SettingRow
                label="备份口令"
                description="备份用它加密，恢复时要输入。忘了它，备份就打不开。"
                control={data.hasPassphrase && !editingPassphrase ? (
                  <Button variant="outline" size="sm" onClick={() => setEditingPassphrase(true)}>修改</Button>
                ) : undefined}
              >
                {needsPassphrase ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <PasswordInput
                      value={form.passphrase}
                      onChange={(event) => set("passphrase", event.target.value)}
                      placeholder="至少 8 位"
                      autoComplete="new-password"
                      aria-label="备份口令"
                    />
                    <PasswordInput
                      value={form.passphraseConfirm}
                      onChange={(event) => set("passphraseConfirm", event.target.value)}
                      placeholder="再输一次"
                      autoComplete="new-password"
                      aria-label="再输一次备份口令"
                    />
                  </div>
                ) : null}
                {editingPassphrase && data.hasPassphrase ? (
                  <span className="text-meta text-[var(--fx-warn-text)]">改了以后，之前的备份仍要用旧口令打开。</span>
                ) : null}
              </SettingRow>

              <SettingRow label="多久一次" description="北京时间。">
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={form.scheduleMode} onValueChange={(value) => set("scheduleMode", value as ScheduleMode)}>
                    <SelectTrigger className="h-9 w-[88px]" aria-label="备份节奏"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SCHEDULE_MODES.map((mode) => <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {form.scheduleMode === "weekly" ? (
                    <Select value={form.scheduleWeekday} onValueChange={(value) => set("scheduleWeekday", value)}>
                      <SelectTrigger className="h-9 w-[88px]" aria-label="每周几备份"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((day) => <SelectItem key={day.value} value={day.value}>{day.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {form.scheduleMode === "interval" ? (
                    <span className="flex items-center gap-2 text-sm">
                      <Input className="h-9 w-16" inputMode="numeric" aria-label="每隔几小时备份" value={form.everyHours} onChange={(event) => set("everyHours", event.target.value.replace(/\D/g, ""))} />
                      小时
                    </span>
                  ) : (
                    <Select value={form.scheduleHour} onValueChange={(value) => set("scheduleHour", value)}>
                      <SelectTrigger className="h-9 w-[96px]" aria-label="几点备份"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, hour) => (
                          <SelectItem key={hour} value={String(hour)}>{String(hour).padStart(2, "0")}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </SettingRow>

              <SettingRow
                label="保留几份"
                description="只删面板自己传上去的旧备份，目录里别的文件不动。"
                control={(
                  <Input className="h-9 w-20 text-right" inputMode="numeric" aria-label="保留几份" value={form.keep} onChange={(event) => set("keep", event.target.value.replace(/\D/g, ""))} />
                )}
              />
            </>
          ) : null}
        </SettingList>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void onSave()} disabled={busy || (!dirty && !(needsPassphrase && form.passphrase))}>
            {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
          {anyOn ? (
            <>
              <Button variant="outline" onClick={() => void onTest()} disabled={busy}>
                {testConnection.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                测试连接
              </Button>
              <Button variant="outline" onClick={() => void onRunNow()} disabled={busy}>
                {runNow.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                立即备份
              </Button>
            </>
          ) : null}
        </div>

        {savedOn ? (
          <div className="space-y-1.5 border-t border-[var(--fx-stroke-weak)] pt-3">
            <div className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
              <span>最近结果</span>
              {data.nextRunAt ? <span>下次 {formatTime(data.nextRunAt)}</span> : null}
            </div>
            {history.length === 0 ? (
              <span className="block text-meta text-muted-foreground">还没有备份过。</span>
            ) : (
              <ul className="space-y-1">
                {shownHistory.map((entry, index) => (
                  <li key={`${entry.at}-${entry.destination}-${index}`} className="flex min-w-0 items-start gap-2 text-meta">
                    {entry.ok
                      ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="成功" />
                      : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--fx-warn-text)]" aria-label="失败" />}
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(entry.at)}</span>
                    <span className="shrink-0">{TARGET_LABELS[entry.destination]}</span>
                    <span className={cn("min-w-0 flex-1 break-words", entry.ok ? "text-muted-foreground" : "text-[var(--fx-warn-text)]")}>
                      {entry.ok ? [formatSize(entry.size), entry.message].filter(Boolean).join("，") : entry.message || "失败"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-2">
              {history.length > HISTORY_PREVIEW ? (
                <Button variant="link" size="sm" className="h-auto p-0 text-meta" onClick={() => setShowAllHistory((value) => !value)}>
                  {showAllHistory ? "收起" : `全部 ${history.length} 条`}
                </Button>
              ) : <span />}
              <Button variant="link" size="sm" className="h-auto p-0 text-meta" onClick={() => setRestoreOpen(true)} disabled={busy}>从远端恢复</Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={restoreOpen} onOpenChange={(open) => { if (!open) closeRestore(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>从异地备份恢复</DialogTitle>
            <DialogDescription>
              会用选中的备份替换面板现在的全部数据（用户、主机、规则、设置……），之后的改动都会丢失。Agent 会按恢复后的配置重新同步。
            </DialogDescription>
          </DialogHeader>
          {listQuery.isLoading ? (
            <span className="text-meta text-muted-foreground">正在读取远端的备份…</span>
          ) : listQuery.error ? (
            <span className="text-meta text-[var(--fx-warn-text)]">读不到远端的备份：{listQuery.error.message}</span>
          ) : (
            <div className="max-h-[40svh] space-y-3 overflow-y-auto">
              {remoteGroups.map((group) => (
                <div key={group.destination} className="space-y-1">
                  {remoteGroups.length > 1 ? <span className="block text-meta text-muted-foreground">{group.label}</span> : null}
                  {group.error ? (
                    <span className="block text-meta text-[var(--fx-warn-text)]">读不到：{group.error}</span>
                  ) : group.files.length === 0 ? (
                    <span className="block text-meta text-muted-foreground">还没有备份。</span>
                  ) : group.files.map((file) => {
                    const picked = restorePick?.destination === group.destination && restorePick.name === file.name;
                    return (
                      <button
                        key={file.name}
                        type="button"
                        aria-pressed={picked}
                        onClick={() => setRestorePick({ destination: group.destination, name: file.name })}
                        className={cn(
                          "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left",
                          picked ? "border-primary bg-primary/10" : "border-[var(--fx-stroke-weak)]",
                        )}
                      >
                        <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
                        <span className="shrink-0 text-meta text-muted-foreground">{formatSize(file.size)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <FormField className="space-y-1.5">
            <Label className="text-xs">备份口令</Label>
            <PasswordInput value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} autoComplete="off" placeholder="这份备份当时的口令" />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={closeRestore} disabled={restore.isPending}>取消</Button>
            <Button variant="destructive" onClick={() => void onRestore()} disabled={!restorePick || !restorePassword || restore.isPending}>
              {restore.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              替换并恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
