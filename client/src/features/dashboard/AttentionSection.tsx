import { ListRow, ListSection } from "@/components/ios/GroupedList";
import { PathLine } from "@/components/network/PathStrip";
import { StatusDot } from "@/components/network/StatusDot";
import {
  attentionHealth,
  describeAttentionRow,
  sortAttentionRows,
  summarizeHiddenAttention,
  type DashboardAttention,
} from "@shared/dashboardAttention";

import { attentionHref } from "./attentionLinks";

/**
 * 首页最多画几行。
 *
 * 再多就不是「需要关注」了，是「全部列表」—— 那是各自页面的事。截掉的部分
 * 在脚注里按类别说清楚（「还有 2 条转发、1 个转发组」），人知道该去哪一页找。
 */
export const ATTENTION_VISIBLE_ROWS = 5;

/**
 * 说明里的「A → B」画成一小段线：那是隧道两头的两台机器，线断了就是虚线。
 * 其余部分（「隧道没在运行 · 」）照原样是字。
 */
export function renderAttentionDetail(detail: string, health: Parameters<typeof PathLine>[0]["health"]) {
  const parts = detail.split(" · ");
  const index = parts.findIndex((part) => part.includes(" → "));
  if (index < 0) return detail;
  const [from, ...rest] = parts[index].split(" → ");
  const before = parts.slice(0, index).join(" · ");
  const after = parts.slice(index + 1).join(" · ");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {before ? <span className="shrink-0">{before} ·</span> : null}
      <PathLine from={from} to={rest.join(" → ")} health={health} className="min-w-0 flex-1" />
      {after ? <span className="shrink-0">· {after}</span> : null}
    </span>
  );
}

/**
 * 「需要关注」。
 *
 * V1 首页告诉用户「我有什么」（一堆数字卡片），这一块告诉他「我现在需要处理
 * 什么」。顶上那一行说「3 处异常」，这里说是哪三处、各自出了什么事、点进去
 * 在哪儿处理。
 *
 * 用的是 iOS 分组列表那一套（和设置页同一个组件）：一行一件事，左边状态点、
 * 中间名字和原因、右边箭头。状态点和各页的点是同一套词汇 —— 这里红的，点进去
 * 那一页上也是红的。
 *
 * 没有要处理的事时整块不出现。顶上已经写了「运行正常」，再来一块「一切正常」
 * 是同一句话说两遍。
 */
export function AttentionSection({
  attention,
  isAdmin,
  onOpen,
  header = "需要关注",
  now = Date.now(),
}: {
  attention: DashboardAttention | null | undefined;
  isAdmin: boolean;
  onOpen: (href: string) => void;
  /** 列表标题。首页默认布局把顶上那句结论（「4 处需要关注」）挪到这里当标题，见 SystemStatusHeader 的 attentionListedBelow */
  header?: string;
  now?: number;
}) {
  if (!attention) return null;
  const sorted = sortAttentionRows(attention.rows);
  if (sorted.length === 0) return null;
  const shown = sorted.slice(0, ATTENTION_VISIBLE_ROWS);

  return (
    <ListSection id="dashboard-attention" header={header} footer={summarizeHiddenAttention(attention.totals, shown)}>
      {shown.map((row) => {
        const { title, detail } = describeAttentionRow(row, now);
        const href = attentionHref(row, { isAdmin });
        const health = attentionHealth(row.reason);
        return (
          <ListRow
            key={`${row.reason}:${row.id}`}
            icon={<StatusDot health={health} />}
            label={title}
            detail={renderAttentionDetail(detail, health)}
            onSelect={href ? () => onOpen(href) : undefined}
          />
        );
      })}
    </ListSection>
  );
}
