import { useState } from "react";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { trpc } from "@/lib/trpc";
import { formatBytes } from "@shared/formatBytes";
import { formatMoneyCents } from "@shared/formatMoney";
import { OPS_BOARD_REFRESH_OPTIONS, ORDER_BUCKET_LABELS, type OpsBoardRange, type OrderBucket } from "@shared/opsBoard";

/*
  监控 › 看板（运维看板，参考上游 2.3.285）：这段时间收了多少钱、跑了多少流量、谁在连。

  - 范围：今天 / 7 天 / 30 天（北京时间切天）。
  - 自动刷新 5 / 10 / 30 秒或不刷新，默认 30 秒；切到别的页、手机切后台时不刷（react-query 默认就停）。
  - 数都来自现成的表，服务端缓存 15 秒。来源 IP 的地区查面板自带的离线库，不发给第三方。
*/

const RANGE_OPTIONS: Array<{ value: OpsBoardRange; label: string }> = [
  { value: 1, label: "今天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
];

const ORDER_ORDER: OrderBucket[] = ["completed", "delivering", "pending", "closed"];
/** 订单状态是「状态」不是类别：只有开通中（收了钱还没发货）用提醒色，其余都是中性灰。 */
const ORDER_BAR_CLASS: Record<OrderBucket, string> = {
  completed: "bg-primary",
  delivering: "bg-[var(--fx-warn)]",
  pending: "bg-muted-foreground/40",
  closed: "bg-muted-foreground/25",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3">
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-meta text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** 一行「名字 —— 横条 —— 数」。横条一律同一个颜色，长短说话。 */
function BarRow({ label, value, max, text, barClassName = "bg-primary" }: { label: string; value: number; max: number; text: string; barClassName?: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-2 text-sm">
      <span className="truncate" title={label}>{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className={`block h-full rounded-full ${barClassName}`} style={{ width: `${width}%` }} />
      </span>
      <span className="tabular-nums text-muted-foreground">{text}</span>
    </div>
  );
}

function DailyTraffic({ days }: { days: Array<{ date: string; inBytes: number; outBytes: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((day) => day.inBytes + day.outBytes);
  const max = Math.max(1, ...totals);
  const shown = hover ?? days.length - 1;
  const current = days[shown];
  return (
    <div className="space-y-2">
      <div className="text-meta text-muted-foreground tabular-nums" aria-live="polite">
        {current ? `${current.date.slice(5)} · 共 ${formatBytes(current.inBytes + current.outBytes)}（上行 ${formatBytes(current.inBytes)} · 下行 ${formatBytes(current.outBytes)}）` : ""}
      </div>
      <div className="flex h-28 items-end gap-0.5" role="img" aria-label={`每天流量，最多一天 ${formatBytes(max)}`} onMouseLeave={() => setHover(null)}>
        {days.map((day, index) => (
          <button
            key={day.date}
            type="button"
            className="group flex h-full min-w-0 flex-1 items-end"
            onMouseEnter={() => setHover(index)}
            onFocus={() => setHover(index)}
            onClick={() => setHover(index)}
            aria-label={`${day.date} 共 ${formatBytes(totals[index])}`}
          >
            <span
              className={`block w-full rounded-t-[4px] ${totals[index] > 0 ? (index === shown ? "bg-primary" : "bg-primary/55 group-hover:bg-primary/80") : "bg-muted"}`}
              style={{ height: `${totals[index] > 0 ? Math.max(4, (totals[index] / max) * 100) : 4}%` }}
            />
          </button>
        ))}
      </div>
      <div className="flex justify-between text-meta text-muted-foreground tabular-nums">
        <span>{days[0]?.date.slice(5)}</span>
        <span>{days.at(-1)?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function relativeTime(seconds: number, nowSeconds: number) {
  const diff = Math.max(0, nowSeconds - seconds);
  if (diff < 90) return "刚刚";
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  return `${Math.round(diff / 86400)} 天前`;
}

export default function OpsBoardTab() {
  const [range, setRange] = useState<OpsBoardRange>(7);
  const [refreshSeconds, setRefreshSeconds] = useState<number>(30);
  const query = trpc.ops.board.summary.useQuery({ range }, {
    refetchInterval: refreshSeconds > 0 ? refreshSeconds * 1000 : false,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
  const data = query.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={segmentedControlClassName} role="group" aria-label="时间范围">
          <div className="grid grid-cols-3 gap-1">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={range === option.value}
                className={segmentedOptionClassName(range === option.value)}
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <Select value={String(refreshSeconds)} onValueChange={(value) => setRefreshSeconds(Number(value))}>
          <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label="自动刷新"><SelectValue /></SelectTrigger>
          <SelectContent>
            {OPS_BOARD_REFRESH_OPTIONS.map((seconds) => (
              <SelectItem key={seconds} value={String(seconds)}>{seconds > 0 ? `每 ${seconds} 秒刷新` : "不自动刷新"}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isLoading && !data ? (
        <DataSectionLoading label="正在汇总看板" minHeight="min-h-[200px]" />
      ) : query.isError || !data ? (
        <DataSectionError label="看板" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="实收"
              value={data.finance.revenue.length > 0 ? formatMoneyCents(data.finance.revenue[0].cents, data.finance.revenue[0].currency) : formatMoneyCents(0)}
              hint={data.finance.revenue.length > 1 ? data.finance.revenue.slice(1).map((item) => formatMoneyCents(item.cents, item.currency)).join(" · ") : `新订阅 ${data.finance.newSubscriptions} 个`}
            />
            <Stat
              label="余额"
              value={`+${formatMoneyCents(data.finance.balanceInCents)}`}
              hint={`消耗 ${formatMoneyCents(data.finance.balanceOutCents)}`}
            />
            <Stat
              label="流量"
              value={formatBytes(data.traffic.totalBytes)}
              hint={data.traffic.topRules[0] ? `最多：${data.traffic.topRules[0].name}` : "这段时间没有流量"}
            />
            <Stat
              label="来源 IP"
              value={`${data.sources.distinctIps}${data.sources.truncated ? "+" : ""}`}
              hint={data.sources.areas[0] ? `最多来自 ${data.sources.areas[0].name}` : "这段时间没有记录"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">每天流量</CardTitle></CardHeader>
              <CardContent>
                <DailyTraffic days={data.traffic.daily} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">订单 <span className="text-sm font-normal text-muted-foreground tabular-nums">共 {data.finance.orderTotal} 笔</span></CardTitle></CardHeader>
              <CardContent className="space-y-2.5">
                {data.finance.orderTotal === 0 ? (
                  <div className="text-sm text-muted-foreground">这段时间没有订单。</div>
                ) : ORDER_ORDER.map((bucket) => (
                  <BarRow
                    key={bucket}
                    label={ORDER_BUCKET_LABELS[bucket]}
                    value={data.finance.orders[bucket]}
                    max={data.finance.orderTotal}
                    text={String(data.finance.orders[bucket])}
                    barClassName={ORDER_BAR_CLASS[bucket]}
                  />
                ))}
                {data.finance.orders.delivering > 0 ? (
                  <p className="text-meta leading-5 text-muted-foreground">「开通中」是已经付款、还没发好货的单；长时间不动请到账单里按订单号查支付日志。</p>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">流量最多的规则</CardTitle></CardHeader>
              <CardContent className="space-y-2.5">
                {data.traffic.topRules.length === 0 ? (
                  <div className="text-sm text-muted-foreground">这段时间没有流量。</div>
                ) : data.traffic.topRules.map((rule) => (
                  <BarRow key={rule.ruleId} label={rule.name} value={rule.bytes} max={data.traffic.topRules[0].bytes} text={formatBytes(rule.bytes)} />
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">来源地区</CardTitle></CardHeader>
              <CardContent className="space-y-2.5">
                {data.sources.areas.length === 0 ? (
                  <div className="text-sm text-muted-foreground">这段时间没有记录到来源 IP。要先在「在线 IP」里看过，Agent 才会开始上报。</div>
                ) : data.sources.areas.map((area) => (
                  <BarRow key={area.name} label={area.name} value={area.count} max={data.sources.areas[0].count} text={`${area.count} 个 IP`} />
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">来源 IP 排行</CardTitle></CardHeader>
            <CardContent>
              {data.sources.top.length === 0 ? (
                <div className="text-sm text-muted-foreground">这段时间没有记录到来源 IP。</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead className="text-meta text-muted-foreground">
                      <tr className="text-left">
                        <th className="py-1.5 pr-3 font-normal">IP</th>
                        <th className="py-1.5 pr-3 font-normal">地区</th>
                        <th className="py-1.5 pr-3 text-right font-normal">规则</th>
                        <th className="py-1.5 pr-3 text-right font-normal">最多同时连接</th>
                        <th className="py-1.5 text-right font-normal">最后出现</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sources.top.map((row) => (
                        <tr key={row.ip} className="border-t border-[var(--fx-stroke-weak)]">
                          <td className="py-1.5 pr-3 font-mono text-xs">{row.ip}</td>
                          <td className="max-w-[12rem] truncate py-1.5 pr-3" title={row.isp ? `${row.area} · ${row.isp}` : row.area}>{row.area}{row.isp ? <span className="text-muted-foreground"> · {row.isp}</span> : null}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{row.rules}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{row.conns}</td>
                          <td className="py-1.5 text-right text-muted-foreground tabular-nums">{relativeTime(row.lastSeen, data.generatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
