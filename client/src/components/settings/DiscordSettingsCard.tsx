import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ExternalLink, Send } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import DiscordMark from "@/features/discordLogin/DiscordMark";
import { copyTextToClipboard } from "@/lib/clipboard";
import { docsUrl } from "@/lib/docsLinks";
import { trpc } from "@/lib/trpc";
import { isDiscordAcceptableRedirectBase } from "@shared/discordLogin";

type Draft = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  allowRegistration: boolean;
  allowedDomains: string;
  botEnabled: boolean;
  botToken: string;
  hostStatusNotify: boolean;
  expiryReminder: boolean;
  trafficReminder: boolean;
};

const EMPTY_DRAFT: Draft = {
  enabled: false,
  clientId: "",
  clientSecret: "",
  allowRegistration: false,
  allowedDomains: "",
  botEnabled: false,
  botToken: "",
  hostStatusNotify: false,
  expiryReminder: false,
  trafficReminder: false,
};

function draftOf(saved: any): Draft {
  if (!saved) return EMPTY_DRAFT;
  return {
    enabled: saved.login.enabled,
    clientId: saved.login.clientId,
    clientSecret: "",
    allowRegistration: saved.login.allowRegistration,
    allowedDomains: saved.login.allowedDomains,
    botEnabled: saved.bot.enabled,
    botToken: "",
    hostStatusNotify: saved.bot.hostStatusNotify,
    expiryReminder: saved.bot.expiryReminder,
    trafficReminder: saved.bot.trafficReminder,
  };
}

const PORTAL_URL = "https://discord.com/developers/applications";

/**
 * 系统设置 › 系统配置 › Discord（放在「Google 登录」下面）：登录（OAuth2）和通知机器人两块。
 *
 * 回调地址由「面板公开地址」拼出来，管理员照抄进 Discord Developer Portal › OAuth2 › Redirects；
 * 没填公开地址、或者公开地址不是 https 时登录开不了。密钥和 Token 只显示打码值：输入框留空 = 不改。
 */
export default function DiscordSettingsCard() {
  const utils = trpc.useUtils();
  const settingsQuery = trpc.discordAuth.adminSettings.useQuery(undefined, { staleTime: 10_000 });
  const updateMutation = trpc.discordAuth.updateAdminSettings.useMutation();
  const testMutation = trpc.discordAuth.testBot.useMutation();
  const saved = settingsQuery.data;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const savedDraft = draftOf(saved);

  useEffect(() => {
    if (saved) setDraft(draftOf(saved));
  }, [saved]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const panelUrlMissing = !!saved && !saved.login.panelPublicUrl;
  const redirectUri = saved?.login.redirectUri || "";
  const httpsMissing = !!saved?.login.panelPublicUrl && !isDiscordAcceptableRedirectBase(saved.login.panelPublicUrl);

  const save = async () => {
    if (!saved) return false;
    try {
      await updateMutation.mutateAsync({
        enabled: draft.enabled,
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret.trim() || undefined,
        allowRegistration: draft.allowRegistration,
        allowedDomains: draft.allowedDomains.trim(),
        botEnabled: draft.botEnabled,
        botToken: draft.botToken.trim() || undefined,
        hostStatusNotify: draft.hostStatusNotify,
        expiryReminder: draft.expiryReminder,
        trafficReminder: draft.trafficReminder,
      });
      await Promise.all([utils.discordAuth.adminSettings.invalidate(), utils.discordAuth.status.invalidate(), utils.system.publicInfo.invalidate()]);
      toast.success("Discord 设置已保存");
      return true;
    } catch (error: any) {
      toast.error(error?.message || "保存 Discord 设置失败");
      return false;
    }
  };

  useSaveDockItem({
    id: "system.discord",
    label: "Discord",
    dirty,
    pending: updateMutation.isPending,
    save,
    reset: () => setDraft(savedDraft),
  });

  const copyRedirectUri = async () => {
    if (!redirectUri) return;
    if (await copyTextToClipboard(redirectUri)) toast.success("回调地址已复制");
    else toast.error("复制失败，请手动选中复制");
  };

  const sendTest = async () => {
    try {
      await testMutation.mutateAsync();
      toast.success("测试消息已发送，请到 Discord 私信里查看");
    } catch (error: any) {
      toast.error(error?.message || "测试发送失败");
      void utils.discordAuth.adminSettings.invalidate();
    }
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DiscordMark className="h-4 w-4" />
          Discord
        </CardTitle>
        <CardDescription>
          用户可以用 Discord 账号登录面板；开了通知机器人后，提醒和告警也会私信给绑定了 Discord 的人。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-4" aria-labelledby="discord-login-heading">
          <h3 id="discord-login-heading" className="text-secondary-type font-medium">Discord 登录</h3>
          {panelUrlMissing ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>还没有配置面板公开地址</AlertTitle>
              <AlertDescription>Discord 的回调地址要用它拼出来。先在上面「面板地址」里填好并保存，再回来开启。</AlertDescription>
            </Alert>
          ) : httpsMissing ? (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>面板公开地址不是 https</AlertTitle>
              <AlertDescription>授权码和登录状态不能走明文：请先给面板配上 HTTPS（或反代），Discord 登录才能开启。</AlertDescription>
            </Alert>
          ) : null}

          <SettingList>
            <SettingRow
              asLabel
              label="启用 Discord 登录"
              description={panelUrlMissing ? "填好面板公开地址后才能开启。" : "开启后登录页出现「使用 Discord 登录」。默认只有已经在 个人资料 里绑定过的账号能用。"}
              control={(
                <Checkbox
                  aria-label="启用 Discord 登录"
                  checked={draft.enabled}
                  disabled={panelUrlMissing && !draft.enabled}
                  onCheckedChange={(value) => set("enabled", value === true)}
                />
              )}
            />
            <SettingRow
              asLabel
              label="允许用 Discord 注册新账号"
              description="关闭时，没绑定过的 Discord 账号不能登录。开启后还要同时满足「开放注册」、邮箱白名单和邀请码规则；已有账号的邮箱不会被自动合并。"
              control={(
                <Checkbox
                  aria-label="允许用 Discord 注册新账号"
                  checked={draft.allowRegistration}
                  onCheckedChange={(value) => set("allowRegistration", value === true)}
                />
              )}
            />
          </SettingList>

          <div className="grid gap-3 @[42rem]:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="discord-client-id">Client ID</Label>
              <Input
                id="discord-client-id"
                value={draft.clientId}
                onChange={(e) => set("clientId", e.target.value)}
                placeholder="一串数字，例如 1234567890123456789"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="discord-client-secret">Client Secret</Label>
              <PasswordInput
                id="discord-client-secret"
                value={draft.clientSecret}
                onChange={(e) => set("clientSecret", e.target.value)}
                placeholder={saved?.login.clientSecretSet ? "已保存，留空不改" : "OAuth2 页面点 Reset Secret 后复制"}
                autoComplete="off"
              />
              {saved?.login.clientSecretMasked ? <p className="break-all text-meta text-muted-foreground">当前：{saved.login.clientSecretMasked}</p> : null}
            </div>
            <div className="space-y-2 @[42rem]:col-span-2">
              <Label htmlFor="discord-allowed-domains">只允许这些邮箱域名（可选，留空不限）</Label>
              <Input
                id="discord-allowed-domains"
                value={draft.allowedDomains}
                onChange={(e) => set("allowedDomains", e.target.value)}
                placeholder="example.com, corp.example.org"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="text-secondary-type font-medium">Redirects（回调地址）</div>
            {redirectUri ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs">{redirectUri}</code>
                <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={copyRedirectUri} title="复制回调地址" aria-label="复制回调地址">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <p className="text-meta text-muted-foreground">填好面板公开地址后这里会显示。</p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-meta text-muted-foreground">
              <li>
                打开
                <a className="mx-1 inline-flex items-center gap-0.5 underline" href={PORTAL_URL} target="_blank" rel="noopener noreferrer">
                  Discord Developer Portal › Applications<ExternalLink className="h-3 w-3" />
                </a>
                ，点 New Application 新建一个应用（名字会显示在授权页上）。
              </li>
              <li>进入 OAuth2 › Redirects，点 Add Redirect，把上面的地址原样粘进去，保存。</li>
              <li>同一页复制 Client ID；点 Reset Secret 生成并复制 Client Secret（只显示一次）。「Public Client」保持关闭。</li>
              <li>把两项填到这里，勾选启用后保存。</li>
            </ol>
          </div>
        </section>

        <section className="space-y-4 border-t border-[var(--fx-stroke-weak)] pt-5" aria-labelledby="discord-bot-heading">
          <h3 id="discord-bot-heading" className="text-secondary-type font-medium">Discord 通知机器人</h3>
          <SettingList>
            <SettingRow
              asLabel
              label="启用 Discord 通知"
              description="开启后，发给 Telegram 的工单、规则异常、线路切换、自动换 IP、安全巡检等通知，也会私信给绑定了 Discord 的人（各人在 个人资料 里按类别开关）。"
              control={<Checkbox aria-label="启用 Discord 通知" checked={draft.botEnabled} onCheckedChange={(value) => set("botEnabled", value === true)} />}
            />
            <SettingRow
              asLabel
              label="主机上下线通知"
              description="主机掉线 / 恢复时私信管理员。"
              control={<Checkbox aria-label="主机上下线通知" checked={draft.hostStatusNotify} onCheckedChange={(value) => set("hostStatusNotify", value === true)} />}
            />
            <SettingRow
              asLabel
              label="到期提醒"
              description="套餐和主机快到期时私信用户。提前天数沿用「Telegram 机器人」里的设置。"
              control={<Checkbox aria-label="到期提醒" checked={draft.expiryReminder} onCheckedChange={(value) => set("expiryReminder", value === true)} />}
            />
            <SettingRow
              asLabel
              label="流量提醒"
              description="流量快用完时私信用户。剩余百分比阈值沿用「Telegram 机器人」里的设置。"
              control={<Checkbox aria-label="流量提醒" checked={draft.trafficReminder} onCheckedChange={(value) => set("trafficReminder", value === true)} />}
            />
          </SettingList>
          <div className="space-y-2">
            <Label htmlFor="discord-bot-token">Bot Token</Label>
            <PasswordInput
              id="discord-bot-token"
              value={draft.botToken}
              onChange={(e) => set("botToken", e.target.value)}
              placeholder={saved?.bot.tokenSet ? "已保存，留空不改" : "Bot 页面点 Reset Token 后复制"}
              autoComplete="off"
            />
            {saved?.bot.tokenMasked ? (
              <p className="break-all text-meta text-muted-foreground">
                当前：{saved.bot.tokenMasked}{saved.bot.botUsername ? `（机器人 ${saved.bot.botUsername}）` : ""}
              </p>
            ) : null}
          </div>
          <ol className="list-decimal space-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 pl-8 text-meta text-muted-foreground">
            <li>在同一个应用里进入 Bot 页面，点 Reset Token 复制 Bot Token（不需要打开任何 Privileged Gateway Intents）。</li>
            <li>进入 OAuth2 › URL Generator，Scopes 勾 bot，打开生成的链接，把机器人拉进你的 Discord 服务器。</li>
            <li>机器人只能私信和它在同一个服务器、并允许「服务器成员私信」的人：请让用户加入这个服务器。</li>
            <li>保存后，先在 个人资料 里绑定自己的 Discord，再点「发送测试消息」。</li>
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a className="inline-flex items-center gap-1 text-meta text-primary underline" href={docsUrl("/guide/discord")} target="_blank" rel="noopener noreferrer">
              详细步骤和注意事项<ExternalLink className="h-3 w-3" />
            </a>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="gap-2" onClick={() => void sendTest()} disabled={!saved?.bot.ready || dirty || testMutation.isPending}>
                <Send className="h-4 w-4" />
                {testMutation.isPending ? "发送中..." : "发送测试消息"}
              </Button>
              <Button data-dock-save onClick={() => void save()} disabled={!saved || updateMutation.isPending}>
                {updateMutation.isPending ? "保存中..." : "保存 Discord 设置"}
              </Button>
            </div>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
