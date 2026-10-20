import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 卡片里的一组设置：一行一项，名字和说明在左，控件在右，行与行之间一根细线。
 *
 * 取代设置页里那种「一个开关一个小框」（圆角 + 描边 + 灰底 + 12px 内边距）。
 * 手册的规矩是块里面再分组先用间距和细线（L2），小框是 V1 的「框里套框」——
 * 系统设置六个分区的卡片里一共套着 48 个这种框（系统配置一页 22 个）。框本身不说
 * 任何事，一屏几十个框读起来就是线框图。
 *
 * 分隔线和分组列表是同一条（.fx-list-row 相邻时画上边线），所以一张卡片里的设置行和
 * 一张分组列表里的行看起来是一回事。首行上面、末行下面不留内边距：列表贴着卡片自己的
 * 内边距走，不在卡片的留白上再叠一层。
 */
export function SettingList({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-w-0 flex-col", className)}>{children}</div>;
}

export function SettingRow({
  label,
  description,
  keepDescription = false,
  control,
  asLabel = false,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /**
   * 说明其实是状态（账号名、绑定时间、当前协议）：精简布局下也要显示。
   * 默认当「介绍」处理，精简下收起（compact.css 按 data-fx-help 选）。
   */
  keepDescription?: boolean;
  /** 右边的控件：开关、复选框、短的选择框或一个按钮。 */
  control?: ReactNode;
  /**
   * 整行做成 <label>：点名字、点说明都等于点右边那个开关。只在控件是**一个**开关或
   * 复选框时用 —— 手机上那个 20px 的方块不好点，整行就是 44px 以上的一块。
   * 右边是选择框或按钮时别开：点名字会去开选择框。
   */
  asLabel?: boolean;
  className?: string;
  /** 这一项打开之后才出现的那几个字段，跟在这一行下面、同一格里。 */
  children?: ReactNode;
}) {
  const Row = asLabel ? "label" : "div";
  return (
    <div className={cn("fx-list-row fx-setting-row flex min-w-0 flex-col gap-3 py-3 first:pt-0 last:pb-0", className)}>
      <Row className={cn("flex min-w-0 items-center justify-between gap-3", asLabel && "cursor-pointer")}>
        {/*
          说明用 span 不用 p：手机上 `.workspace-main p` 会给每个段落加上下各 12px 的外边距，
          一行设置会被撑成三行高。
        */}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-secondary-type font-medium text-foreground">{label}</span>
          {/* 说明是「介绍」：精简布局下收起（compact.css 按 data-fx-help 选） */}
          {description ? <span data-fx-help="" data-fx-keep={keepDescription ? "" : undefined} className="text-meta text-muted-foreground">{description}</span> : null}
        </span>
        {control ? <span className="flex shrink-0 items-center gap-2">{control}</span> : null}
      </Row>
      {/* fx-setting-sub：玫瑰主题下这一段往里缩、左边一条细竖线挂在开关下面（见 theme-rose.css），别的主题下没有样式 */}
      {children ? <div className="fx-setting-sub flex min-w-0 flex-col gap-3">{children}</div> : null}
    </div>
  );
}
