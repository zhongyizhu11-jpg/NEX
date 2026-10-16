import { useEffect, useRef, useState } from "react";
import { Browser } from "@capacitor/browser";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { authErrorMessage } from "@/lib/authErrorMessage";
import GoogleMark from "./GoogleMark";
import { googleWebStartUrl } from "./googleLoginReturn";

const APP_POLL_INTERVAL_MS = 2000;

export type GoogleTwoFactorChallenge = {
  challengeId: string;
  username: string;
  expiresInSeconds: number;
};

/**
 * 登录页的「使用 Google 登录」。
 *
 * 网页：整页跳到 /api/auth/google/start，Google 授权完回到面板，服务端直接种好会话 cookie。
 * App：Google 不让在内嵌 WebView 里授权（disallowed_useragent），而且 App 的页面不在面板域名下，
 * 回调的 cookie 也到不了 App。所以用系统浏览器打开授权页，App 这边轮询结果，拿到 App 自己的
 * 会话令牌（和 Telegram 的 App 登录一个思路）。
 */
export default function GoogleLoginButton({
  disabled,
  redirectPath = "/",
  inviteCode,
  onLoggedIn,
  onTwoFactorRequired,
}: {
  disabled?: boolean;
  redirectPath?: string;
  /** 从邀请链接进来时的邀请码：用 Google 注册新账号时带上（网页流程）。 */
  inviteCode?: string | null;
  /** App 里轮询到登录成功（网页里不会调用：浏览器直接跳走了）。 */
  onLoggedIn: (user: any) => void;
  onTwoFactorRequired: (challenge: GoogleTwoFactorChallenge) => void;
}) {
  const [webPending, setWebPending] = useState(false);
  const [appFlow, setAppFlow] = useState<{ flowId: string; pollToken: string; expiresAt: number } | null>(null);
  const appStartMutation = trpc.googleAuth.appStart.useMutation();
  const appStatusMutation = trpc.googleAuth.appStatus.useMutation();
  const appCancelMutation = trpc.googleAuth.appCancel.useMutation();
  const pollingRef = useRef(false);
  const callbacksRef = useRef({ onLoggedIn, onTwoFactorRequired });
  callbacksRef.current = { onLoggedIn, onTwoFactorRequired };
  const statusMutateRef = useRef(appStatusMutation.mutateAsync);
  statusMutateRef.current = appStatusMutation.mutateAsync;

  // 页面从 bfcache 回来（用户在 Google 那边点了返回）时，别让按钮一直转圈。
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
        toast.error("Google 登录已超时，请重新发起");
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
          toast.error(result.message || "Google 登录失败");
        } else {
          toast.error("Google 登录已超时，请重新发起");
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
  }, [appFlow]);

  const startApp = async () => {
    if (!mobileAuth.hasPanelUrl()) {
      toast.error("请先点击右上角设置按钮添加服务器地址");
      return;
    }
    try {
      const flow = await appStartMutation.mutateAsync();
      setAppFlow({ flowId: flow.flowId, pollToken: flow.pollToken, expiresAt: Date.now() + flow.expiresInSeconds * 1000 });
      await Browser.open({ url: flow.startUrl });
    } catch (error: any) {
      setAppFlow(null);
      toast.error(authErrorMessage(error?.message || "", "无法发起 Google 登录"));
    }
  };

  const cancelApp = () => {
    if (appFlow) appCancelMutation.mutate({ flowId: appFlow.flowId, pollToken: appFlow.pollToken });
    setAppFlow(null);
  };

  const handleClick = () => {
    if (mobileAuth.isNative) {
      void startApp();
      return;
    }
    setWebPending(true);
    window.location.assign(googleWebStartUrl("login", redirectPath, inviteCode));
  };

  const waitingApp = !!appFlow || appStartMutation.isPending;
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
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <GoogleMark />}
        {waitingApp ? "等待在浏览器里完成 Google 登录…" : webPending ? "正在前往 Google…" : "使用 Google 登录"}
      </Button>
      {appFlow ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>在打开的浏览器里选好 Google 账号后回到这里，会自动登录。</span>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={cancelApp}>
            取消
          </Button>
        </div>
      ) : null}
    </div>
  );
}
