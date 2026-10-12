import { useEffect, useMemo, useState } from "react";
import { CloudUpload, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * 设置 › 备份恢复 › 异地自动备份（#10）。
 *
 * 和上面的手动导出是同一份加密备份，只是定时自动传到别处：机器整台没了，备份还在。
 * 口令存在面板里，定时任务才能加密；恢复时要再输一次 —— 那是一件会替换全部数据的事。
 */

type Destination = "off" | "webdav" | "s3" | "telegram";

const DESTINATIONS: Array<{ value: Destination; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "webdav", label: "WebDAV" },
  { value: "s3", label: "S3" },
  { value: "telegram", label: "Telegram" },
];

const DESTINATION_HINTS: Record<Destination, string> = {
  off: "不自动备份。上面的「导出备份」照常可用。",
  webdav: "坚果云、Nextcloud、群晖、Alist 等。填一个专用目录，面板只管 nex-backup- 开头的文件。",
  s3: "AWS S3、Cloudflare R2、MinIO、阿里云 OSS 等 S3 兼容存储。",
  telegram: "以文件发给绑定了 Telegram 的管理员（先在「设置 › Telegram」配好机器人）。超过 20 MB 的备份只能在 Telegram 里手动下载后导入。",
};

type Form = {
  destination: Destination;
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
  scheduleMode: "daily" | "interval";
  scheduleHour: string;
  everyHours: string;
  keep: string;
};

function formFrom(data: any): Form {
  return {
    destination: (data?.destination || "off") as Destination,
    webdavUrl: data?.webdav?.url || "",
    webdavUser: data?.webdav?.user || "",
    webdavPassword: "",
    s3Endpoint: data?.s3?.endpoint || "",
    s3Region: data?.s3?.region || "",
    s3Bucket: data?.s3?.bucket || "",
    s3Prefix: data?.s3?.prefix || "",
    s3AccessKey: data?.s3?.accessKeyId || "",
    s3SecretKey: "",
    s3PathStyle: data?.s3?.pathStyle !== false,
    passphrase: "",
    passphraseConfirm: "",
    scheduleMode: data?.schedule?.mode === "interval" ? "interval" : "daily",
    scheduleHour: String(data?.schedule?.mode === "daily" ? data.schedule.hour : 4),
    everyHours: String(data?.schedule?.mode === "interval" ? data.schedule.everyHours : 12),
    keep: String(data?.keep || 7),
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

export default function OffsiteBackupSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.offsiteBackup.get.useQuery(undefined, { refetchOnWindowFocus: false });
  const data = query.data as any;
  const [form, setForm] = useState<Form>(() => formFrom(null));
  const [editingPassphrase, setEditingPassphrase] = useState(false);
  const [restoreName, setRestoreName] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState("");

  useEffect(() => {
    if (data) setForm(formFrom(data));
  }, [data]);

  const savedDestination = (data?.destination || "off") as Destination;
  const listQuery = trpc.ops.offsiteBackup.list.useQuery(undefined, {
    enabled: savedDestination !== "off",
    retry: false,
    refetchOnWindowFocus: false,
  });

  const save = trpc.ops.offsiteBackup.save.useMutation();
  const testConnection = trpc.ops.offsiteBackup.testConnection.useMutation();
  const runNow = trpc.ops.offsiteBackup.runNow.useMutation();
  const restore = trpc.ops.offsiteBackup.restore.useMutation();

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const needsPassphrase = !data?.hasPassphrase || editingPassphrase;
  const busy = save.isPending || testConnection.isPending || runNow.isPending;

  const dirty = useMemo(() => {
    if (!data) return false;
    const base = formFrom(data);
    return (Object.keys(base) as Array<keyof Form>).some((key) => base[key] !== form[key]);
  }, [data, form]);

  const persist = async () => {
    if (needsPassphrase && (form.passphrase || form.destination !== "off")) {
      if (form.passphrase.length < 8) throw new Error("备份口令至少 8 位");
      if (form.passphrase !== form.passphraseConfirm) throw new Error("两次输入的口令不一样");
    }
    await save.mutateAsync({
      destination: form.destination,
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
      schedule: form.scheduleMode === "daily"
        ? { mode: "daily", hour: Math.min(23, Math.max(0, Number(form.scheduleHour) || 0)) }
        : { mode: "interval", everyHours: Math.min(168, Math.max(1, Math.floor(Number(form.everyHours) || 12))) },
      keep: Math.min(100, Math.max(1, Math.floor(Number(form.keep) || 7))),
    });
    setEditingPassphrase(false);
    await utils.ops.offsiteBackup.get.invalidate();
  };

  const onSave = async () => {
    try {
      await persist();
      toast.success("已保存");
      void utils.ops.offsiteBackup.list.invalidate();
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
      void utils.ops.offsiteBackup.list.invalidate();
    }
  });

  const onRestore = async () => {
    if (!restoreName) return;
    try {
      const result: any = await restore.mutateAsync({ name: restoreName, password: restorePassword, confirmed: true });
      setRestoreName(null);
      setRestorePassword("");
      toast.success(result?.alreadyImported ? "这份备份之前已经恢复过" : "已恢复，页面即将刷新");
      if (!result?.alreadyImported) window.setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  if (query.isLoading) return <DataSectionLoading />;
  if (query.error) return <DataSectionError label="异地备份设置" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;

  const status = data?.status || {};
  const files = (listQuery.data || []) as Array<{ name: string; size: number; modifiedAt: number | null }>;

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
          <SettingRow label="传到哪里" description={DESTINATION_HINTS[form.destination]}>
            <div className={cn(segmentedControlClassName, "grid grid-cols-4 gap-1")} role="group" aria-label="备份目的地">
              {DESTINATIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={form.destination === item.value}
                  onClick={() => set("destination", item.value)}
                  className={segmentedOptionClassName(form.destination === item.value, false, "px-1")}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {form.destination === "webdav" ? (
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
                    placeholder={data?.webdav?.hasPassword ? "已设置，留空不改" : "应用密码"}
                    autoComplete="new-password"
                  />
                </FormField>
              </div>
            ) : null}
            {form.destination === "s3" ? (
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
                    placeholder={data?.s3?.hasSecretKey ? "已设置，留空不改" : ""}
                    autoComplete="new-password"
                  />
                </FormField>
                <label className="flex items-center justify-between gap-3 sm:col-span-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm">路径风格地址</span>
                    <span className="text-meta text-muted-foreground">MinIO、R2 等用路径风格；阿里云 OSS 要关掉。</span>
                  </span>
                  <Switch checked={form.s3PathStyle} onCheckedChange={(checked) => set("s3PathStyle", checked)} />
                </label>
              </div>
            ) : null}
          </SettingRow>

          {form.destination !== "off" ? (
            <>
              <SettingRow
                label="备份口令"
                description="备份用它加密，恢复时要输入。口令存在面板里供定时任务使用；忘了它，备份就打不开。"
                control={data?.hasPassphrase && !editingPassphrase ? (
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
                {editingPassphrase && data?.hasPassphrase ? (
                  <p className="text-meta text-[var(--fx-warn-text)]">改了以后，之前的备份仍要用旧口令打开。</p>
                ) : null}
              </SettingRow>

              <SettingRow label="多久一次" description="北京时间。">
                <div className="flex flex-wrap items-center gap-2">
                  <div className={cn(segmentedControlClassName, "grid grid-cols-2 gap-1")} role="group" aria-label="备份节奏">
                    <button type="button" aria-pressed={form.scheduleMode === "daily"} onClick={() => set("scheduleMode", "daily")} className={segmentedOptionClassName(form.scheduleMode === "daily")}>每天</button>
                    <button type="button" aria-pressed={form.scheduleMode === "interval"} onClick={() => set("scheduleMode", "interval")} className={segmentedOptionClassName(form.scheduleMode === "interval")}>每隔</button>
                  </div>
                  {form.scheduleMode === "daily" ? (
                    <Select value={form.scheduleHour} onValueChange={(value) => set("scheduleHour", value)}>
                      <SelectTrigger className="h-9 w-[104px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, hour) => (
                          <SelectItem key={hour} value={String(hour)}>{String(hour).padStart(2, "0")}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="flex items-center gap-2 text-sm">
                      <Input className="h-9 w-20" inputMode="numeric" value={form.everyHours} onChange={(event) => set("everyHours", event.target.value.replace(/\D/g, ""))} />
                      小时
                    </span>
                  )}
                </div>
              </SettingRow>

              <SettingRow
                label="保留几份"
                description="只删面板自己传上去的旧备份，目录里别的文件不动。"
                control={(
                  <Input className="h-9 w-20 text-right" inputMode="numeric" value={form.keep} onChange={(event) => set("keep", event.target.value.replace(/\D/g, ""))} />
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
          {form.destination !== "off" ? (
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

        {savedDestination !== "off" && (status.lastMessage || data?.nextRunAt) ? (
          <p className={cn("text-meta", status.lastStatus === "failed" ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>
            {status.lastMessage ? `${formatTime(status.lastAttemptAt)} ${status.lastMessage}` : "还没有备份过"}
            {data?.nextRunAt ? ` · 下次 ${formatTime(data.nextRunAt)}` : ""}
          </p>
        ) : null}

        {savedDestination !== "off" ? (
          <div className="space-y-1.5 border-t border-[var(--fx-stroke-weak)] pt-3">
            <p className="text-meta text-muted-foreground">远端的备份</p>
            {listQuery.isLoading ? (
              <p className="text-meta text-muted-foreground">正在读取…</p>
            ) : listQuery.error ? (
              <p className="text-meta text-[var(--fx-warn-text)]">读不到远端目录：{listQuery.error.message}</p>
            ) : files.length === 0 ? (
              <p className="text-meta text-muted-foreground">还没有。</p>
            ) : (
              <ul className="space-y-1">
                {files.map((file) => (
                  <li key={file.name} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{file.name}</span>
                      <span className="block text-meta text-muted-foreground">{formatTime(file.modifiedAt)} · {formatSize(file.size)}</span>
                    </span>
                    <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1 px-2" onClick={() => { setRestoreName(file.name); setRestorePassword(""); }}>
                      <RotateCcw className="h-3.5 w-3.5" />
                      恢复
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>

      <Dialog open={!!restoreName} onOpenChange={(open) => { if (!open && !restore.isPending) setRestoreName(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>从异地备份恢复？</DialogTitle>
            <DialogDescription>
              会用 {restoreName} 替换面板现在的全部数据（用户、主机、规则、设置……），之后的改动都会丢失。Agent 会按恢复后的配置重新同步。
            </DialogDescription>
          </DialogHeader>
          <FormField className="space-y-1.5">
            <Label className="text-xs">备份口令</Label>
            <PasswordInput value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} autoComplete="off" placeholder="这份备份当时的口令" />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreName(null)} disabled={restore.isPending}>取消</Button>
            <Button variant="destructive" onClick={() => void onRestore()} disabled={!restorePassword || restore.isPending}>
              {restore.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              替换并恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
