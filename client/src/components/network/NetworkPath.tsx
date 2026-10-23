import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { describeNetworkHealth, type NetworkHealth, type NetworkLineStyle } from "@shared/networkHealth";

import { StatusDot } from "./StatusDot";

/**
 * NEX 的核心视觉语言：节点是点，链路是线，转发是流。
 *
 * 这个文件里的三个组件（NetworkNode / NetworkEdge / NetworkPath）是整个设计
 * 系统的地基。**凡是表达网络关系的地方，都用它们，不再各写各的**。
 *
 * 为什么值得单独抽出来：
 *
 * 面板里「入口 → 出口」这件事，隧道页、规则页、转发链、转发组、链路诊断、
 * 创建向导的预览，一共有六处在画，六处画法都不一样 —— 有的是两行带标题的
 * 竖排，有的是一行加箭头，有的干脆写「入口主机：xxx / 出口主机：yyy」。
 * 同一个概念在一个产品里有六种长相，用户每换一页就要重新认一次。
 *
 * 而且「入口主机：」这种写法本身就是在用文字解释空间关系。空间关系应该
 * **由空间来表达**：左边那个点就是入口，右边那个点就是出口，中间那条线就是
 * 它们之间的关系，不用读字。
 *
 * 状态怎么画由 shared/networkHealth.ts 统一给：
 *
 *   绿 = Healthy   琥珀 = Degraded   红 = Down   灰 = Standby
 *   实线 = Active   虚线 = Standby   脉冲 = Switching
 *
 * 所以以后做主备线路、负载均衡、多出口，都不用重新设计 UI —— 一条 standby 的
 * 备线就是「灰点 + 虚线」，切换的瞬间就是「脉冲」，这套规则已经在这里了。
 */

export type NetworkNodeSpec = {
  id: string;
  /** 节点名。主机名、落地名、「NEX」这种中继标识都算 */
  name: string;
  /** 名字底下那行：地区、地址、角色。不是第二个标题，是注脚 */
  sublabel?: string;
  health?: NetworkHealth;
  /** 右上角挂一个小标记（协议、版本之类）。列表里慎用，会抢点的注意力 */
  badge?: ReactNode;
};

export type NetworkEdgeSpec = {
  /** 这一段经过谁：NEX、GOST、中继名。写在线的旁边 */
  via?: string;
  /** 这一段的延迟。数字本身是视觉元素，所以单独一档字号 */
  latencyMs?: number | null;
  health?: NetworkHealth;
  /** 不传则由 health 决定；只有需要覆盖默认画法时才显式传 */
  lineStyle?: NetworkLineStyle;
};

/** 一个节点：点 + 名字 + 注脚。 */
export function NetworkNode({
  node,
  orientation,
  className,
}: {
  node: NetworkNodeSpec;
  orientation: "horizontal" | "vertical";
  className?: string;
}) {
  const health = node.health || "unknown";
  /*
    横竖两种排法里点都在名字那一行的左边（名字 22px 行高，圆心在 11px，点 8px，所以 pt 7px）。
    上一版横排时点在名字上面一行、线又对着点画，结果隧道卡上「● ── ●」那条线浮在两个名字
    的上方，看着像三样东西各排各的。
  */
  return (
    <div className={cn("flex min-w-0 flex-row items-start gap-2", className)}>
      <span className="flex shrink-0 items-center gap-2 pt-[7px]">
        <StatusDot health={health} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-primary-type font-medium text-foreground">{node.name}</span>
          {node.badge}
        </span>
        {node.sublabel ? (
          <span className="truncate text-meta text-muted-foreground">{node.sublabel}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * 一段连线。
 *
 * 横排时是一条横线，竖排时是一条竖线 —— 但线型、颜色、标注的规则完全一样，
 * 只有方向不同。所以是同一个组件，不是两个。
 */
export function NetworkEdge({
  edge,
  orientation,
  className,
}: {
  edge: NetworkEdgeSpec;
  orientation: "horizontal" | "vertical";
  className?: string;
}) {
  const descriptor = describeNetworkHealth(edge.health || "healthy");
  const style = edge.lineStyle || descriptor.lineStyle;
  const color = style === "dashed" ? "var(--fx-standby)" : `var(--fx-${descriptor.token})`;

  const hasLabel = !!edge.via || typeof edge.latencyMs === "number";
  const label = hasLabel ? (
    <span
      className={cn(
        "flex min-w-0 flex-col leading-tight",
        orientation === "horizontal" ? "items-center text-center" : "items-start",
      )}
    >
      {edge.via ? <span className="truncate text-meta text-muted-foreground">{edge.via}</span> : null}
      {typeof edge.latencyMs === "number" ? (
        <span className="text-meta font-medium tabular-nums text-foreground">
          {edge.latencyMs}
          <span className="ml-1 font-normal text-muted-foreground">ms</span>
        </span>
      ) : null}
    </span>
  ) : null;

  /*
    线本身用 border 画而不是背景色：虚线只能靠 border-style 得到，用背景色
    得去调 repeating-linear-gradient，换个颜色就要重算一次。
  */
  const line = (
    <span
      aria-hidden="true"
      className={cn(
        "block shrink-0",
        orientation === "horizontal" ? "w-full border-t" : "h-full min-h-2 border-l",
        style === "dashed" && "border-dashed",
        style === "pulse" && "fx-edge-pulse",
      )}
      style={{ borderColor: color, borderWidth: style === "pulse" ? 2 : 1 }}
    />
  );

  if (orientation === "horizontal") {
    /*
      横排的线至少留 48px：手机上两个长名字（Po0(200M)1188、Jinx(29.9y)）把线挤成零宽，
      名字就叠在一起，底下的「7 ms」也没地方放。线有底线，名字自己去截断（见 NetworkPath）。
    */
    return (
      <span data-fx-path-edge="" className={cn("flex min-w-12 flex-1 flex-col items-center gap-1", className)}>
        {line}
        {label}
      </span>
    );
  }
  /*
    竖排那一段的高度：有标注时留 24px（放得下「GOST TLS / 46ms」两行），
    没标注时只留 12px。

    两个值分开是因为它们的职责不同：有标注的那一段要装下文字，没标注的那一段
    只是在说「这两个点是连着的」，一条 12px 的线足够说清楚。上一版统一 24px，
    一条四跳的路径光在三段空线上就花掉 72px —— 而列表卡总共才 350px。
  */
  return (
    <span className={cn("flex items-stretch gap-2", hasLabel ? "min-h-6" : "min-h-3", className)}>
      <span className="flex w-2 shrink-0 justify-center">{line}</span>
      {label}
    </span>
  );
}

/**
 * 一条完整路径：节点 — 线 — 节点 — 线 — 节点。
 *
 * edges[i] 连的是 nodes[i] 和 nodes[i+1]，所以 edges 比 nodes 少一个；少给了
 * 就按默认实线补，多给的忽略。这样调用方只在真的有话要说（经过谁、多少 ms）
 * 时才需要构造 edges。
 *
 * 方向默认自动：两个节点横排（一行放得下，而且左右天然就是「从这到那」），
 * 三个及以上竖排（横排会把每个节点压到放不下名字）。需要固定时显式传。
 */
export function NetworkPath({
  nodes,
  edges = [],
  orientation = "auto",
  className,
}: {
  nodes: readonly NetworkNodeSpec[];
  edges?: readonly NetworkEdgeSpec[];
  orientation?: "auto" | "horizontal" | "vertical";
  className?: string;
}) {
  if (nodes.length === 0) return null;

  const direction: "horizontal" | "vertical" =
    orientation === "auto" ? (nodes.length <= 2 ? "horizontal" : "vertical") : orientation;

  if (nodes.length === 1) {
    return <NetworkNode node={nodes[0]} orientation={direction} className={className} />;
  }

  /*
    横排不再给每个「节点 + 线」套一层 flex-1 的壳。

    套壳时两个壳平分宽度：左壳装名字加线，右壳只装名字，名字又是 flex-none 不许缩 ——
    手机上一个长名字就把左壳撑爆，右边的名字直接压在它上面，线缩成零宽，「7 ms」悬在
    两个名字中间。现在点、线、点是同一行里的兄弟：线拿走全部富余宽度（至少 48px），
    名字只在放不下时才缩、缩了就打省略号，谁也不叠谁。
  */
  if (direction === "horizontal") {
    return (
      <div className={cn("flex min-w-0 flex-row items-start gap-3", className)}>
        {nodes.map((node, index) => {
          const edge = index < nodes.length - 1 ? (edges[index] || {}) : null;
          return (
            <Fragment key={node.id}>
              <NetworkNode node={node} orientation="horizontal" className="min-w-0 shrink" />
              {edge ? <NetworkEdge edge={edge} orientation="horizontal" className="mt-[10px]" /> : null}
            </Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0",
        className,
      )}
    >
      {nodes.map((node, index) => {
        const edge = index < nodes.length - 1 ? (edges[index] || {}) : null;
        return (
          <div
            key={node.id}
            className="flex min-w-0 flex-col"
          >
            <NetworkNode node={node} orientation={direction} />
            {edge ? (
              <NetworkEdge
                edge={edge}
                orientation={direction}
                /*
                  线要落在状态点的圆心上：点宽 8px 从 x=0 起，圆心在 x=4；边自己的 w-2 容器已经
                  把线居中到 4px 了，所以**不能再加左边距** —— 之前那个 ml-1 把线推到 x=8，比圆心
                  右了 4px，一条三跳的路径看上去就是线和点各走各的，根本没连起来。
                  差几个像素在这里不是审美问题：Path 的全部意义就是「这两个点是连着的」。
                */
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 创建流程的 Review 那一步用的预览：竖排、每个节点一行、不带交互。
 *
 * 单独包一层是因为它的职责不同 —— 列表里的 Path 是「看现状」，这个是
 * 「确认你即将创建的东西」，所以它永远竖排（一行一个，读起来像一份清单），
 * 也永远显示完整地址而不截断。
 */
export function PathPreview({
  nodes,
  edges,
  className,
}: {
  nodes: readonly NetworkNodeSpec[];
  edges?: readonly NetworkEdgeSpec[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--fx-radius-card)] bg-[var(--fx-l2-group)] p-4",
        className,
      )}
    >
      <NetworkPath nodes={nodes} edges={edges} orientation="vertical" />
    </div>
  );
}
