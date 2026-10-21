import { useCallback } from "react";
import { toast } from "sonner";

import { normalizePersonalizationLayout, normalizeUserLayoutPreference, resolveEffectiveLayout, type PersonalizationLayoutId } from "@shared/personalization";
import { useAuth } from "@/_core/hooks/useAuth";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";

/*
  精简布局（shared/personalization.ts 里的 PERSONALIZATION_LAYOUTS）。

  谁说了算：个人资料 › 界面 里的个人偏好（users.uiLayout）› 设置 › 个性化 › 布局 的站点默认（personalizationLayout）。
  2026-10-21 起紧凑外壳就是标准布局（client/src/styles/compact.css 对两种布局都生效），两种只差总览 / 转发 /
  主机 / 链路四页的卡片：标准下页面根带 data-fx-std-cards 让卡片按原来的尺寸画，精简下不带。所以读这个 hook 的
  只剩那四页（决定带不带属性）和链路卡的 oneLineFoot。
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
