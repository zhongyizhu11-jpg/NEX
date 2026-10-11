import { resolveSiteTitle } from "@shared/brand";
import { useState, useCallback, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Sun, Moon, RefreshCw, UserPlus, LogIn, Send, Settings as SettingsIcon } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";
import { Link, useLocation, useSearch } from "wouter";
import { mobileAuth } from "@/lib/mobileAuth";
import { clearPersistedQueryCache } from "@/lib/queryPersistence";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { ACCOUNT_DISABLED_ERR_MSG } from "@shared/const";

const REGISTRATION_CLOSED_MESSAGE = "当前注册未开放，请联系管理员";

type Mode = "login" | "register";

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isMobileNetworkError(message: string) {
  return /failed to fetch|fetch failed|networkerror/i.test(message);
}

type MobileTelegramLoginState = {
  code: string;
  pollToken: string;
  telegramUrl: string;
  expiresAt: number;
};

type TwoFactorChallengeState = {
  challengeId: string;
  username: string;
  expiresAt: number;
};

type CaptchaChallengeState = {
  captchaId: string;
  imageDataUrl: string;
  expiresAt: number;
  purpose: "login" | "register";
};

type TelegramWebAppBridge = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
};

function getTelegramWebAppBridge(): TelegramWebAppBridge | null {
  if (typeof window === "undefined") return null;
  return ((window as any).Telegram?.WebApp as TelegramWebAppBridge | undefined) || null;
}

function getTelegramWebAppInitData() {
  const webApp = getTelegramWebAppBridge();
  const initData = typeof webApp?.initData === "string" ? webApp.initData.trim() : "";
  return initData;
}

function getTelegramWebAppChallenge() {
  if (typeof window === "undefined") return "";
  return String(new URLSearchParams(window.location.search).get("wa") || "").trim();
}

function isTelegramWebAppRequested() {
  if (typeof window === "undefined") return false;
  const value = String(new URLSearchParams(window.location.search).get("tgWebApp") || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// 把 ?tg= 从地址栏去掉（保留其它参数），刷新页面不会再次弹出确认框。
function clearTelegramLinkFromUrl() {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("tg")) return;
  params.delete("tg");
  const query = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
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
  onError: (message: string) => void;
}) {
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
        if (cancelled) return;
        setLoadFailed(true);
        props.onError("CAPTCHA_LOAD_FAILED");
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, props.onError, widgetReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !widgetReady) return;
    const widget = document.createElement("cap-widget");
    const panelBase = mobileAuth.isNative ? mobileAuth.normalizePanelUrl(mobileAuth.getPanelUrl()) : "";
    widget.setAttribute("data-cap-api-endpoint", `${panelBase}/api/auth/cap/${props.purpose}/`);
    widget.setAttribute("data-cap-worker-count", "2");
    widget.setAttribute("data-cap-i18n-initial-state", "点击验证");
    widget.setAttribute("data-cap-i18n-verifying-label", "验证中...");
    widget.setAttribute("data-cap-i18n-solved-label", "验证通过");
    widget.setAttribute("data-cap-i18n-error-label", "验证失败，请重试");
    widget.setAttribute("data-cap-i18n-verify-aria-label", "点击验证你是真人");
    if (props.disabled) {
      widget.setAttribute("aria-disabled", "true");
      widget.style.pointerEvents = "none";
      widget.style.opacity = "0.65";
    }
    const handleSolve = (event: Event) => {
      const token = String((event as CustomEvent<{ token?: string }>).detail?.token || "").trim();
      if (token) props.onToken(token);
    };
    const handleReset = () => props.onToken("");
    const handleError = (event: Event) => {
      props.onToken("");
      props.onError(String((event as CustomEvent<{ message?: string }>).detail?.message || "CAPTCHA_INVALID"));
    };
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
  }, [props.disabled, props.onError, props.onToken, props.purpose, props.resetKey, widgetReady]);

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

const ignoreCapError = () => undefined;

function ImageCaptchaField(props: {
  id: string;
  value: string;
  imageDataUrl?: string;
  loading: boolean;
  refreshDisabled: boolean;
  refreshTitle: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
  resetKey?: number;
}) {
  return (
    <CapVerificationField
      purpose={props.id === "reg-captcha" ? "register" : "login"}
      disabled={props.disabled}
      resetKey={props.resetKey ?? 0}
      onToken={props.onChange}
      onError={ignoreCapError}
    />
  );
  /*
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>验证码</Label>
      <div className="flex items-stretch gap-2">
        <div className="flex h-14 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-white">
          {props.imageDataUrl ? (
            <img
              src={props.imageDataUrl}
              alt="图片验证码"
              className="h-full w-full select-none object-fill"
              draggable={false}
            />
          ) : props.loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-sm text-muted-foreground">验证码暂不可用</span>
          )}
        </div>
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={props.refreshDisabled}
          className="flex h-14 w-11 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          title={props.refreshTitle}
          aria-label={props.refreshTitle}
        >
          <RefreshCw className={`h-4 w-4 ${props.loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <Input
        id={props.id}
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        placeholder="请输入图片中的字符"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled || !props.imageDataUrl}
      />
    </div>
  );
  */
}

const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";
const LOGIN_NOTICE_TOAST_KEY = "forwardx.loginNotice";
const DISPLAY_NAME_MAX_LENGTH = 24;
const TELEGRAM_WEBAPP_INIT_WAIT_MS = 6000;
const TELEGRAM_WEBAPP_INIT_POLL_MS = 250;
function getWelcomeName(user: any) {
  return String(user?.name || user?.username || "用户").trim() || "用户";
}

function rememberLoginWelcome(user: any) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(LOGIN_WELCOME_TOAST_KEY, getWelcomeName(user));
}

export default function Login() {
  const [location] = useLocation();
  // 到了登录页，上一位登录者留在本机的列表数据就不该再拿来画了（换账号登录时不会闪出别人的数据）。
  useEffect(() => {
    clearPersistedQueryCache();
  }, []);
  // wouter 的 useLocation() 只有路径，查询串要从 useSearch() 取。
  const search = useSearch();
  const initialMode = new URLSearchParams(search).get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState(() => mobileAuth.getUsername());
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaChallenge, setCaptchaChallenge] = useState<CaptchaChallengeState | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [loginCaptchaRequiredFor, setLoginCaptchaRequiredFor] = useState<string | null>(null);
  const [captchaCooldownUntil, setCaptchaCooldownUntil] = useState(0);
  const [telegramLoginCode, setTelegramLoginCode] = useState<string | null>(null);
  const [mobileTelegramLogin, setMobileTelegramLogin] = useState<MobileTelegramLoginState | null>(null);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<TwoFactorChallengeState | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [panelUrlDraft, setPanelUrlDraft] = useState(() => mobileAuth.getPanelUrl());
  const [showPanelSettings, setShowPanelSettings] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();
  const showInsecurePanelWarning = mobileAuth.isNative && mobileAuth.isInsecurePanelUrl(mobileAuth.getPanelUrl());
  const telegramWebAppAutoLoginTriedRef = useRef(false);
  const telegramWebAppChallengeRetriedRef = useRef(false);
  const captchaRequestIdRef = useRef(0);
  const captchaRequestPendingRef = useRef(false);
  const telegramWebAppLoginRetryMutateRef = useRef((payload: { initData: string; challenge?: string; mobile?: boolean }) => {
    void payload;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const message = window.sessionStorage.getItem(LOGIN_NOTICE_TOAST_KEY);
    if (!message) return;
    window.sessionStorage.removeItem(LOGIN_NOTICE_TOAST_KEY);
    toast.error(message);
  }, []);

  useEffect(() => {
    const nextMode = new URLSearchParams(search).get("mode") === "register" ? "register" : "login";
    setMode(nextMode);
  }, [location, search]);

  const utils = trpc.useUtils();
  const { data: emailConfig } = trpc.auth.emailConfig.useQuery(undefined, {
    enabled: hasMobilePanelUrl && mode === "register",
    retry: false,
    refetchOnWindowFocus: false,
  });
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: hasMobilePanelUrl,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const registrationEnabled = emailConfig?.registrationEnabled !== false && publicInfo?.registrationEnabled !== false;
  const siteTitle = resolveSiteTitle(publicInfo?.siteTitle);
  const logoSrc = publicInfo?.siteLogoDataUrl || (resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png");

  useEffect(() => {
    if (mode === "register" && !registrationEnabled) {
      toast.info(REGISTRATION_CLOSED_MESSAGE);
      setMode("login");
    }
  }, [mode, registrationEnabled]);

  const normalizedUsername = username.trim().toLowerCase();
  const captchaStatusQuery = trpc.auth.needsCaptcha.useQuery({ username: normalizedUsername }, {
    enabled: hasMobilePanelUrl && mode === "login" && !!normalizedUsername,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const serverRequiresLoginCaptcha = captchaStatusQuery.data?.required === true;
  const loginCaptchaRequired = serverRequiresLoginCaptcha || loginCaptchaRequiredFor === normalizedUsername;
  // The image challenge remains available only for old clients; the current
  // page uses the self-hosted Cap widget below.
  const captchaVisible = false;
  const captchaPurpose = mode === "register" ? "register" as const : "login" as const;

  const createCaptchaMutation = trpc.auth.createCaptcha.useMutation();
  const requestCaptcha = useCallback((purpose: "login" | "register", clearExisting = true) => {
    if (!hasMobilePanelUrl) {
      setCaptchaAnswer("");
      return;
    }
    if (Date.now() < captchaCooldownUntil || captchaRequestPendingRef.current) return;
    const requestId = ++captchaRequestIdRef.current;
    captchaRequestPendingRef.current = true;
    if (clearExisting) setCaptchaChallenge(null);
    createCaptchaMutation.mutate({ purpose }, {
      onSuccess: (data) => {
        captchaRequestPendingRef.current = false;
        if (requestId !== captchaRequestIdRef.current) return;
        setCaptchaChallenge({
          captchaId: data.captchaId,
          imageDataUrl: data.imageDataUrl,
          expiresAt: Date.now() + data.expiresInSeconds * 1000,
          purpose,
        });
        setCaptchaAnswer("");
        setCaptchaCooldownUntil(0);
      },
      onError: (error) => {
        captchaRequestPendingRef.current = false;
        if (requestId !== captchaRequestIdRef.current) return;
        const retryAfter = captchaRetryAfterSeconds(error.message || "");
        if (retryAfter > 0) {
          setCaptchaCooldownUntil(Date.now() + retryAfter * 1000);
          toast.error(`验证码刷新过于频繁，请 ${retryAfter} 秒后重试`);
          return;
        }
        if (mobileAuth.isNative && isMobileNetworkError(error.message || "")) {
          toast.error("无法连接面板，请检查右上角面板地址");
          return;
        }
        toast.error(authErrorMessage(error.message, "验证码加载失败"));
      },
    });
  }, [captchaCooldownUntil, createCaptchaMutation, hasMobilePanelUrl]);

  useEffect(() => {
    if (!captchaVisible || !hasMobilePanelUrl) return;
    const challengeReady = captchaChallenge?.purpose === captchaPurpose && captchaChallenge.expiresAt > Date.now();
    if (challengeReady || createCaptchaMutation.isPending || Date.now() < captchaCooldownUntil) return;
    requestCaptcha(captchaPurpose);
  }, [captchaChallenge, captchaCooldownUntil, captchaPurpose, captchaVisible, createCaptchaMutation.isPending, hasMobilePanelUrl, requestCaptcha]);

  useEffect(() => {
    if (captchaCooldownUntil <= Date.now()) return;
    const timeout = window.setTimeout(() => setCaptchaCooldownUntil(0), captchaCooldownUntil - Date.now() + 50);
    return () => window.clearTimeout(timeout);
  }, [captchaCooldownUntil]);

  // 登录 mutation
  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      if (data.twoFactorRequired) {
        setLoginCaptchaRequiredFor(null);
        setCaptchaChallenge(null);
        setCaptchaAnswer("");
        setTwoFactorChallenge({
          challengeId: data.challengeId,
          username: data.username,
          expiresAt: Date.now() + data.expiresInSeconds * 1000,
        });
        setTwoFactorCode("");
        toast.info("请输入双重验证验证码");
        return;
      }
      if (mobileAuth.isNative) {
        mobileAuth.setUsername(username);
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error, variables) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      if (msg === "CAPTCHA_REQUIRED" || msg === "CAPTCHA_REQUIRED_AFTER_FAIL") {
        setLoginCaptchaRequiredFor(variables.username.trim().toLowerCase());
        setCaptchaAnswer("");
        setCaptchaResetKey((value) => value + 1);
        if (msg === "CAPTCHA_REQUIRED_AFTER_FAIL") {
          toast.error("用户名或密码错误，请输入验证码后重试");
        } else {
          toast.error("请输入验证码");
        }
      } else if (msg === "CAPTCHA_INVALID") {
        setLoginCaptchaRequiredFor(variables.username.trim().toLowerCase());
        toast.error("验证码错误或已过期，请重新输入");
        setCaptchaAnswer("");
        setCaptchaResetKey((value) => value + 1);
      } else {
        toast.error(authErrorMessage(msg, "登录失败"));
        if (msg === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) {
          mobileAuth.clear();
        }
        if (variables.captchaId && !msg.startsWith("LOGIN_RATE_LIMITED:")) {
          setLoginCaptchaRequiredFor(null);
          setCaptchaChallenge(null);
          setCaptchaAnswer("");
          void captchaStatusQuery.refetch();
        }
      }
    },
  });

  // Telegram 登录的账户开了双重验证时，服务端返回挑战而不是会话：和密码登录一样弹出验证码输入。
  const startTwoFactorFromTelegram = (data: any) => {
    if (!data?.twoFactorRequired) return false;
    setTwoFactorChallenge({
      challengeId: data.challengeId,
      username: data.username,
      expiresAt: Date.now() + data.expiresInSeconds * 1000,
    });
    setTwoFactorCode("");
    toast.info("请输入双重验证验证码");
    return true;
  };

  const telegramLoginMutation = trpc.telegram.login.useMutation({
    onSuccess: (data) => {
      if (startTwoFactorFromTelegram(data)) return;
      if (mobileAuth.isNative) {
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      if (error.message === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) mobileAuth.clear();
      toast.error(authErrorMessage(error.message, "Telegram 登录失败"));
    },
  });

  /*
    /login?tg=CODE 是机器人「网页登录」发的一次性链接。打开就自动登录是登录 CSRF：
    别人把**他自己**的链接发给你，你点开就在不知情时登进了他的账户，之后填的东西都进了他那边。
    所以先只读地查出这个码对应哪个账户，弹框让用户确认，点「继续登录」才真正消费登录码。
  */
  const telegramLinkCode = getTelegramWebAppInitData()
    ? ""
    : String(new URLSearchParams(search).get("tg") || "").trim();
  const telegramLinkActive = telegramLinkCode.length >= 8 && telegramLinkCode.length <= 64 && telegramLoginCode !== telegramLinkCode;
  const telegramLoginPreviewQuery = trpc.telegram.previewLogin.useQuery({ code: telegramLinkCode }, {
    enabled: telegramLinkActive && hasMobilePanelUrl,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  /*
    点了「继续登录」之后链接已经从地址栏清掉，预览随之失效；把确认时看到的账户留下来，
    弹窗保持打开并显示加载中，直到登录请求有结果 —— 否则弹窗一闪就没了，慢网下像是没反应。
  */
  const [telegramLinkConfirming, setTelegramLinkConfirming] = useState<typeof telegramLoginPreviewQuery.data | null>(null);
  const telegramLoginPreview = telegramLinkActive ? telegramLoginPreviewQuery.data : telegramLinkConfirming ?? undefined;
  const showTelegramLinkConfirm = (telegramLinkActive && hasMobilePanelUrl && !telegramLoginPreviewQuery.error) || !!telegramLinkConfirming;
  const telegramLinkLoginPending = !!telegramLinkConfirming;

  useEffect(() => {
    const error = telegramLoginPreviewQuery.error;
    if (!error || !telegramLinkActive) return;
    setTelegramLoginCode(telegramLinkCode);
    clearTelegramLinkFromUrl();
    toast.error(authErrorMessage(error.message, "Telegram 登录码无效或已过期"));
  }, [telegramLinkActive, telegramLinkCode, telegramLoginPreviewQuery.error]);

  const confirmTelegramLinkLogin = () => {
    if (!telegramLinkActive || !telegramLoginPreview || telegramLoginMutation.isPending) return;
    const code = telegramLinkCode;
    setTelegramLinkConfirming(telegramLoginPreview);
    setTelegramLoginCode(code);
    clearTelegramLinkFromUrl();
    telegramLoginMutation.mutate({ code, mobile: mobileAuth.isNative }, {
      onSettled: () => setTelegramLinkConfirming(null),
    });
  };

  const cancelTelegramLinkLogin = () => {
    if (telegramLinkLoginPending) return;
    setTelegramLoginCode(telegramLinkCode);
    clearTelegramLinkFromUrl();
  };

  const telegramWebAppLoginMutation = trpc.telegram.loginWithWebApp.useMutation({
    onSuccess: (data) => {
      if (startTwoFactorFromTelegram(data)) return;
      if (mobileAuth.isNative) {
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error, variables) => {
      if (error.message === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) mobileAuth.clear();
      const msg = error.message || "";
      if (msg === "TELEGRAM_NOT_BOUND") {
        toast.info("当前 Telegram 未绑定面板账号，请先使用账号密码登录并在面板完成绑定");
        return;
      }
      if (msg === "TELEGRAM_WEBAPP_REPLAYED") {
        toast.info("自动登录请求已失效，请返回机器人重新打开 WebApp");
        return;
      }
      if (msg === "TELEGRAM_WEBAPP_CHALLENGE_INVALID") {
        const initData = String((variables as any)?.initData || "").trim();
        const hasChallenge = !!String((variables as any)?.challenge || "").trim();
        if (initData && hasChallenge && !telegramWebAppChallengeRetriedRef.current) {
          telegramWebAppChallengeRetriedRef.current = true;
          telegramWebAppLoginRetryMutateRef.current({
            initData,
            mobile: !!(variables as any)?.mobile,
          });
          return;
        }
        toast.info("登录入口已失效，请返回机器人重新点击“打开面板”");
        return;
      }
      if (msg === "TELEGRAM_WEBAPP_VERIFY_FAILED") {
        toast.error("Telegram 自动登录校验失败，请在机器人中重新打开 WebApp");
        return;
      }
      if (msg === "TELEGRAM_LOGIN_DISABLED") {
        toast.error("Telegram 登录未启用，请改用账号密码登录");
        return;
      }
      toast.error(authErrorMessage(msg, "Telegram 自动登录失败，请使用账号密码登录。"));
    },
  });

  useEffect(() => {
    telegramWebAppLoginRetryMutateRef.current = telegramWebAppLoginMutation.mutate;
  }, [telegramWebAppLoginMutation.mutate]);

  const mobileTelegramStatusMutation = trpc.telegram.mobileLoginStatus.useMutation({
    onSuccess: (data) => {
      if (data.status !== "success") return;
      if (startTwoFactorFromTelegram(data)) {
        setMobileTelegramLogin(null);
        return;
      }
      mobileAuth.setToken(data.mobileToken);
      setMobileTelegramLogin(null);
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      setMobileTelegramLogin(null);
      if (error.message === ACCOUNT_DISABLED_ERR_MSG) mobileAuth.clear();
      toast.error(authErrorMessage(error.message, "Telegram 登录失败"));
    },
    onSettled: () => {
      mobileTelegramStatusPendingRef.current = false;
    },
  });

  const verifyTwoFactorLoginMutation = trpc.auth.verifyTwoFactorLogin.useMutation({
    onSuccess: (data) => {
      if (mobileAuth.isNative) {
        // Telegram 登录进来的双重验证没有账号密码，别用空值覆盖掉 App 里记住的用户名。
        if (password) mobileAuth.setUsername(username);
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      if (error.message === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) mobileAuth.clear();
      toast.error(authErrorMessage(error.message, "双重验证失败"));
    },
  });
  const mobileTelegramStatusPendingRef = useRef(false);
  const mobileTelegramStatusMutateRef = useRef(mobileTelegramStatusMutation.mutate);

  useEffect(() => {
    mobileTelegramStatusPendingRef.current = mobileTelegramStatusMutation.isPending;
  }, [mobileTelegramStatusMutation.isPending]);

  useEffect(() => {
    mobileTelegramStatusMutateRef.current = mobileTelegramStatusMutation.mutate;
  }, [mobileTelegramStatusMutation.mutate]);

  const startMobileTelegramLoginMutation = trpc.telegram.startMobileLogin.useMutation({
    onSuccess: async (data) => {
      const openedAt = Date.now();
      setMobileTelegramLogin({
        code: data.code,
        pollToken: data.pollToken,
        telegramUrl: data.telegramUrl,
        expiresAt: openedAt + data.expiresInSeconds * 1000,
      });
      if (mobileAuth.isNative) {
        window.location.href = data.telegramUrl;
      } else {
        window.open(data.telegramUrl, "_blank", "noopener,noreferrer");
      }
      toast.success("已打开 Telegram");
    },
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      toast.error(authErrorMessage(msg, "无法发起 Telegram 登录"));
    },
  });

  // 注册 mutation
  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "注册成功");
      setMode("login");
      setConfirmPassword("");
      setName("");
      setCaptchaAnswer("");
      setCaptchaChallenge(null);
    },
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      toast.error(authErrorMessage(msg, "注册失败"));
      setCaptchaAnswer("");
      setCaptchaResetKey((value) => value + 1);
    },
  });

  const sendEmailCodeMutation = trpc.auth.sendEmailCode.useMutation({
    onSuccess: () => toast.success("验证码已发送，5 分钟内有效"),
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      toast.error(authErrorMessage(msg, "发送验证码失败"));
    },
  });

  useEffect(() => {
    if (telegramWebAppAutoLoginTriedRef.current || telegramWebAppLoginMutation.isPending) return;
    if (!isTelegramWebAppRequested()) return;

    const challenge = getTelegramWebAppChallenge();
    let cancelled = false;
    let intervalId: number | null = null;
    let timeoutId: number | null = null;

    const tryAutoLogin = () => {
      if (cancelled || telegramWebAppAutoLoginTriedRef.current || telegramWebAppLoginMutation.isPending) return true;
      const initData = getTelegramWebAppInitData();
      if (!initData) return false;
      telegramWebAppAutoLoginTriedRef.current = true;
      const webApp = getTelegramWebAppBridge();
      try {
        webApp?.ready?.();
        webApp?.expand?.();
      } catch {
        // no-op
      }
      telegramWebAppChallengeRetriedRef.current = false;
      telegramWebAppLoginMutation.mutate({
        initData,
        ...(challenge ? { challenge } : {}),
        mobile: mobileAuth.isNative,
      });
      return true;
    };

    if (!tryAutoLogin()) {
      intervalId = window.setInterval(() => {
        if (!tryAutoLogin()) return;
        if (intervalId) window.clearInterval(intervalId);
        if (timeoutId) window.clearTimeout(timeoutId);
      }, TELEGRAM_WEBAPP_INIT_POLL_MS);
      timeoutId = window.setTimeout(() => {
        if (cancelled || telegramWebAppAutoLoginTriedRef.current) return;
        if (intervalId) window.clearInterval(intervalId);
        toast.info("未获取到 Telegram 登录凭证，请返回机器人重新点击“打开面板”");
      }, TELEGRAM_WEBAPP_INIT_WAIT_MS);
    }

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [telegramWebAppLoginMutation.isPending, telegramWebAppLoginMutation.mutate]);

  useEffect(() => {
    if (!mobileTelegramLogin) return;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      if (Date.now() >= mobileTelegramLogin.expiresAt) {
        setMobileTelegramLogin(null);
        toast.error("Telegram 登录已超时，请重新尝试");
        return;
      }
      if (!mobileTelegramStatusPendingRef.current) {
        mobileTelegramStatusPendingRef.current = true;
        mobileTelegramStatusMutateRef.current({
          code: mobileTelegramLogin.code,
          pollToken: mobileTelegramLogin.pollToken,
        });
      }
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    const handleFocus = () => poll();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [mobileTelegramLogin?.code, mobileTelegramLogin?.pollToken, mobileTelegramLogin?.expiresAt]);

  const handleVerifyTwoFactorLogin = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!twoFactorChallenge) return;
    if (!twoFactorCode.trim()) {
      toast.error("请输入双重验证验证码");
      return;
    }
    verifyTwoFactorLoginMutation.mutate({
      challengeId: twoFactorChallenge.challengeId,
      code: twoFactorCode.trim(),
      mobile: mobileAuth.isNative,
    });
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (mobileAuth.isNative) {
      if (!mobileAuth.hasPanelUrl()) {
        toast.error("请先点击右上角设置按钮添加服务器地址");
        return;
      }
    }
    if (!username.trim() || !password.trim()) {
      toast.error("请输入用户名和密码");
      return;
    }
    if (loginCaptchaRequired) {
      if (!captchaAnswer.trim()) {
        toast.error("请先完成人机验证");
        return;
      }
      loginMutation.mutate({
        username: username.trim(),
        password,
        capToken: captchaAnswer.trim(),
        mobile: mobileAuth.isNative,
      });
    } else {
      loginMutation.mutate({
        username: username.trim(),
        password,
        mobile: mobileAuth.isNative,
      });
    }
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (mobileAuth.isNative && !mobileAuth.hasPanelUrl()) {
      toast.error("请先点击右上角设置按钮添加服务器地址");
      return;
    }
    if (!registrationEnabled) {
      toast.info(REGISTRATION_CLOSED_MESSAGE);
      setMode("login");
      return;
    }
    if (!username.trim() || !password.trim()) {
      toast.error("请输入用户名和密码");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }
    if (password.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    if (!isEmail(username)) {
      toast.error("注册用户名必须是邮箱格式");
      return;
    }
    if (emailConfig?.verifyRegistration) {
      if (!email.trim()) {
        toast.error("请填写邮箱地址");
        return;
      }
      if (!emailCode.trim()) {
        toast.error("请输入邮箱验证码");
        return;
      }
    }
    if (!captchaAnswer.trim()) {
      toast.error("请先完成人机验证");
      return;
    }
    if (name.trim().length > DISPLAY_NAME_MAX_LENGTH) {
      toast.error(`显示名称最多 ${DISPLAY_NAME_MAX_LENGTH} 个字符`);
      return;
    }
    registerMutation.mutate({
      username: username.trim(),
      password,
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      emailCode: emailCode.trim() || undefined,
      capToken: captchaAnswer.trim(),
    });
  };

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const savePanelUrl = () => {
    const normalized = mobileAuth.normalizePanelUrl(panelUrlDraft);
    if (!mobileAuth.isValidPanelUrl(normalized)) {
      toast.error("请输入完整面板地址，例如 https://panel.example.com");
      return;
    }
    mobileAuth.setPanelUrl(normalized);
    setPanelUrlDraft(normalized);
    setShowPanelSettings(false);
    setCaptchaAnswer("");
    void utils.invalidate();
    toast.success("面板地址已保存");
  };

  const handleMobileTelegramLogin = () => {
    if (mobileAuth.isNative && !mobileAuth.hasPanelUrl()) {
      toast.error("请先点击右上角设置按钮添加服务器地址");
      setShowPanelSettings(true);
      return;
    }
    startMobileTelegramLoginMutation.mutate();
  };

  const cancelTwoFactorLogin = () => {
    setTwoFactorChallenge(null);
    setTwoFactorCode("");
    setPassword("");
  };

  const isPending = loginMutation.isPending || registerMutation.isPending || telegramWebAppLoginMutation.isPending || telegramLoginMutation.isPending;
  const isTwoFactorPending = verifyTwoFactorLoginMutation.isPending;
  const isTelegramPending = telegramLoginMutation.isPending || telegramWebAppLoginMutation.isPending;
  const isMobileTelegramWaiting = startMobileTelegramLoginMutation.isPending || !!mobileTelegramLogin;
  const showTelegramLoginSlot = mode === "login" && hasMobilePanelUrl && !getTelegramWebAppInitData();
  const captchaCooldownSeconds = Math.max(0, Math.ceil((captchaCooldownUntil - Date.now()) / 1000));
  const activeCaptchaImage = captchaChallenge?.purpose === captchaPurpose ? captchaChallenge.imageDataUrl : undefined;
  const captchaRefreshTitle = captchaCooldownSeconds > 0
    ? `${captchaCooldownSeconds} 秒后可刷新`
    : "刷新验证码";

  return (
    <div className="mobile-login-screen auth-shell relative min-h-screen overflow-hidden">
      {/*
        参考站的登录页是一张白纸上一列窄表单：左上角一枚品牌链接回首页，没有背景装饰、
        没有左侧介绍栏、没有卡片。原来的流动渐变背景和左栏都去掉了（壁纸背景的例外见 index.css）。
      */}
      {!mobileAuth.isNative && (
        <Link href="/" className="auth-home-link" aria-label="返回首页">
          <img src={logoSrc} alt="" />
          <span>{siteTitle}</span>
        </Link>
      )}
      <div
        className="absolute z-20 flex items-center gap-2"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 16px)",
          right: "calc(env(safe-area-inset-right, 0px) + 16px)",
        }}
      >
        {mobileAuth.isNative && (
          <button
            onClick={() => {
              setPanelUrlDraft(mobileAuth.getPanelUrl());
              setShowPanelSettings(true);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--fx-l1-surface)] text-foreground shadow-[var(--fx-elevation-control)] transition-colors hover:bg-[var(--fx-hover)] focus:outline-none focus-visible:shadow-[var(--fx-focus-ring)]"
            aria-label="设置面板地址"
            title="设置面板地址"
          >
            <SettingsIcon className={mobileAuth.hasPanelUrl() ? "h-5 w-5 text-muted-foreground" : "h-5 w-5 text-[var(--fx-warn-text)]"} />
          </button>
        )}
        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--fx-l1-surface)] text-foreground shadow-[var(--fx-elevation-control)] transition-colors hover:bg-[var(--fx-hover)] focus:outline-none focus-visible:shadow-[var(--fx-focus-ring)]"
          aria-label="切换主题"
          title={resolvedTheme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
        >
          {resolvedTheme === "dark" ? (
            <Sun className="h-5 w-5 text-muted-foreground" />
          ) : (
            <Moon className="h-5 w-5 text-muted-foreground" />
          )}
        </button>
      </div>

      <div className="auth-route-enter relative z-10 grid min-h-screen">

        <main className="auth-route-enter-panel flex min-h-screen items-center justify-center px-4 py-20 sm:px-6 lg:px-10">
          <Card disableEnterAnimation className="auth-card-surface w-full max-w-[416px] rounded-[var(--fx-radius-surface)] px-6 py-7 sm:px-8 sm:py-8">
            <CardHeader className="px-0 pb-6 text-left">
              {mobileAuth.isNative && (
                <div className="mb-5 flex items-center gap-3">
                  <img src={logoSrc} alt={siteTitle} className="h-10 w-10 object-contain" />
                  <span className="text-lg font-semibold tracking-tight">{siteTitle}</span>
                </div>
              )}
              <h1 className="text-2xl font-bold tracking-tight">
                {mode === "login" ? "欢迎回来" : "创建账号"}
              </h1>
              <CardDescription className="mt-1 text-sm text-muted-foreground">
                {isTelegramPending ? "正在通过 Telegram 登录" : mode === "login" ? `登录 ${siteTitle}，继续你的工作` : `使用邮箱创建 ${siteTitle} 账号`}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
          <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={mode}
            className="auth-mode-panel"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
          {isTelegramPending ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span>{telegramWebAppLoginMutation.isPending ? "正在验证 Telegram 登录..." : "正在验证一次性登录码..."}</span>
            </div>
          ) : mode === "login" ? (
            <form onSubmit={handleLogin} className="space-y-4">
              {mobileAuth.isNative && !hasMobilePanelUrl && (
                <button
                  type="button"
                  onClick={() => setShowPanelSettings(true)}
                  className="w-full rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-left text-sm text-[var(--fx-warn-text)] transition-colors hover:bg-[var(--fx-warn-soft)]"
                >
                  未添加服务器地址，请点击右上角设置按钮添加
                </button>
              )}
              {showInsecurePanelWarning && (
                <p className="rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]">
                  当前面板地址使用 http://，密码和登录令牌会以明文传输，建议改用 https:// 地址。
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="username">用户名或邮箱</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="请输入用户名或邮箱"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus={!mobileAuth.isNative || hasMobilePanelUrl}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <PasswordInput
                  id="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={isPending}
                />
              </div>
              {loginCaptchaRequired && (
                <ImageCaptchaField
                  id="captcha"
                  value={captchaAnswer}
                  imageDataUrl={activeCaptchaImage}
                  loading={createCaptchaMutation.isPending}
                  refreshDisabled={createCaptchaMutation.isPending || captchaCooldownSeconds > 0}
                  refreshTitle={captchaRefreshTitle}
                  disabled={isPending}
                  onChange={setCaptchaAnswer}
                  resetKey={captchaResetKey}
                  onRefresh={() => requestCaptcha("login", false)}
                />
              )}

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={isPending}
              >
                {loginMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    登录中...
                  </>
                ) : (
                  <>
                    <LogIn className="mr-2 h-4 w-4" />
                    登录
                  </>
                )}
              </Button>

              {showTelegramLoginSlot && (
                <div className="auth-telegram-slot space-y-3">
                  <div className="relative flex items-center justify-center">
                    <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                    <span className="auth-divider-label relative px-3 text-xs text-muted-foreground">或</span>
                  </div>
                  <div className="min-h-[132px] rounded-lg border border-border/50 bg-muted/20 p-3 transition-colors">
                    <div className="mb-3 flex items-center justify-center gap-2 text-sm font-medium">
                      <Send className="h-4 w-4 text-primary" />
                      Telegram 快捷登录
                    </div>
                    <div className="space-y-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full gap-2"
                        onClick={handleMobileTelegramLogin}
                        disabled={!hasMobilePanelUrl || isMobileTelegramWaiting}
                      >
                        {isMobileTelegramWaiting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            等待 Telegram 确认
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4" />
                            打开 Telegram 登录
                          </>
                        )}
                      </Button>
                      {mobileTelegramLogin ? (
                        <div className="space-y-2">
                          <p className="text-center text-xs leading-5 text-muted-foreground">
                            请在 Telegram 中确认登录。
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full text-xs"
                            onClick={() => setMobileTelegramLogin(null)}
                          >
                            取消本次登录
                          </Button>
                        </div>
                      ) : (
                        <p className="text-center text-xs leading-5 text-muted-foreground">
                          已绑定账户可用，点击后再连接后端校验。
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    if (!registrationEnabled) {
                      toast.info(REGISTRATION_CLOSED_MESSAGE);
                      return;
                    }
                    setMode("register");
                    setCaptchaAnswer("");
                  }}
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  没有账号？点击注册
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              {mobileAuth.isNative && !hasMobilePanelUrl && (
                <button
                  type="button"
                  onClick={() => setShowPanelSettings(true)}
                  className="w-full rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-left text-sm text-[var(--fx-warn-text)] transition-colors hover:bg-[var(--fx-warn-soft)]"
                >
                  未添加服务器地址，请点击右上角设置按钮添加
                </button>
              )}
              {showInsecurePanelWarning && (
                <p className="rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]">
                  当前面板地址使用 http://，注册时填写的密码和邮箱验证码会以明文传输，建议改用 https:// 地址。
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="reg-username">用户名</Label>
                <Input
                  id="reg-username"
                  type="text"
                  placeholder="请输入邮箱作为用户名"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (!email || email === username) setEmail(e.target.value);
                  }}
                  autoComplete="username"
                  autoFocus
                  disabled={isPending || !hasMobilePanelUrl}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-name">昵称（选填）</Label>
                <Input
                  id="reg-name"
                  type="text"
                  placeholder="显示名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={DISPLAY_NAME_MAX_LENGTH}
                  disabled={isPending}
                />
              </div>
              {emailConfig?.verifyRegistration && (
                <div className="space-y-2">
                  <Label htmlFor="reg-email">邮箱</Label>
                  <div className="flex gap-2">
                    <Input
                      id="reg-email"
                      type="email"
                      placeholder="用于接收验证码"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={isPending}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!hasMobilePanelUrl || !email.trim() || sendEmailCodeMutation.isPending}
                      onClick={() => sendEmailCodeMutation.mutate({ email: email.trim() })}
                    >
                      {sendEmailCodeMutation.isPending ? "发送中" : "发送验证码"}
                    </Button>
                  </div>
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="请输入邮箱验证码"
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="reg-password">密码</Label>
                <PasswordInput
                  id="reg-password"
                  placeholder="至少6个字符"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-confirm">确认密码</Label>
                <PasswordInput
                  id="reg-confirm"
                  placeholder="再次输入密码"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isPending}
                />
              </div>

              <ImageCaptchaField
                id="reg-captcha"
                value={captchaAnswer}
                imageDataUrl={activeCaptchaImage}
                loading={createCaptchaMutation.isPending}
                refreshDisabled={createCaptchaMutation.isPending || captchaCooldownSeconds > 0}
                refreshTitle={captchaRefreshTitle}
                disabled={isPending || !hasMobilePanelUrl}
                onChange={setCaptchaAnswer}
                resetKey={captchaResetKey}
                onRefresh={() => requestCaptcha("register", false)}
              />

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={isPending}
              >
                {registerMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    注册中...
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 h-4 w-4" />
                    注册
                  </>
                )}
              </Button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => { setMode("login"); setCaptchaAnswer(""); }}
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  已有账号？返回登录
                </button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                注册后需要管理员授权才能使用转发功能
              </p>
            </form>
          )}
          </m.div>
          </AnimatePresence>
            </CardContent>
          </Card>
        </main>
      </div>

      {mobileAuth.isNative && (
        <Dialog open={showPanelSettings} onOpenChange={setShowPanelSettings}>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-sm">
            <DialogTitle>面板地址</DialogTitle>
            <DialogDescription>APP 将连接这个面板地址。</DialogDescription>
            <div className="space-y-2">
              <Label htmlFor="mobile-panel-url">服务器地址</Label>
              <Input
                id="mobile-panel-url"
                type="url"
                placeholder="https://panel.example.com"
                value={panelUrlDraft}
                onChange={(e) => setPanelUrlDraft(e.target.value)}
                autoComplete="url"
                autoFocus
              />
              {mobileAuth.isInsecurePanelUrl(panelUrlDraft) && (
                <p className="text-xs text-[var(--fx-warn-text)]">
                  http:// 地址不加密，密码和登录令牌会以明文传输，建议使用 https://。
                </p>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button className="w-full sm:w-auto" variant="outline" onClick={() => setShowPanelSettings(false)}>
                取消
              </Button>
              <Button className="w-full sm:w-auto" onClick={savePanelUrl}>
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog
        open={showTelegramLinkConfirm}
        onOpenChange={(open) => {
          if (!open) cancelTelegramLinkLogin();
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-sm">
          <DialogTitle>确认 Telegram 登录</DialogTitle>
          {telegramLoginPreview ? (
            <>
              <DialogDescription>
                {telegramLoginPreview.telegramUsername
                  ? `以 Telegram 用户 @${telegramLoginPreview.telegramUsername} / 面板账户 ${telegramLoginPreview.username} 登录？`
                  : `以面板账户 ${telegramLoginPreview.username} 登录？`}
              </DialogDescription>
              <div className="space-y-1 rounded-lg border border-border/50 bg-muted/20 p-3 text-sm">
                {telegramLoginPreview.telegramUsername && (
                  <p className="text-muted-foreground">Telegram：@{telegramLoginPreview.telegramUsername}</p>
                )}
                <p className="font-medium">面板账户：{telegramLoginPreview.username}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                如果这个链接不是你刚在机器人里点「网页登录」获取的，请点取消：它可能会让你登录到别人的账户。
              </p>
            </>
          ) : (
            <>
              <DialogDescription>正在读取登录链接...</DialogDescription>
              <div className="flex justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            </>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={cancelTelegramLinkLogin} disabled={telegramLinkLoginPending}>
              取消
            </Button>
            <Button
              type="button"
              className="w-full sm:w-auto"
              onClick={confirmTelegramLinkLogin}
              disabled={!telegramLoginPreview || telegramLoginMutation.isPending || telegramLinkLoginPending}
            >
              {telegramLinkLoginPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
              {telegramLinkLoginPending ? "登录中..." : "继续登录"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!twoFactorChallenge}
        onOpenChange={(open) => {
          if (!open && !isTwoFactorPending) cancelTwoFactorLogin();
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-sm">
          <DialogTitle>双重验证</DialogTitle>
          <DialogDescription>
            请输入 2FA 软件中当前显示的动态验证码。
          </DialogDescription>
          <form onSubmit={handleVerifyTwoFactorLogin} className="space-y-4">
            <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-sm">
              <p className="font-medium">{twoFactorChallenge?.username}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="two-factor-code">动态验证码</Label>
              <Input
                id="two-factor-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="请输入 6 位验证码"
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                autoComplete="one-time-code"
                autoFocus
                disabled={isTwoFactorPending}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={cancelTwoFactorLogin} disabled={isTwoFactorPending}>
                返回
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={isTwoFactorPending || twoFactorCode.length < 6}>
                {isTwoFactorPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    验证中...
                  </>
                ) : (
                  <>
                    <LogIn className="mr-2 h-4 w-4" />
                    验证并登录
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
