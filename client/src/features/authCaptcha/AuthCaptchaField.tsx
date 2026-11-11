import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { authErrorMessage } from "@/lib/authErrorMessage";
import type { AuthCaptchaMode, AuthCaptchaSubmission } from "@shared/authCaptchaMode";

/*
  登录 / 注册 / 找回密码共用的人机验证框（上游 2.3.286）。管理员在 系统设置 › 注册 里选方式：

  · click：自建的 Cap.js「点一下」（工作量证明），默认；
  · image：混淆的图片字符验证码。

  服务端只认选中的那一种（server/authCaptchaMode.ts），所以这里也只画那一种。验证结果统一交成
  AuthCaptchaSubmission：点击是一枚令牌，图片是「挑战 id + 填的字符」，调用方原样展开进请求。
  两种结果都只能用一次：调用方提交失败后把 resetKey 加一，这里会换一枚新的。
*/

export type AuthCaptchaFieldProps = {
  mode: AuthCaptchaMode;
  purpose: "login" | "register";
  /** 输入框 id（图片模式下的「请输入图片中的字符」）。 */
  id: string;
  disabled?: boolean;
  /** 手机 App 还没填面板地址时为 false：不去要挑战。 */
  available?: boolean;
  resetKey: number;
  onChange: (submission: AuthCaptchaSubmission | null) => void;
};

export default function AuthCaptchaField(props: AuthCaptchaFieldProps) {
  const { onChange } = props;
  const handleToken = useCallback((token: string) => onChange(token ? { capToken: token } : null), [onChange]);
  if (props.mode === "image") {
    return (
      <ImageCaptchaField
        id={props.id}
        purpose={props.purpose}
        disabled={props.disabled}
        available={props.available !== false}
        resetKey={props.resetKey}
        onChange={onChange}
      />
    );
  }
  return <CapVerificationField purpose={props.purpose} disabled={props.disabled} resetKey={props.resetKey} onToken={handleToken} />;
}

function captchaRetryAfterSeconds(message: string) {
  const match = /^CAPTCHA_REFRESH_RATE_LIMITED:(\d+)$/.exec(message);
  return match ? Math.max(1, Number(match[1])) : 0;
}

/*
  验证组件（@cap.js/widget，压缩前 42 kB）用到时才下载。

  登录页是同步打进入口包的，原来顶部一句 import 就让每个人首屏都带上它 ——
  可验证只在「同一账号连续输错」和「注册」时才出现，绝大多数登录根本用不到。
  cap-widget 是自定义元素，模块加载完才注册；所以等它 ready 了再创建元素，
  不去依赖浏览器事后升级（升级前设的属性和监听虽然也保得住，但少一种时序可想）。
*/
let capWidgetLoaded = false;
let capWidgetPromise: Promise<void> | null = null;
function loadCapWidget() {
  if (!capWidgetPromise) {
    capWidgetPromise = import("@cap.js/widget").then(
      () => {
        capWidgetLoaded = true;
      },
      (error) => {
        capWidgetPromise = null;
        throw error;
      },
    );
  }
  return capWidgetPromise;
}

function CapVerificationField(props: {
  purpose: "login" | "register";
  disabled?: boolean;
  resetKey: number;
  onToken: (token: string) => void;
}) {
  const { purpose, disabled, resetKey, onToken } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [widgetReady, setWidgetReady] = useState(capWidgetLoaded);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (widgetReady) return;
    let cancelled = false;
    setLoadFailed(false);
    loadCapWidget()
      .then(() => {
        if (!cancelled) setWidgetReady(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, widgetReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !widgetReady) return;
    const widget = document.createElement("cap-widget");
    const panelBase = mobileAuth.isNative ? mobileAuth.normalizePanelUrl(mobileAuth.getPanelUrl()) : "";
    widget.setAttribute("data-cap-api-endpoint", `${panelBase}/api/auth/cap/${purpose}/`);
    widget.setAttribute("data-cap-worker-count", "2");
    widget.setAttribute("data-cap-i18n-initial-state", "点击验证");
    widget.setAttribute("data-cap-i18n-verifying-label", "验证中...");
    widget.setAttribute("data-cap-i18n-solved-label", "验证通过");
    widget.setAttribute("data-cap-i18n-error-label", "验证失败，请重试");
    widget.setAttribute("data-cap-i18n-verify-aria-label", "点击验证你是真人");
    if (disabled) {
      widget.setAttribute("aria-disabled", "true");
      widget.style.pointerEvents = "none";
      widget.style.opacity = "0.65";
    }
    const handleSolve = (event: Event) => {
      const token = String((event as CustomEvent<{ token?: string }>).detail?.token || "").trim();
      if (token) onToken(token);
    };
    const handleReset = () => onToken("");
    const handleError = () => onToken("");
    widget.addEventListener("solve", handleSolve);
    widget.addEventListener("reset", handleReset);
    widget.addEventListener("error", handleError);
    container.replaceChildren(widget);
    return () => {
      widget.removeEventListener("solve", handleSolve);
      widget.removeEventListener("reset", handleReset);
      widget.removeEventListener("error", handleError);
      widget.remove();
    };
  }, [disabled, onToken, purpose, resetKey, widgetReady]);

  return (
    <div className="space-y-2">
      <Label>人机验证</Label>
      <div className="min-h-14" aria-live="polite">
        {!widgetReady && (loadFailed ? (
          <button
            type="button"
            className="flex min-h-14 w-full items-center text-left text-meta text-destructive underline-offset-4 hover:underline"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            验证没加载出来，点这里重试
          </button>
        ) : (
          <p className="flex min-h-14 items-center text-meta text-muted-foreground">正在加载验证…</p>
        ))}
        {/* 组件是命令式塞进去的，单独一个空 div，不和 React 管的占位文字混在一起 */}
        <div ref={containerRef} />
      </div>
    </div>
  );
}

type ImageChallenge = { captchaId: string; imageDataUrl: string; expiresAt: number };

/*
  图片验证码：自己管挑战（auth.createCaptcha），一出现就要一张，resetKey 变了、过期了再换一张。
  服务端按来源 IP 限每分钟换几次（CAPTCHA_REFRESH_RATE_LIMITED:秒），被限了刷新按钮就灰着倒数。
*/
function ImageCaptchaField(props: {
  id: string;
  purpose: "login" | "register";
  disabled?: boolean;
  available: boolean;
  resetKey: number;
  onChange: (submission: AuthCaptchaSubmission | null) => void;
}) {
  const { id, purpose, disabled, available, resetKey, onChange } = props;
  const [challenge, setChallenge] = useState<ImageChallenge | null>(null);
  const [answer, setAnswer] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const createCaptchaMutation = trpc.auth.createCaptcha.useMutation();
  const mutateRef = useRef(createCaptchaMutation.mutate);
  useEffect(() => {
    mutateRef.current = createCaptchaMutation.mutate;
  }, [createCaptchaMutation.mutate]);
  const requestIdRef = useRef(0);
  const pendingRef = useRef(false);
  const cooldownRef = useRef(0);

  const requestChallenge = useCallback(() => {
    if (!available || pendingRef.current || Date.now() < cooldownRef.current) return;
    const requestId = ++requestIdRef.current;
    pendingRef.current = true;
    setAnswer("");
    mutateRef.current({ purpose }, {
      onSuccess: (data) => {
        pendingRef.current = false;
        if (requestId !== requestIdRef.current) return;
        setChallenge({ captchaId: data.captchaId, imageDataUrl: data.imageDataUrl, expiresAt: Date.now() + data.expiresInSeconds * 1000 });
        setAnswer("");
      },
      onError: (error) => {
        pendingRef.current = false;
        if (requestId !== requestIdRef.current) return;
        const retryAfter = captchaRetryAfterSeconds(error.message || "");
        if (retryAfter > 0) {
          cooldownRef.current = Date.now() + retryAfter * 1000;
          setCooldownUntil(cooldownRef.current);
          toast.error(`验证码刷新过于频繁，请 ${retryAfter} 秒后重试`);
          return;
        }
        toast.error(authErrorMessage(error.message, "验证码加载失败"));
      },
    });
  }, [available, purpose]);

  // 一出现、resetKey 变了（上一张已经用掉）：换一张。旧的立刻作废，免得拿用过的去提交。
  useEffect(() => {
    setChallenge(null);
    requestChallenge();
  }, [requestChallenge, resetKey]);

  // 过期了自动换；被限流时每秒刷新一次倒数
  useEffect(() => {
    const until = Math.max(challenge?.expiresAt ?? 0, cooldownUntil);
    if (until <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(1000, until - Date.now() + 50));
    return () => window.clearTimeout(timer);
  }, [challenge?.expiresAt, cooldownUntil, now]);
  useEffect(() => {
    if (challenge && challenge.expiresAt <= now) {
      setChallenge(null);
      requestChallenge();
    }
  }, [challenge, now, requestChallenge]);

  useEffect(() => {
    const trimmed = answer.trim();
    onChange(challenge && trimmed ? { captchaId: challenge.captchaId, captchaAnswer: trimmed } : null);
  }, [answer, challenge, onChange]);

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const loading = createCaptchaMutation.isPending;
  const refreshTitle = cooldownSeconds > 0 ? `${cooldownSeconds} 秒后可刷新` : "刷新验证码";
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>验证码</Label>
      <div className="flex items-stretch gap-2">
        <div className="flex h-14 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-white">
          {challenge ? (
            <img src={challenge.imageDataUrl} alt="图片验证码" className="h-full w-full select-none object-fill" draggable={false} />
          ) : loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-sm text-muted-foreground">验证码暂不可用</span>
          )}
        </div>
        <button
          type="button"
          onClick={requestChallenge}
          disabled={disabled || loading || cooldownSeconds > 0 || !available}
          className="flex h-14 w-11 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          title={refreshTitle}
          aria-label={refreshTitle}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <Input
        id={id}
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        placeholder="请输入图片中的字符"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={disabled || !challenge}
      />
    </div>
  );
}
