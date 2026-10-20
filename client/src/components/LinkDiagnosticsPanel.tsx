import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, Clock3, Copy, Loader2, RotateCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  DIAGNOSTIC_GROUP_LABELS,
  DIAGNOSTIC_GROUPS,
  DIAGNOSTIC_NEEDS_UPGRADE_LABEL,
  DIAGNOSTIC_STATUS_LABELS,
  formatDiagnosticsReportText,
  type DiagnosticItem,
  type DiagnosticStatus,
  type DiagnosticSubjectKind,
  type LinkDiagnosticsReport,
} from "@shared/linkDiagnostics";

/**
 * 「一键诊断」：规则 / 隧道 / 转发链诊断对话框里的清单那一页（DiagnoseDialog 的 checklist）。
 *
 * 打开就开始：面板侧的项马上有结论，主机上的项先是「等待」，每 2 秒问一次服务端，回来一项
 * 换一项。最上面一句总评和「最可能的原因」—— 人打开诊断是想知道哪里坏了，不是想读完二十行。
 * 每一行点开看修复建议和原始输出；「复制结果」把整张清单变成纯文本，发工单 / 给客服用。
 */

const STATUS_STYLE: Record<DiagnosticStatus, { icon: typeof CheckCircle2; pill: string; text: string }> = {
  pass: { icon: CheckCircle2, pill: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]", text: "text-[var(--fx-healthy-text)]" },
  warn: { icon: AlertTriangle, pill: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]", text: "text-[var(--fx-warn-text)]" },
  fail: { icon: XCircle, pill: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]", text: "text-[var(--fx-down-text)]" },
  skip: { icon: CircleSlash, pill: "bg-[var(--fx-l3-control-fill)] text-muted-foreground", text: "text-muted-foreground" },
  pending: { icon: Clock3, pill: "bg-[var(--fx-l3-control-fill)] text-muted-foreground", text: "text-muted-foreground" },
};

export function DiagnosticStatusPill({ item }: { item: Pick<DiagnosticItem, "status" | "needsUpgrade"> }) {
  const style = STATUS_STYLE[item.status];
  const Icon = item.status === "pending" ? Loader2 : style.icon;
  const label = item.needsUpgrade ? DIAGNOSTIC_NEEDS_UPGRADE_LABEL : DIAGNOSTIC_STATUS_LABELS[item.status];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-medium",
        item.needsUpgrade ? "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]" : style.pill,
      )}
      data-status={item.status}
    >
      <Icon className={cn("h-3.5 w-3.5", item.status === "pending" && "animate-spin")} aria-hidden="true" />
      {label}
    </span>
  );
}

function DiagnosticRow({ item, expanded, onToggle }: { item: DiagnosticItem; expanded: boolean; onToggle: () => void }) {
  const expandable = !!(item.detail || (item.hint && item.status !== "pass"));
  const latency = typeof item.latencyMs === "number" ? `${item.latencyMs} ms` : "";
  return (
    <li className="min-w-0 border-b border-[var(--fx-border-subtle,var(--border))] last:border-b-0" data-diagnostic-key={item.key}>
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 py-2.5 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? expanded : undefined}
      >
        <DiagnosticStatusPill item={item} />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[13px] font-medium leading-5 text-foreground">{item.title}</span>
          <span className="block break-words text-[12px] leading-5 text-muted-foreground">
            {item.summary}
            {latency ? <span className="tabular-nums">{` · ${latency}`}</span> : null}
          </span>
          {!expanded && item.hint && (item.status === "fail" || item.status === "warn") ? (
            <span className={cn("mt-0.5 block break-words text-[12px] leading-5", STATUS_STYLE[item.status].text)}>{item.hint}</span>
          ) : null}
        </span>
        {expandable ? (
          <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        ) : null}
      </button>
      {expanded ? (
        <div className="mb-2.5 ml-0 space-y-2 sm:ml-[4.75rem]">
          {item.hint && item.status !== "pass" ? (
            <p className={cn("break-words text-[12px] leading-5", STATUS_STYLE[item.status].text)}>建议：{item.hint}</p>
          ) : null}
          {item.detail ? (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--fx-l3-control-fill)] p-2 font-mono text-[11px] leading-4 text-muted-foreground">
              {item.detail}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 纯展示：总评 + 分组清单。单测直接渲染它。 */
export function LinkDiagnosticsChecklist({
  report,
  expandedKeys,
  onToggle,
}: {
  report: LinkDiagnosticsReport;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const verdictStatus: DiagnosticStatus = report.verdict === "pending" ? "pending" : report.verdict;
  const VerdictIcon = report.verdict === "pending" ? Loader2 : STATUS_STYLE[verdictStatus].icon;
  return (
    <div className="min-w-0 space-y-4">
      <div
        className={cn(
          "min-w-0 rounded-lg p-3",
          report.verdict === "fail" ? "bg-[var(--fx-down-soft)]" : report.verdict === "warn" ? "bg-[var(--fx-warn-soft)]" : report.verdict === "pass" ? "bg-[var(--fx-healthy-soft)]" : "bg-[var(--fx-l3-control-fill)]",
        )}
        role="status"
        aria-live="polite"
      >
        <div className={cn("flex items-center gap-2 text-[14px] font-semibold", STATUS_STYLE[verdictStatus].text)}>
          <VerdictIcon className={cn("h-4 w-4 shrink-0", report.verdict === "pending" && "animate-spin")} aria-hidden="true" />
          <span className="min-w-0 break-words">{report.verdictText}</span>
        </div>
        {report.cause ? (
          <div className="mt-1.5 min-w-0 text-[13px] leading-5 text-foreground">
            <span className="font-medium">最可能的原因：</span>
            <span className="break-words">{report.cause.title} —— {report.cause.summary}</span>
            {report.cause.hint ? <p className="mt-0.5 break-words text-[12px] text-muted-foreground">怎么修：{report.cause.hint}</p> : null}
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground tabular-nums">
          {(["pass", "warn", "fail", "skip", "pending"] as const).map((status) => (
            report.counts[status] > 0 ? <span key={status}>{DIAGNOSTIC_STATUS_LABELS[status]} {report.counts[status]}</span> : null
          ))}
        </div>
      </div>

      {DIAGNOSTIC_GROUPS.map((group) => {
        const items = report.items.filter((item) => item.group === group);
        if (items.length === 0) return null;
        const bad = items.filter((item) => item.status === "fail").length;
        return (
          <section key={group} className="min-w-0" aria-label={DIAGNOSTIC_GROUP_LABELS[group]}>
            <h3 className="flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              {DIAGNOSTIC_GROUP_LABELS[group]}
              <span className="font-normal normal-case tabular-nums">{bad > 0 ? `${bad} 项失败` : `${items.length} 项`}</span>
            </h3>
            <ul className="min-w-0">
              {items.map((item) => (
                <DiagnosticRow key={item.key} item={item} expanded={expandedKeys.has(item.key)} onToggle={() => onToggle(item.key)} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** 诊断对话框里的「一键诊断」页：自己发起、自己轮询。 */
export function LinkDiagnosticsPanel({ kind, id, active }: { kind: DiagnosticSubjectKind; id: number; active: boolean }) {
  const [report, setReport] = useState<LinkDiagnosticsReport | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const startedFor = useRef("");
  const start = trpc.diagnostics.start.useMutation({
    onSuccess: (data) => {
      setReport(data as LinkDiagnosticsReport);
      setExpanded(new Set());
    },
    onError: (error) => toast.error(error?.message || "诊断没发起成功"),
  });
  const sessionId = report?.sessionId || "";
  const status = trpc.diagnostics.status.useQuery(
    { sessionId },
    {
      enabled: active && !!sessionId && !!report?.running,
      // 主机上的检查一般十几秒内回来，每 2 秒问一次。
      refetchInterval: 2000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  useEffect(() => {
    if (status.data && status.data.sessionId === sessionId) setReport(status.data as LinkDiagnosticsReport);
  }, [sessionId, status.data]);

  const subjectKey = `${kind}:${id}`;
  useEffect(() => {
    if (!active || startedFor.current === subjectKey) return;
    startedFor.current = subjectKey;
    setReport(null);
    start.mutate({ kind, id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, subjectKey]);

  const copyText = useMemo(() => (report ? formatDiagnosticsReportText(report) : ""), [report]);
  const running = start.isPending || !!report?.running;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={start.isPending}
          onClick={() => start.mutate({ kind, id })}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
          {start.isPending ? "正在发起…" : report ? "重新诊断" : "开始诊断"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!report}
          onClick={async () => {
            if (await copyTextToClipboard(copyText)) toast.success("诊断结果已复制");
            else toast.error("复制失败，请手动选中复制");
          }}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          复制结果
        </Button>
        {running && report ? <span className="text-meta text-muted-foreground">主机上的检查回来一项更新一项</span> : null}
      </div>
      {status.error && !status.isFetching ? (
        <p className="text-meta text-[var(--fx-down-text)]">{status.error.message}</p>
      ) : null}
      {report ? (
        <LinkDiagnosticsChecklist
          report={report}
          expandedKeys={expanded}
          onToggle={(key) => setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })}
        />
      ) : start.isError ? (
        <p className="py-6 text-[13px] text-[var(--fx-down-text)]">{start.error?.message || "诊断没发起成功"}</p>
      ) : (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在检查配置、主机和端口…
        </div>
      )}
    </div>
  );
}
