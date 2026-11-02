import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
  tailwind-merge 得认识我们自己的字号。

  V2 的字号是 index.css 里 @theme 定义的 text-display / metric / section / primary-type /
  secondary-type / meta。tailwind-merge 不认识它们，就当成「文字颜色」—— 于是
  cn("text-meta", "text-muted-foreground") 会以「颜色冲突、后者胜出」为由把 text-meta
  删掉，字号悄悄退回继承来的大一号。扫源码有 10 处 cn() 调用踩中（策略面板的条件标题、
  公开监控页、个人资料页……），按钮这类组件里 cn(变体, className) 的合并也会踩：
  className 里的 text-meta 和变体里的 text-[14px] 两个都留着，谁生效看 CSS 先后。
  注册成字号之后：和颜色类共存，和别的字号冲突时后写的胜出 —— 和 text-sm 一个待遇。
*/
/*
  圆角同理：index.css 的 @theme 里加了 rounded-inner（控件里面那一层小圆角，跟着主题走），
  不注册的话它和 className 里的 rounded-full 两个都留着，谁生效看 CSS 先后。
*/
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      borderRadius: ["inner"],
    },
    classGroups: {
      "font-size": [{ text: ["display", "metric", "section", "primary-type", "secondary-type", "meta"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
