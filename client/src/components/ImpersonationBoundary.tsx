import { getFormatLocale } from "@/i18n";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Eye, Loader2, LogOut } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { userImpersonation } from "@/lib/userImpersonation";

/*
  管理员「进入用户后台」那个标签页的外框（lib/userImpersonation.ts）。

  · 进行中：页面最上面常驻一条横幅「正在以 某某 的身份查看」+「退出」。横幅是普通文档流里的一条，
    不是浮层 —— 页面整体往下挪，不会盖住任何东西，也不用去改各套主题的吸顶头部。
  · 已结束（到期、点了退出、管理员那边退出了登录、目标被停用）：整页换成「代入已结束」，
    不渲染任何业务页面，也不会跳到登录页 —— 那个标签页里不该出现管理员自己的登录。
  · 普通标签页：什么都不加。
*/

function ImpersonationBanner({ expiresAt }: { expiresAt: number }) {
  const { data: me } = trpc.auth.me.useQuery(undefined, { retry: false, refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const exit = trpc.auth.logout.useMutation({ onSettled: () => userImpersonation.finish() });
  const name = me ? (me.username || me.name || `#${me.id}`) : "";
  const admin = me?.impersonation?.adminName;
  const until = new Date(expiresAt).toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div
      role="status"
      className="relative z-40 flex flex-wrap items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--fx-warn)_35%,transparent)] bg-[var(--fx-warn-soft)] px-4 py-2 text-sm text-[var(--fx-warn-text)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {name ? <>正在以 <strong className="font-semibold">{name}</strong> 的身份查看</> : "正在确认用户身份…"}
          <span className="ml-2 text-meta opacity-80">
            {admin ? `管理员 ${admin} · ` : ""}{until} 自动结束 · 不能改账号安全设置和付款
          </span>
        </span>
      </span>
      <Button size="sm" variant="outline" disabled={exit.isPending} onClick={() => exit.mutate()}>
        {exit.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LogOut className="mr-1 h-3.5 w-3.5" />}
        退出
      </Button>
    </div>
  );
}

function ImpersonationEnded() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <h1 className="text-xl font-semibold text-foreground">已退出用户后台</h1>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground">
        这次代入已经结束（到期、已退出，或管理员登录已失效）。管理员原来的窗口不受影响；要继续查看，请回到用户管理重新进入。
      </p>
      <Button variant="outline" onClick={() => window.close()}>关闭这个窗口</Button>
    </main>
  );
}

export function ImpersonationBoundary({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(userImpersonation.subscribe, userImpersonation.getState, userImpersonation.getState);
  // 到点自己结束：不等下一个请求被服务端拒掉才发现。
  useEffect(() => {
    if (state.mode !== "active") return;
    const timer = window.setTimeout(() => userImpersonation.finish(), Math.max(0, state.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state]);
  if (state.mode === "ended") return <ImpersonationEnded />;
  if (state.mode === "normal") return <>{children}</>;
  return (
    <>
      <ImpersonationBanner expiresAt={state.expiresAt} />
      {children}
    </>
  );
}
