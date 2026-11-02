import { useEffect, useState } from "react";

/**
 * 这个标签页现在是不是在前台。
 *
 * 主机管理和 Token 管理各存过一份一样的实现。页面切到后台就停掉轮询 —— 一个
 * 开了十几个标签页的管理员，后台那些页照常几秒一次地打接口，人却一眼没看。
 */
export function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return visible;
}
