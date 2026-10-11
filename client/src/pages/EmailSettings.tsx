import { FormField } from "@/components/ui/form-field";
import { useEffect, useRef, useState } from "react";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, BellRing, KeyRound, Loader2, Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { Redirect } from "wouter";

type SmtpSecurityMode = "auto" | "implicit-tls" | "starttls" | "none";

const EMAIL_TEST_UI_TIMEOUT_MS = 30_000;

function normalizeSmtpSecurityMode(value: unknown, port: number, secure: boolean): SmtpSecurityMode {
  if (value === "auto" || value === "implicit-tls" || value === "starttls" || value === "none") return value;
  if (port === 465) return "implicit-tls";
  if (port === 587) return "starttls";
  return secure ? "implicit-tls" : "auto";
}

export default function EmailSettings() {
  return <Redirect to="/settings?tab=email" />;
}

export function EmailSettingsContent() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const email = settings?.email;
  const savedEmail = email;
  const expiryReminderDays = String(settings?.telegram?.expiryReminderDays || "7,3,1").split(/[,，\s]+/).filter(Boolean).join("、");
  const [form, setForm] = useState({
    enabled: false,
    host: "",
    port: 587,
    security: "auto" as SmtpSecurityMode,
    user: "",
    password: "",
    from: "",
    verifyRegistration: false,
    whitelistEnabled: false,
    whitelist: "",
    expiryReminder: false,
    trafficReminder: false,
    trafficReminderThreshold: 20,
  });
  const [testTo, setTestTo] = useState("");
  const [testError, setTestError] = useState("");
  const testAttemptRef = useRef(0);
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const formFromEmail = (email: NonNullable<typeof savedEmail>) => ({
      enabled: !!email.enabled,
      host: email.host || "",
      port: Number(email.port || 587),
      security: normalizeSmtpSecurityMode("security" in email ? email.security : undefined, Number(email.port || 587), !!email.secure),
      user: email.user || "",
      password: "",
      from: email.from || "",
      verifyRegistration: !!email.verifyRegistration,
      whitelistEnabled: !!email.whitelistEnabled,
      whitelist: email.whitelist || "",
      expiryReminder: !!email.expiryReminder,
      trafficReminder: !!email.trafficReminder,
      trafficReminderThreshold: Number(email.trafficReminderThreshold || 20),
  });

  useEffect(() => {
    if (!email) return;
    setForm(formFromEmail(email));
  }, [email]);

  useEffect(() => () => {
    testAttemptRef.current += 1;
    if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
  }, []);

  const updateSettings = trpc.system.updateSettings.useMutation({
    onSuccess: async () => {
      await utils.system.getSettings.invalidate();
      setForm((prev) => ({ ...prev, password: "" }));
      toast.success("邮箱设置已保存");
    },
    onError: (error) => toast.error(error.message || "保存邮箱设置失败"),
  });

  const sendTestEmail = trpc.system.sendTestEmail.useMutation();

  const saveEmailSettings = (): Promise<boolean> | boolean => {
    if (form.enabled && !form.host.trim()) {
      toast.error("请输入 SMTP 服务器地址");
      return false;
    }
    if (form.enabled && !form.from.trim() && !form.user.trim()) {
      toast.error("请输入发件邮箱或 SMTP 用户名");
      return false;
    }
    return updateSettings.mutateAsync({
      email: {
        enabled: form.enabled,
        host: form.host,
        port: Number(form.port || 587),
        security: form.security,
        user: form.user,
        password: form.password,
        from: form.from,
        verifyRegistration: form.verifyRegistration,
        whitelistEnabled: form.whitelistEnabled,
        whitelist: form.whitelist,
        expiryReminder: form.expiryReminder,
        trafficReminder: form.trafficReminder,
        trafficReminderThreshold: Number(form.trafficReminderThreshold || 20),
      },
    }).then(() => true, () => false);
  };

  /* 玫瑰主题下的贴底保存栏（components/settings/SaveDock.tsx）：这一页登记自己 */
  useSaveDockItem({
    id: "email.smtp",
    label: "邮箱",
    dirty: !!email && JSON.stringify(form) !== JSON.stringify(formFromEmail(email)),
    pending: updateSettings.isPending,
    save: saveEmailSettings,
    reset: () => { if (email) setForm(formFromEmail(email)); },
  });

  const handleTestEmail = () => {
    const to = testTo.trim();
    if (!to) {
      toast.error("请输入测试收件邮箱");
      return;
    }
    const attempt = testAttemptRef.current + 1;
    testAttemptRef.current = attempt;
    setTestError("");
    if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
    testTimeoutRef.current = setTimeout(() => {
      if (testAttemptRef.current !== attempt) return;
      testAttemptRef.current += 1;
      testTimeoutRef.current = null;
      sendTestEmail.reset();
      const message = "SMTP 测试请求超时，请检查面板网络和 SMTP 端口";
      setTestError(message);
      toast.error(message);
    }, EMAIL_TEST_UI_TIMEOUT_MS);
    sendTestEmail.mutate({ to }, {
      onSuccess: () => {
        if (testAttemptRef.current !== attempt) return;
        if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
        testTimeoutRef.current = null;
        setTestError("");
        toast.success("测试邮件已发送");
      },
      onError: (error) => {
        if (testAttemptRef.current !== attempt) return;
        if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
        testTimeoutRef.current = null;
        const message = error.message || "测试邮件发送失败";
        setTestError(message);
        toast.error(message);
      },
    });
  };

  const effectiveSecurity = form.security === "auto"
    ? (Number(form.port) === 465 ? "implicit-tls" : "starttls")
    : form.security;
  const securityDescription = effectiveSecurity === "implicit-tls"
    ? "连接建立时立即启用 TLS，通常使用 465 端口。"
    : effectiveSecurity === "starttls"
      ? "先建立 SMTP 连接，再升级到 TLS，通常使用 587 端口。"
      : "不使用 TLS，仅适用于可信内网 SMTP。";

  if (isLoading) {
    return (
      <DataSectionLoading label="正在加载邮箱设置" minHeight="min-h-[260px]" />
    );
  }

  return (
    /*
      这一块只在系统设置的「邮箱设置」分区里渲染（/email-settings 早就跳过去了）。原来
      自己还带一个页头：一个 h1「邮箱设置」+「未启用」徽标，再下面一条「邮件发送说明」
      提示框 —— 系统设置页本身已经有页头，分区也有标题，于是一屏两个 h1、三遍「邮箱设置」。
      徽标说的是下面那个复选框的状态，提示框前半句是那个复选框的说明，后半句是密码框的
      占位文字，都已经在它们该在的地方了。
    */
    <div className="space-y-4">
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-primary" />
            SMTP 对接
          </CardTitle>
          <CardDescription>配置 SMTP 服务器和账号。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="启用邮箱服务"
              description="关闭后不发送任何邮件，包括注册验证码。"
              control={<Checkbox aria-label="启用邮箱服务" checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />}
            />
          </SettingList>

          <div className="grid gap-4 md:grid-cols-[1fr_120px]">
            <FormField className="space-y-2">
              <Label>SMTP 服务器</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" />
            </FormField>
            <FormField className="space-y-2">
              <Label>端口</Label>
              <Input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value || 587) })} />
            </FormField>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField className="space-y-2">
              <Label>SMTP 用户名</Label>
              <Input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="user@example.com" />
            </FormField>
            <FormField className="space-y-2">
              <Label>SMTP 密码 / 授权码</Label>
              <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="留空表示不修改已保存密码" />
            </FormField>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_260px]">
            <FormField className="space-y-2">
              <Label>发件邮箱</Label>
              <Input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="NEX <noreply@example.com>" />
            </FormField>
            <FormField className="space-y-2">
              <Label>连接加密</Label>
              <Select value={form.security} onValueChange={(security: SmtpSecurityMode) => setForm({ ...form, security })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动（推荐）</SelectItem>
                  <SelectItem value="implicit-tls">隐式 TLS / SMTPS</SelectItem>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                  <SelectItem value="none">无加密</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{securityDescription}</p>
            </FormField>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-primary" />
            功能开关
          </CardTitle>
          <CardDescription>选择需要启用的邮件场景。</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingList>
            <SettingRow
              asLabel
              label="强制邮箱验证码注册"
              description="注册时必须验证邮箱。"
              control={<Checkbox aria-label="强制邮箱验证码注册" checked={form.verifyRegistration} onCheckedChange={(verifyRegistration) => setForm({ ...form, verifyRegistration })} />}
            />
            <SettingRow
              asLabel
              label="邮箱后缀白名单"
              description="仅允许指定邮箱后缀注册。"
              control={<Checkbox aria-label="邮箱后缀白名单" checked={form.whitelistEnabled} onCheckedChange={(whitelistEnabled) => setForm({ ...form, whitelistEnabled })} />}
            >
              <FormField className="space-y-2">
                <Label>允许的邮箱后缀</Label>
                <Input
                  value={form.whitelist}
                  onChange={(e) => setForm({ ...form, whitelist: e.target.value })}
                  placeholder="example.com，gmail.com"
                  disabled={!form.whitelistEnabled}
                />
              </FormField>
            </SettingRow>
            <SettingRow
              asLabel
              label="账户临期提醒"
              /*
                原来写的是「到期前 3 天提醒」—— 服务端发邮件用的是和 Telegram 共用的那组天数
                （expiryReminderDays，默认 7、3、1），不是固定 3 天。照实际的写，并说清在哪儿改。
              */
              description={`到期前第 ${expiryReminderDays} 天各提醒一次。天数和 Telegram 提醒共用，在 Telegram 分区里改。`}
              control={<Checkbox aria-label="账户临期提醒" checked={form.expiryReminder} onCheckedChange={(expiryReminder) => setForm({ ...form, expiryReminder })} />}
            />
            <SettingRow
              asLabel
              label="流量不足提醒"
              description="低于阈值时提醒。"
              control={<Checkbox aria-label="流量不足提醒" checked={form.trafficReminder} onCheckedChange={(trafficReminder) => setForm({ ...form, trafficReminder })} />}
            >
              <FormField className="flex items-center gap-2">
                <Label className="shrink-0 text-xs text-muted-foreground">剩余阈值</Label>
                <Input
                  type="number"
                  min={1}
                  max={99}
                  value={form.trafficReminderThreshold}
                  onChange={(e) => setForm({ ...form, trafficReminderThreshold: Number(e.target.value || 20) })}
                  className="h-8 w-24"
                />
                <span className="text-xs text-muted-foreground">%</span>
              </FormField>
            </SettingRow>
          </SettingList>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            保存与测试
          </CardTitle>
          <CardDescription>保存后可发送测试邮件。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {form.enabled && (!form.host.trim() || (!form.from.trim() && !form.user.trim())) && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>邮箱配置尚未完整</AlertTitle>
              <AlertDescription>启用邮箱服务时至少需要 SMTP 服务器和发件邮箱或用户名。</AlertDescription>
            </Alert>
          )}
          {testError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>SMTP 测试失败</AlertTitle>
              <AlertDescription>{testError}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button data-dock-save onClick={saveEmailSettings} disabled={updateSettings.isPending}>
              {updateSettings.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存邮箱设置
            </Button>
            <div className="flex flex-1 flex-col gap-2 sm:flex-row">
              <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="测试收件邮箱" />
              <Button variant="outline" onClick={handleTestEmail} disabled={sendTestEmail.isPending || !form.enabled}>
                {sendTestEmail.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                发送测试
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
