import { useEffect, useState } from "react";

import { readUiThemeOverride, UI_THEME_OVERRIDE_EVENT, UI_THEME_OVERRIDE_STORAGE_KEY } from "@/lib/personalizationTheme";

/*
  这台设备在顶栏调色盘里给自己选的那套界面主题（没选是 null，跟随站点默认）。
  顶栏调色盘和设置页都读它：一边换了，另一边当场跟着变（同一页靠 UI_THEME_OVERRIDE_EVENT，
  别的标签页靠 storage 事件）。
*/
export function useUiThemeOverride() {
  const [override, setOverride] = useState<string | null>(() => readUiThemeOverride());
  useEffect(() => {
    const sync = () => setOverride(readUiThemeOverride());
    const onStorage = (event: StorageEvent) => { if (event.key === UI_THEME_OVERRIDE_STORAGE_KEY) sync(); };
    window.addEventListener(UI_THEME_OVERRIDE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    sync();
    return () => {
      window.removeEventListener(UI_THEME_OVERRIDE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return override;
}
