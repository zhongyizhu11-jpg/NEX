import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { isUiMotionEnabled, mergeUiPreferences, parseUiPreferences, serializeUiPreferences, type UiPreferencesPatch } from "@shared/uiPreferences";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { MOTION_ATTRIBUTE, isMotionAttributeOff } from "@/lib/uiMotion";

/*
  按账号保存的界面偏好（users.uiPreferences，见 shared/uiPreferences.ts）：界面动画、列表的列设置。
  和布局偏好（hooks/useCompactLayout.ts）一个做法：先改本地的 auth.me 缓存让界面当场换，
  存失败再退回去。服务端按「读 → 合并 → 写」只改这次提交的那一项。
*/
export function useUiPreferences() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const preferences = parseUiPreferences(user?.uiPreferences);
  const mutation = trpc.auth.updateUiPreferences.useMutation();
  const update = useCallback(async (patch: UiPreferencesPatch, errorMessage = "界面设置保存失败") => {
    const previous = utils.auth.me.getData();
    type MeData = typeof previous;
    utils.auth.me.setData(undefined, (old: MeData) => (old
      ? { ...old, uiPreferences: serializeUiPreferences(mergeUiPreferences(parseUiPreferences(old.uiPreferences), patch)) }
      : old));
    try {
      const result = await mutation.mutateAsync(patch);
      // 用服务端合并后的那份（别的标签页这期间改过的项也一起带回来）
      utils.auth.me.setData(undefined, (old: MeData) => (old ? { ...old, uiPreferences: result.uiPreferences } : old));
      return true;
    } catch (error) {
      utils.auth.me.setData(undefined, previous);
      toast.error((error as Error)?.message || errorMessage);
      return false;
    }
  }, [mutation, utils]);
  return { user, preferences, update, saving: mutation.isPending };
}

/** 个人资料 › 界面 › 界面动画。没登录 / 没设过都按开。 */
export function useMotionPreference() {
  const { user, update, saving } = useUiPreferences();
  const enabled = isUiMotionEnabled(user);
  const setEnabled = useCallback((next: boolean) => update({ motion: next ? null : false }, "界面动画设置失败"), [update]);
  return { enabled, setEnabled, saving };
}

/**
 * 只看 <html data-motion>（LayoutLayer 写的那个属性），不碰 trpc / auth：登录页、App 外壳、
 * SectionTransition 这些地方用。没登录时也是本机上次记住的那个值。
 */
export function useMotionEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => !isMotionAttributeOff());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setEnabled(!isMotionAttributeOff(root)));
    observer.observe(root, { attributes: true, attributeFilter: [MOTION_ATTRIBUTE] });
    setEnabled(!isMotionAttributeOff(root));
    return () => observer.disconnect();
  }, []);
  return enabled;
}
