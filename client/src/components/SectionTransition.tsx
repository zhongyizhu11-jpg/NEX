import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

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

  return (
    <AnimatePresence mode="wait">
      <m.div
        key={transitionKey}
        className={className}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.995 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.995 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}

export default SectionTransition;
