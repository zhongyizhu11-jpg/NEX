import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 「这里整块没有东西」。
 *
 * 全站原来至少五种写法：一整张带标题的卡片（「暂无公告」）、一个虚线框、一行灰字、
 * 一个自己拼的大号居中块，外加这个组件。同一件事五个样子，用户分不清「没有」和「没加载完」。
 * 现在统一成这一个：图标 + 一句是什么 + 一句下一步怎么做 + 可选的操作。
 *
 * 默认就是一块白底（和卡片同一种 surface）：直接坐在灰页面上时它自己成一块；放进卡片里时
 * 白底贴着白底，看不出来 —— 不会变成卡中卡，也就不用分两个变体。
 */
export default function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty-state", className)}>
      {icon ? <div className="empty-state-icon" aria-hidden="true">{icon}</div> : null}
      <div className="flex flex-col items-center gap-1">
        <h2>{title}</h2>
        {description ? <p data-fx-help="">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
