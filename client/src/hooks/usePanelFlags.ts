import { useEffect, useMemo, useRef } from "react";

import { normalizeForwardProtocolSettings } from "@shared/forwardTypes";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";

/*
  页面要用的几个开关（协议开关、面板公开地址、专属域名、Telegram / DDNS 是否就绪……）。

  以前各页为了这几项拉整份 system.getSettings —— 管理员那份里有证书、首页 HTML、各种配置，
  每进一次规则页、隧道页、主机页都要下载一遍。现在从 system.publicInfo 读：布局本来就要拉它，
  多数时候缓存里已经有了，进页面时顺手刷新一次。

  adminFlags 跟着登录身份走：登录页（未登录时）拉过的那份里是 null。管理员手里拿到的还是
  null，说明是登录前的旧结果，补拉一次。
*/
export function usePanelFlags(options: { enabled?: boolean } = {}) {
  const { user, loading: authLoading } = useAuth();
  const query = trpc.system.publicInfo.useQuery(undefined, {
    enabled: (options.enabled ?? true) && !authLoading,
    refetchOnWindowFocus: false,
  });
  const info = query.data;
  const isAdmin = user?.role === "admin";
  const staleForAdmin = isAdmin && info !== undefined && !info.adminFlags;
  const refetchedForRef = useRef<number | null>(null);
  useEffect(() => {
    if (!staleForAdmin || query.isFetching || refetchedForRef.current === user?.id) return;
    refetchedForRef.current = user?.id ?? null;
    void query.refetch();
  }, [query, staleForAdmin, user?.id]);
  const flags = useMemo(() => ({
    forwardProtocols: normalizeForwardProtocolSettings(info?.forwardProtocols),
    panelPublicUrl: info?.panelPublicUrl ?? "",
    ruleEntryDomainActive: !!info?.ruleEntryDomainActive,
    agentVersion: info?.agentVersion ?? "",
    telegramBotReady: !!info?.adminFlags?.telegramBotReady,
    ddnsEnabled: !!info?.adminFlags?.ddnsEnabled,
    ddnsProvider: String(info?.adminFlags?.ddnsProvider || ""),
    linkWizardEnabled: !!info?.adminFlags?.linkWizardEnabled,
  }), [info]);
  return {
    ...flags,
    /** 拿到了能用的结果（管理员要拿到带 adminFlags 的那份） */
    loaded: info !== undefined && !staleForAdmin,
    /** 有结果了，或者读失败了（等它的逻辑不至于一直卡住） */
    settled: (info !== undefined && !staleForAdmin) || query.isError,
    refetch: query.refetch,
  };
}
