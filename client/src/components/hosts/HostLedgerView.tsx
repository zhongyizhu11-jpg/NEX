import { useEffect, type ReactNode } from "react";
import { Wallet } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import { LedgerRow } from "@/components/LedgerRow";
import { formatBytes } from "@shared/formatBytes";
import { formatMoneyCents } from "@shared/formatMoney";
import { formatBillingDateInput } from "@shared/billingTime";
import { hostCycleLabel, type HostLedgerRow, type HostLedgerSummary } from "@shared/hostLedger";

/*
  主机管理 →「账本」页签（只给管理员）。数据全在服务端算好（trpc.hosts.ledger → shared/hostLedger.ts），
  这里只管怎么摆。

  手机上一行一台：名字和每月多少钱在第一行，到期、流量、95 值在第二行，有事的那一项变色。
  电脑上是表格。不加图表、不加筛选 —— 这一页回答的就是三件事：花多少、哪台快到期、哪台流量要不够。
*/

const WARN = "text-[var(--fx-warn-text)]";
const DOWN = "text-[var(--fx-down-text)]";

function money(cents: number, currency: string) {
  return formatMoneyCents(Math.round(cents), currency);
}

function monthlyText(row: HostLedgerRow) {
  if (row.monthlyTotalCents <= 0) return "—";
  return `${row.p95CostCents !== null ? "约 " : ""}${money(row.monthlyTotalCents, row.currency)}/月`;
}

/** 月费那一格的小字：季付、年付写出原价；95 计费写出固定 + 95 两部分。 */
function monthlyDetail(row: HostLedgerRow) {
  const parts: string[] = [];
  if (row.costCents > 0 && row.cycleMonths > 1) parts.push(`${money(row.costCents, row.currency)}/${hostCycleLabel(row.cycleMonths)}`);
  if (row.p95CostCents !== null) parts.push(`95 约 ${money(row.p95CostCents, row.currency)}`);
  return parts.join(" · ");
}

function expiryNode(row: HostLedgerRow, withDate = false): ReactNode {
  const { daysLeft, expiresAtMs, soon } = row.expiry;
  if (daysLeft === null || expiresAtMs === null) return <span className="text-muted-foreground">没填到期</span>;
  const date = formatBillingDateInput(expiresAtMs);
  const text = daysLeft < 0 ? `已过期 ${-daysLeft} 天` : daysLeft === 0 ? "今天到期" : `${daysLeft} 天后到期`;
  return (
    <span className={cn(daysLeft < 0 ? DOWN : soon ? WARN : undefined)} title={`到期：${date}`}>
      {text}{withDate ? <span className="ml-1 text-muted-foreground">{date}</span> : null}
    </span>
  );
}

function usedText(row: HostLedgerRow) {
  return row.limitBytes > 0 ? `${formatBytes(row.usedBytes)} / ${formatBytes(row.limitBytes)}` : `已用 ${formatBytes(row.usedBytes)}`;
}

/** 剩余低于「流量耗尽提醒」阈值时标黄（和提醒同一个判断）。 */
function usedNode(row: HostLedgerRow): ReactNode {
  return <span className={cn(row.trafficReminderDue && WARN)}>{usedText(row)}</span>;
}

/** 费用、到期、额度一样都没填、也没跑过流量的机器：手机上一句话带过，不摆一串「—」。 */
function isBlankRow(row: HostLedgerRow) {
  return row.monthlyTotalCents <= 0 && row.expiry.daysLeft === null && row.limitBytes <= 0 && row.usedBytes <= 0 && !row.p95;
}

function projectionNode(row: HostLedgerRow): ReactNode {
  const p = row.projection;
  if (p.exceeded) return <span className={DOWN}>已超额</span>;
  if (p.projectedBytes === null) {
    return <span className="text-muted-foreground" title="没开每月重置、也没填到期时间，说不出周期末是哪天">—</span>;
  }
  const exhaust = p.exhaustAtMs !== null ? `，约 ${formatBillingDateInput(p.exhaustAtMs)} 用完` : "";
  return (
    <span className={cn(p.willExceed && DOWN)} title={p.lowSample ? "周期刚开始，按几个小时的速度外推，只是粗估" : undefined}>
      预计 {formatBytes(p.projectedBytes)}{p.willExceed ? ` 会超${exhaust}` : ""}{p.lowSample ? "（粗估）" : ""}
    </span>
  );
}

function budgetText(row: HostLedgerRow) {
  const budget = row.projection.dailyBudgetBytes;
  return budget === null ? null : `每天还能用 ${formatBytes(budget)}`;
}

const SHORT_REASON: Record<string, string> = {
  no_samples: "还没有采样",
  too_few: "不到一天的样本",
  low_coverage: "这个周期缺了不少采样",
};

function p95Node(row: HostLedgerRow): ReactNode {
  const p95 = row.p95;
  if (!p95) return null;
  if (p95.mbps === null) return <span className="text-muted-foreground" title="开了 95 计费后面板每 5 分钟记一次网卡速率">95 值：还没有采样</span>;
  const title = `本周期 ${p95.samples} 个 5 分钟样本（应有 ${p95.expectedSamples} 个）${p95.shortReason ? `：${SHORT_REASON[p95.shortReason] ?? ""}` : ""}`;
  return (
    <span title={title}>
      95 值 {p95.mbps.toFixed(1)} Mbps
      <span className={cn("ml-1", p95.sufficient ? "text-muted-foreground" : WARN)}>{p95.sufficient ? "估算" : "估算 · 样本不足"}</span>
    </span>
  );
}

function joinNodes(nodes: Array<ReactNode | null | false>) {
  const present = nodes.filter((node): node is Exclude<ReactNode, null | false | undefined> => node !== null && node !== false && node !== undefined && node !== "");
  return present.map((node, index) => (
    <span key={index}>{index > 0 ? " · " : ""}{node}</span>
  ));
}

function SummaryTile({ label, children, sub, tone }: { label: string; children: ReactNode; sub?: ReactNode; tone?: "warn" | "down" }) {
  return (
    <div className="min-w-0 rounded-[var(--fx-radius-card)] border border-border/50 bg-[var(--fx-l1-surface)] px-3 py-2.5">
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 min-w-0 text-base font-semibold tabular-nums sm:text-lg", tone === "warn" && WARN, tone === "down" && DOWN)}>{children}</div>
      {sub ? <div className="mt-0.5 text-meta leading-snug text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function LedgerSummary({ summary }: { summary: HostLedgerSummary }) {
  const unpriced = summary.totalHosts - summary.pricedHosts;
  const estimate = summary.monthlyByCurrency.some((item) => item.includesP95Estimate);
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      <SummaryTile
        label="每月成本"
        sub={[estimate ? "含 95 估算" : "", unpriced > 0 ? `${unpriced} 台没填` : ""].filter(Boolean).join(" · ") || undefined}
      >
        {summary.monthlyByCurrency.length === 0 ? "—" : summary.monthlyByCurrency.map((item) => (
          <div key={item.currency} className="truncate">{formatMoneyCents(item.cents, item.currency)}</div>
        ))}
      </SummaryTile>
      <SummaryTile
        label="30 天内到期"
        tone={summary.expiringWithin30Days > 0 ? "warn" : undefined}
        sub={summary.expired > 0 ? <span className={DOWN}>另有 {summary.expired} 台已过期</span> : undefined}
      >
        {summary.expiringWithin30Days} 台
      </SummaryTile>
      <SummaryTile label="流量快用完" tone={summary.trafficTight > 0 ? "down" : undefined}>
        {summary.trafficTight} 台
      </SummaryTile>
    </div>
  );
}

export function HostLedgerView({
  searchQuery = "",
  onFilterStatsChange,
}: {
  searchQuery?: string;
  /** 搜索框右边那个「几 / 几 台」。 */
  onFilterStatsChange?: (stats: { filtered: number; total: number }) => void;
}) {
  const query = trpc.hosts.ledger.useQuery(undefined, { staleTime: 30_000, refetchOnWindowFocus: false });
  const keyword = searchQuery.trim().toLowerCase();
  const allRows = query.data?.rows ?? [];
  const rows = keyword ? allRows.filter((row) => row.name.toLowerCase().includes(keyword)) : allRows;
  useEffect(() => {
    onFilterStatsChange?.({ filtered: rows.length, total: allRows.length });
  }, [onFilterStatsChange, rows.length, allRows.length]);
  if (query.isLoading) return <DataSectionLoading label="正在加载账本" minHeight="min-h-[260px]" />;
  if (query.error && !query.data) {
    return <DataSectionError label="主机账本" error={query.error} retrying={query.isFetching} onRetry={() => { void query.refetch(); }} />;
  }
  const data = query.data;
  if (!data || data.rows.length === 0) {
    return <EmptyState icon={<Wallet className="h-8 w-8 opacity-40" />} title="还没有主机" />;
  }
  return (
    <div className="space-y-3" data-testid="host-ledger">
      <LedgerSummary summary={data.summary} />
      {data.summary.pricedHosts === 0 ? (
        <p className="text-xs text-muted-foreground">在主机编辑 → 其他配置 → 费用 里填上每期多少钱，这里就会算出每月成本。</p>
      ) : null}
      <Card>
        <CardContent className="px-4 py-1 md:p-0">
          {/* 手机上不画表：七列挤进 390px 只剩省略号。 */}
          <div className="md:hidden" data-testid="host-ledger-mobile">
            {rows.map((row) => (
              <LedgerRow
                key={row.hostId}
                title={row.name}
                amount={monthlyText(row)}
                amountClassName={row.monthlyTotalCents > 0 ? undefined : "font-normal text-muted-foreground"}
                meta={isBlankRow(row) ? "费用、到期、流量额度都没填" : (
                  <>
                    <span className="block">{joinNodes([expiryNode(row), monthlyDetail(row) || null])}</span>
                    <span className="block">{joinNodes([
                      usedNode(row),
                      row.projection.projectedBytes !== null || row.projection.exceeded ? projectionNode(row) : null,
                      budgetText(row),
                    ])}</span>
                    {row.p95 ? <span className="block">{p95Node(row)}</span> : null}
                  </>
                )}
              />
            ))}
            {rows.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的主机</p> : null}
          </div>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>主机</TableHead>
                  <TableHead>每月</TableHead>
                  <TableHead>下次到期</TableHead>
                  <TableHead>本周期流量</TableHead>
                  <TableHead>到周期末</TableHead>
                  <TableHead>每天还能用</TableHead>
                  <TableHead>95 值</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.hostId}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      <div>{monthlyText(row)}</div>
                      {monthlyDetail(row) ? <div className="text-xs text-muted-foreground">{monthlyDetail(row)}</div> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{expiryNode(row, true)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{usedNode(row)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{projectionNode(row)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{row.projection.dailyBudgetBytes === null ? "—" : `${formatBytes(row.projection.dailyBudgetBytes)}/天`}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{row.p95 ? p95Node(row) : <span className="text-muted-foreground">—</span>}</TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">没有匹配的主机</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
