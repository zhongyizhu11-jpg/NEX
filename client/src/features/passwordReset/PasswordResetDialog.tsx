import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authErrorMessage } from "@/lib/authErrorMessage";
import {
  PASSWORD_RESET_MAX_LENGTH,
  PASSWORD_RESET_MIN_LENGTH,
  PASSWORD_RESET_TTL_MINUTES,
} from "@shared/passwordReset";
import { takePasswordResetToken } from "./passwordResetLink";

/*
  登录页的「忘记密码」（上游 v2.3.299）。两段：

  1. 申请：填用户名或邮箱（开着人机验证时要先过一遍），服务端把一次性链接发到账号已验证的邮箱、
     已绑定的 Telegram / Discord。回来的永远是同一句话 —— 页面不知道、也不显示账号存不存在。
  2. 设新密码：从邮件 / 消息里点开 /login#password-reset=…，这里认出令牌、立刻从地址栏删掉，
     弹出设新密码。成功后这个账号所有登录都失效，用新密码重新登录；双重验证不变。

  人机验证组件在 Login.tsx 里（按需加载的 Cap），由 renderCaptcha 传进来，不在这里再写一份。
*/

export type PasswordResetCaptchaProps = { resetKey: number; disabled: boolean; onToken: (token: string) => void };

type Stage = "request" | "requested" | "reset" | "done";

export default function PasswordResetDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultIdentifier: string;
  renderCaptcha: (captcha: PasswordResetCaptchaProps) => ReactNode;
  /** 密码重置成功：登录页清掉还填着的旧密码。 */
  onPasswordReset: () => void;
}) {
  const { open, onOpenChange, defaultIdentifier, renderCaptcha, onPasswordReset } = props;
  const [stage, setStage] = useState<Stage>("request");
  const [token, setToken] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [capToken, setCapToken] = useState("");
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [requestedMessage, setRequestedMessage] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const optionsQuery = trpc.auth.passwordResetOptions.useQuery(undefined, {
    enabled: open && stage === "request",
    retry: false,
    staleTime: 30_000,
  });
  const requestMutation = trpc.auth.requestPasswordReset.useMutation({
    onSuccess: (data) => {
      setRequestedMessage(data.message);
      setStage("requested");
      setError("");
    },
    onError: (failure) => {
      setError(authErrorMessage(failure.message || "申请失败，请稍后重试"));
      // 验证令牌用一次就作废：失败了得重新验证。
      setCapToken("");
      setCaptchaResetKey((value) => value + 1);
    },
  });
  const resetMutation = trpc.auth.resetPasswordWithToken.useMutation({
    onSuccess: () => {
      setStage("done");
      setToken(null);
      setNewPassword("");
      setConfirmPassword("");
      setError("");
      onPasswordReset();
    },
    onError: (failure) => setError(failure.message || "重置失败，请稍后重试"),
  });

  // 从重置链接打开登录页：拿走地址栏里的令牌，直接进入「设置新密码」。
  useEffect(() => {
    const receive = () => {
      const value = takePasswordResetToken(window.location, window.history);
      if (value === null) return;
      setToken(value);
      setStage("reset");
      setError(value ? "" : "重置链接不完整，请从邮件或消息里重新打开，或重新申请");
      onOpenChange(true);
    };
    receive();
    window.addEventListener("hashchange", receive);
    return () => window.removeEventListener("hashchange", receive);
  }, [onOpenChange]);

  // 每次打开「申请」都从头来；关掉时清掉填过的密码。
  useEffect(() => {
    if (open) {
      if (stage === "request") setIdentifier((current) => current || defaultIdentifier);
      return;
    }
    setNewPassword("");
    setConfirmPassword("");
    setCapToken("");
    setError("");
    if (stage !== "reset") setStage("request");
  }, [open, defaultIdentifier, stage]);

  const handleCaptchaToken = useCallback((value: string) => setCapToken(value), []);
  const pending = requestMutation.isPending || resetMutation.isPending;
  const options = optionsQuery.data;
  const captchaRequired = options?.captchaEnabled !== false;
  const canRequest = !!options?.enabled && options.available;

  const submitRequest = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !canRequest) return;
    if (!identifier.trim()) {
      setError("请输入用户名或邮箱");
      return;
    }
    if (captchaRequired && !capToken) {
      setError("请先完成人机验证");
      return;
    }
    setError("");
    requestMutation.mutate({ identifier: identifier.trim(), capToken: captchaRequired ? capToken : undefined });
  };

  const submitReset = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !token) return;
    if (newPassword.length < PASSWORD_RESET_MIN_LENGTH) {
      setError(`新密码至少${PASSWORD_RESET_MIN_LENGTH}个字符`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setError("");
    resetMutation.mutate({ token, newPassword });
  };

  const title = stage === "done" ? "密码已重置" : stage === "reset" ? "设置新密码" : "找回密码";
  const description = stage === "done"
    ? "原来所有设备上的登录都已失效，请用新密码重新登录。双重验证和通行密钥保持不变。"
    : stage === "reset"
      ? `链接 ${PASSWORD_RESET_TTL_MINUTES} 分钟内有效，只能用一次。设置好以后，所有设备上的旧登录都会退出。`
      : "重置链接会发到账号已验证的邮箱，或已绑定的 Telegram / Discord。未配置找回方式时请联系管理员。";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {stage === "done" ? (
          <div className="space-y-4">
            <CheckCircle2 className="h-9 w-9 text-[var(--fx-healthy-text)]" aria-hidden="true" />
            <DialogFooter>
              <Button className="w-full" onClick={() => { setStage("request"); onOpenChange(false); }}>返回登录</Button>
            </DialogFooter>
          </div>
        ) : stage === "reset" ? (
          <form className="space-y-4" onSubmit={submitReset}>
            <div className="space-y-2">
              <Label htmlFor="reset-new-password">新密码</Label>
              <PasswordInput
                id="reset-new-password"
                autoComplete="new-password"
                placeholder={`至少 ${PASSWORD_RESET_MIN_LENGTH} 个字符`}
                maxLength={PASSWORD_RESET_MAX_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={pending || !token}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm-password">再输一遍</Label>
              <PasswordInput
                id="reset-confirm-password"
                autoComplete="new-password"
                maxLength={PASSWORD_RESET_MAX_LENGTH}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={pending || !token}
              />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button type="submit" className="w-full" disabled={pending || !token}>
                {resetMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在重置...</> : "确认重置密码"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={pending}
                onClick={() => { setToken(null); setStage("request"); setError(""); setNewPassword(""); setConfirmPassword(""); }}
              >
                重新申请链接
              </Button>
            </DialogFooter>
          </form>
        ) : stage === "requested" ? (
          <div className="space-y-4">
            <p role="status" className="text-sm leading-6">{requestedMessage}</p>
            <p className="text-meta leading-5 text-muted-foreground">邮件可能在垃圾箱里；Telegram / Discord 的消息在机器人私聊里。不要把重置链接转发给任何人。</p>
            <DialogFooter>
              <Button className="w-full" variant="outline" onClick={() => onOpenChange(false)}>返回登录</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submitRequest}>
            {optionsQuery.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取找回方式…</p>
            ) : optionsQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">暂时读不到找回方式，请稍后重试，或联系管理员。</p>
            ) : !options?.enabled ? (
              <p role="status" className="text-sm leading-6 text-muted-foreground">管理员没有开放自助找回密码，请联系管理员重置密码。</p>
            ) : !options.available ? (
              <p role="status" className="text-sm leading-6 text-muted-foreground">面板还没有配置能发送重置链接的方式（邮件、Telegram 或 Discord，以及面板公开访问地址），请联系管理员重置密码。</p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="reset-identifier">用户名或邮箱</Label>
                  <Input
                    id="reset-identifier"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={320}
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    disabled={pending}
                  />
                </div>
                {captchaRequired ? renderCaptcha({ resetKey: captchaResetKey, disabled: pending, onToken: handleCaptchaToken }) : null}
              </>
            )}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button type="submit" className="w-full" disabled={pending || !canRequest}>
                {requestMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />提交中...</> : "发送重置链接"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
