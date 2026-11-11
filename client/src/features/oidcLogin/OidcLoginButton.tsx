import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { oidcButtonLabel } from "@shared/oidcLogin";
import type { OAuthTwoFactorChallenge } from "@/features/oauthLogin/OAuthLoginButton";
import OidcMark from "./OidcMark";
import { oidcWebStartUrl, parseOidcLoginReturn, stripOidcLoginReturnFromUrl } from "./oidcLoginReturn";

/**
 * 登录页的「使用 <显示名称> 登录」（通用 OIDC：Pocket ID、Keycloak……）。
 *
 * 整块自己管自己：读 publicInfo 决定显不显示、按钮上写什么；回调跳回来的 ?oidcError=码 写在按钮上方
 * （整页跳回来的那一刻 Toaster 可能还没挂好，弹窗会丢）；#oidcTwoFactor=… 交给登录页弹出双重验证。
 * 这样登录页只需要挂一个组件。
 *
 * 只在网页里显示：App 的页面不在面板域名下，回调种的 cookie 到不了 App，而 App 那条「系统浏览器 + 轮询」
 * 流程通用 OIDC 没有接。
 */
export default function OidcLoginButton({
  disabled,
  inviteCode,
  onTwoFactorRequired,
}: {
  disabled?: boolean;
  /** 从邀请链接进来时的邀请码：注册新账号时带上。 */
  inviteCode?: string | null;
  onTwoFactorRequired: (challenge: OAuthTwoFactorChallenge) => void;
}) {
  const isWeb = !mobileAuth.isNative;
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, { enabled: isWeb, retry: false, refetchOnWindowFocus: false });
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const twoFactorRef = useRef(onTwoFactorRequired);
  twoFactorRef.current = onTwoFactorRequired;

  // OIDC 回调跳回来：?oidcError=码 显示原因；#oidcTwoFactor=… 弹出双重验证。
  useEffect(() => {
    if (typeof window === "undefined" || !isWeb) return;
    const result = parseOidcLoginReturn(window.location.search, window.location.hash);
    if (!result.errorMessage && !result.twoFactor) return;
    stripOidcLoginReturnFromUrl();
    if (result.errorMessage) setNotice(result.errorMessage);
    if (result.twoFactor) {
      twoFactorRef.current({
        challengeId: result.twoFactor.challengeId,
        username: result.twoFactor.username,
        expiresInSeconds: result.twoFactor.expiresInSeconds,
      });
    }
  }, [isWeb]);

  // 页面从 bfcache 回来（用户在授权页点了返回）时，别让按钮一直转圈。
  useEffect(() => {
    const reset = () => setPending(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  if (!isWeb) return null;
  const enabled = publicInfo?.oidcLoginEnabled === true;
  const providerName = publicInfo?.oidcLoginName;
  if (!enabled && !notice) return null;

  const handleClick = () => {
    setPending(true);
    window.location.assign(oidcWebStartUrl("login", "/", inviteCode));
  };

  return (
    <div className="space-y-2">
      {notice ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-[var(--fx-down-soft)] p-3 text-sm text-[var(--fx-down-text)]">
          <OidcMark className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" className="shrink-0 text-xs underline opacity-80 hover:opacity-100" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      ) : null}
      {enabled ? (
        <Button type="button" variant="outline" size="lg" className="w-full gap-2.5" onClick={handleClick} disabled={disabled || pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <OidcMark />}
          {pending ? "正在前往登录页…" : oidcButtonLabel(providerName)}
        </Button>
      ) : null}
    </div>
  );
}
