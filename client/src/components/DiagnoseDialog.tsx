import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Stethoscope } from "lucide-react";

import { LinkDiagnosticsPanel } from "@/components/LinkDiagnosticsPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { DiagnosticSubjectKind } from "@shared/linkDiagnostics";

export type DiagnoseTab = "checklist" | "latency";

export type DiagnoseOutcome = "success" | "timeout" | "failed";

/**
 * 诊断的外壳：规则、隧道、转发链三处「诊断」共用。
 *
 * 原来三处各写一份，而且同一件事有四个名字：卡片上的按钮叫「诊断」，点开标题叫「延迟探测」，
 * 底部按钮叫「链路测试」，测的时候写「探测中…」。用户按的是「诊断」，就一路叫诊断。
 *
 * 另外补了两样原来没有的：
 * - 标题下面一句「测的是什么」—— 规则是一段段测到目标地址，隧道是入口到出口，转发链是沿着
 *   链逐段测。三者看上去一样，测的范围不一样，出了问题要去查的地方也不一样。
 * - 路径下面一行「上次诊断 09-23 21:30 · 通 / 超时 / 没通」。原来打开对话框看到的是上一次
 *   的结果，却看不出是几点测的 —— 一小时前通过，不代表现在通。
 *
 * 怎么排出要测的那几段、怎么跟 Agent 要结果，各处不一样，留在各自的对话框里；这里只管人看到的部分。
 *
 * 2.3.444 起多了「一键诊断」页（传了 checklist 就有）：打开对话框直接跑一张通过 / 警告 / 失败
 * 的清单（LinkDiagnosticsPanel），原来一段段测延迟的那页挪到「延迟测试」，用法不变。
 *
 * 2.3.450 起两页换了位置：「延迟测试」在前、打开就是它，而且一打开就测一次（不用再按按钮），
 * 「一键诊断」挪到第二页，切过去才开始跑清单。
 */
export function DiagnoseDialog({
  open,
  onOpenChange,
  subjectName,
  scope,
  sizeClassName,
  testing,
  lastRunAt,
  outcome,
  failureReason,
  onRun,
  checklist,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 诊断的是哪一个（规则名、隧道名、转发链名）。 */
  subjectName: string;
  /** 测的是什么，一句话：「从入口测到出口」。 */
  scope: string;
  sizeClassName?: string;
  testing: boolean;
  /** 上一次诊断什么时候（没有就是还没诊断过）。 */
  lastRunAt?: string | number | Date | null;
  outcome?: DiagnoseOutcome | null;
  /** 没通时的原因（Agent 报上来的那一句），有就写在结果后面。 */
  failureReason?: string | null;
  onRun: () => void;
  /** 一键诊断要诊断的对象；不传就只有延迟测试。 */
  checklist?: { kind: DiagnosticSubjectKind; id: number } | null;
  /** 路径和每一段的结果（LinkTestProbeView）。 */
  children: ReactNode;
}) {
  const ranBefore = !!lastRunAt && !Number.isNaN(new Date(lastRunAt).getTime());
  const [tab, setTab] = useState<DiagnoseTab>("latency");
  // 一键诊断切过去才跑；跑过一次就一直挂着，来回切不重跑。
  const [checklistVisited, setChecklistVisited] = useState(false);
  useEffect(() => {
    if (!open) {
      setTab("latency");
      setChecklistVisited(false);
    }
  }, [open]);
  useEffect(() => {
    if (tab === "checklist") setChecklistVisited(true);
  }, [tab]);
  // 打开就测一次延迟；正在测就不再发一次。一次打开只自动测一次。
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const testingRef = useRef(testing);
  testingRef.current = testing;
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoRanRef.current = false;
      return;
    }
    if (autoRanRef.current) return;
    // 子组件的 effect 先于父组件跑：隧道那边打开时会重置「手动测试」的记录，这里等那一轮
    // effect 都跑完再发，免得刚记下的测试状态被清掉。
    const timer = setTimeout(() => {
      autoRanRef.current = true;
      if (!testingRef.current) onRunRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);
  const hasChecklist = !!checklist && checklist.id > 0;
  const showLatency = !hasChecklist || tab === "latency";
  // 清单一行一项，窄了读着累：至少 2xl；延迟测试那页要更宽时（多段）用调用方给的宽度。
  const contentSize = hasChecklist && !/max-w-(3xl|4xl|5xl|6xl)/.test(sizeClassName || "") ? "sm:max-w-2xl" : sizeClassName;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(contentSize, "min-w-0")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-5 w-5" aria-hidden="true" />
            诊断
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{subjectName}</span>
            <span className="text-muted-foreground"> · {scope}</span>
          </DialogDescription>
        </DialogHeader>

        {hasChecklist ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as DiagnoseTab)}>
            <TabsList aria-label="诊断方式" className="w-full sm:w-auto">
              <TabsTrigger value="latency" className="flex-1 sm:flex-none">延迟测试</TabsTrigger>
              <TabsTrigger value="checklist" className="flex-1 sm:flex-none">一键诊断</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        {hasChecklist && checklistVisited ? (
          // 切到延迟测试再切回来不重跑：清单一直挂着，只是藏起来。
          <div className={cn("min-w-0", tab !== "checklist" && "hidden")}>
            <LinkDiagnosticsPanel kind={checklist!.kind} id={checklist!.id} active={open} />
          </div>
        ) : null}

        {showLatency ? (
          <>
            {children}

            <DiagnoseStatusLine testing={testing} lastRunAt={ranBefore ? lastRunAt : null} outcome={outcome} failureReason={failureReason} />

            <DialogFooter className="gap-2">
              <Button onClick={onRun} disabled={testing} className="w-full min-w-0 gap-2 sm:w-auto sm:min-w-[112px]">
                {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Stethoscope className="h-4 w-4" aria-hidden="true" />}
                {/* 有「一键诊断」页时这一页叫延迟测试，按钮也跟着叫测试，免得两个「重新诊断」 */}
                {hasChecklist
                  ? (testing ? "测试中…" : ranBefore ? "重新测试" : "开始测试")
                  : (testing ? "诊断中…" : ranBefore ? "重新诊断" : "开始诊断")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 「09-23 21:30」：诊断结果看的是最近几天，年份和秒都不用写。 */
export function formatDiagnoseTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const OUTCOME_TEXT: Record<DiagnoseOutcome, { text: string; className: string }> = {
  success: { text: "通", className: "text-[var(--fx-healthy-text)]" },
  timeout: { text: "超时", className: "text-[var(--fx-warn-text)]" },
  failed: { text: "没通", className: "text-[var(--fx-down-text)]" },
};

export function DiagnoseStatusLine({
  testing,
  lastRunAt,
  outcome,
  failureReason,
}: {
  testing: boolean;
  lastRunAt?: string | number | Date | null;
  outcome?: DiagnoseOutcome | null;
  failureReason?: string | null;
}) {
  let content: ReactNode;
  if (testing) {
    content = "正在诊断，结果回来后这里会更新。";
  } else if (!lastRunAt) {
    content = "还没有诊断过。";
  } else {
    const when = formatDiagnoseTime(lastRunAt);
    const result = outcome ? OUTCOME_TEXT[outcome] : null;
    const reason = outcome && outcome !== "success" ? String(failureReason || "").trim() : "";
    content = (
      <>
        上次诊断 <span className="tabular-nums">{when}</span>
        {result ? (
          <>
            {" · "}
            <span className={cn("font-medium", result.className)}>{result.text}</span>
          </>
        ) : null}
        {reason ? <span className="break-words">{`：${reason.length > 120 ? `${reason.slice(0, 120)}…` : reason}`}</span> : null}
      </>
    );
  }
  return (
    <div className="text-meta text-muted-foreground" role="status" aria-live="polite">
      {content}
    </div>
  );
}
