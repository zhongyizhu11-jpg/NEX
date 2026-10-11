import { useEffect, useState } from "react";

/**
 * 现在生效的界面主题（设置 › 个性化 › 界面主题）：<html data-ui-theme> 上那个值，经典没有属性。
 *
 * 画法都在 CSS 里按这个属性选，组件一般不用知道主题；只有形状上要换结构的地方
 * （墨金手机上的分类条折成一个下拉）才在这里读一下。属性一变（设置页切换、登录后
 * 从服务端拿到设置）组件跟着重渲染，不用刷新。
 */
function readUiTheme(): string {
  if (typeof document === "undefined") return "classic";
  return document.documentElement.getAttribute("data-ui-theme") || "classic";
}

export function useUiTheme(): string {
  const [theme, setTheme] = useState<string>(readUiTheme);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(readUiTheme());
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-ui-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);
  return theme;
}
