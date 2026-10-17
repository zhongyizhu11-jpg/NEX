import { useLayoutEffect, useRef } from "react";

import { useUiTheme } from "@/hooks/useUiTheme";

/*
  「珍珠」主题（theme-pearl.css）侧栏里那块会滑的瓷片：照上游 poouo/Forwardx 的 PearlSidebarContent
  （Pearl Glass，改编自 scaffold-master，MIT）。只在 <html data-ui-theme="pearl"> 且侧栏没折叠成图标栏时挂；
  别的主题这里什么都不渲染，也不挂任何监听。

  做法：量出当前选中的菜单项相对侧栏内容区的位置，把一枚绝对定位的瓷片放过去（transform），
  换页时 CSS transition 把它从上一项滑到下一项（480ms，有终点；减少动态效果时 CSS 里关掉过渡）。
  侧栏是常驻的外壳，换页不重挂，所以不用像上游那样记住上一次的几何。
  量好之后给内容区挂 data-pearl-marker，选中项自己那块瓷片就让给这枚标记画；没挂上时按钮自己画，
  所以测量失败、还没量、或者 JS 还没跑的时候看起来也是对的。

  只在第一次量的时候瞬间就位（不从左上角飞进来）；页面在后台时也瞬间就位。
  ResizeObserver / MutationObserver / resize 监听 / 动画帧在卸载或主题切走时全部清掉。
*/
export default function PearlNavMarker({ collapsed }: { collapsed: boolean }) {
  const uiTheme = useUiTheme();
  const enabled = uiTheme === "pearl" && !collapsed;
  const markerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const marker = markerRef.current;
    const content = marker?.parentElement;
    if (!enabled || !marker || !content) return;
    let frame = 0;
    let settleFrame = 0;
    let placed = false;
    let last = "";

    const measure = () => {
      const active = content.querySelector<HTMLElement>('[data-sidebar="menu-button"][data-active="true"]');
      if (!active) {
        marker.hidden = true;
        delete content.dataset.pearlMarker;
        placed = false;
        last = "";
        return;
      }
      const bounds = content.getBoundingClientRect();
      const target = active.getBoundingClientRect();
      const x = Math.round(target.left - bounds.left + content.scrollLeft);
      const y = Math.round(target.top - bounds.top + content.scrollTop);
      const key = `${x}|${y}|${target.width}|${target.height}`;
      if (key === last) return;
      last = key;
      const instant = !placed || document.hidden;
      if (instant) marker.setAttribute("data-instant", "");
      marker.style.width = `${target.width}px`;
      marker.style.height = `${target.height}px`;
      marker.style.transform = `translate(${x}px, ${y}px)`;
      marker.hidden = false;
      content.dataset.pearlMarker = "";
      placed = true;
      if (instant) {
        cancelAnimationFrame(settleFrame);
        settleFrame = requestAnimationFrame(() => marker.removeAttribute("data-instant"));
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    resize?.observe(content);
    // 换页只是 data-active 换了一个按钮；菜单项也可能晚到（插件页 / 自定义菜单）。不看 style，免得自己触发自己。
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-active"] });
    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      delete content.dataset.pearlMarker;
    };
  }, [enabled]);

  if (!enabled) return null;
  return <span ref={markerRef} className="fx-pearl-nav-marker" aria-hidden="true" hidden />;
}
