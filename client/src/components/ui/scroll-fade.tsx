import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 可滚动区域的上下两道「还有内容」的渐隐。
 *
 * 弹层里的滚动区顶上贴着标题、底下贴着按钮，内容一滚起来就是半行字被硬生生切在
 * 标题底下（手机上「订阅内容」那一屏看得最清楚）。iOS 的做法是让边缘淡出去，
 * 既说明「上面 / 下面还有」，也不会出现切半的字。
 *
 * 只在真的滚到中间时才淡：顶到头时第一张卡的上边不能被吃掉，到底时最后一行同理。
 * 用 mask 画，不加遮罩元素 —— 遮罩元素会挡住滚动区边上的点击，也要跟着圆角走。
 */
export const ScrollFade = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, onScroll, children, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLDivElement | null>(null);
    const setRef = React.useCallback((node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef]);

    const update = React.useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      // 直接写 DOM 属性，不走 state：滚动事件里 setState 每帧一次渲染，手机上划得越快掉帧越多。
      if (el.dataset.fadeTop !== String(top)) el.dataset.fadeTop = String(top);
      if (el.dataset.fadeBottom !== String(bottom)) el.dataset.fadeBottom = String(bottom);
    }, []);

    React.useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      update();
      // 内容异步到达（弹窗先开、数据后来）时高度会变，靠 ResizeObserver 补一次。
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
      observer?.observe(el);
      for (const child of Array.from(el.children)) observer?.observe(child);
      return () => observer?.disconnect();
    }, [update]);

    return (
      <div
        ref={setRef}
        className={cn("fx-scroll-fade", className)}
        onScroll={(event) => { update(); onScroll?.(event); }}
        {...props}
      >
        {children}
      </div>
    );
  },
);
ScrollFade.displayName = "ScrollFade";
