import { Wrench } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { useOpsFeatures } from "../useOpsFeatures";

/**
 * 维护模式开着时页面顶上的一条（#14）。
 *
 * 管理员：提醒「普通用户现在进不来」，免得忘了关 —— 一句话加一个「去关闭」。
 * 普通用户：他们的接口都在报「面板维护中」，这条把原因和管理员写的说明摆在最上面。
 * 维护状态是公开接口，被挡住的用户也读得到；30 秒刷新一次，关掉后横幅自己消失。
 */
export default function OpsMaintenanceBanner({ className = "mb-4" }: { className?: string }) {
  const opsFeatures = useOpsFeatures();
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const stateQuery = trpc.ops.maintenance.get.useQuery(undefined, {
    enabled: opsFeatures && !!user,
    refetchInterval: pollingInterval("slow"),
  });
  const state = stateQuery.data;
  if (!opsFeatures || !user || !state?.enabled) return null;
  const isAdmin = user.role === "admin";

  return (
    <div role="status" className={`${className} flex items-center gap-2 rounded-lg bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]`}>
      <Wrench className="h-4 w-4 shrink-0" aria-hidden="true" />
      {/* span 不用 p：手机上 .workspace-main p 自带上下外边距，横幅会被撑高 */}
      <span className="min-w-0 flex-1">
        {isAdmin
          ? `维护模式开启中，普通用户暂时不能登录和操作${state.message ? `（${state.message}）` : ""}`
          : `${state.baseMessage}${state.message ? `：${state.message}` : ""}`}
      </span>
      {isAdmin ? (
        <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-[var(--fx-warn-text)]" onClick={() => setLocation("/settings?tab=advanced")}>
          去关闭
        </Button>
      ) : null}
    </div>
  );
}
