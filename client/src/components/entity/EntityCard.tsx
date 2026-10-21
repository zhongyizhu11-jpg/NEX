import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/network/StatusDot";
import type { NetworkHealth } from "@shared/networkHealth";

/**
 * Entity —— 一个真实业务对象的卡片。
 *
 * NEX 只允许三种 Surface：
 *
 *   A  Page Section  页面级大模块（系统状态、实时流量、需要关注）
 *   B  Entity        一个真实业务对象：Host / Tunnel / Rule / Subscription
 *   C  Control       输入框、Select、Segment、Button
 *
 * **只有 B 画框。** Entity 内部的数据组不再用卡片 —— 用间距、分隔线、字号、
 * 一条浅色带来分组就够了。
 *
 * 这条规则要解决的是上一版最典型的「普通后台感」：Card 里面又 Card，里面再有
 * 小 Card。HostCard 一张卡里嵌了资源面板、流量面板、分栏盒三层框，而框本身不
 * 携带任何信息，只是在重复画边界。删掉它们，信息一点没少，视觉噪音少一大半。
 *
 * 各页的 HostCard / TunnelCard / RuleCard / ProxyNodeCard 都由这一组拼出来，
 * 所以视觉统一是**拼出来的**，不是靠全局 CSS 去强行盖出来的。
 */
export function EntityCard({
  interactive = false,
  className,
  children,
  ...rest
}: {
  /** 整张卡可点进详情时传 true —— 列表负责看状态，详情负责看数据 */
  interactive?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      data-fx-entity="card"
      className={cn(
        /*
          一圈弱线、不投影。页面和卡片都是白纸，卡片靠这一条 1px 的弱线成形
          （参考站 ring-foreground/10 那一档）。线只画这一次：卡里不再套框，
          分隔用 border-t，不用四面围合的框。

          圆角走 surface 档而不是 card 档：一条细线勾出来的轮廓，小圆角会让
          白块看起来像没切干净的纸。
        */
        "fx-entity-card flex min-w-0 flex-col rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]",
        interactive && "cursor-pointer transition-shadow hover:shadow-[var(--fx-elevation-card)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * 卡头：状态点 + 名字 + 归属 + 右侧控件。
 *
 * 一行里只有一个主角。名字是主角（primary 档、字重 500），归属那一行是注脚
 * （meta 档、muted），不是第二个标题 —— 上一版两者都是 16px/400，同样大同样粗，
 * 一行里没有任何主次。
 */
export function EntityHeader({
  health,
  leading,
  title,
  subtitle,
  meta,
  badges,
  trailing,
  className,
}: {
  health?: NetworkHealth;
  /**
   * 顶替左边那枚状态点的东西（主机卡放发行版图标，状态点挂在图标右下角）。
   * 传了它就不再画 health 的点 —— 状态要由它自己带上。
   */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 名字下面、注脚上面的一行标识（主机的「Debian 12」「Agent v2.2.196」） */
  meta?: ReactNode;
  /** 名字右边的小标记。**最多两个** —— 再多就该收进详情 */
  badges?: ReactNode;
  /** 右上角：开关、操作菜单 */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "fx-entity-head flex min-w-0 items-start gap-2 px-[var(--fx-card-padding)] pt-[var(--fx-space-3)]",
        className,
      )}
    >
      {leading ?? (health ? <StatusDot health={health} size="large" className="mt-1.5" /> : null)}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-primary-type font-medium text-foreground">{title}</span>
          {badges}
        </div>
        {meta ? <div className="mt-1 mb-0.5 flex min-w-0">{meta}</div> : null}
        {subtitle ? (
          <span className="truncate text-meta text-muted-foreground">{subtitle}</span>
        ) : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </div>
  );
}

/**
 * 卡身：内容区。
 *
 * `band` 给那种需要和上下文分开、但又不值得单独成为一张卡的块（比如转发路径）
 * —— 一条浅色带，没有边框。这是「L2 内容分组不画边框」的落点。
 */
export function EntityBody({
  band = false,
  tight = false,
  className,
  children,
}: {
  band?: boolean;
  /**
   * 一组彼此紧挨的同类项（三条占用条、两个速率）用 tight。
   *
   * 默认的 12px 是给「两块不同的内容」之间用的；三条 16px 高的占用条之间也留
   * 12px，那一组就散成了三件事。组内紧、组间松。
   */
  tight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "fx-entity-body flex min-w-0 flex-col px-[var(--fx-card-padding)] py-[var(--fx-space-2)]",
        tight ? "gap-[var(--fx-space-1)]" : "gap-[var(--fx-space-2)]",
        /*
          band 原来是一块浅灰底。面全白之后改成上下各一条细线 —— 要表达的本来
          就是「这一段和上下文不是一回事」，一条线说得清楚，一块灰只是在涂色。
        */
        band && "border-y border-[var(--fx-stroke-weak)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 卡内分隔线。
 *
 * 替代「再套一个卡片」。左右拉满到卡片边缘（负边距），因为一条缩进的线看起来
 * 像装饰，拉满的线才像「这里分成了两段」。
 */
export function EntityDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn("mx-[var(--fx-card-padding)] h-px shrink-0 bg-[var(--fx-stroke-weak)]", className)}
    />
  );
}

/**
 * 卡脚：操作区。
 *
 * 一级操作最多 2 个，其余收进 ActionMenu —— 规则写在 EntityActions 里。
 */
/**
 * 还没换成 EntityCard 的列表卡（隧道、转发组、规则）底部的操作区。
 *
 * 原来这一行是 `.action-card-footer`：一条灰底带，里面五个图标，再由 workspace.css 分三个
 * 断点各覆盖一遍 —— 手机上把按钮压成 28×24 的纯图标，带字的按钮放进去会被压坏。
 * 这里只画一条细线、右对齐，不给底色；里面放 EntityActions（最多两个带字的 + ···）。
 */
export function CardActions({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("fx-card-actions mt-auto flex min-w-0 items-center justify-end border-t border-[var(--fx-stroke-weak)] pt-1", className)}>
      {children}
    </div>
  );
}

export function EntityFooter({
  className,
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      className={cn(
        "fx-entity-footer mt-auto flex min-w-0 items-center justify-end gap-2 border-t border-[var(--fx-stroke-weak)] px-[var(--fx-space-2)] py-[var(--fx-space-1)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * 名字旁边那种只读小标记（协议、类型、版本）。
 *
 * 和状态徽标（HealthBadge）分开：状态徽标回答「它现在好不好」，这个回答
 * 「它是什么」。两者长得不一样是故意的 —— 一列卡片扫下去，眼睛要能立刻
 * 分出哪个是状态、哪个是属性。
 */
export function EntityTag({
  children,
  tone,
  className,
}: {
  children: ReactNode;
  /** 只在这个标记本身带语义时才传（比如「备线」用 standby） */
  tone?: "path" | "delivery" | "standby";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[var(--fx-radius-control)] border px-1.5 py-0.5 text-meta",
        className,
      )}
      /*
        中性档靠边框成形，不靠底色。面全白之后灰底标记就是一片看不见的白，
        而一个标记的形状本来也可以由一条线给出。
      */
      style={
        tone
          ? {
              color: `var(--fx-${tone})`,
              backgroundColor: `var(--fx-${tone}-soft)`,
              borderColor: "transparent",
            }
          : {
              color: "var(--fx-text-secondary)",
              backgroundColor: "transparent",
              borderColor: "var(--fx-stroke-base)",
            }
      }
    >
      {children}
    </span>
  );
}
