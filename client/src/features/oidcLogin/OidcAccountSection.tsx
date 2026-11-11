import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Link2Off, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { oidcButtonLabel } from "@shared/oidcLogin";
import OidcMark from "./OidcMark";
import { oidcWebStartUrl, parseOidcLoginReturn, stripOidcLoginReturnFromUrl } from "./oidcLoginReturn";

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * 个人资料 › <显示名称> 账号（通用 OIDC）：绑定 / 解除绑定，以及 OIDC 注册的账号第一次设密码。
 * 做法和 Google 那块（GoogleAccountSection）一样：
 *
 * - 管理员没开、自己也没绑过时整块不显示；
 * - 绑定要在「面板公开地址」打开的面板里点（回调落在那个域名上，登录 cookie 也得在那里）；
 * - 解绑前账号必须还有别的登录方式（密码、通行密钥、开着的 Google / Discord 登录），服务端也会再判一次；
 * - 管理员换了 Issuer 之后，旧绑定显示成「已失效」，可以直接重新绑定。
 */
export default function OidcAccountSection() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const statusQuery = trpc.oidcAuth.status.useQuery(undefined, { staleTime: 30_000 });
  const unlinkMutation = trpc.oidcAuth.unlink.useMutation();
  const setPasswordMutation = trpc.oidcAuth.setInitialPassword.useMutation();
  const [linking, setLinking] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [linkNotice, setLinkNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // 绑定流程跳回 /profile?oidcLinked=1 或 ?oidcError=码
  useEffect(() => {
    const result = parseOidcLoginReturn(window.location.search, "");
    if (!result.errorMessage && !result.linked) return;
    stripOidcLoginReturnFromUrl();
    if (result.linked) {
      setLinkNotice({ tone: "ok", text: "已绑定，下次可以在登录页直接点登录按钮。" });
      void utils.oidcAuth.status.invalidate();
    } else if (result.errorMessage) {
      setLinkNotice({ tone: "error", text: result.errorMessage });
    }
  }, [utils]);

  const status = statusQuery.data;
  const bound = !!status && (status.linked || status.staleBinding);
  if (!status || (!status.enabled && !bound)) return null;

  const name = status.providerName;
  const panelOrigin = originOf(status.panelPublicUrl);
  const onPanelOrigin = !mobileAuth.isNative && !!panelOrigin && typeof window !== "undefined" && window.location.origin === panelOrigin;

  const handleLink = () => {
    setLinking(true);
    window.location.assign(oidcWebStartUrl("link", "/profile"));
  };

  const handleUnlink = async () => {
    const ok = await confirm({
      title: `解除 ${name} 绑定`,
      description: `解除后就不能再用 ${status.email || `这个 ${name} 账号`} 登录了，其它登录方式不受影响。以后可以重新绑定。`,
      confirmText: "解除绑定",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await unlinkMutation.mutateAsync();
      await utils.oidcAuth.status.invalidate();
      toast.success(`已解除 ${name} 绑定`);
    } catch (error) {
      toast.error((error instanceof Error && error.message) || "解除绑定失败");
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
      await Promise.all([utils.oidcAuth.status.invalidate(), utils.auth.me.invalidate()]);
      toast.success("登录密码已设置，现在也可以用用户名 + 密码登录了");
    } catch (error) {
      toast.error((error instanceof Error && error.message) || "设置密码失败");
    }
  };

  const linkButton = !status.enabled ? null : mobileAuth.isNative ? (
    <p className="text-sm text-muted-foreground">请在浏览器里打开面板，在 个人资料 里绑定 {name}。</p>
  ) : !onPanelOrigin ? (
    <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">
        绑定 {name} 要在面板公开地址上操作：
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
      {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : <OidcMark className="h-4 w-4" />}
      {linking ? "正在前往登录页…" : `绑定 ${name}`}
    </Button>
  );

  return (
    <Card className="border-border/50 bg-card/70">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <OidcMark className="h-4 w-4" />
            {name} 账号
          </CardTitle>
          <CardDescription>绑定后可以在登录页点「{oidcButtonLabel(name)}」。</CardDescription>
        </div>
        <Badge variant={status.linked ? "default" : "outline"} className="w-fit">
          {status.linked ? "已绑定" : status.staleBinding ? "已失效" : "未绑定"}
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
        {status.staleBinding ? (
          <p className="text-sm text-muted-foreground">管理员换了身份提供方（Issuer），原来的绑定已经不能用来登录了：可以解除，或者直接重新绑定。</p>
        ) : null}
        {bound ? (
          <SettingList>
            <SettingRow keepDescription
              label={`${name} 账号`}
              description={status.linkedAt ? `${new Date(status.linkedAt).toLocaleString()} 绑定` : undefined}
              control={<span className="max-w-[12rem] truncate text-secondary-type font-medium sm:max-w-xs">{status.email || "-"}</span>}
            />
            <SettingRow
              label="解除绑定"
              description={status.canUnlink ? `解除后不能再用这个 ${name} 账号登录。` : "这个账号还没有别的登录方式：先在下面设一个密码（或添加通行密钥），才能解除绑定。"}
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
        ) : null}
        {!status.linked ? linkButton : null}

        {bound && !status.hasPassword ? (
          <div className="space-y-3 border-t border-[var(--fx-stroke-weak)] pt-4">
            <div className="text-secondary-type font-medium">设置登录密码</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="oidc-initial-password">新密码</Label>
                <PasswordInput id="oidc-initial-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 6 个字符" autoComplete="new-password" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="oidc-initial-password-confirm">确认新密码</Label>
                <PasswordInput id="oidc-initial-password-confirm" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再输入一次" autoComplete="new-password" />
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
