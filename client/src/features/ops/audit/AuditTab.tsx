import { useEffect, useMemo, useState } from "react";
import { Loader2, ScrollText, Search } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { OPERATION_AUDIT_RETENTION_OPTIONS, operationAuditModuleLabel, type OperationAuditResult } from "@shared/operationAudit";

import AuditDetailDialog from "./AuditDetailDialog";
import {
  RANGE_OPTIONS,
  RESULT_TONE,
  auditChannelLabel,
  auditOperationParts,
  auditResultLabel,
  formatAuditDuration,
  formatAuditTime,
  type AuditListItem,
  type AuditRange,
} from "./auditFormat";

/*
  监控 › 操作审计：所有人的写操作，一次一行，新的在上。

  电脑上是一张表（时间 / 操作人 / 操作 / 结果 / 来源·IP / 耗时），手机上每行两截：操作 + 结果，下面一行谁、从哪、什么时候。
  筛选：结果、模块、操作人、时间范围，再加一个搜索框（过程名、操作人、IP、参数、出错原因里找）。
  点一行看详情：打过码的参数，以及这次请求改动的规则 / 主机 / 隧道 / 转发组字段。
  筛选栏最后是保留天数，默认 90 天，过期的每天清掉。
*/

type ResultFilter = "all" | OperationAuditResult;

const RESULT_OPTIONS: Array<{ value: ResultFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "ok", label: "成功" },
  { value: "denied", label: "被拒绝" },
  { value: "error", label: "失败" },
];

function useDebounced<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function AuditRow({ item, onOpen }: { item: AuditListItem; onOpen: () => void }) {
  const op = auditOperationParts(item);
  const actor = item.actorName || (item.actorUserId ? `#${item.actorUserId}` : "—");
  const result = <Badge tone={RESULT_TONE[item.result]} size="sm" className="fx-audit-badge shrink-0">{auditResultLabel(item.result)}</Badge>;
  return (
    <button type="button" className="fx-audit-row" data-result={item.result} onClick={onOpen} style={{ minHeight: 0 }}>
      {/* 手机：两截 */}
      <span className="fx-audit-row-mobile">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-secondary-type font-medium text-foreground">
            {op.module} <code className="fx-audit-code font-normal text-muted-foreground">{op.procedure}</code>
          </span>
          {result}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          <span className="truncate">{actor} · {auditChannelLabel(item)}{item.ip ? ` · ${item.ip}` : ""}</span>
          <span className="fx-audit-time ml-auto shrink-0 tabular-nums">{formatAuditTime(item.createdAt)}</span>
        </span>
      </span>
      {/* 电脑：一行一条 */}
      <span className="fx-audit-row-desktop">
        <span className="fx-audit-time truncate tabular-nums text-muted-foreground">{formatAuditTime(item.createdAt)}</span>
        <span className="truncate text-foreground" title={actor}>{actor}</span>
        <span className="min-w-0 truncate text-foreground" title={item.path}>
          {op.module} <code className="fx-audit-code text-muted-foreground">{op.procedure}</code>
        </span>
        <span>{result}</span>
        <span className="truncate text-muted-foreground" title={item.userAgent || undefined}>{auditChannelLabel(item)}{item.ip ? ` · ${item.ip}` : ""}</span>
        <span className="fx-audit-dur text-right tabular-nums text-muted-foreground">{formatAuditDuration(item.durationMs)}</span>
      </span>
    </button>
  );
}

export default function AuditTab(_props: Record<string, never>) {
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [range, setRange] = useState<AuditRange>("7d");
  const [searchText, setSearchText] = useState("");
  const [selected, setSelected] = useState<AuditListItem | null>(null);
  const search = useDebounced(searchText.trim(), 300);
  const utils = trpc.useUtils();

  // 时间范围的起点在选的那一刻定下来，不跟着分钟变（否则查询键每分钟都变，列表反复重拉）
  const sinceSeconds = useMemo(() => {
    const option = RANGE_OPTIONS.find((item) => item.value === range);
    return option && option.seconds > 0 ? Math.floor(Date.now() / 1000) - option.seconds : null;
  }, [range]);

  const listQuery = trpc.ops.audit.list.useInfiniteQuery(
    {
      result: resultFilter === "all" ? null : resultFilter,
      module: moduleFilter === "all" ? null : moduleFilter,
      actorUserId: actorFilter === "all" ? null : Number(actorFilter),
      sinceSeconds,
      search: search || null,
      limit: 50,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      refetchInterval: pollingInterval("slow"),
      placeholderData: (previous) => previous,
    },
  );
  const facetsQuery = trpc.ops.audit.facets.useQuery(undefined, { staleTime: 60_000 });
  const settingsQuery = trpc.ops.audit.settings.useQuery(undefined, { staleTime: 60_000 });
  const setRetention = trpc.ops.audit.setRetention.useMutation({
    onSuccess: (data) => {
      toast.success(`操作审计改为保留 ${data.retentionDays} 天`);
      void utils.ops.audit.settings.invalidate();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const items = useMemo<AuditListItem[]>(
    () => (listQuery.data?.pages ?? []).flatMap((page) => page.items as AuditListItem[]),
    [listQuery.data?.pages],
  );
  const modules = facetsQuery.data?.modules ?? [];
  const actors = facetsQuery.data?.actors ?? [];
  const retentionDays = settingsQuery.data?.retentionDays;
  const retentionOptions = useMemo(() => {
    const values = new Set<number>(OPERATION_AUDIT_RETENTION_OPTIONS);
    if (retentionDays) values.add(retentionDays);
    return [...values].sort((a, b) => a - b);
  }, [retentionDays]);
  const filtered = resultFilter !== "all" || moduleFilter !== "all" || actorFilter !== "all" || range !== "all" || !!search;
  const resetFilters = () => {
    setResultFilter("all");
    setModuleFilter("all");
    setActorFilter("all");
    setRange("all");
    setSearchText("");
  };

  return (
    <div className="fx-audit flex min-w-0 flex-col gap-4">
      <div className="fx-audit-toolbar flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            {/* fx-search-pill：和转发 / 主机页同一种搜索框（各主题有自己的样子，输入框不定位、不会盖住放大镜） */}
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索过程、操作人、IP、参数"
              aria-label="搜索操作审计"
              className="fx-search-pill w-full"
              maxLength={64}
            />
          </div>
          <SegmentedControl ariaLabel="结果" value={resultFilter} options={RESULT_OPTIONS} onChange={setResultFilter} listClassName="grid grid-cols-4 gap-1" />
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <Select value={moduleFilter} onValueChange={setModuleFilter}>
            <SelectTrigger className="h-9 w-full sm:w-44" aria-label="模块"><SelectValue placeholder="全部模块" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模块</SelectItem>
              {modules.map((item) => (
                <SelectItem key={item.module} value={item.module}>{operationAuditModuleLabel(item.module)}（{item.count}）</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actorFilter} onValueChange={setActorFilter}>
            <SelectTrigger className="h-9 w-full sm:w-40" aria-label="操作人"><SelectValue placeholder="全部操作人" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作人</SelectItem>
              {actors.map((item) => (
                <SelectItem key={item.userId} value={String(item.userId)}>{item.name}（{item.count}）</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={(value) => setRange(value as AuditRange)}>
            <SelectTrigger className="h-9 w-full sm:w-36" aria-label="时间范围"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select
            value={retentionDays ? String(retentionDays) : undefined}
            onValueChange={(value) => setRetention.mutate({ days: Number(value) })}
            disabled={!retentionDays || setRetention.isPending}
          >
            <SelectTrigger className="h-9 w-full sm:ml-auto sm:w-36" aria-label="保留天数"><SelectValue placeholder="保留天数" /></SelectTrigger>
            <SelectContent>
              {retentionOptions.map((days) => <SelectItem key={days} value={String(days)}>保留 {days} 天</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {listQuery.isLoading ? (
        <DataSectionLoading label="正在读取操作审计" />
      ) : listQuery.isError && items.length === 0 ? (
        <DataSectionError label="操作审计" error={listQuery.error} onRetry={() => { void listQuery.refetch(); }} retrying={listQuery.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title={filtered ? "没有符合条件的记录" : "还没有操作记录"}
          description={filtered
            ? "换个筛选条件看看。"
            : "谁在什么时候改了设置、用户、套餐、计费、规则、令牌……每一次写操作都会记在这里，密码和密钥会自动隐藏。"}
          actions={filtered ? <Button variant="outline" size="sm" onClick={resetFilters}>清除筛选</Button> : undefined}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="fx-audit-list overflow-hidden rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]">
            <div className="fx-audit-head" aria-hidden="true">
              <span>时间</span><span>操作人</span><span>操作</span><span>结果</span><span>来源 · IP</span><span className="text-right">耗时</span>
            </div>
            {items.map((item) => <AuditRow key={item.id} item={item} onOpen={() => setSelected(item)} />)}
          </div>
          {listQuery.hasNextPage ? (
            <Button
              variant="outline"
              className="w-full sm:w-auto sm:self-center"
              disabled={listQuery.isFetchingNextPage}
              onClick={() => { void listQuery.fetchNextPage(); }}
            >
              {listQuery.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              加载更多
            </Button>
          ) : (
            <div className="text-center text-meta text-muted-foreground">只保留最近 {retentionDays ?? 90} 天</div>
          )}
        </div>
      )}

      <AuditDetailDialog item={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </div>
  );
}
