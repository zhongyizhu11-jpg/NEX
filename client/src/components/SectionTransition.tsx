import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useUiTheme } from "@/hooks/useUiTheme";

/**
 * 页内切换分区时的淡入淡出，链路管理和转发组原来各存一份一样的实现。
 *
 * `useReducedMotion` 那一支是必要的：系统里开了「减少动态效果」的人，多半是
 * 因为位移动画会让他不舒服 —— 这时候只留透明度变化，不做位移和缩放。
 */
function SectionTransition({
  transitionKey,
  className,
  children,
}: {
  transitionKey: string;
  /** 转发规则那一份带自己的排版类名，合并时保留成可选项。 */
  className?: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  /*
    液态玻璃：这一层不能动透明度。它是玻璃卡的祖先，透明度一不到 1，卡的 backdrop 模糊就只能
    看到这一层自己透明的底，切分区的那 200ms 里照片从卡里直接透出来，动画结束模糊才突然出现。
    只动位移；要减少动态效果的就不做动画。
  */
  const glass = useUiTheme() === "liquid-glass";
  const motionProps = glass
    ? (reduceMotion
      ? { initial: false as const, animate: { y: 0 }, exit: undefined }
      : { initial: { y: 10 }, animate: { y: 0 }, exit: { y: -8 } })
    : (reduceMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
      : { initial: { opacity: 0, y: 10, scale: 0.995 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -8, scale: 0.995 } });

  return (
    // initial=false：页面刚挂上那一次不做进场（外面 route-content-enter 已经在做整页进场，叠两层只是更慢）；分区切换时照常
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={transitionKey}
        className={className}
        {...motionProps}
        transition={{ duration: glass ? 0.16 : 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}

export default SectionTransition;
