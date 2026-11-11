import { useEffect, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2, Search } from "lucide-react";
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
import OidcMark from "@/features/oidcLogin/OidcMark";
import { copyTextToClipboard } from "@/lib/clipboard";
import { docsUrl } from "@/lib/docsLinks";
import { trpc } from "@/lib/trpc";
import { OIDC_DEFAULT_SCOPES, oidcButtonLabel } from "@shared/oidcLogin";

type Draft = {
  enabled: boolean;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowRegistration: boolean;
  requireVerifiedEmail: boolean;
  allowedDomains: string;
  allowPrivateNetwork: boolean;
  allowHmacTokens: boolean;
};

const EMPTY_DRAFT: Draft = {
  enabled: false,
  providerName: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: OIDC_DEFAULT_SCOPES,
  allowRegistration: false,
  requireVerifiedEmail: true,
  allowedDomains: "",
  allowPrivateNetwork: false,
  allowHmacTokens: false,
};

type OidcOutputs = inferRouterOutputs<AppRouter>["oidcAuth"];
type Saved = OidcOutputs["adminSettings"];
type DiscoveryResult = OidcOutputs["testDiscovery"];

function draftOf(saved: Saved): Draft {
  return {
    enabled: saved.enabled,
    providerName: saved.providerName,
    issuer: saved.issuer,
    clientId: saved.clientId,
    clientSecret: "",
    scopes: saved.scopes,
    allowRegistration: saved.allowRegistration,
    requireVerifiedEmail: saved.requireVerifiedEmail,
    allowedDomains: saved.allowedDomains,
    allowPrivateNetwork: saved.allowPrivateNetwork,
    allowHmacTokens: saved.allowHmacTokens,
  };
}

/**
 * 系统设置 › 系统配置 › OIDC 登录（放在 Google 登录下面）：Pocket ID、Authentik、Keycloak、Authelia、Zitadel 这类自建 IdP。
 *
 * 回调地址由「面板公开地址」拼出来，管理员照抄进 IdP 的客户端设置；没填公开地址时不让开。
 * 密钥只显示打码值：输入框留空 = 不改。「测试发现」按输入框里（可能还没保存）的 Issuer 拉一次 discovery，
 * 走和登录一样的出站检查，把找到的端点列出来 —— 多数配置错误（Issuer 差一个斜杠、IdP 在内网没勾）在这里就能看出来。
 */
export default function OidcLoginSettingsCard() {
  const utils = trpc.useUtils();
  const settingsQuery = trpc.oidcAuth.adminSettings.useQuery(undefined, { staleTime: 10_000 });
  const updateMutation = trpc.oidcAuth.updateAdminSettings.useMutation();
  const discoveryMutation = trpc.oidcAuth.testDiscovery.useMutation();
  const saved = settingsQuery.data;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  // 客户端 ID / 密钥两个框先只读、点进去才可写：挡浏览器把面板登录密码自动填进来（同 Google 登录那张卡）。
  const [clientFieldsEditable, setClientFieldsEditable] = useState(false);

  const savedDraft: Draft = saved ? draftOf(saved) : EMPTY_DRAFT;

  useEffect(() => {
    if (saved) setDraft(draftOf(saved));
  }, [saved]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const panelUrlMissing = !!saved && !saved.panelPublicUrl;
  const redirectUri = saved?.redirectUri || "";

  const save = async () => {
    if (!saved) return false;
    try {
      await updateMutation.mutateAsync({
        enabled: draft.enabled,
        providerName: draft.providerName.trim(),
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret.trim() || undefined,
        scopes: draft.scopes.trim(),
        allowRegistration: draft.allowRegistration,
        requireVerifiedEmail: draft.requireVerifiedEmail,
        allowedDomains: draft.allowedDomains.trim(),
        allowPrivateNetwork: draft.allowPrivateNetwork,
        allowHmacTokens: draft.allowHmacTokens,
      });
      await Promise.all([utils.oidcAuth.adminSettings.invalidate(), utils.system.publicInfo.invalidate()]);
      toast.success("OIDC 登录设置已保存");
      return true;
    } catch (error) {
      toast.error((error instanceof Error && error.message) || "保存 OIDC 登录设置失败");
      return false;
    }
  };

  useSaveDockItem({
    id: "system.oidcLogin",
    label: "OIDC 登录",
    dirty,
    pending: updateMutation.isPending,
    save,
    reset: () => setDraft(savedDraft),
  });

  const testDiscovery = async () => {
    try {
      setDiscovery(await discoveryMutation.mutateAsync({
        issuer: draft.issuer.trim(),
        allowPrivateNetwork: draft.allowPrivateNetwork,
        scopes: draft.scopes.trim(),
        allowHmacTokens: draft.allowHmacTokens,
      }));
    } catch (error) {
      setDiscovery({ ok: false, message: (error instanceof Error && error.message) || "测试失败" });
    }
  };

  const copyRedirectUri = async () => {
    if (!redirectUri) return;
    if (await copyTextToClipboard(redirectUri)) toast.success("回调地址已复制");
    else toast.error("复制失败，请手动选中复制");
  };

  const toggle = (key: "enabled" | "allowRegistration" | "requireVerifiedEmail" | "allowPrivateNetwork" | "allowHmacTokens", label: string, description: string, disabled = false) => (
    <SettingRow
      asLabel
      label={label}
      description={description}
      control={(
        <Checkbox aria-label={label} checked={draft[key]} disabled={disabled} onCheckedChange={(value) => set(key, value === true)} />
      )}
    />
  );

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <OidcMark className="h-4 w-4" />
          OIDC 登录
        </CardTitle>
        <CardDescription>
          接入自建的身份提供方（Pocket ID、Authentik、Keycloak、Authelia、Zitadel……）。默认只有已经在 个人资料 里绑定过的账号能用。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {panelUrlMissing ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>还没有配置面板公开地址</AlertTitle>
            <AlertDescription>回调地址要用它拼出来。先在上面「面板地址」里填好并保存，再回来开启。</AlertDescription>
          </Alert>
        ) : saved?.redirectUriInsecure ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>回调地址是 http</AlertTitle>
            <AlertDescription>多数 IdP（Pocket ID、Authelia 等）只接受 https 的回调地址，授权码也会以明文经过网络。建议先给面板配上 HTTPS。</AlertDescription>
          </Alert>
        ) : null}

        <SettingList>
          {toggle("enabled", "启用 OIDC 登录", panelUrlMissing ? "填好面板公开地址后才能开启。" : `开启后登录页出现「${oidcButtonLabel(draft.providerName)}」。`, panelUrlMissing && !draft.enabled)}
          {toggle("allowRegistration", "允许用它注册新账号", "关闭时，没绑定过的账号不能登录。开启后还要同时满足「开放注册」、邮箱白名单和邀请码规则；已有账号的邮箱不会被自动合并。")}
          {toggle("requireVerifiedEmail", "只接受已验证邮箱", "IdP 返回的 email_verified 必须是 true（IdP 没给这一项也不算）。自建 IdP 里邮箱常常是用户自己随手填的，建议保持开启。")}
          {toggle("allowPrivateNetwork", "IdP 在内网", "默认面板只连公网地址（防止被拿来探测内网）。IdP 在局域网里（例如 192.168.x.x、auth.home.lan）时勾选；回环地址和云元数据地址仍然不允许。勾选后 Issuer 也可以是 http。")}
          {toggle("allowHmacTokens", "接受 HS256 签名的 ID Token", "默认只认 RS256 / ES256。只有 IdP 只能用客户端密钥签名（HS256）时才勾选，并且要填客户端密钥。")}
        </SettingList>

        <div className="grid gap-3 @[42rem]:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="oidc-provider-name">显示名称</Label>
            <Input id="oidc-provider-name" value={draft.providerName} onChange={(e) => set("providerName", e.target.value)} placeholder="Pocket ID" maxLength={32} autoComplete="off" />
            <p className="text-meta text-muted-foreground">按钮上显示「{oidcButtonLabel(draft.providerName)}」。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-issuer">Issuer 地址</Label>
            <div className="flex gap-2">
              <Input
                id="oidc-issuer"
                value={draft.issuer}
                onChange={(e) => set("issuer", e.target.value)}
                placeholder="https://id.example.com"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="button" variant="outline" className="shrink-0 gap-1.5" onClick={() => void testDiscovery()} disabled={!draft.issuer.trim() || discoveryMutation.isPending}>
                {discoveryMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                测试发现
              </Button>
            </div>
            <p className="text-meta text-muted-foreground">要和 IdP 的 discovery 里的 issuer 一字不差（包括末尾有没有斜杠）。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-client-id">客户端 ID</Label>
            <Input
              id="oidc-client-id"
              name="oidc-client-id"
              value={draft.clientId}
              onChange={(e) => set("clientId", e.target.value)}
              autoComplete="off"
              spellCheck={false}
              readOnly={!clientFieldsEditable}
              onFocus={() => setClientFieldsEditable(true)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-client-secret">客户端密钥</Label>
            <PasswordInput
              id="oidc-client-secret"
              name="oidc-client-secret"
              value={draft.clientSecret}
              onChange={(e) => set("clientSecret", e.target.value)}
              placeholder={saved?.clientSecretSet ? "已保存，留空不改" : "公开客户端可以不填"}
              autoComplete="new-password"
              readOnly={!clientFieldsEditable}
              onFocus={() => setClientFieldsEditable(true)}
            />
            {saved?.clientSecretMasked ? <p className="break-all text-meta text-muted-foreground">当前：{saved.clientSecretMasked}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-scopes">Scope</Label>
            <Input id="oidc-scopes" value={draft.scopes} onChange={(e) => set("scopes", e.target.value)} placeholder={OIDC_DEFAULT_SCOPES} autoComplete="off" spellCheck={false} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="oidc-allowed-domains">只允许这些邮箱域名（可选，留空不限）</Label>
            <Input id="oidc-allowed-domains" value={draft.allowedDomains} onChange={(e) => set("allowedDomains", e.target.value)} placeholder="example.com, corp.example.org" autoComplete="off" spellCheck={false} />
          </div>
        </div>

        {discovery ? (
          discovery.ok ? (
            <div className="space-y-2 rounded-lg border border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-[var(--fx-healthy-text)]">
                <CheckCircle2 className="h-4 w-4" />
                发现成功，JWKS 里有 {discovery.keyCount} 把可用公钥
              </div>
              <dl className="grid gap-x-3 gap-y-1 text-meta @[42rem]:grid-cols-[max-content_1fr]">
                {([
                  ["issuer", discovery.discovery.issuer],
                  ["授权端点", discovery.discovery.authorizationEndpoint],
                  ["token 端点", discovery.discovery.tokenEndpoint],
                  ["JWKS", discovery.discovery.jwksUri],
                  ["userinfo", discovery.discovery.userinfoEndpoint || "（没有）"],
                  ["签名算法", discovery.discovery.idTokenSigningAlgs.join(", ") || "（没声明）"],
                  ["客户端认证", discovery.discovery.tokenEndpointAuthMethods.join(", ") || "（没声明，按 client_secret_basic）"],
                ] as const).map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-all font-mono">{value}</dd>
                  </div>
                ))}
              </dl>
              {discovery.warnings.length ? (
                <ul className="list-disc space-y-1 pl-5 text-meta text-[var(--fx-warn-text)]">
                  {discovery.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
            </div>
          ) : (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-[var(--fx-down-soft)] p-3 text-sm text-[var(--fx-down-text)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-all">{discovery.message}</span>
            </div>
          )
        ) : null}

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-secondary-type font-medium">回调地址（Redirect URI）</div>
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
            <li>在 IdP 里新建一个 OIDC 客户端（Pocket ID：OIDC Clients › Add OIDC Client）。</li>
            <li>把上面的地址原样填到它的 Callback / Redirect URI。</li>
            <li>把 IdP 的 Issuer 地址、客户端 ID 和密钥填到这里，点「测试发现」确认能连上，再勾选启用后保存。</li>
          </ol>
          <a className="inline-flex items-center gap-1 text-meta text-primary underline" href={docsUrl("/guide/oidc-login")} target="_blank" rel="noopener noreferrer">
            详细步骤和常见问题<ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="flex justify-end">
          <Button data-dock-save onClick={() => void save()} disabled={!saved || updateMutation.isPending}>
            {updateMutation.isPending ? "保存中..." : "保存 OIDC 登录设置"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
