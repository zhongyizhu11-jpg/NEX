import { useCallback } from "react";
import { toast } from "sonner";

import { normalizePersonalizationLayout, normalizeUserLayoutPreference, resolveEffectiveLayout, type PersonalizationLayoutId } from "@shared/personalization";
import { useAuth } from "@/_core/hooks/useAuth";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";

/*
  精简布局（shared/personalization.ts 里的 PERSONALIZATION_LAYOUTS）。

  谁说了算：个人资料 › 界面 里的个人偏好（users.uiLayout）› 设置 › 个性化 › 布局 的站点默认（personalizationLayout）。画法全在 client/src/styles/compact.css 里按 <html data-layout>
  选（LayoutLayer 负责写这个属性），组件一般不用知道自己在哪套布局 —— 只有形状上要换结构的地方
  （诊断把有问题的排前面、流量用尽合成一行 + 一键升级、规则框不放解释小字）才读这个 hook。
*/
export function useLayoutPreference() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });
  const siteLayout = normalizePersonalizationLayout((publicInfo as any)?.personalizationLayout);
  const preference = normalizeUserLayoutPreference((user as any)?.uiLayout);
  const effective = resolveEffectiveLayout(user as any, siteLayout);
  const mutation = trpc.auth.updateProfile.useMutation({
    onError: (error) => toast.error(error.message || "布局设置失败"),
  });
  /*
    先改本地缓存让界面当场换（LayoutLayer 盯着 auth.me），存失败再退回去。
    uiLayout = null 是「跟随站点」。
  */
  const setPreference = useCallback(async (next: PersonalizationLayoutId | null) => {
    const previous = utils.auth.me.getData();
    utils.auth.me.setData(undefined, (old: any) => (old ? { ...old, uiLayout: next } : old));
    try {
      await mutation.mutateAsync({ uiLayout: next });
      await utils.auth.me.invalidate();
    } catch {
      utils.auth.me.setData(undefined, previous as any);
    }
  }, [mutation, utils]);
  return { preference, siteLayout, effective, setPreference, saving: mutation.isPending };
}

/** 这个账号现在是不是精简布局。没登录 / 还在加载时按站点默认。 */
export function useCompactLayout(): boolean {
  return useLayoutPreference().effective === "compact";
}
