import { useState } from "react";
import { KeyRound, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useOpsFeatures } from "../useOpsFeatures";
import { getPasskeyAssertion, passkeyAvailability, passkeyErrorMessage } from "./webauthnClient";

/** 和 Login.tsx 的 rememberLoginWelcome 同一个键：进了首页弹「欢迎回来，xx」。 */
const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";

/**
 * 登录页上运维功能多出来的两样：维护中的提示，和「用通行密钥登录」（#12 / #14）。
 *
 * 通行密钥按钮只在能用的时候出现：浏览器支持、https（或 localhost）、不在 App 里。
 * 用的是「可发现凭据」，不用先填用户名 —— 浏览器自己列出这个域名下存过的通行密钥。
 */
export default function OpsLoginExtras({ disabled }: { disabled?: boolean }) {
  const opsFeatures = useOpsFeatures();
  const availability = passkeyAvailability();
  const maintenanceQuery = trpc.ops.maintenance.get.useQuery(undefined, { enabled: opsFeatures, staleTime: 30_000 });
  const optionsMutation = trpc.ops.passkeys.loginOptions.useMutation();
  const finishMutation = trpc.ops.passkeys.finishLogin.useMutation();
  const utils = trpc.useUtils();
  const [pending, setPending] = useState(false);

  if (!opsFeatures) return null;
  const maintenance = maintenanceQuery.data;

  const handlePasskeyLogin = async () => {
    setPending(true);
    try {
      const options = await optionsMutation.mutateAsync({ origin: window.location.origin });
      const credential = await getPasskeyAssertion(options.publicKey);
      const user = await finishMutation.mutateAsync({ challengeId: options.challengeId, credential });
      try {
        window.sessionStorage.setItem(LOGIN_WELCOME_TOAST_KEY, String(user?.name || user?.username || "用户").trim() || "用户");
      } catch {
        // 无痕模式写不进去也不影响登录
      }
      await utils.auth.me.invalidate();
      window.location.href = "/";
    } catch (error) {
      toast.error(passkeyErrorMessage(error, "通行密钥登录失败"));
      setPending(false);
    }
  };

  return (
    <>
      {maintenance?.enabled ? (
        <div role="status" className="flex items-start gap-2 rounded-lg bg-[var(--fx-warn-soft)] p-3 text-sm text-[var(--fx-warn-text)]">
          <Wrench className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {maintenance.baseMessage}
            {maintenance.message ? `：${maintenance.message}` : ""}
            <span className="opacity-80">（管理员仍可登录）</span>
          </span>
        </div>
      ) : null}
      {availability.usable ? (
        <Button type="button" variant="outline" className="w-full gap-2" size="lg" onClick={handlePasskeyLogin} disabled={disabled || pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          {pending ? "等待设备确认…" : "用通行密钥登录"}
        </Button>
      ) : null}
    </>
  );
}
