import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * iOS 分组列表（inset grouped list）。
 *
 * 这是 iOS 上「一屏功能入口」的标准形态：若干个分组，每组一块圆角，组内是
 * 一行行「图标 + 名称 …… 值 ›」，组上面一行小标题说明这一组是什么。
 *
 * 为什么值得专门做一套：**它是为「功能多」设计的**。
 *
 * 面板里那些功能多的页面（系统设置六个横向 tab、高级配置十几个开关）现在靠
 * 横向标签条组织 —— 而标签条的容量是固定的，加到第七个就开始滚动，加到第十个
 * 就没人找得到第十个。分组列表没有这个上限：加一项就是多一行，而且**它天然
 * 说得清层级**：哪几项是一类，一眼看出来。
 *
 * ── 它凭什么成形 ──
 *
 * 和 iOS 原版一样：**浅灰页面底 + 纯白圆角块，块本身不描边**。
 * 面板的 L0/L1 就是按这个定的，所以这里直接用令牌，不需要为列表开特例。
 *
 * 行与行之间的分隔线内缩到文字起点，这是块内部唯一的线。
 *
 * ── 分隔线为什么要内缩 ──
 *
 * iOS 的行分隔线从**文字**开始画，不从行的最左边开始 —— 这样图标那一列是
 * 连续的，眼睛顺着图标往下扫不会被一堆横线打断。这个细节不做，列表立刻就
 * 「像网页表格」而不像 iOS 列表。
 */

export function ListSection({
  id,
  header,
  footer,
  className,
  children,
}: {
  id?: string;
  /** 组上面那行小标题。iOS 上是大写小字灰色 */
  header?: ReactNode;
  /** 组下面那段说明。放规则解释，不放警告 —— 警告要自己显眼 */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn("flex min-w-0 flex-col scroll-mt-16", className)}>
      {header ? (
        /*
          这里必须是 h2（文档大纲、读屏跳转都靠它），但 workspace.css 里
          `.workspace-main h2 { font-size: 20px }` 的特指度是 (0,1,1)，
          压过工具类的 (0,1,0) —— 第一版写了 text-meta，实测渲染出来是 20px
          的黑标题，和 iOS 那种小号灰标题完全不是一回事。

          用一个专门的类把尺寸钉死，别再靠工具类和页面级规则拼特指度。
        */
        <h2 className="fx-list-section-header">{header}</h2>
      ) : null}
      {/*
        白底、大圆角、一圈弱线 —— 页面是白纸，分组块靠这条 1px 的弱线成形，
        和工作区里的卡片同一种线。行自己不是面，行与行之间只有分隔线。
      */}
      <div className="fx-grouped-list overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]">
        {children}
      </div>
      {footer ? (
        <p data-fx-help="" className="px-1 pt-1.5 text-meta leading-relaxed text-muted-foreground">{footer}</p>
      ) : null}
    </section>
  );
}

export type ListRowProps = {
  /** 左侧图标。给的话分隔线会内缩到文字起点 */
  icon?: ReactNode;
  label: ReactNode;
  /** 名称下面那行说明 */
  detail?: ReactNode;
  /** 右侧的值（「Auto」「DNS」「12」这类） */
  value?: ReactNode;
  /** 右侧控件（开关等）。给了就不画箭头 —— 一行里不能既是入口又是开关 */
  trailing?: ReactNode;
  /** 可点：画箭头，整行可按 */
  onSelect?: () => void;
  /** 当前选中（用在索引列表里标出正在看的那一项） */
  selected?: boolean;
  /** 可点时画不画右侧箭头。当侧栏导航用时不画 —— 选中那一行已经说明「内容在右边」。 */
  chevron?: boolean;
  disabled?: boolean;
  className?: string;
};

export function ListRow({
  icon,
  label,
  detail,
  value,
  trailing,
  onSelect,
  selected = false,
  chevron = true,
  disabled = false,
  className,
}: ListRowProps) {
  const interactive = !!onSelect && !disabled;
  /*
    一行里不能既是入口又是开关：有 trailing（开关）就不画箭头。
    两个都画的话用户不知道点哪儿 —— 点开关还是进下一层？
  */
  const showChevron = interactive && !trailing && chevron;

  const content = (
    <>
      {icon ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--fx-text-secondary)]">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col text-left">
        {/*
          行的名字走 primary 档（手机 15 / 桌面 17，iOS 列表正文就是 17pt）。这里原来写的是
          secondary，却一直显示成 15/16px —— cn() 把自定义字号当成颜色删掉了，字号退回继承值
          （见 lib/utils.ts）。修好 cn 之后照原样会缩到 13/15px；按手册「名字、地址 → primary」改过来。
        */}
        <span
          className={cn(
            "truncate text-primary-type",
            selected ? "font-semibold text-[var(--fx-accent)]" : "text-foreground",
          )}
        >
          {label}
        </span>
        {detail ? <span data-fx-help="" className="truncate text-meta text-muted-foreground">{detail}</span> : null}
      </span>
      {value ? (
        <span className="ml-auto shrink-0 truncate text-secondary-type text-muted-foreground">
          {value}
        </span>
      ) : null}
      {trailing ? <span className="ml-auto shrink-0">{trailing}</span> : null}
      {showChevron ? (
        <ChevronRight className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
    </>
  );

  /*
    分隔线画在行上（border-top + 首行去掉），不画在容器上。内缩用 margin-left
    交给 ::before 做不到 —— 这里直接用一个伪元素太绕，改成外层 padding-left
    配合行内 border-top 的负边距，读起来更直接。
  */
  const shared = cn(
    "fx-list-row flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left",
    icon ? "fx-list-row-inset" : null,
    disabled && "opacity-50",
    className,
  );

  if (!interactive) {
    return <div className={shared}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-current={selected ? "true" : undefined}
      /*
        选中是「正在看哪一项」，不是状态 —— 不染状态色。底色和应用左边那条侧栏的选中项
        同一个灰（--fx-hover）：设置页宽屏时两栏导航并排，同一件事得说成同一个样子。
        用控件底那个灰（#f1f1f4）试过，白块上几乎看不出来，和页面底一个色，像块上缺了一格。
      */
      className={cn(shared, "transition-colors hover:bg-[var(--fx-hover)]", selected && "bg-[var(--fx-hover)]")}
    >
      {content}
    </button>
  );
}

/**
 * 一整页的分组列表容器。
 *
 * 组与组之间留一个区块间距 —— iOS 上这个间距是分组能被读成「不同类」的
 * 唯一线索，比组内的行距明显大一档才行。
 */
export function GroupedList({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-w-0 flex-col gap-[var(--fx-space-6)]", className)}>{children}</div>;
}
