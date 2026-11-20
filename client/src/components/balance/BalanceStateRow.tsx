import { useState, type ReactNode } from "react";

import { LINE_TONE_TEXT, LinePill } from "@/features/lines/LineUi";
import { BALANCE_STATE_TONE, BALANCE_STATE_WORDS, type BalanceStateKey } from "@/lib/balanceState";
import { cn } from "@/lib/utils";

/*
  负载均衡里「一台出口 / 一条线路」此刻怎么样的一行（链路的负载均衡弹窗、线路组详情共用）：

    [前缀]  名字  [在用]                       [动作]
            到目标 12 ms · 抖动 3 ms · 分到 34%
            入口连不上这台出口机，已切走 · 检查出口机的防火墙和隧道端口

  状态词和颜色只从 lib/balanceState.ts 来；不是在用的那一行写原因（不截断，手机上换行）。
*/

export function BalanceStatePill({ state, title, className }: { state: BalanceStateKey; title?: string; className?: string }) {
  const tone = BALANCE_STATE_TONE[state];
  return (
    <LinePill tone={tone} dot={tone !== "gray"} title={title} className={className} testId={`balance-state-${state}`}>
      {BALANCE_STATE_WORDS[state]}
    </LinePill>
  );
}

export function BalanceStateRow({
  name,
  state,
  detail,
  reason,
  hint,
  leading,
  action,
  dim = false,
}: {
  name: ReactNode;
  state: BalanceStateKey;
  detail?: string | null;
  reason?: string | null;
  hint?: string | null;
  leading?: ReactNode;
  action?: ReactNode;
  /** 指定了别的、这台空着：淡一点 */
  dim?: boolean;
}) {
  const tone = BALANCE_STATE_TONE[state];
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <li className={cn("flex min-w-0 items-center gap-2.5 px-3 py-2.5", dim && "opacity-60")} data-balance-state={state}>
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[14.5px] font-medium leading-5">{name}</span>
          <BalanceStatePill state={state} />
        </div>
        {detail ? (
          // 手机上一行放不下（几条规则的整链范围 + 两段 + 分到多少）：点一下展开看全，再点收起
          <button
            type="button"
            className={cn("block w-full min-w-0 text-left text-meta leading-5 text-muted-foreground tabular-nums", detailOpen ? "whitespace-normal break-words" : "truncate")}
            title={detail}
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((open) => !open)}
          >
            {detail}
          </button>
        ) : null}
        {reason ? (
          <p className={cn("text-meta leading-5", tone === "gray" || tone === "ok" || tone === "acc" ? "text-muted-foreground" : LINE_TONE_TEXT[tone])}>
            {reason}
            {hint ? <span className="text-muted-foreground"> · {hint}</span> : null}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}
