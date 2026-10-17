/*
  工单页：用户的 /tickets 和管理员的 /admin/tickets 是同一个组件，mode 决定走哪套接口。

  桌面：左边列表、右边对话；手机：先看列表，点开一张后上面只留一条「返回列表」，下面是对话。
  打开的对话每 10 秒拉一次，列表每 30 秒拉一次（标签页在后台时 react-query 自己会停）。
  当前打开的是哪一张记在地址栏 ?id= 上，Telegram / 邮件里的链接能直接打开。
*/
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, Inbox, LifeBuoy, Loader2, Lock, Plus, RotateCcw, Search, Send } from "lucide-react";
import { toast } from "sonner";

import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  normalizeTicketContent,
  normalizeTicketTitle,
  TICKET_CONTENT_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TITLE_MAX_LENGTH,
  type TicketPriority,
  type TicketStatus,
  type TicketStatusFilter,
} from "@shared/tickets";

type Mode = "user" | "admin";
type StatusFilterValue = "all" | TicketStatusFilter;
type PriorityFilterValue = "all" | TicketPriority;

type TicketItem = {
  id: number;
  title: string;
  priority: TicketPriority;
  status: TicketStatus;
  lastMessageAt: Date | string | null;
  lastMessageByStaff: boolean;
  closedAt: Date | string | null;
  createdAt: Date | string | null;
  username?: string;
  userDeleted?: boolean;
};

type TicketMessage = {
  id: number;
  isStaff: boolean;
  mine: boolean;
  senderName: string;
  content: string;
  createdAt: Date | string | null;
};

const LIST_POLL_MS = 30_000;
const THREAD_POLL_MS = 10_000;

const STATUS_FILTER_OPTIONS: Array<{ value: StatusFilterValue; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "open", label: "未关闭" },
  { value: "waiting_staff", label: TICKET_STATUS_LABELS.waiting_staff },
  { value: "waiting_user", label: TICKET_STATUS_LABELS.waiting_user },
  { value: "closed", label: TICKET_STATUS_LABELS.closed },
];

/* 优先级：低浅蓝、中浅黄、高浅红，用主题里的软底 + 深字，深色主题跟着变。 */
const PRIORITY_BADGE_CLASS: Record<TicketPriority, string> = {
  low: "border-[color-mix(in_srgb,var(--fx-accent)_30%,transparent)] bg-[var(--fx-accent-soft)] text-[var(--fx-accent)]",
  medium: "border-[color-mix(in_srgb,var(--fx-warn)_35%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  high: "border-[color-mix(in_srgb,var(--fx-down)_35%,transparent)] bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
};

const STATUS_BADGE_CLASS: Record<TicketStatus, string> = {
  waiting_staff: "",
  waiting_user: "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  closed: "",
};

function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge variant={status === "closed" ? "secondary" : status === "waiting_staff" ? "outline" : "default"} className={STATUS_BADGE_CLASS[status]}>
      {TICKET_STATUS_LABELS[status]}
    </Badge>
  );
}

function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <Badge variant="outline" className={PRIORITY_BADGE_CLASS[priority]}>
      {TICKET_PRIORITY_LABELS[priority]}优先级
    </Badge>
  );
}

function toDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fullTime(value: Date | string | null | undefined) {
  const date = toDate(value);
  // 跟着界面用中文 24 小时制，不随浏览器语言变成 10/16/2026, 3:40:50 AM
  return date ? date.toLocaleString("zh-CN", { hour12: false }) : "";
}

/** 列表里的短时间：今天只写时分，今年写月日，再早写年月日。 */
function shortTime(value: Date | string | null | undefined) {
  const date = toDate(value);
  if (!date) return "";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readTicketIdFromSearch(search: string) {
  const id = Number(new URLSearchParams(search).get("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export default function Tickets({ mode = "user" }: { mode?: Mode }) {
  const isAdmin = mode === "admin";
  const basePath = isAdmin ? "/admin/tickets" : "/tickets";
  const utils = trpc.useUtils();
  const isMobile = useIsMobile();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const selectedId = readTicketIdFromSearch(search);
  const selectTicket = (id: number | null) => {
    setLocation(id ? `${basePath}?id=${id}` : basePath, { replace: true });
  };

  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>(isAdmin ? "open" : "all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilterValue>("all");
  const [keywordInput, setKeywordInput] = useState("");
  const keyword = useDebouncedValue(keywordInput.trim(), 300);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [statusFilter, priorityFilter, keyword]);

  const listInput = {
    status: statusFilter === "all" ? undefined : statusFilter,
    page,
  };
  const listOptions = { refetchInterval: LIST_POLL_MS, placeholderData: (previous: any) => previous };
  const userList = trpc.tickets.list.useQuery(listInput, { ...listOptions, enabled: !isAdmin });
  const adminList = trpc.tickets.adminList.useQuery({
    ...listInput,
    priority: priorityFilter === "all" ? undefined : priorityFilter,
    keyword: keyword || undefined,
  }, { ...listOptions, enabled: isAdmin });
  const list = isAdmin ? adminList : userList;
  const items = (list.data?.items || []) as TicketItem[];
  const total = list.data?.total || 0;
  const pageSize = list.data?.pageSize || 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const invalidateAll = () => {
    void utils.tickets.list.invalidate();
    void utils.tickets.get.invalidate();
    void utils.tickets.adminList.invalidate();
    void utils.tickets.adminGet.invalidate();
    void utils.tickets.adminCounts.invalidate();
  };

  const [createOpen, setCreateOpen] = useState(false);
  const createTicket = trpc.tickets.create.useMutation({
    onSuccess: (ticket) => {
      toast.success("工单已提交，管理员会尽快回复");
      setCreateOpen(false);
      setStatusFilter("all");
      invalidateAll();
      selectTicket(ticket.id);
    },
    onError: (error) => toast.error(error.message || "提交失败"),
  });

  const showList = !isMobile || !selectedId;
  const showThread = !isMobile || !!selectedId;

  // 工单总开关（server/routers/tickets.ts）：关掉后普通用户不能新建、回复；管理员在这里开关。
  const ticketStatus = trpc.tickets.status.useQuery(undefined, { staleTime: 30_000 });
  const ticketsOpen = ticketStatus.data?.enabled !== false;
  const setTicketsEnabled = trpc.tickets.adminSetEnabled.useMutation({
    onSuccess: (result) => {
      toast.success(result.enabled ? "已开放工单" : "已关闭工单，普通用户暂时不能提交和回复");
      void utils.tickets.status.invalidate();
      void utils.system.publicInfo.invalidate();
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <WorkspaceHeader
          title={isAdmin ? "工单管理" : "工单"}
          description={isAdmin ? "处理用户提交的工单，待处理的排在最前面。" : "遇到问题可以在这里联系管理员。"}
          status={total > 0 ? `共 ${total} 张` : undefined}
          actions={!isAdmin ? (
            ticketsOpen ? (
              <Button onClick={() => setCreateOpen(true)} className="gap-2 max-md:w-[34px] max-md:px-0" aria-label="新建工单">
                <Plus className="h-4 w-4" />
                <span className="max-md:sr-only">新建工单</span>
              </Button>
            ) : undefined
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">开放工单</span>
              <Switch
                aria-label="开放工单"
                checked={ticketsOpen}
                disabled={!ticketStatus.data || setTicketsEnabled.isPending}
                onCheckedChange={(enabled) => setTicketsEnabled.mutate({ enabled })}
              />
            </label>
          )}
        />

        {!ticketsOpen ? (
          <div role="status" className="flex items-start gap-2 rounded-[var(--fx-radius-control)] border border-[color-mix(in_srgb,var(--fx-warn)_35%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {isAdmin
                ? "工单已关闭：普通用户侧边栏看不到「工单」，也不能新建或回复。你仍然可以在这里查看和处理已有工单。"
                : "工单功能已关闭，暂时不能新建或回复工单。之前的工单仍可查看。"}
            </span>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] md:items-start">
          {showList ? (
            <Card className="min-w-0">
              <CardContent className="space-y-3 p-3">
                <div className="flex flex-wrap gap-2">
                  <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilterValue)}>
                    <SelectTrigger className="h-8 min-w-[7.5rem] flex-1" aria-label="按状态筛选">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_FILTER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isAdmin ? (
                    <Select value={priorityFilter} onValueChange={(value) => setPriorityFilter(value as PriorityFilterValue)}>
                      <SelectTrigger className="h-8 min-w-[7.5rem] flex-1" aria-label="按优先级筛选">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部优先级</SelectItem>
                        {[...TICKET_PRIORITIES].reverse().map((priority) => (
                          <SelectItem key={priority} value={priority}>{TICKET_PRIORITY_LABELS[priority]}优先级</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
                {isAdmin ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                      value={keywordInput}
                      onChange={(event) => setKeywordInput(event.target.value)}
                      placeholder="搜索标题、用户名或 #编号"
                      className="h-8 pl-8"
                      maxLength={128}
                      aria-label="搜索工单"
                    />
                  </div>
                ) : null}

                {list.isLoading && !list.data ? (
                  <DataSectionLoading label="正在加载工单" minHeight="min-h-[160px]" />
                ) : list.isError && !list.data ? (
                  <EmptyState icon={<Inbox />} title="工单加载失败" description={list.error?.message || "请稍后重试"} />
                ) : items.length === 0 ? (
                  <EmptyState
                    icon={<Inbox />}
                    title={isAdmin ? "没有符合条件的工单" : "还没有工单"}
                    description={isAdmin ? "换个筛选条件试试。" : ticketsOpen ? "遇到问题时点右上角「新建工单」联系管理员。" : "工单功能已关闭。"}
                  />
                ) : (
                  <ul className="-mx-1 space-y-1" aria-label="工单列表">
                    {items.map((ticket) => {
                      const active = ticket.id === selectedId;
                      const highlight = isAdmin ? ticket.status === "waiting_staff" : ticket.status === "waiting_user";
                      return (
                        <li key={ticket.id}>
                          <button
                            type="button"
                            onClick={() => selectTicket(ticket.id)}
                            aria-current={active ? "true" : undefined}
                            className={cn(
                              "w-full rounded-[var(--fx-radius-control)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--fx-hover)]",
                              active && "bg-[var(--fx-accent-soft)] hover:bg-[var(--fx-accent-soft)]",
                            )}
                          >
                            <div className="flex items-start gap-2">
                              {highlight ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--fx-accent)]" aria-label={isAdmin ? "待处理" : "有新回复"} /> : null}
                              <span className={cn("min-w-0 flex-1 truncate text-sm", highlight && "font-medium")}>{ticket.title}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">{shortTime(ticket.lastMessageAt)}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <span>#{ticket.id}</span>
                              {isAdmin ? <span className={cn("max-w-[10rem] truncate", ticket.userDeleted && "italic")}>{ticket.username}</span> : null}
                              <StatusBadge status={ticket.status} />
                              <PriorityBadge priority={ticket.priority} />
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {pageCount > 1 ? (
                  <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                    <Button variant="outline" size="sm" className="h-7 px-2" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一页">
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span>第 {page} / {pageCount} 页</span>
                    <Button variant="outline" size="sm" className="h-7 px-2" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="下一页">
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {showThread ? (
            <div className="min-w-0 space-y-3">
              {isMobile && selectedId ? (
                <Button variant="ghost" size="sm" className="-ml-2 gap-1" onClick={() => selectTicket(null)}>
                  <ArrowLeft className="h-4 w-4" />
                  返回工单列表
                </Button>
              ) : null}
              {selectedId ? (
                <TicketThread key={selectedId} mode={mode} ticketId={selectedId} onChanged={invalidateAll} onMissing={() => selectTicket(null)} />
              ) : (
                <EmptyState
                  icon={<LifeBuoy />}
                  title="选择一张工单"
                  description={isAdmin ? "在左边点开一张工单查看和回复。" : "在左边点开一张工单查看对话，或者新建一张。"}
                />
              )}
            </div>
          ) : null}
        </div>

        {!isAdmin ? (
          <CreateTicketDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            pending={createTicket.isPending}
            onSubmit={(payload) => createTicket.mutate(payload)}
          />
        ) : null}
      </div>
    </DashboardLayout>
  );
}

function TicketThread({ mode, ticketId, onChanged, onMissing }: {
  mode: Mode;
  ticketId: number;
  onChanged: () => void;
  onMissing: () => void;
}) {
  const isAdmin = mode === "admin";
  const ticketStatus = trpc.tickets.status.useQuery(undefined, { staleTime: 30_000 });
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const threadOptions = { refetchInterval: THREAD_POLL_MS, retry: false };
  const userThread = trpc.tickets.get.useQuery({ ticketId }, { ...threadOptions, enabled: !isAdmin });
  const adminThread = trpc.tickets.adminGet.useQuery({ ticketId }, { ...threadOptions, enabled: isAdmin });
  const thread = isAdmin ? adminThread : userThread;
  const ticket = thread.data?.ticket as TicketItem | undefined;
  const latestMessages = (thread.data?.messages || []) as TicketMessage[];

  // 「加载更早的消息」翻出来的那些，和轮询拿到的最新一页拼在一起。
  const [olderMessages, setOlderMessages] = useState<TicketMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const messages = useMemo(() => {
    const byId = new Map<number, TicketMessage>();
    for (const message of [...olderMessages, ...latestMessages]) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [olderMessages, latestMessages]);
  const hasMore = olderHasMore ?? !!thread.data?.hasMore;

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = isAdmin
        ? await utils.tickets.adminGet.fetch({ ticketId, beforeId: oldest.id })
        : await utils.tickets.get.fetch({ ticketId, beforeId: oldest.id });
      setOlderMessages((current) => [...(result.messages as TicketMessage[]), ...current]);
      setOlderHasMore(result.hasMore);
    } catch (error: any) {
      toast.error(error?.message || "加载失败");
    } finally {
      setLoadingOlder(false);
    }
  };

  // 新消息到了（或刚打开）就滚到底；在往上翻旧消息时不打扰。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageId = latestMessages[latestMessages.length - 1]?.id ?? 0;
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastMessageId]);

  const [draft, setDraft] = useState("");
  const onReplied = () => {
    setDraft("");
    onChanged();
  };
  const userReply = trpc.tickets.reply.useMutation({ onSuccess: onReplied, onError: (error) => toast.error(error.message || "发送失败") });
  const adminReply = trpc.tickets.adminReply.useMutation({ onSuccess: onReplied, onError: (error) => toast.error(error.message || "发送失败") });
  const userSetStatus = trpc.tickets.setStatus.useMutation({ onSuccess: onChanged, onError: (error) => toast.error(error.message || "操作失败") });
  const adminSetStatus = trpc.tickets.adminSetStatus.useMutation({ onSuccess: onChanged, onError: (error) => toast.error(error.message || "操作失败") });
  const replying = userReply.isPending || adminReply.isPending;
  const settingStatus = userSetStatus.isPending || adminSetStatus.isPending;

  const sendReply = () => {
    if (replying) return;
    const result = normalizeTicketContent(draft);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    if (isAdmin) adminReply.mutate({ ticketId, content: result.value });
    else userReply.mutate({ ticketId, content: result.value });
  };

  const setOpenState = async (status: "open" | "closed") => {
    if (settingStatus) return;
    if (status === "closed") {
      const confirmed = await confirmDialog({
        title: "关闭工单",
        description: isAdmin ? "关闭后双方都不能再回复，需要时可以重新打开。" : "问题解决了就可以关闭。关闭后不能再回复，需要时可以重新打开。",
        confirmText: "关闭工单",
      });
      if (!confirmed) return;
    }
    if (isAdmin) adminSetStatus.mutate({ ticketId, status });
    else userSetStatus.mutate({ ticketId, status });
  };

  const notFound = (thread.error as any)?.data?.code === "NOT_FOUND";
  if (thread.isLoading && !thread.data) return <DataSectionLoading label="正在加载对话" />;
  if (notFound || (thread.isError && !thread.data)) {
    return (
      <EmptyState
        icon={<Inbox />}
        title={notFound ? "工单不存在" : "对话加载失败"}
        description={notFound ? "这张工单不存在或你无权查看。" : thread.error?.message || "请稍后重试"}
        actions={<Button variant="outline" size="sm" onClick={onMissing}>返回列表</Button>}
      />
    );
  }
  if (!ticket) return null;

  const closed = ticket.status === "closed";
  const ticketsOpen = ticketStatus.data?.enabled !== false;
  const contentLength = draft.trim().length;

  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <h2 className="break-words text-base font-semibold leading-snug">{ticket.title}</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>#{ticket.id}</span>
              {isAdmin ? <span className={cn(ticket.userDeleted && "italic")}>{ticket.username}</span> : null}
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <span>创建于 {fullTime(ticket.createdAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {closed ? (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={settingStatus} onClick={() => void setOpenState("open")}>
                <RotateCcw className="h-3.5 w-3.5" />
                重新打开
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={settingStatus} onClick={() => void setOpenState("closed")}>
                <Lock className="h-3.5 w-3.5" />
                关闭工单
              </Button>
            )}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="max-h-[min(60svh,640px)] min-h-[160px] space-y-3 overflow-y-auto rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l2-group)] p-2.5 sm:p-3"
          aria-label="工单对话"
        >
          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? <Loader2 className="mr-1.5 h-3.5 w-3.5 forwardx-icon-spin" /> : null}
                加载更早的消息
              </Button>
            </div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={cn("flex flex-col", message.mine ? "items-end" : "items-start")}>
              <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <span className={cn(message.isStaff && "font-medium text-[var(--fx-accent)]")}>{message.senderName}</span>
                {isAdmin && message.isStaff ? <span>（客服）</span> : null}
                <span title={fullTime(message.createdAt)}>{shortTime(message.createdAt)}</span>
              </div>
              <div
                className={cn(
                  "max-w-[88%] whitespace-pre-wrap break-words rounded-[var(--fx-radius-control)] px-3 py-2 text-sm leading-6 [overflow-wrap:anywhere]",
                  message.mine
                    ? "bg-[var(--fx-accent-soft)] text-foreground"
                    : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-foreground",
                )}
              >
                {message.content}
              </div>
            </div>
          ))}
        </div>

        {closed ? (
          <div className="flex flex-col gap-2 rounded-[var(--fx-radius-control)] border border-dashed border-[var(--fx-stroke-base)] p-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>工单已关闭{ticket.closedAt ? `（${fullTime(ticket.closedAt)}）` : ""}，重新打开后才能继续回复。</span>
            <Button variant="outline" size="sm" className="gap-1.5 self-start sm:self-auto" disabled={settingStatus} onClick={() => void setOpenState("open")}>
              <RotateCcw className="h-3.5 w-3.5" />
              重新打开
            </Button>
          </div>
        ) : !isAdmin && !ticketsOpen ? (
          <div className="rounded-[var(--fx-radius-control)] border border-dashed border-[var(--fx-stroke-base)] p-3 text-sm text-muted-foreground">
            工单功能已关闭，暂时不能回复。
          </div>
        ) : (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  sendReply();
                }
              }}
              placeholder={isAdmin ? "回复用户…" : "补充说明或回复管理员…"}
              className="min-h-24 text-sm"
              maxLength={TICKET_CONTENT_MAX_LENGTH}
              aria-label="回复内容"
            />
            <div className="flex items-center justify-between gap-2">
              <span className={cn("text-xs text-muted-foreground", contentLength > TICKET_CONTENT_MAX_LENGTH && "text-[var(--fx-down-text)]")}>
                {contentLength.toLocaleString()} / {TICKET_CONTENT_MAX_LENGTH.toLocaleString()}
                <span className="max-md:hidden"> · Ctrl / ⌘ + Enter 发送</span>
              </span>
              <Button size="sm" className="gap-1.5" disabled={replying || contentLength === 0} onClick={sendReply}>
                {replying ? <Loader2 className="h-3.5 w-3.5 forwardx-icon-spin" /> : <Send className="h-3.5 w-3.5" />}
                发送
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreateTicketDialog({ open, onOpenChange, pending, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (payload: { title: string; priority: TicketPriority; content: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [content, setContent] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setPriority("medium");
    setContent("");
  }, [open]);

  const submit = () => {
    if (pending) return;
    const titleResult = normalizeTicketTitle(title);
    if (!titleResult.ok) {
      toast.error(titleResult.error);
      return;
    }
    const contentResult = normalizeTicketContent(content);
    if (!contentResult.ok) {
      toast.error(contentResult.error);
      return;
    }
    onSubmit({ title: titleResult.value, priority, content: contentResult.value });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建工单</DialogTitle>
          <DialogDescription>把遇到的问题说清楚：哪条规则 / 哪台机器、什么时候开始、看到了什么报错。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <FormField className="space-y-2">
              <Label htmlFor="ticket-title">标题</Label>
              <Input
                id="ticket-title"
                value={title}
                onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, " "))}
                maxLength={TICKET_TITLE_MAX_LENGTH}
                placeholder="一句话说明问题"
              />
            </FormField>
            <FormField className="space-y-2">
              <Label>优先级</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as TicketPriority)}>
                <SelectTrigger aria-label="优先级">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TICKET_PRIORITIES.map((item) => (
                    <SelectItem key={item} value={item}>{TICKET_PRIORITY_LABELS[item]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField className="space-y-2">
            <Label htmlFor="ticket-content">问题描述</Label>
            <Textarea
              id="ticket-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              maxLength={TICKET_CONTENT_MAX_LENGTH}
              className="min-h-40 text-sm"
              placeholder="只支持纯文本，不能上传附件。"
            />
            <p className="text-xs text-muted-foreground">{content.trim().length.toLocaleString()} / {TICKET_CONTENT_MAX_LENGTH.toLocaleString()}</p>
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={pending || !title.trim() || !content.trim()}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 forwardx-icon-spin" /> : null}
            提交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
