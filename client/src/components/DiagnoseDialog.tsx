import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileJson, Gauge, Loader2, Network, Stethoscope } from "lucide-react";
import { useLocation } from "wouter";

import { LinkDiagnosticsPanel } from "@/components/LinkDiagnosticsPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFaultBundleExport, type FaultBundleKind } from "@/components/links/useFaultBundleExport";
import { cn } from "@/lib/utils";
import type { DiagnosticSubjectKind } from "@shared/linkDiagnostics";

export type DiagnoseTab = string;

/** 精简布局下并进诊断框的页：延迟记录、连接监控（见 Rules.tsx / Tunnels.tsx 传进来的）。 */
export type DiagnoseExtraTab = { key: string; label: string; content: ReactNode };

export type DiagnoseOutcome = "success" | "timeout" | "failed";

/**
 * 诊断的外壳：规则、隧道、转发链三处「诊断」共用（2.3.506 起三处的页签和底部按钮也一样：延迟测试 /
 * 一键诊断 / 延迟记录 …，底部是 DiagnoseSubjectActions）。服务端对应的统一入口是 diagnostics.*。
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
  extraTabs,
  initialTab,
  actions,
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
  /**
   * 精简布局：原来散在卡片菜单里的「延迟记录」「连接监控」并进来当页签（切过去才挂载，挂上就不卸）。
   * 一条线路的毛病在一个框里看完，不用关了再开。
   */
  extraTabs?: DiagnoseExtraTab[];
  /** 打开时先停在哪一页（比如表格里点「详细」直接看延迟记录）。不给就是延迟测试 */
  initialTab?: DiagnoseTab;
  /** 精简布局：「导出故障包」「查看拓扑」这类和诊断同一件事的动作，放在底部、每一页都在。 */
  actions?: ReactNode;
  /** 路径和每一段的结果（LinkTestProbeView）。 */
  children: ReactNode;
}) {
  const ranBefore = !!lastRunAt && !Number.isNaN(new Date(lastRunAt).getTime());
  const [tab, setTab] = useState<DiagnoseTab>(initialTab || "latency");
  // 一键诊断切过去才跑；跑过一次就一直挂着，来回切不重跑。
  const [checklistVisited, setChecklistVisited] = useState(false);
  const [visitedExtra, setVisitedExtra] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setTab(initialTab || "latency");
    } else {
      setTab("latency");
      setChecklistVisited(false);
      setVisitedExtra([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (tab === "checklist") setChecklistVisited(true);
    else if (tab !== "latency") setVisitedExtra((list) => (list.includes(tab) ? list : [...list, tab]));
  }, [tab]);
  // 延迟测试那一页第一次露面时测一次（直接打开在别的页就等切过来再测）；正在测就不再发一次。一次打开只自动测一次。
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
    if (autoRanRef.current || tab !== "latency") return;
    // 子组件的 effect 先于父组件跑：隧道那边打开时会重置「手动测试」的记录，这里等那一轮
    // effect 都跑完再发，免得刚记下的测试状态被清掉。
    const timer = setTimeout(() => {
      autoRanRef.current = true;
      if (!testingRef.current) onRunRef.current();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, tab]);
  const hasChecklist = !!checklist && checklist.id > 0;
  const extras = extraTabs ?? [];
  const hasTabs = hasChecklist || extras.length > 0;
  const showLatency = !hasTabs || tab === "latency";
  // 清单一行一项，窄了读着累：至少 2xl；延迟测试那页要更宽时（多段）用调用方给的宽度。并了延迟记录那种图表页时至少 3xl。
  const contentSize = extras.length > 0 && !/max-w-(4xl|5xl|6xl)/.test(sizeClassName || "")
    ? "sm:max-w-3xl"
    : hasChecklist && !/max-w-(3xl|4xl|5xl|6xl)/.test(sizeClassName || "") ? "sm:max-w-2xl" : sizeClassName;
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

        {hasTabs ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as DiagnoseTab)}>
            <TabsList aria-label="诊断方式" className="w-full sm:w-auto">
              <TabsTrigger value="latency" className="flex-1 sm:flex-none">延迟测试</TabsTrigger>
              {hasChecklist ? <TabsTrigger value="checklist" className="flex-1 sm:flex-none">一键诊断</TabsTrigger> : null}
              {extras.map((item) => <TabsTrigger key={item.key} value={item.key} className="flex-1 sm:flex-none">{item.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        ) : null}

        {extras.filter((item) => visitedExtra.includes(item.key)).map((item) => (
          <div key={item.key} className={cn("min-w-0", tab !== item.key && "hidden")}>
            {item.content}
          </div>
        ))}

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
              {actions ? <div className="flex flex-wrap items-center gap-2 sm:mr-auto">{actions}</div> : null}
              <Button onClick={onRun} disabled={testing} className="w-full min-w-0 gap-2 sm:w-auto sm:min-w-[112px]">
                {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Stethoscope className="h-4 w-4" aria-hidden="true" />}
                {/* 有「一键诊断」页时这一页叫延迟测试，按钮也跟着叫测试，免得两个「重新诊断」 */}
                {hasChecklist
                  ? (testing ? "测试中…" : ranBefore ? "重新测试" : "开始测试")
                  : (testing ? "诊断中…" : ranBefore ? "重新诊断" : "开始诊断")}
              </Button>
            </DialogFooter>
          </>
        ) : actions ? (
          <DialogFooter className="gap-2 sm:justify-start">
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 「查看拓扑」聚焦用的参数名（/topology?rule= / ?tunnel= / ?group=）。 */
const TOPOLOGY_FOCUS_KEY: Record<FaultBundleKind, string> = { rule: "rule", tunnel: "tunnel", forwardGroup: "group" };

/** 网络测试页「iperf3 对拉」，先选好这条隧道（Iperf3PairPanel 的 initialTunnelId）。 */
export function tunnelSpeedTestHref(tunnelId: number) {
  return `/looking-glass?method=iperf3-pair&tunnel=${Math.trunc(Number(tunnelId))}`;
}

/**
 * 诊断框底部那一排（2.3.506 起规则、隧道、转发链三处一个样）：导出故障包、查看拓扑，隧道多一个「测带宽」
 * （打开网络测试页的 iperf3 对拉、选好这条隧道 —— 和线路详情的「逐段测带宽」同一套测法、同一种结果）。
 * onLeave：跳去别的页之前把诊断框关掉。
 */
export function DiagnoseSubjectActions({ kind, id, onLeave, speedTest = false }: { kind: FaultBundleKind; id: number; onLeave: () => void; speedTest?: boolean }) {
  const faultBundle = useFaultBundleExport();
  const [, setLocation] = useLocation();
  const go = (href: string) => { onLeave(); setLocation(href); };
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={faultBundle.pending} onClick={() => { void faultBundle.exportBundle(kind, Number(id)); }}>
        <FileJson className="h-3.5 w-3.5" />导出故障包
      </Button>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => go(`/topology?${TOPOLOGY_FOCUS_KEY[kind]}=${Number(id)}`)}>
        <Network className="h-3.5 w-3.5" />查看拓扑
      </Button>
      {speedTest && kind === "tunnel" ? (
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => go(tunnelSpeedTestHref(id))} data-testid="diagnose-speed-test">
          <Gauge className="h-3.5 w-3.5" />测带宽
        </Button>
      ) : null}
    </>
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
