/* 从 client/src/pages/Settings.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EntityActions } from "@/components/entity/EntityActions";
import DataSectionLoading from "@/components/DataSectionLoading";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { downloadTextFile } from "@/lib/fileDownload";
import { cn } from "@/lib/utils";
import { Download, RefreshCw, FileText, Loader2 } from "lucide-react";
import PanelProfilingCard from "@/components/settings/PanelProfilingCard";
import { useRef, useState, useEffect } from "react";
import { toast } from "sonner";

const LOG_PAGE_SIZE = 200;

type PanelLogLevel = "all" | "info" | "warn" | "error" | "log";

type PanelLogSummary = Record<PanelLogLevel, number>;

const EMPTY_PANEL_LOG_SUMMARY: PanelLogSummary = { all: 0, info: 0, warn: 0, error: 0, log: 0 };


function normalizePanelLogSummary(summary?: Partial<PanelLogSummary> | null): PanelLogSummary {
  return {
    all: Number(summary?.all) || 0,
    info: Number(summary?.info) || 0,
    warn: Number(summary?.warn) || 0,
    error: Number(summary?.error) || 0,
    log: Number(summary?.log) || 0,
  };
}


/** 日志时间：「09-23 12:51:27」。日志只保留三天（今天和前两天），年份和上下午都是多余的。 */
function formatLogTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}


export default function PanelLogsSection() {
  const confirmDialog = useConfirmDialog();
  const [panelLogLevel, setPanelLogLevel] = useState<PanelLogLevel>("all");
  const [panelLogOffset, setPanelLogOffset] = useState(0);
  const panelLogSummaryRef = useRef<PanelLogSummary>(EMPTY_PANEL_LOG_SUMMARY);
  const [supportTaskId, setSupportTaskId] = useState("");
  const downloadedSupportTaskRef = useRef("");
  const { data: panelLogs, isLoading: panelLogsLoading, isFetching: panelLogsFetching, refetch: refetchPanelLogs } = trpc.system.panelLogs.useQuery({
    level: panelLogLevel,
    limit: LOG_PAGE_SIZE,
    offset: panelLogOffset,
  }, {
    placeholderData: (previousData) => previousData,
    refetchInterval: pollingInterval("log"),
  });
  const exportLogsMutation = trpc.system.exportPanelLogs.useMutation({
    onSuccess: (data) => {
      try {
        downloadTextFile(data.filename, data.content, data.mimeType || "text/plain;charset=utf-8");
        toast.success(`已导出 ${data.count} 条日志`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "日志已生成，但浏览器保存文件失败");
      }
    },
    onError: (err) => toast.error(err.message || "导出日志失败"),
  });
  const clearLogsMutation = trpc.system.clearPanelLogs.useMutation({
    onSuccess: async () => {
      toast.success("日志已清空");
      setPanelLogOffset(0);
      await refetchPanelLogs();
    },
    onError: (err) => toast.error(err.message || "清空日志失败"),
  });
  const startSupportBundleMutation = trpc.system.startSupportBundle.useMutation({
    onSuccess: (data) => {
      downloadedSupportTaskRef.current = "";
      setSupportTaskId(data.taskId);
      toast.info(`正在收集 ${data.requested} 台在线 Agent 的诊断信息`);
    },
    onError: (err) => toast.error(err.message || "启动支持包任务失败"),
  });
  const supportBundleQuery = trpc.system.supportBundleStatus.useQuery(
    { taskId: supportTaskId || "00000000-0000-0000-0000-000000000000" },
    { enabled: !!supportTaskId, refetchInterval: supportTaskId ? 1000 : false },
  );
  useEffect(() => {
    const data = supportBundleQuery.data;
    if (!supportTaskId || !data?.complete || !data.download || downloadedSupportTaskRef.current === supportTaskId) return;
    downloadedSupportTaskRef.current = supportTaskId;
    try {
      downloadTextFile(data.download.filename, data.download.content, data.download.mimeType);
      const failed = data.hosts.filter((host) => host.status !== "complete").length;
      toast.success(failed > 0 ? `支持包已生成，${failed} 台 Agent 未返回完整诊断` : "支持包已生成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "支持包已生成，但浏览器保存文件失败");
    }
    setSupportTaskId("");
  }, [supportBundleQuery.data, supportTaskId]);
  const logLevelClass = (level: string) => {
    if (level === "error") return "text-destructive";
    if (level === "warn") return "text-[var(--fx-warn-text)]";
    if (level === "info") return "text-primary";
    return "text-muted-foreground";
  };
  const panelLogEntries = panelLogs?.logs || [];
  const resetPanelLogs = (level: PanelLogLevel) => {
    setPanelLogLevel(level);
    setPanelLogOffset(0);
  };
  const refreshPanelLogs = () => {
    if (panelLogOffset === 0) {
      refetchPanelLogs();
      return;
    }
    setPanelLogOffset(0);
  };
  const panelLogStart = panelLogEntries.length > 0 ? (panelLogs?.offset || 0) + 1 : 0;
  const panelLogEnd = (panelLogs?.offset || 0) + panelLogEntries.length;
  if (panelLogs?.summary) {
    panelLogSummaryRef.current = normalizePanelLogSummary(panelLogs.summary as Partial<PanelLogSummary>);
  }
  const summary = panelLogSummaryRef.current;
  const levelTabs = [
    { value: "all", label: "全部", count: summary.all || 0 },
    { value: "info", label: "Info", count: summary.info || 0 },
    { value: "warn", label: "Warn", count: summary.warn || 0 },
    { value: "error", label: "Error", count: summary.error || 0 },
    { value: "log", label: "Log", count: summary.log || 0 },
  ] as const;
  const logViewportClass = "h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-border/40 bg-muted/20 p-3 font-mono text-xs leading-relaxed";
  const logEmptyClass = "flex h-full items-center justify-center text-muted-foreground";
  return (
    <div className="flex flex-col gap-4">
      <Card className="border-border bg-card">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                面板日志
              </CardTitle>
              <CardDescription>今天和前两天的运行日志（按北京时间零点切）。</CardDescription>
              {/* 几个面板实例连同一个库时，后台任务只由拿着租约的那个跑（server/panelLease.ts）。 */}
              {panelLogs?.backgroundLease ? (
                <p className="mt-1 text-meta text-muted-foreground" title={panelLogs.backgroundLease.instanceId ? `本实例 ${panelLogs.backgroundLease.instanceId}` : undefined}>
                  {panelLogs.backgroundLease.text}
                </p>
              ) : null}
            </div>
            {/*
              原来这里并排五样：一个「导出级别」选择框、导出、刷新、生成支持包、一个红色实心的
              「清空日志」—— 点一下就清，没有确认。选择框和下面那排级别标签是两套筛选，
              一个管看、一个管导出，谁也说不清导出的是哪一种。

              现在：导出的就是正在看的那一级（看 Warn 时导出 Warn）；外面留导出和刷新，
              支持包和清空收进「···」，清空排最后、先确认。
            */}
            <EntityActions
              primary={[
                {
                  key: "export",
                  label: panelLogLevel === "all" ? "导出日志" : `导出 ${levelTabs.find((tab) => tab.value === panelLogLevel)?.label ?? ""} 日志`,
                  icon: <Download className="h-3.5 w-3.5" />,
                  onSelect: () => exportLogsMutation.mutate({ level: panelLogLevel }),
                  disabled: exportLogsMutation.isPending,
                },
                {
                  key: "refresh",
                  label: "刷新",
                  icon: <RefreshCw className={cn("h-3.5 w-3.5", panelLogsFetching && "forwardx-icon-spin")} />,
                  onSelect: refreshPanelLogs,
                  disabled: panelLogsFetching,
                },
              ]}
              menu={[
                {
                  key: "support",
                  label: "生成支持包",
                  icon: <Download className="h-3.5 w-3.5" />,
                  onSelect: () => startSupportBundleMutation.mutate(),
                  disabled: startSupportBundleMutation.isPending || !!supportTaskId,
                },
                {
                  key: "clear",
                  label: "清空日志",
                  destructive: true,
                  onSelect: () => {
                    void confirmDialog({
                      title: "清空面板日志",
                      description: "最近三天的面板日志会全部删除，删除后无法恢复。需要留底的话先导出。",
                      confirmText: "清空",
                      tone: "destructive",
                    }).then((confirmed) => {
                      if (confirmed) clearLogsMutation.mutate();
                    });
                  },
                  disabled: clearLogsMutation.isPending,
                },
              ]}
              menuLabel="更多日志操作"
            />
          </div>
          {supportTaskId ? (
            /* 支持包收进菜单之后，进度不能跟着藏起来：收集要几十秒，得看得见在干活。 */
            <p className="flex items-center gap-1.5 text-meta text-muted-foreground" title="收集面板日志、配置审计和在线 Agent 的脱敏诊断">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              正在收集支持包 {supportBundleQuery.data?.total ? supportBundleQuery.data.total - supportBundleQuery.data.pending : 0}/{supportBundleQuery.data?.total || 0}，完成后自动下载
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          <Tabs value={panelLogLevel} onValueChange={(v) => resetPanelLogs(v as typeof panelLogLevel)} className="space-y-3">
            <TabsList className="grid h-auto w-full grid-cols-2 bg-muted/50 sm:grid-cols-5">
              {levelTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="min-w-0 gap-1.5 text-xs">
                  {tab.label}
                  <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">{tab.count}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {panelLogsLoading ? (
            <DataSectionLoading label="正在加载面板日志" minHeight="h-80" />
          ) : (
          <div className={logViewportClass}>
            {panelLogEntries.length === 0 ? (
              <div className={logEmptyClass}>暂无日志</div>
            ) : (
              <div className="space-y-1">
                {panelLogEntries.map((entry: any) => (
                  <div key={entry.id} className="grid gap-x-2 sm:grid-cols-[112px_48px_1fr]">
                    {/*
                      原来是 toLocaleString()：英文系统上是「9/23/2026, 12:51:27 PM」，150px 的列放不下，
                      每一条都折成两行，一屏只剩一半的日志。日志只看最近三天，年份不用写；
                      固定成「09-23 12:51:27」，完整时间悬停看。
                    */}
                    <span className="whitespace-nowrap text-muted-foreground" title={new Date(entry.createdAt).toLocaleString()}>
                      {formatLogTime(entry.createdAt)}
                    </span>
                    <span className={logLevelClass(entry.level)}>{String(entry.level).toUpperCase()}</span>
                    <span className="whitespace-pre-wrap break-words text-foreground/90">{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
          <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              当前显示 {panelLogStart}-{panelLogEnd} / {panelLogs?.total || 0} 条
              {panelLogsFetching && !panelLogsLoading ? "，正在刷新" : ""}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPanelLogOffset(Math.max(0, panelLogOffset - LOG_PAGE_SIZE))}
                disabled={panelLogsFetching || panelLogOffset <= 0}
              >
                较新
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPanelLogOffset(panelLogs?.nextOffset || 0)}
                disabled={panelLogsFetching || !panelLogs?.hasMore}
              >
                更早
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <PanelProfilingCard />
    </div>
  );
}
