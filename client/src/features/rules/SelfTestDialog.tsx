/* 从 client/src/pages/Rules.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { DiagnoseDialog, formatDiagnoseTime, type DiagnoseExtraTab } from "@/components/DiagnoseDialog";
import { LinkTestProbeView, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { applyRuleCurrentLatency, describeOutdatedDiagnosisRoute, describeRuleCurrentLatency, type RuleCurrentLatency } from "@/lib/diagnosisCurrentLatency";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { handoffManualTestResult } from "@/lib/manualTestCache";
import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";

export default function SelfTestDialog({
  ruleId,
  ruleName,
  sourceLabel,
  targetLabel,
  nodeMeta,
  plannedSegments,
  current,
  open,
  onOpenChange,
  extraTabs,
  actions,
  initialTab,
}: {
  ruleId: number;
  ruleName: string;
  sourceLabel?: string;
  targetLabel?: string;
  nodeMeta?: Record<string, any>;
  plannedSegments?: LinkTestPlannedSegment[];
  /** 规则卡那一行的延迟（trafficSummary）：比上次诊断新就画它，弹窗和卡片一个数（lib/diagnosisCurrentLatency.ts） */
  current?: RuleCurrentLatency | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 并进来的页（延迟记录）和底部动作（故障包、拓扑），见 DiagnoseDialog。 */
  extraTabs?: DiagnoseExtraTab[];
  actions?: ReactNode;
  initialTab?: string;
}) {
  const utils = trpc.useUtils();
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [activeTestId, setActiveTestId] = useState<number | null>(null);
  const manualTestRef = useRef(false);
  const { data: latest } = trpc.rules.latestTest.useQuery(
    { ruleId, includeActive: optimisticTesting },
    {
      enabled: open,
      // 诊断进行中每秒查一次，结果回来最多晚 1 秒。
      refetchInterval: pollingInterval(optimisticTesting ? "realtime" : "interactive", open),
      refetchOnWindowFocus: false,
    }
  );
  const startMutation = trpc.rules.startSelfTest.useMutation({
    onSuccess: (data) => {
      const nextTestId = Number(data?.id) || 0;
      if (nextTestId > 0) {
        setActiveTestId(nextTestId);
      } else {
        setOptimisticTesting(false);
        setActiveTestId(null);
        manualTestRef.current = false;
      }
      utils.rules.latestTest.invalidate({ ruleId });
    },
    onError: (e) => {
      setOptimisticTesting(false);
      setActiveTestId(null);
      manualTestRef.current = false;
      toast.error(e?.message || "诊断没发出去");
    },
  });

  const status = latest?.status as string | undefined;
  const isServerTesting = status === "pending" || status === "running";
  const isTerminalStatus = !!status && !isServerTesting;
  const latestTestId = Number((latest as any)?.id) || 0;
  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setActiveTestId(null);
      manualTestRef.current = false;
    }
  }, [open]);
  useEffect(() => {
    if (!optimisticTesting || !activeTestId || !isTerminalStatus) return;
    if (latestTestId >= activeTestId) {
      handoffManualTestResult(
        latest,
        (result) => utils.rules.latestTest.setData(
          { ruleId, includeActive: false },
          result,
        ),
        () => setOptimisticTesting(false),
      );
      void Promise.all([
        utils.rules.trafficSummary.invalidate(),
        utils.rules.tcpingSeries.invalidate({ ruleId, hours: 24 }),
      ]);
      setActiveTestId(null);
      if (status === "success") manualTestRef.current = false;
    }
  }, [activeTestId, isTerminalStatus, latest, latestTestId, optimisticTesting, ruleId, status, utils]);
  useEffect(() => {
    if (!startMutation.isError) return;
    setOptimisticTesting(false);
    setActiveTestId(null);
  }, [startMutation.isError]);
  const isTesting = startMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isTimeout = status === "timeout";
  const isFailed = !!latest && !isTesting && !isSuccess && !isTimeout;
  /*
    上次诊断是旧路线测的（规则换了隧道 / 目标、隧道换了出口 / 入口 / 中转，shared/diagnosisRoute.ts，服务端算好）：
    不画它那条旧路线，按现在的配置（plannedSegments）画、写明原因，并自动重测一次（2.3.547，用户：「隧道换了出口，
    转发的不实时变过来？」）。重测排出去之后 latest 换成新的一行，这个标记自然就没了。
  */
  const routeOutdated = !!latest && !isTesting && (latest as { routeOutdated?: boolean }).routeOutdated === true;
  const routeChangedAt = (latest as { routeChangedAt?: string | Date | null } | null)?.routeChangedAt ?? null;
  const autoRetestRef = useRef(0);
  useEffect(() => {
    if (!open || !routeOutdated || isTesting || startMutation.isPending) return;
    if (autoRetestRef.current === latestTestId) return;
    autoRetestRef.current = latestTestId;
    setOptimisticTesting(true);
    setActiveTestId(null);
    startMutation.mutate({ ruleId });
  }, [open, routeOutdated, isTesting, latestTestId, ruleId, startMutation]);
  const diagnosedMessage = useMemo(() => {
    const parsed = parseLinkTestMessage(latest?.message);
    // 旧路线的两段不画：只留现在配置里的节点（LinkTestProbeView 没有 details 时按 plannedSegments 画）
    return routeOutdated ? { ...parsed, message: "", details: [], totalLatencyMs: null, tunnelLatencyMs: null, tunnelProbeTimedOut: false } : parsed;
  }, [latest?.message, routeOutdated]);
  // 规则卡上的延迟比上次诊断新（定时探测又测了一轮）：画卡片上的那份，两边一个数；测试中、诊断没通、卡片没数就画诊断的
  const currentView = useMemo(
    () => (isTesting || !isSuccess || routeOutdated ? null : applyRuleCurrentLatency({ parsed: diagnosedMessage, diagnosisAt: latest?.updatedAt, diagnosisSuccess: isSuccess, current })),
    [current, diagnosedMessage, isSuccess, isTesting, latest?.updatedAt, routeOutdated],
  );
  const parsedMessage = currentView?.parsed ?? diagnosedMessage;
  const latencyNote = routeOutdated
    ? describeOutdatedDiagnosisRoute({ routeChangedAt, diagnosedAt: latest?.updatedAt ?? null }, (at) => formatDiagnoseTime(at))
    : currentView ? describeRuleCurrentLatency(currentView, (at) => formatDiagnoseTime(at)) : null;
  const plannedSegmentCount = plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";
  const lastFailureToastKey = useRef("");
  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = parsedMessage.message.trim();
    if (!isTesting && manualTestRef.current && latest && !isSuccess && isTerminalStatus) {
      const key = `${ruleId}:${status}:${latest?.updatedAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        manualTestRef.current = false;
        toast.error(isTimeout ? "诊断超时" : "诊断没通过");
      }
    }
  }, [open, isTesting, isSuccess, isTerminalStatus, isTimeout, latest, latest?.updatedAt, parsedMessage.message, ruleId, status]);
  return (
    <DiagnoseDialog
      open={open}
      onOpenChange={onOpenChange}
      subjectName={ruleName}
      scope="从入口一段段测到目标地址"
      sizeClassName={probeDialogSizeClass}
      testing={isTesting || routeOutdated}
      lastRunAt={latest?.updatedAt ?? null}
      outcome={routeOutdated ? null : isSuccess ? "success" : isTimeout ? "timeout" : isFailed ? "failed" : null}
      failureReason={parsedMessage.message}
      latencyNote={latencyNote}
      checklist={{ kind: "rule", id: ruleId }}
      extraTabs={extraTabs}
      initialTab={initialTab}
      actions={actions}
      onRun={() => {
        manualTestRef.current = true;
        setOptimisticTesting(true);
        setActiveTestId(null);
        startMutation.mutate({ ruleId });
      }}
    >
      <LinkTestProbeView
        parsed={parsedMessage}
        fallbackLatencyMs={currentView ? currentView.latencyMs : typeof latest?.latencyMs === "number" && latest.latencyMs > 0 ? latest.latencyMs : null}
        isSuccess={isSuccess && !routeOutdated}
        isTesting={isTesting || routeOutdated}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        nodeMeta={nodeMeta}
        plannedSegments={plannedSegments}
        ignorePlannedResultsWhenDetailsPresent
        compactFrom={3}
        roomyNodes
        mobileStacked
        wrapDesktopRows
      />
    </DiagnoseDialog>
  );
}
