import { useEffect, useState } from "react";
import { AlertTriangle, BellRing, CheckCircle2, ExternalLink, Link2Off, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { OptimisticSwitch } from "@/components/ui/switch";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import DiscordMark from "./DiscordMark";
import { discordWebStartUrl, parseDiscordLoginReturn, stripDiscordLoginReturnFromUrl } from "./discordLoginReturn";

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * 个人资料 › Discord：绑定 / 解除绑定、Discord 注册的账号第一次设密码，
 * 以及 Discord 私信通知（绑定就是订阅：管理员开了 Discord 通知后，提醒会私信给绑定的账号）。
 *
 * 管理员既没开 Discord 登录、也没开 Discord 通知，自己也没绑过时整块不显示。
 * 绑定要在「面板公开地址」打开的面板里点；App 里点不了，提示去浏览器里绑定。
 */
export default function DiscordAccountSection() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const statusQuery = trpc.discordAuth.status.useQuery(undefined, { staleTime: 30_000 });
  const linkedWithBot = !!statusQuery.data?.linked && !!statusQuery.data?.notifications.botReady;
  const prefsQuery = trpc.discordAuth.notifyPrefs.useQuery(undefined, { enabled: linkedWithBot, staleTime: 30_000 });
  const unlinkMutation = trpc.discordAuth.unlink.useMutation();
  const setPasswordMutation = trpc.discordAuth.setInitialPassword.useMutation();
  const retryMutation = trpc.discordAuth.retryDm.useMutation();
  const setCategoryMutation = trpc.discordAuth.setNotifyCategory.useMutation();
  const setDigestMutation = trpc.discordAuth.setDigest.useMutation();
  const [linking, setLinking] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // 绑定结果写在卡片里（整页跳回来时 Toaster 可能还没挂好，弹窗会丢）。
  const [linkNotice, setLinkNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // 绑定流程跳回 /profile?discordLinked=1 或 ?discordError=码
  useEffect(() => {
    const result = parseDiscordLoginReturn(window.location.search, "");
    if (!result.errorMessage && !result.linked) return;
    stripDiscordLoginReturnFromUrl();
    if (result.linked) {
      setLinkNotice({ tone: "ok", text: "已绑定 Discord 账号，下次可以在登录页点「使用 Discord 登录」；管理员开了 Discord 通知时，提醒也会私信给你。" });
      void utils.discordAuth.status.invalidate();
    } else if (result.errorMessage) {
      setLinkNotice({ tone: "error", text: result.errorMessage });
    }
  }, [utils]);

  const status = statusQuery.data;
  if (!status || (!status.enabled && !status.linked && !status.notifications.botReady)) return null;

  const panelOrigin = originOf(status.panelPublicUrl);
  const onPanelOrigin = !mobileAuth.isNative && !!panelOrigin && typeof window !== "undefined" && window.location.origin === panelOrigin;

  const handleLink = () => {
    setLinking(true);
    window.location.assign(discordWebStartUrl("link", "/profile"));
  };

  const handleUnlink = async () => {
    const ok = await confirm({
      title: "解除 Discord 绑定",
      description: `解除后就不能再用 Discord 账号 ${status.username || ""} 登录，也收不到 Discord 私信通知了；密码${status.passkeyCount ? "和通行密钥" : ""}登录不受影响。以后可以重新绑定。`,
      confirmText: "解除绑定",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await unlinkMutation.mutateAsync();
      await utils.discordAuth.status.invalidate();
      toast.success("已解除 Discord 绑定");
    } catch (error: any) {
      toast.error(error?.message || "解除绑定失败");
    }
  };

  const handleSetPassword = async () => {
    if (newPassword.length < 6) {
      toast.error("密码至少 6 个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }
    try {
      await setPasswordMutation.mutateAsync({ newPassword });
      setNewPassword("");
      setConfirmPassword("");
      await Promise.all([utils.discordAuth.status.invalidate(), utils.auth.me.invalidate()]);
      toast.success("登录密码已设置，现在也可以用用户名 + 密码登录了");
    } catch (error: any) {
      toast.error(error?.message || "设置密码失败");
    }
  };

  const handleRetry = async () => {
    try {
      await retryMutation.mutateAsync();
      await utils.discordAuth.status.invalidate();
      toast.success("已发出一条私信，请到 Discord 查看");
    } catch (error: any) {
      toast.error(error?.message || "还是发不过去");
    }
  };

  const blocked = !!status.notifications.dmBlockedAt;
  const prefs = prefsQuery.data;

  return (
    <Card className="border-border/50 bg-card/70">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <DiscordMark className="h-4 w-4" />
            Discord
          </CardTitle>
          <CardDescription>
            {status.enabled ? "绑定后可以在登录页点「使用 Discord 登录」" : "绑定后可以接收 Discord 私信通知"}
            {status.enabled && status.notifications.botReady ? "，提醒也会私信给你。" : "。"}
          </CardDescription>
        </div>
        <Badge variant={status.linked ? "default" : "outline"} className="w-fit">
          {status.linked ? "已绑定" : "未绑定"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {linkNotice ? (
          <div
            role={linkNotice.tone === "error" ? "alert" : "status"}
            className={linkNotice.tone === "error"
              ? "flex items-start gap-2 rounded-lg bg-[var(--fx-down-soft)] p-3 text-sm text-[var(--fx-down-text)]"
              : "flex items-start gap-2 rounded-lg bg-[var(--fx-healthy-soft)] p-3 text-sm text-[var(--fx-healthy-text)]"}
          >
            {linkNotice.tone === "error" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0 flex-1">{linkNotice.text}</span>
            <button type="button" className="shrink-0 text-xs underline opacity-80 hover:opacity-100" onClick={() => setLinkNotice(null)}>
              知道了
            </button>
          </div>
        ) : null}

        {status.linked ? (
          <SettingList>
            <SettingRow
              label="Discord 账号"
              description={status.linkedAt ? `${new Date(status.linkedAt).toLocaleString()} 绑定` : undefined}
              control={(
                <span className="max-w-[12rem] truncate text-secondary-type font-medium sm:max-w-xs">
                  {status.username ? `@${status.username}` : status.email || "-"}
                </span>
              )}
            />
            <SettingRow
              label="解除绑定"
              description={status.canUnlink ? "解除后不能再用这个 Discord 账号登录，也收不到私信通知。" : "这个账号是用 Discord 注册的，还没有登录密码：先在下面设一个密码，才能解除绑定。"}
              control={(
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={handleUnlink}
                  disabled={!status.canUnlink || unlinkMutation.isPending}
                >
                  <Link2Off className="h-4 w-4" />
                  {unlinkMutation.isPending ? "解除中..." : "解除绑定"}
                </Button>
              )}
            />
          </SettingList>
        ) : !status.enabled ? (
          <p className="text-sm text-muted-foreground">管理员还没有开启 Discord 登录，暂时不能绑定。</p>
        ) : mobileAuth.isNative ? (
          <p className="text-sm text-muted-foreground">请在浏览器里打开面板，在 个人资料 里绑定 Discord；绑好以后 App 里也能用 Discord 登录。</p>
        ) : !onPanelOrigin ? (
          <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">
              绑定 Discord 要在面板公开地址上操作：
              {status.panelPublicUrl ? (
                <a className="ml-1 inline-flex items-center gap-1 break-all underline" href={`${status.panelPublicUrl}/profile`}>
                  {status.panelPublicUrl}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : "管理员还没有配置面板公开地址。"}
            </span>
          </div>
        ) : (
          <Button className="w-full gap-2 sm:w-auto" variant="outline" onClick={handleLink} disabled={linking}>
            {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : <DiscordMark className="h-4 w-4" />}
            {linking ? "正在前往 Discord…" : "绑定 Discord"}
          </Button>
        )}

        {linkedWithBot ? (
          <div className="space-y-3 border-t border-[var(--fx-stroke-weak)] pt-4">
            <div className="flex items-center gap-2 text-secondary-type font-medium">
              <BellRing className="h-4 w-4 text-primary" />
              Discord 私信通知
              {status.notifications.botUsername ? <span className="text-meta font-normal text-muted-foreground">（机器人 {status.notifications.botUsername}）</span> : null}
            </div>
            {blocked ? (
              <div role="alert" className="flex flex-col gap-2 rounded-lg bg-[var(--fx-warn-soft)] p-3 text-sm text-[var(--fx-warn-text)] sm:flex-row sm:items-start">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  Discord 拒收了机器人的私信：请先加入管理员的 Discord 服务器，并在该服务器的「隐私设置」里打开「允许来自服务器成员的私信」。
                  改好以后点「重新尝试」；不点的话面板会在 {status.notifications.dmBlockedRetryAt ? new Date(status.notifications.dmBlockedRetryAt).toLocaleString() : "几小时后"} 自动再试。
                </span>
                <Button type="button" size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={handleRetry} disabled={retryMutation.isPending}>
                  <RefreshCw className={retryMutation.isPending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                  重新尝试
                </Button>
              </div>
            ) : (
              <p className="text-meta text-muted-foreground">
                机器人只能私信和它在同一个 Discord 服务器里、并允许服务器成员私信的人。下面的开关和 Telegram 通知共用：在这里关掉，两边都不再发。
              </p>
            )}
            {prefs ? (
              <SettingList>
                {prefs.categories.map((category) => (
                  <SettingRow
                    key={category.key}
                    label={category.label}
                    control={(
                      <OptimisticSwitch
                        aria-label={`接收${category.label}通知`}
                        checked={category.enabled}
                        onCheckedChangeAsync={async (enabled) => {
                          await setCategoryMutation.mutateAsync({ category: category.key, enabled });
                          await utils.discordAuth.notifyPrefs.invalidate();
                        }}
                        onToggleError={(error: any) => toast.error(error?.message || "保存失败")}
                      />
                    )}
                  />
                ))}
                <SettingRow
                  label="每日简报"
                  description="每天一份运行概况。"
                  control={(
                    <OptimisticSwitch
                      aria-label="接收每日简报"
                      checked={prefs.digest}
                      onCheckedChangeAsync={async (enabled) => {
                        await setDigestMutation.mutateAsync({ enabled });
                        await utils.discordAuth.notifyPrefs.invalidate();
                      }}
                      onToggleError={(error: any) => toast.error(error?.message || "保存失败")}
                    />
                  )}
                />
              </SettingList>
            ) : null}
          </div>
        ) : null}

        {status.linked && !status.hasPassword ? (
          <div className="space-y-3 border-t border-[var(--fx-stroke-weak)] pt-4">
            <div className="text-secondary-type font-medium">设置登录密码</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="discord-initial-password">新密码</Label>
                <PasswordInput id="discord-initial-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 6 个字符" autoComplete="new-password" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="discord-initial-password-confirm">确认新密码</Label>
                <PasswordInput id="discord-initial-password-confirm" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再输入一次" autoComplete="new-password" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSetPassword} disabled={setPasswordMutation.isPending}>
                {setPasswordMutation.isPending ? "保存中..." : "设置密码"}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
