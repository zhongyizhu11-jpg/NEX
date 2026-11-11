import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Loader2, RotateCcw, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { trackRuleBatchJob, untrackRuleBatchJob, useTrackedRuleBatchJobs } from "@/lib/ruleBatchJobStore";
import { isRuleBatchJobFinished, type RuleBatchJobSnapshot } from "@shared/ruleBatchJobs";

/*
  规则批量任务的进度小窗（右下角，上游 2.3.290 / 2.3.292）。

  挂在后台布局上，不跟着规则页走：提交之后去别的页面、刷新，进度都还在（任务号存在 ruleBatchJobStore）。
  只有在盯着任务时才轮询，在跑的每秒问一次，全做完就不再问。
  任务只在面板进程的内存里：面板重启后查不到，小窗会说清楚，而不是一直转圈。
*/

const POLL_MS = 1_000;

function stateText(job: RuleBatchJobSnapshot) {
  if (job.state === "running") return `进行中 ${job.percent}%`;
  if (job.state === "stopping") return "正在停止…";
  if (job.state === "stopped") return job.stopReason || "已停止";
  return job.failed > 0 ? "已完成（有失败）" : "已完成";
}

function JobCard({ id, job, onRefetch }: { id: string; job: RuleBatchJobSnapshot | null; onRefetch: () => void }) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const stop = trpc.rules.batchJobStop.useMutation({ onSuccess: onRefetch, onError: (error) => toast.error(error.message || "停止失败") });
  const dismiss = trpc.rules.batchJobDismiss.useMutation();
  const retry = trpc.rules.batchJobRetryFailed.useMutation({
    onSuccess: ({ snapshot, duplicate }) => {
      trackRuleBatchJob(snapshot.id);
      if (!duplicate) untrackRuleBatchJob(id);
      toast.success(duplicate ? "这些失败项已经在重试中" : `已提交重试：${snapshot.total} 项`);
    },
    onError: (error) => toast.error(error.message || "重试失败"),
  });

  if (!job) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-lg border border-border/60 bg-background/95 p-3 text-xs shadow-lg backdrop-blur">
        <p className="text-muted-foreground">这个批量任务的记录已经不在了：做完超过 10 分钟会自动忘掉，面板重启后也不会保留。请以规则列表为准。</p>
        <Button type="button" size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label="关闭" onClick={() => untrackRuleBatchJob(id)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  const finished = isRuleBatchJobFinished(job);
  const close = () => {
    untrackRuleBatchJob(id);
    if (finished) dismiss.mutate({ id });
  };
  return (
    <div className="rounded-lg border border-border/60 bg-background/95 p-3 text-xs shadow-lg backdrop-blur" role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            {finished
              ? job.failed > 0 || job.state === "stopped" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--fx-warn-text)]" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--fx-healthy-text)]" />
              : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
            <span className="truncate">{job.title}</span>
          </p>
          <p className="mt-0.5 text-muted-foreground">{stateText(job)}</p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          aria-label={finished ? "关闭" : "收起（任务继续在后台进行）"}
          title={finished ? "关闭" : "不再显示；任务继续在服务端进行"}
          onClick={close}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Progress value={job.percent} className="mt-2 h-1.5" />
      <p className="mt-1.5 tabular-nums text-muted-foreground">
        {job.processed} / {job.total} · 成功 {job.succeeded}
        {job.skipped ? ` · 跳过 ${job.skipped}` : ""}
        {job.failed ? <span className="text-destructive"> · 失败 {job.failed}</span> : null}
        {job.notRun ? ` · 未执行 ${job.notRun}` : ""}
      </p>
      {job.failures.length > 0 && (
        <div className="mt-1.5">
          <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setExpanded((value) => !value)}>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            失败明细
          </button>
          {expanded && (
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1">
              {job.failures.map((failure) => (
                <li key={failure.index} className="break-words">
                  <span className="font-medium">{failure.label}</span>
                  <span className="text-muted-foreground">：{failure.error}</span>
                </li>
              ))}
              {job.moreFailures > 0 && <li className="text-muted-foreground">还有 {job.moreFailures} 条没列出</li>}
            </ul>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {!finished && (
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={job.state === "stopping" || stop.isPending} onClick={() => stop.mutate({ id })}>
            <Square className="mr-1 h-3 w-3" />停止剩余
          </Button>
        )}
        {finished && job.failed > 0 && (
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={retry.isPending} onClick={() => retry.mutate({ id })}>
            <RotateCcw className="mr-1 h-3 w-3" />重试失败项（{job.failed}）
          </Button>
        )}
        {finished && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => {
              void utils.rules.invalidate();
              close();
            }}
          >
            知道了
          </Button>
        )}
      </div>
    </div>
  );
}

export default function RuleBatchJobWidget() {
  const ids = useTrackedRuleBatchJobs();
  const utils = trpc.useUtils();
  const statusQuery = trpc.rules.batchJobStatus.useQuery(
    { ids },
    {
      enabled: ids.length > 0,
      refetchInterval: (query) => {
        const rows = query.state.data || [];
        return rows.some((row) => row.job && !isRuleBatchJobFinished(row.job)) ? POLL_MS : false;
      },
      refetchOnWindowFocus: true,
      meta: { silentFailure: true },
    },
  );
  const rows = useMemo(() => statusQuery.data || [], [statusQuery.data]);
  // 任务从「在跑」变成「结束」时刷新一次规则列表：页面上看到的启停 / 删除状态马上跟上。
  const lastStates = useRef(new Map<string, string>());
  useEffect(() => {
    let finishedNow = false;
    for (const row of rows) {
      const previous = lastStates.current.get(row.id);
      const current = row.job?.state || "gone";
      if (previous && previous !== current && row.job && isRuleBatchJobFinished(row.job)) finishedNow = true;
      lastStates.current.set(row.id, current);
    }
    if (finishedNow) void utils.rules.invalidate();
  }, [rows, utils]);

  if (ids.length === 0 || !statusQuery.data) return null;
  const byId = new Map(rows.map((row) => [row.id, row.job]));
  return (
    <div className={cn("pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2", "max-sm:bottom-20")}>
      {ids.filter((id) => byId.has(id)).map((id) => (
        <div key={id} className="pointer-events-auto">
          <JobCard id={id} job={byId.get(id) ?? null} onRefetch={() => { void statusQuery.refetch(); }} />
        </div>
      ))}
      <p className="pointer-events-auto self-end rounded bg-background/80 px-1.5 text-[10px] text-muted-foreground">批量任务在服务端执行，面板重启后进度不保留</p>
    </div>
  );
}
