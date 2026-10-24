import { useEffect, useRef, useState, type ReactNode } from "react";
import { Browser } from "@capacitor/browser";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { mobileAuth } from "@/lib/mobileAuth";
import { authErrorMessage } from "@/lib/authErrorMessage";

const APP_POLL_INTERVAL_MS = 2000;

export type OAuthTwoFactorChallenge = {
  challengeId: string;
  username: string;
  expiresInSeconds: number;
};

type AppFlowCredentials = { flowId: string; pollToken: string };

/** App 登录要的三个接口（各家 tRPC 路由里的 appStart / appStatus / appCancel）。 */
export type OAuthAppMutations = {
  start: {
    mutateAsync: (input: { inviteCode?: string }) => Promise<AppFlowCredentials & { expiresInSeconds: number; startUrl: string }>;
    isPending: boolean;
  };
  status: { mutateAsync: (input: AppFlowCredentials) => Promise<unknown> };
  cancel: { mutate: (input: AppFlowCredentials) => void };
};

export type OAuthLoginProvider = {
  /** 按钮和提示里的名字：Google、Discord。 */
  label: string;
  mark: ReactNode;
  webStartUrl: (mode: "login" | "link", redirect: string, inviteCode?: string | null) => string;
  /** App 里等待时按钮下面那句话。 */
  appWaitingHint: string;
  /** 每家自己的 tRPC 接口；是个 hook，每次渲染都调。 */
  useAppMutations: () => OAuthAppMutations;
};

/**
 * 登录页的「使用 Google / Discord 登录」，两家同一套做法：
 *
 * 网页：整页跳到 /api/auth/<家>/start，授权完回到面板，服务端直接种好会话 cookie。
 * App：App 的页面不在面板域名下，回调的 cookie 到不了 App；Google 还不让在内嵌 WebView 里授权
 * （disallowed_useragent）。所以用系统浏览器打开授权页，App 这边轮询结果，拿到 App 自己的会话令牌
 * （和 Telegram 的 App 登录一个思路）。
 */
export function OAuthLoginButton({
  provider,
  disabled,
  redirectPath = "/",
  inviteCode,
  onLoggedIn,
  onTwoFactorRequired,
}: {
  provider: OAuthLoginProvider;
  disabled?: boolean;
  redirectPath?: string;
  /** 从邀请链接进来时的邀请码：注册新账号时带上（网页和 App 流程都带）。 */
  inviteCode?: string | null;
  /** App 里轮询到登录成功（网页里不会调用：浏览器直接跳走了）。 */
  onLoggedIn: (user: any) => void;
  onTwoFactorRequired: (challenge: OAuthTwoFactorChallenge) => void;
}) {
  const { label } = provider;
  const [webPending, setWebPending] = useState(false);
  const [appFlow, setAppFlow] = useState<(AppFlowCredentials & { expiresAt: number }) | null>(null);
  const mutations = provider.useAppMutations();
  const pollingRef = useRef(false);
  const callbacksRef = useRef({ onLoggedIn, onTwoFactorRequired });
  callbacksRef.current = { onLoggedIn, onTwoFactorRequired };
  const statusMutateRef = useRef(mutations.status.mutateAsync);
  statusMutateRef.current = mutations.status.mutateAsync;

  // 页面从 bfcache 回来（用户在授权页点了返回）时，别让按钮一直转圈。
  useEffect(() => {
    const reset = () => setWebPending(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  useEffect(() => {
    if (!appFlow) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || pollingRef.current) return;
      if (Date.now() > appFlow.expiresAt) {
        stopped = true;
        setAppFlow(null);
        toast.error(`${label} 登录已超时，请重新发起`);
        return;
      }
      pollingRef.current = true;
      try {
        const result: any = await statusMutateRef.current({ flowId: appFlow.flowId, pollToken: appFlow.pollToken });
        if (stopped || result.status === "pending") return;
        stopped = true;
        setAppFlow(null);
        Browser.close().catch(() => undefined);
        if (result.status === "success") {
          mobileAuth.setToken(result.mobileToken);
          callbacksRef.current.onLoggedIn(result);
        } else if (result.status === "two_factor") {
          callbacksRef.current.onTwoFactorRequired(result);
        } else if (result.status === "failed") {
          toast.error(result.message || `${label} 登录失败`);
        } else {
          toast.error(`${label} 登录已超时，请重新发起`);
        }
      } catch {
        // 网络抖一下：下一轮再问
      } finally {
        pollingRef.current = false;
      }
    };
    const timer = window.setInterval(() => void tick(), APP_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [appFlow, label]);

  const startApp = async () => {
    if (!mobileAuth.hasPanelUrl()) {
      toast.error("请先点击右上角设置按钮添加服务器地址");
      return;
    }
    try {
      const flow = await mutations.start.mutateAsync({ inviteCode: inviteCode || undefined });
      setAppFlow({ flowId: flow.flowId, pollToken: flow.pollToken, expiresAt: Date.now() + flow.expiresInSeconds * 1000 });
      await Browser.open({ url: flow.startUrl });
    } catch (error: any) {
      setAppFlow(null);
      toast.error(authErrorMessage(error?.message || "", `无法发起 ${label} 登录`));
    }
  };

  const cancelApp = () => {
    if (appFlow) mutations.cancel.mutate({ flowId: appFlow.flowId, pollToken: appFlow.pollToken });
    setAppFlow(null);
  };

  const handleClick = () => {
    if (mobileAuth.isNative) {
      void startApp();
      return;
    }
    setWebPending(true);
    window.location.assign(provider.webStartUrl("login", redirectPath, inviteCode));
  };

  const waitingApp = !!appFlow || mutations.start.isPending;
  const pending = webPending || waitingApp;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full gap-2.5"
        onClick={handleClick}
        disabled={disabled || pending}
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : provider.mark}
        {waitingApp ? `等待在浏览器里完成 ${label} 登录…` : webPending ? `正在前往 ${label}…` : `使用 ${label} 登录`}
      </Button>
      {appFlow ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{provider.appWaitingHint}</span>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={cancelApp}>
            取消
          </Button>
        </div>
      ) : null}
    </div>
  );
}
