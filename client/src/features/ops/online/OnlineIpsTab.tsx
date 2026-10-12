import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, History, Radio, Search, Users2 } from "lucide-react";
import { formatAgo } from "@shared/dashboardAttention";
import EmptyState from "@/components/EmptyState";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterChips } from "@/components/ui/filter-chips";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { segmentedControlClassName, segmentedIconClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { cn } from "@/lib/utils";
import { BlockIpButton, LiveIpRowItem, OutdatedAgentNotice, limitText, regionText, useOnlineIpsWatch } from "./onlineIpParts";

/*
  监控 › 在线 IP（#6）。

  当前在线：谁此刻连着哪台机器的哪条规则，按用户分组，每组顶上写「在线几个 IP / 上限几个」，
  到了上限只标一句「IP 数已到设置的上限」：现有的 maxIPs 是 iptables connlimit 按单个来源 IP 限连接数（agentHeartbeatRoute.ts buildAccessLimitCmds，mask 32），并不拒绝第 N+1 个 IP，所以不能说「新设备会被拒绝」。开着这一页时 Agent 10 秒报一次（useOnlineIpsWatch），平时 60 秒。
  IP 历史：最近 1 / 7 / 30 / 90 天出现过的 IP，谁用过、在哪些主机上、最后一次什么时候。
*/

type View = "live" | "history";
const ALL = "all";

export default function OnlineIpsTab(_props: Record<string, never>) {
  const [view, setView] = useState<View>("live");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="在线 IP" className={cn(segmentedControlClassName, "inline-flex w-full max-w-sm")}>
        {([
          { value: "live" as const, label: "当前在线", icon: Radio },
          { value: "history" as const, label: "IP 历史", icon: History },
        ]).map((item) => {
          const active = view === item.value;
          const Icon = item.icon;
          return (
            <button key={item.value} type="button" role="tab" aria-selected={active} className={segmentedOptionClassName(active, false, "flex-1")} onClick={() => setView(item.value)}>
              <Icon className={segmentedIconClassName(active)} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>
      {view === "live" ? <LiveView /> : <HistoryView />}
    </div>
  );
}

function LiveView() {
  useOnlineIpsWatch(true);
  const [userFilter, setUserFilter] = useState<string>(ALL);
  const [hostFilter, setHostFilter] = useState<string>(ALL);
  const live = trpc.ops.onlineIps.live.useQuery(
    { hostId: hostFilter === ALL ? undefined : Number(hostFilter) },
    { refetchInterval: pollingInterval("fast"), placeholderData: (prev) => prev },
  );
  const data = live.data;
  const groups = useMemo(() => {
    const all = data?.users || [];
    return userFilter === ALL ? all : all.filter((g) => String(g.userId) === userFilter);
  }, [data, userFilter]);

  if (live.isLoading) return <DataSectionLoading label="正在读取在线 IP" />;
  if (live.error && !data) return <DataSectionError label="在线 IP" error={live.error} onRetry={() => live.refetch()} retrying={live.isFetching} />;
  if (!data) return null;

  const rowCount = groups.reduce((sum, g) => sum + g.rows.length, 0);
  return (
    <div className="space-y-3">
      <OutdatedAgentNotice hosts={data.outdatedHosts} minVersion={data.minAgentVersion} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={userFilter} onValueChange={setUserFilter}>
          <SelectTrigger className="h-9 w-full sm:w-44" aria-label="按用户筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>所有用户</SelectItem>
            {(data.users || []).map((g) => <SelectItem key={g.userId} value={String(g.userId)}>{g.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={hostFilter} onValueChange={setHostFilter}>
          <SelectTrigger className="h-9 w-full sm:w-44" aria-label="按主机筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>所有主机</SelectItem>
            {data.hosts.map((h) => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-[12.5px] text-muted-foreground sm:ml-auto">
          {groups.length} 个用户 · {data.totalIps} 个 IP · 每 {data.intervalSeconds} 秒更新
        </p>
      </div>

      {rowCount === 0 ? (
        <EmptyState
          icon={<Users2 />}
          title="现在没有人在连"
          description={data.reportingHosts === 0 ? "还没有主机报上在线情况，Agent 升级到新版后一两分钟内就会有。" : "有人连上规则或入站端口后，这里几秒内就会出现。"}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group, index) => (
            // 内边距放在里面那层：手机上 workspace.css 会把卡片自身的 padding 清零。
            <Card key={group.userId} enterIndex={index}>
              <div className="px-3 py-2.5 sm:px-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--fx-stroke-weak)] pb-2">
                <h3 className="min-w-0 truncate text-[14px] font-semibold text-foreground">
                  {group.name}
                  <span className="ml-1.5 font-normal text-muted-foreground">· {limitText(group.ipCount, group.limit)}</span>
                </h3>
                {group.atLimit ? (
                  <span className="rounded-full bg-[var(--fx-down-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--fx-down-text)]">
                    IP 数已到设置的上限
                  </span>
                ) : null}
              </div>
              <ul className="divide-y divide-[var(--fx-stroke-weak)]">
                {group.rows.map((row) => <LiveIpRowItem key={`${row.hostId}-${row.port}-${row.ip}`} row={row} />)}
              </ul>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function userNames(users: Array<{ name: string }>) {
  return users.map((u) => u.name).join("、") || "未归属";
}

const DAY_CHIPS = [
  { value: "1", label: "1 天" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
] as const;

function HistoryView() {
  const [days, setDays] = useState<"1" | "7" | "30" | "90">("7");
  const [hostFilter, setHostFilter] = useState<string>(ALL);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const history = trpc.ops.onlineIps.history.useQuery(
    {
      days: Number(days) as 1 | 7 | 30 | 90,
      hostId: hostFilter === ALL ? undefined : Number(hostFilter),
      search: search || undefined,
      page,
      pageSize: 30,
    },
    { placeholderData: (prev) => prev },
  );
  const data = history.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <FilterChips
          items={DAY_CHIPS}
          value={days}
          onChange={(value) => { setDays(value); setPage(1); }}
          ariaLabel="时间范围"
        />
        <div className="flex gap-2 sm:ml-auto">
          <Select value={hostFilter} onValueChange={(value) => { setHostFilter(value); setPage(1); }}>
            <SelectTrigger className="h-9 w-36 shrink-0 sm:w-44" aria-label="按主机筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>所有主机</SelectItem>
              {(data?.hosts || []).map((h) => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <form
            className="relative min-w-0 flex-1 sm:w-56 sm:flex-none"
            onSubmit={(event) => { event.preventDefault(); setSearch(searchText.trim()); setPage(1); }}
          >
            <Search className="pointer-events-none absolute left-2.5 z-10 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onBlur={() => { if (searchText.trim() !== search) { setSearch(searchText.trim()); setPage(1); } }}
              placeholder="IP 或用户名"
              className="h-9 pl-8"
              aria-label="搜索 IP 或用户"
            />
          </form>
        </div>
      </div>

      {history.isLoading ? (
        <DataSectionLoading label="正在读取 IP 历史" />
      ) : history.error && !data ? (
        <DataSectionError label="IP 历史" error={history.error} onRetry={() => history.refetch()} retrying={history.isFetching} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={<History />} title={search ? "没有找到匹配的 IP" : "这段时间没有记录"} description="有人连过规则或入站端口，就会在这里留下记录，保留 90 天。" />
      ) : (
        <Card>
          <ul className="divide-y divide-[var(--fx-stroke-weak)] px-3 py-1 sm:px-4">
            {data.items.map((item) => (
              <li key={item.ip} className="flex min-w-0 flex-col gap-1 py-2.5 sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_11.5rem_4.5rem] sm:items-center sm:gap-3">
                <div className="flex min-w-0 items-center justify-between gap-2 sm:contents">
                  <span className="min-w-0 truncate font-mono text-[13px] text-foreground" title={item.ip}>{item.ip}</span>
                  <BlockIpButton ip={item.ip} className="sm:hidden" />
                </div>
                {/* 手机上两行：「地区 · 用户」「主机 · 时间」；桌面上各占一列。 */}
                <span className="min-w-0 truncate text-[12.5px] text-muted-foreground sm:text-[13px]">
                  {regionText(item.region)}
                  <span className="text-foreground sm:hidden"> · {userNames(item.users)}</span>
                </span>
                <span className="hidden min-w-0 truncate text-[13px] text-foreground sm:block" title={userNames(item.users)}>{userNames(item.users)}</span>
                <span className="min-w-0 truncate text-[12.5px] text-muted-foreground sm:text-[13px]" title={item.hosts.map((h) => h.name).join("、")}>
                  {item.hosts.map((h) => h.name).join("、")}
                  <span className="sm:hidden"> · {formatAgo(Date.now() - item.lastSeenAt * 1000)}出现 · 最多 {item.maxConn} 条</span>
                </span>
                <span className="hidden whitespace-nowrap text-right text-[13px] tabular-nums text-muted-foreground sm:block">
                  {formatAgo(Date.now() - item.lastSeenAt * 1000)}出现 · 最多 {item.maxConn} 条
                </span>
                <BlockIpButton ip={item.ip} className="hidden sm:inline-flex" />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
          <span>共 {data.total} 个 IP · 第 {data.page} / {totalPages} 页</span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page <= 1 || history.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />上一页
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages || history.isFetching} onClick={() => setPage((p) => p + 1)}>
              下一页<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
