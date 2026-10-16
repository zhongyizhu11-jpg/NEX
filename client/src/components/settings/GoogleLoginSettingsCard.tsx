import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ExternalLink } from "lucide-react";
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
import GoogleMark from "@/features/googleLogin/GoogleMark";
import { copyTextToClipboard } from "@/lib/clipboard";
import { docsUrl } from "@/lib/docsLinks";
import { trpc } from "@/lib/trpc";
import { isGoogleAcceptableRedirectBase } from "@shared/googleLogin";

type Draft = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  allowRegistration: boolean;
  allowedDomains: string;
};

const EMPTY_DRAFT: Draft = { enabled: false, clientId: "", clientSecret: "", allowRegistration: false, allowedDomains: "" };

/**
 * 系统设置 › 系统配置 › Google 登录（放在「用户注册 / 双重验证」下面）。
 *
 * 回调地址由「面板公开地址」拼出来，管理员照抄进 Google Cloud Console；没填公开地址时不让开。
 * 密钥只显示打码值：输入框留空 = 不改。
 */
export default function GoogleLoginSettingsCard() {
  const utils = trpc.useUtils();
  const settingsQuery = trpc.googleAuth.adminSettings.useQuery(undefined, { staleTime: 10_000 });
  const updateMutation = trpc.googleAuth.updateAdminSettings.useMutation();
  const saved = settingsQuery.data;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const savedDraft: Draft = saved
    ? { enabled: saved.enabled, clientId: saved.clientId, clientSecret: "", allowRegistration: saved.allowRegistration, allowedDomains: saved.allowedDomains }
    : EMPTY_DRAFT;

  useEffect(() => {
    if (saved) setDraft({ enabled: saved.enabled, clientId: saved.clientId, clientSecret: "", allowRegistration: saved.allowRegistration, allowedDomains: saved.allowedDomains });
  }, [saved]);

  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const panelUrlMissing = !!saved && !saved.panelPublicUrl;
  const redirectUri = saved?.redirectUri || "";
  const httpsMissing = !!saved?.panelPublicUrl && !isGoogleAcceptableRedirectBase(saved.panelPublicUrl);

  const save = async () => {
    if (!saved) return false;
    try {
      await updateMutation.mutateAsync({
        enabled: draft.enabled,
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret.trim() || undefined,
        allowRegistration: draft.allowRegistration,
        allowedDomains: draft.allowedDomains.trim(),
      });
      await Promise.all([utils.googleAuth.adminSettings.invalidate(), utils.system.publicInfo.invalidate()]);
      toast.success("Google 登录设置已保存");
      return true;
    } catch (error: any) {
      toast.error(error?.message || "保存 Google 登录设置失败");
      return false;
    }
  };

  useSaveDockItem({
    id: "system.googleLogin",
    label: "Google 登录",
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

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GoogleMark className="h-4 w-4" />
          Google 登录
        </CardTitle>
        <CardDescription>
          用户可以用 Google 账号登录面板。默认只有已经在 个人资料 里绑定过 Google 的账号能用。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {panelUrlMissing ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>还没有配置面板公开地址</AlertTitle>
            <AlertDescription>Google 的回调地址要用它拼出来。先在上面「面板地址」里填好并保存，再回来开启。</AlertDescription>
          </Alert>
        ) : httpsMissing ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Google 只接受 https 回调地址</AlertTitle>
            <AlertDescription>当前面板公开地址是 http。请先给面板配上 HTTPS（或反代），否则 Google Cloud Console 不会接受下面这个地址。</AlertDescription>
          </Alert>
        ) : null}

        <SettingList>
          <SettingRow
            asLabel
            label="启用 Google 登录"
            description={panelUrlMissing ? "填好面板公开地址后才能开启。" : "开启后登录页出现「使用 Google 登录」。"}
            control={(
              <Checkbox
                aria-label="启用 Google 登录"
                checked={draft.enabled}
                disabled={panelUrlMissing && !draft.enabled}
                onCheckedChange={(value) => setDraft((current) => ({ ...current, enabled: value === true }))}
              />
            )}
          />
          <SettingRow
            asLabel
            label="允许用 Google 注册新账号"
            description="关闭时，没绑定过的 Google 账号不能登录。开启后还要同时满足「开放注册」和邮箱白名单；已有账号的邮箱不会被自动合并。"
            control={(
              <Checkbox
                aria-label="允许用 Google 注册新账号"
                checked={draft.allowRegistration}
                onCheckedChange={(value) => setDraft((current) => ({ ...current, allowRegistration: value === true }))}
              />
            )}
          />
        </SettingList>

        <div className="grid gap-3 @[42rem]:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="google-client-id">客户端 ID</Label>
            <Input
              id="google-client-id"
              value={draft.clientId}
              onChange={(e) => setDraft((current) => ({ ...current, clientId: e.target.value }))}
              placeholder="1234567890-xxxx.apps.googleusercontent.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="google-client-secret">客户端密钥</Label>
            <PasswordInput
              id="google-client-secret"
              value={draft.clientSecret}
              onChange={(e) => setDraft((current) => ({ ...current, clientSecret: e.target.value }))}
              placeholder={saved?.clientSecretSet ? "已保存，留空不改" : "GOCSPX-…"}
              autoComplete="off"
            />
            {saved?.clientSecretMasked ? <p className="break-all text-meta text-muted-foreground">当前：{saved.clientSecretMasked}</p> : null}
          </div>
          <div className="space-y-2 @[42rem]:col-span-2">
            <Label htmlFor="google-allowed-domains">只允许这些邮箱域名（可选，留空不限）</Label>
            <Input
              id="google-allowed-domains"
              value={draft.allowedDomains}
              onChange={(e) => setDraft((current) => ({ ...current, allowedDomains: e.target.value }))}
              placeholder="example.com, corp.example.org"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-secondary-type font-medium">已获授权的重定向 URI</div>
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
              <a className="mx-1 inline-flex items-center gap-0.5 underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">
                Google Cloud Console › 凭据<ExternalLink className="h-3 w-3" />
              </a>
              ，先配好「OAuth 同意屏幕」（用户类型选「外部」，发布为正式版）。
            </li>
            <li>创建凭据 › OAuth 客户端 ID，应用类型选「Web 应用」。</li>
            <li>把上面的地址原样加到「已获授权的重定向 URI」，保存。</li>
            <li>把生成的客户端 ID 和客户端密钥填到这里，勾选启用后保存。</li>
          </ol>
          <a className="inline-flex items-center gap-1 text-meta text-primary underline" href={docsUrl("/guide/google-login")} target="_blank" rel="noopener noreferrer">
            详细步骤和注意事项<ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="flex justify-end">
          <Button data-dock-save onClick={() => void save()} disabled={!saved || updateMutation.isPending}>
            {updateMutation.isPending ? "保存中..." : "保存 Google 登录设置"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
