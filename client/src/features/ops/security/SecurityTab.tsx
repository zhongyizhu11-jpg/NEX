import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, ShieldCheck } from "lucide-react";
import { useSearch } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../server/routers";
import { toast } from "sonner";
import EmptyState from "@/components/EmptyState";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FilterChips } from "@/components/ui/filter-chips";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { SeverityBadge, evidenceEntries, formatDateTime, type Severity } from "./securityParts";

/*
  监控 › 安全巡检（#3）。

  一张卡一条发现：级别、标题、哪台主机、第一次 / 最近一次看到、证据，下面是能做的事。
  ?host=<id> 进来时（主机详情「安全」一节的链接）预先按那台主机筛。
  停止进程、隔离文件只在确认后发给 Agent，Agent 核对发现仍然成立才动手。
*/

type StatusFilter = "open" | "acknowledged" | "expected" | "all";
type SeverityFilter = "all" | "medium" | "high" | "critical";
const ALL = "all";

const STATUS_CHIPS: Array<{ value: StatusFilter; label: string }> = [
  { value: "open", label: "待处理" },
  { value: "acknowledged", label: "已知道" },
  { value: "expected", label: "我的" },
  { value: "all", label: "全部" },
];

function hostFromSearch(search: string) {
  const id = Number(new URLSearchParams(search).get("host"));
  return Number.isInteger(id) && id > 0 ? String(id) : ALL;
}

export default function SecurityTab(_props: Record<string, never>) {
  const search = useSearch();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [severity, setSeverity] = useState<SeverityFilter>(ALL);
  const [hostFilter, setHostFilter] = useState<string>(() => hostFromSearch(search));
  useEffect(() => {
    const fromUrl = hostFromSearch(search);
    if (fromUrl !== ALL) setHostFilter(fromUrl);
  }, [search]);

  const listInput = {
    status,
    minSeverity: severity === ALL ? undefined : severity,
    hostId: hostFilter === ALL ? undefined : Number(hostFilter),
  };
  const list = trpc.ops.hostSecurity.list.useQuery(listInput, {
    placeholderData: (prev) => prev,
    // 有动作在等 Agent 回话时 3 秒一刷，平时 30 秒。
    refetchInterval: (query) => {
      const items = (query.state.data as { items?: FindingItem[] } | undefined)?.items || [];
      return items.some((item) => item.actionPending) ? pollingInterval("active") : pollingInterval("slow");
    },
  });
  const data = list.data;

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Agent 每隔几分钟把主机看一遍：新开的对外端口、新的登录账号、SSH 钥匙、sudo 和定时任务、新的系统服务和内核模块、
        从临时目录运行或像在挖矿的进程、长时间占满 CPU 的陌生程序、SSH 登录，以及 Agent 自己有没有被替换。第一次只记下现状，
        之后有变化才会出现在这里。「知道了」表示看过了，同样的事再发生会重新提醒；「这是我的」表示是你自己弄的，以后不再提醒；
        「重新打开」撤销这两种标记。停止进程、隔离文件都要你确认后才会执行，账号和钥匙不会被自动改动。
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <FilterChips items={STATUS_CHIPS} value={status} onChange={setStatus} ariaLabel="状态" />
        <div className="flex gap-2 sm:ml-auto">
          <Select value={severity} onValueChange={(value) => setSeverity(value as SeverityFilter)}>
            <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-32 sm:flex-none" aria-label="级别"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>所有级别</SelectItem>
              <SelectItem value="medium">中及以上</SelectItem>
              <SelectItem value="high">高及以上</SelectItem>
              <SelectItem value="critical">只看严重</SelectItem>
            </SelectContent>
          </Select>
          <Select value={hostFilter} onValueChange={setHostFilter}>
            <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-44 sm:flex-none" aria-label="主机"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>所有主机</SelectItem>
              {(data?.hosts || []).map((h) => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}
              {hostFilter !== ALL && data && !data.hosts.some((h) => String(h.id) === hostFilter)
                ? <SelectItem value={hostFilter}>主机 #{hostFilter}</SelectItem>
                : null}
            </SelectContent>
          </Select>
        </div>
      </div>

      {list.isLoading ? (
        <DataSectionLoading label="正在读取巡检结果" />
      ) : list.error && !data ? (
        <DataSectionError label="巡检结果" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={status === "open" ? "巡检没有发现需要你处理的事" : "这里没有记录"}
          description={status === "open" ? "有新情况时会出现在这里；严重和高危的还会记进事件并发 Telegram。" : "换个筛选看看。"}
        />
      ) : (
        <div className="space-y-3">
          {data.items.map((item, index) => <FindingCard key={item.id} item={item} index={index} />)}
        </div>
      )}
    </div>
  );
}

type FindingItem = inferRouterOutputs<AppRouter>["ops"]["hostSecurity"]["list"]["items"][number];

const ACTION_LABEL: Record<"kill" | "quarantine" | "restore", string> = { kill: "停止进程", quarantine: "隔离文件", restore: "撤销隔离" };

function FindingCard({ item, index }: { item: FindingItem; index: number }) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const refresh = () => utils.ops.hostSecurity.list.invalidate();
  const decide = trpc.ops.hostSecurity.decide.useMutation({
    onSuccess: () => { void refresh(); void utils.ops.hostSecurity.hostSummary.invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  const act = trpc.ops.hostSecurity.act.useMutation({
    onSuccess: () => { toast.success("已发给 Agent，执行完会在这里显示结果"); void refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const undo = trpc.ops.hostSecurity.undo.useMutation({
    onSuccess: () => { toast.success("已发给 Agent，文件会被放回原处"); void refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const busy = decide.isPending || act.isPending || undo.isPending;
  const evidence = useMemo(() => evidenceEntries(item.evidence), [item.evidence]);
  const lastAction = item.actions[item.actions.length - 1];

  const runAction = async (action: "kill" | "quarantine" | "restore") => {
    const exe = String(item.evidence.exe || "");
    const pid = String(item.evidence.pid || "");
    const description = action === "kill"
      ? `会先让进程 ${pid}（${exe}）自己退出，5 秒内不退就强制结束。Agent 会先核对这个进程还是发现时那个程序，对不上就不动手。`
      : action === "quarantine"
        ? `会把 ${exe} 移到 Agent 的隔离区并去掉所有权限，之后可以「撤销隔离」放回原处。文件内容和发现时不一样就不动手。正在运行的进程不会因此停止。`
        : `会把隔离区里的文件放回 ${exe}，恢复原来的权限。`;
    const ok = await confirm({
      title: `${ACTION_LABEL[action]}？`,
      description,
      confirmText: ACTION_LABEL[action],
      tone: action === "restore" ? "default" : "destructive",
    });
    if (!ok) return;
    if (action === "restore") undo.mutate({ id: item.id });
    else act.mutate({ id: item.id, action });
  };

  return (
    // 内边距放在里面那层：手机上 workspace.css 会把卡片自身的 padding 清零。
    <Card enterIndex={index}>
      <div className="flex min-w-0 flex-col gap-2.5 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-start gap-2">
        <SeverityBadge severity={item.severity as Severity} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-[14px] font-semibold leading-snug text-foreground">{item.title}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {item.hostName} · 首次 {formatDateTime(item.firstSeenAt)} · 最近 {formatDateTime(item.lastSeenAt)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {item.status === "acknowledged" ? <StatusPill>已知道</StatusPill> : null}
        {item.status === "expected" ? <StatusPill>{item.expectedScope === "all" ? "我的 · 所有主机都不提醒" : "我的 · 这台不再提醒"}</StatusPill> : null}
        {item.persistent && item.resolvedAt ? <StatusPill tone="ok">{formatDateTime(item.resolvedAt)} 起已经没有了</StatusPill> : null}
        {item.persistent && !item.resolvedAt ? <StatusPill>仍然存在</StatusPill> : null}
      </div>

      {item.detail ? <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{item.detail}</p> : null}

      {evidence.length > 0 ? (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-[var(--fx-l3-control-fill)] px-3 py-2 text-[12.5px]">
          {evidence.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="whitespace-nowrap text-muted-foreground">{entry.label}</dt>
              <dd className={entry.mono ? "min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] text-foreground" : "min-w-0 break-words text-foreground"}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {item.actionPending ? (
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Loader2 className="forwardx-icon-spin h-3.5 w-3.5" aria-hidden="true" />
          正在等 Agent 执行「{lastAction ? ACTION_LABEL[lastAction.action] : "操作"}」……
        </p>
      ) : lastAction && lastAction.status !== "pending" ? (
        <p className={lastAction.status === "done" ? "text-[12.5px] text-[var(--fx-healthy-text)]" : "text-[12.5px] text-[var(--fx-down-text)]"}>
          {ACTION_LABEL[lastAction.action]}{lastAction.status === "done" ? "完成" : "没有执行"}：{lastAction.message || "—"}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-[var(--fx-stroke-weak)] pt-2.5">
        {item.status === "open" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => decide.mutate({ id: item.id, decision: "acknowledge" })}>知道了</Button>
        ) : null}
        {item.status !== "expected" ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy}>这是我的<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onSelect={() => decide.mutate({ id: item.id, decision: "expected", scope: "host" })}>只是这台主机</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => decide.mutate({ id: item.id, decision: "expected", scope: "all" })}>所有主机都不再提醒</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {item.status !== "open" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide.mutate({ id: item.id, decision: "reopen" })}>重新打开</Button>
        ) : null}
        {item.availableActions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === "restore" ? "outline" : "ghost"}
            className={action === "restore" ? undefined : "text-[var(--fx-down-text)]"}
            disabled={busy}
            onClick={() => void runAction(action)}
          >
            {ACTION_LABEL[action]}
          </Button>
        ))}
      </div>
      </div>
    </Card>
  );
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone?: "ok" }) {
  return (
    <span className={tone === "ok"
      ? "rounded-full bg-[var(--fx-healthy-soft)] px-2 py-0.5 text-[11.5px] text-[var(--fx-healthy-text)]"
      : "rounded-full border border-[var(--fx-stroke-base)] px-2 py-0.5 text-[11.5px] text-muted-foreground"}
    >
      {children}
    </span>
  );
}
