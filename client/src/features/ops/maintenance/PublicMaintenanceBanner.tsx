import { Wrench } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";

/**
 * 公开监控页顶部的维护提示（#14）：面板在维护，但线路照常 —— 来看状态的人最想知道的就是这句。
 */
export default function PublicMaintenanceBanner() {
  const stateQuery = trpc.ops.maintenance.get.useQuery(undefined, { refetchInterval: pollingInterval("slow") });
  const state = stateQuery.data;
  if (!state?.enabled) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]">
      <Wrench className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        面板正在维护{state.message ? `：${state.message}` : ""}。转发和线路不受影响。
      </span>
    </div>
  );
}
