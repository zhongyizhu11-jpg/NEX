/* 从 client/src/pages/Settings.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { FormField } from "@/components/ui/form-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { downloadTextFile, type TextDownloadFile } from "@/lib/fileDownload";
import { cn } from "@/lib/utils";
import { panelMigrationScopeLabel, type PanelMigrationScope } from "@shared/panelMigration";
import { Key, Copy, CheckCircle2, Download, ShieldCheck, AlertTriangle, Database, Upload, Lock, MoveRight, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useMemo, useRef, useState, useEffect } from "react";
import { toast } from "sonner";

function formatDatabaseSwitchDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}


function formatCountdown(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainSeconds = safeSeconds % 60;
  return `${minutes}:${remainSeconds.toString().padStart(2, "0")}`;
}


function getMigrationCodeCountdown(code: { expiresAt: number } | null, now: number) {
  if (!code) return 0;
  return Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
}


/* 分区定义（settingsTabs / settingsGroups / settingsTabItems / settingsTabDetail）在 ./settingsSections.ts，手机「更多」页也用同一份 */
type DatabaseType = "sqlite" | "mysql" | "postgresql";

type BackupSummaryCache = {
  userCount: number;
  hostCount: number;
  ruleCount: number;
  tunnelCount: number;
  forwardGroupCount: number;
  hasExistingData: boolean;
  cachedAt?: number;
};

type BackupTaskProgress = {
  percent: number;
  step: string;
  detail: string;
  status: "running" | "success" | "error";
};


const backupSummaryCacheKey = "forwardx.settings.backupSummary";

const zeroBackupSummary: BackupSummaryCache = {
  userCount: 0,
  hostCount: 0,
  ruleCount: 0,
  tunnelCount: 0,
  forwardGroupCount: 0,
  hasExistingData: false,
};

function normalizeBackupSummaryCache(value: any): BackupSummaryCache {
  return {
    userCount: Math.max(0, Number(value?.userCount || 0)),
    hostCount: Math.max(0, Number(value?.hostCount || 0)),
    ruleCount: Math.max(0, Number(value?.ruleCount || 0)),
    tunnelCount: Math.max(0, Number(value?.tunnelCount || 0)),
    forwardGroupCount: Math.max(0, Number(value?.forwardGroupCount || 0)),
    hasExistingData: !!value?.hasExistingData,
    cachedAt: Number(value?.cachedAt || 0) || undefined,
  };
}


function readBackupSummaryCache(): BackupSummaryCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(backupSummaryCacheKey);
    if (!raw) return null;
    return normalizeBackupSummaryCache(JSON.parse(raw));
  } catch {
    return null;
  }
}


function writeBackupSummaryCache(summary: BackupSummaryCache) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(backupSummaryCacheKey, JSON.stringify({ ...summary, cachedAt: Date.now() }));
  } catch {
    // Local cache is only a display optimization.
  }
}


function BackupTaskProgressView({ progress }: { progress: BackupTaskProgress | null }) {
  if (!progress) return null;
  return (
    <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          {progress.status === "running"
            ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            : progress.status === "success"
              ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
              : <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />}
          <span className="truncate font-medium">{progress.step}</span>
        </div>
        <span className="shrink-0 tabular-nums">{progress.percent}%</span>
      </div>
      <Progress value={progress.percent} className="mt-3" />
      <p className="mt-2 text-xs text-muted-foreground">{progress.detail}</p>
    </div>
  );
}


export default function BackupRestoreSection({ panelUrl }: { panelUrl: string }) {
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const defaultSqlitePath = "/data/forwardx.db";
  const [migrationCode, setMigrationCode] = useState<{
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
    pendingRequest?: {
      id: string;
      targetPanelUrl: string;
      status: "pending" | "approved" | "rejected" | "used";
      createdAt: number;
      expiresAt: number;
      approvedAt?: number;
      rejectedAt?: number;
      dataScope: PanelMigrationScope;
      targetDatabaseType?: "sqlite" | "mysql" | "postgresql";
      directSqliteRequested: boolean;
    } | null;
  } | null>(null);
  const [migrationCodeTick, setMigrationCodeTick] = useState(Date.now());
  const [backupPassword, setBackupPassword] = useState("");
  // 带不带订阅与代理节点：只想把转发、隧道、转发组迁到新面板时可以不带。
  const [backupIncludeProxy, setBackupIncludeProxy] = useState(true);
  const [backupPasswordConfirm, setBackupPasswordConfirm] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importFilename, setImportFilename] = useState("");
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [exportProgress, setExportProgress] = useState<BackupTaskProgress | null>(null);
  const [pendingBackupDownload, setPendingBackupDownload] = useState<TextDownloadFile | null>(null);
  const [backupSaveCooldown, setBackupSaveCooldown] = useState(false);
  const backupSaveCooldownTimerRef = useRef<number | null>(null);
  const [importProgress, setImportProgress] = useState<BackupTaskProgress | null>(null);
  const [onlineMigration, setOnlineMigration] = useState<{
    oldPanelUrl: string;
    migrationCode: string;
    targetPanelUrl: string;
    dataScope: PanelMigrationScope;
  }>({
    oldPanelUrl: "",
    migrationCode: "",
    targetPanelUrl: panelUrl,
    dataScope: "essential",
  });
  const [showOnlineConfirm, setShowOnlineConfirm] = useState(false);
  const [migrationJobId, setMigrationJobId] = useState<string | null>(null);
  const [reportedMigrationJobId, setReportedMigrationJobId] = useState<string | null>(null);
  const [databaseSwitchType, setDatabaseSwitchType] = useState<DatabaseType>("sqlite");
  const [databaseSwitchMysql, setDatabaseSwitchMysql] = useState({
    host: "127.0.0.1",
    port: 3306,
    user: "forwardx",
    password: "",
    database: "forwardx",
    ssl: false,
  });
  const [databaseSwitchPostgresql, setDatabaseSwitchPostgresql] = useState({
    host: "127.0.0.1",
    port: 5432,
    user: "forwardx",
    password: "",
    database: "forwardx",
    ssl: false,
  });
  const [databaseSwitchSqlitePath, setDatabaseSwitchSqlitePath] = useState(defaultSqlitePath);
  const [testedDatabaseSwitchKey, setTestedDatabaseSwitchKey] = useState("");
  const [databaseSwitchValidationError, setDatabaseSwitchValidationError] = useState("");
  const [databaseSwitchJobId, setDatabaseSwitchJobId] = useState<string | null>(null);
  const [reportedDatabaseSwitchJobId, setReportedDatabaseSwitchJobId] = useState<string | null>(null);
  const [showDatabaseSwitchConfirm, setShowDatabaseSwitchConfirm] = useState(false);
  const [cachedBackupSummary, setCachedBackupSummary] = useState<BackupSummaryCache | null>(() => readBackupSummaryCache());

  /*
    原来备份页开着就每秒拉一次迁移码。倒计时本来就在本地走（migrationCodeTick），
    要轮询的只是「新面板有没有发来迁移请求」—— 那只在有码的时候才可能发生。没码就不刷。
  */
  const { data: currentMigrationCode } = trpc.system.getMigrationCode.useQuery(undefined, {
    refetchInterval: (query) => (query.state.data ? pollingInterval("live") : false),
  });
  const { data: databaseSwitchStatus } = trpc.system.databaseSwitchStatus.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
  });
  const { data: backupSummary, isLoading: backupSummaryLoading } = trpc.system.backupSummary.useQuery(undefined, {
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: migrationJob } = trpc.system.panelMigrationStatus.useQuery(
    { jobId: migrationJobId || "" },
    {
      enabled: !!migrationJobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "success" || status === "failed" ? false : 1200;
      },
    },
  );
  const { data: databaseSwitchJob } = trpc.system.databaseSwitchJob.useQuery(
    { jobId: databaseSwitchJobId || "" },
    {
      enabled: !!databaseSwitchJobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "success" || status === "failed" ? false : 1200;
      },
    },
  );

  const actualDefaultSqlitePath = databaseSwitchStatus?.defaultSqlitePath || defaultSqlitePath;
  const databaseSwitchConfig = useMemo(
    () =>
      databaseSwitchType === "mysql"
        ? { type: "mysql" as const, mysql: databaseSwitchMysql }
        : databaseSwitchType === "postgresql"
          ? { type: "postgresql" as const, postgresql: databaseSwitchPostgresql }
          : { type: "sqlite" as const, sqlite: { path: databaseSwitchSqlitePath || actualDefaultSqlitePath } },
    [actualDefaultSqlitePath, databaseSwitchMysql, databaseSwitchPostgresql, databaseSwitchSqlitePath, databaseSwitchType],
  );
  const databaseSwitchConfigKey = useMemo(() => JSON.stringify(databaseSwitchConfig), [databaseSwitchConfig]);
  const databaseSwitchExternal = databaseSwitchType === "postgresql" ? databaseSwitchPostgresql : databaseSwitchMysql;
  const setDatabaseSwitchExternal = databaseSwitchType === "postgresql" ? setDatabaseSwitchPostgresql : setDatabaseSwitchMysql;
  const databaseSwitchExternalDefaultPort = databaseSwitchType === "postgresql" ? 5432 : 3306;
  const isDatabaseSwitchTested = testedDatabaseSwitchKey === databaseSwitchConfigKey;
  const databaseSwitchRunning = databaseSwitchJob?.status === "pending" || databaseSwitchJob?.status === "running";
  const databaseSwitchFailed = databaseSwitchJob?.status === "failed";
  const databaseSwitchSucceeded = databaseSwitchJob?.status === "success";
  const databaseSwitchElapsed = databaseSwitchJob
    ? formatDatabaseSwitchDuration((databaseSwitchJob.finishedAt || Date.now()) - databaseSwitchJob.startedAt)
    : "0 秒";
  const databaseSwitchUpdatedAgo = databaseSwitchJob
    ? formatDatabaseSwitchDuration(Date.now() - (databaseSwitchJob.updatedAt || databaseSwitchJob.startedAt))
    : "0 秒";

  useEffect(() => {
    setMigrationCode(currentMigrationCode || null);
  }, [currentMigrationCode]);

  useEffect(() => {
    if (!backupSummary) return;
    const nextSummary = normalizeBackupSummaryCache(backupSummary);
    setCachedBackupSummary(nextSummary);
    writeBackupSummaryCache(nextSummary);
  }, [backupSummary]);

  useEffect(() => {
    setOnlineMigration((current) => (
      current.targetPanelUrl ? current : { ...current, targetPanelUrl: panelUrl }
    ));
  }, [panelUrl]);

  useEffect(() => {
    if (!migrationCode) return;
    const timer = window.setInterval(() => setMigrationCodeTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [migrationCode?.code]);

  useEffect(() => {
    if (!migrationJob || reportedMigrationJobId === migrationJob.id) return;
    if (migrationJob?.status === "success") {
      toast.success(migrationJob.message || "在线迁移完成");
      utils.system.backupSummary.invalidate();
      setReportedMigrationJobId(migrationJob.id);
    }
    if (migrationJob?.status === "failed") {
      toast.error(migrationJob.error || "在线迁移失败");
      setReportedMigrationJobId(migrationJob.id);
    }
  }, [migrationJob, reportedMigrationJobId, utils.system.backupSummary]);

  useEffect(() => {
    const activeJob = databaseSwitchStatus?.activeJob;
    if (!databaseSwitchJobId && activeJob?.id) {
      setDatabaseSwitchJobId(activeJob.id);
    }
  }, [databaseSwitchJobId, databaseSwitchStatus?.activeJob]);

  useEffect(() => {
    if (!databaseSwitchStatus?.defaultSqlitePath) return;
    setDatabaseSwitchSqlitePath((current) => (
      !current || current === defaultSqlitePath ? databaseSwitchStatus.defaultSqlitePath : current
    ));
  }, [databaseSwitchStatus?.defaultSqlitePath]);

  useEffect(() => {
    if (!databaseSwitchJob || reportedDatabaseSwitchJobId === databaseSwitchJob.id) return;
    if (databaseSwitchJob.status === "success") {
      toast.success(databaseSwitchJob.message || "数据库切换完成");
      utils.system.backupSummary.invalidate();
      utils.system.databaseSwitchStatus.invalidate();
      setReportedDatabaseSwitchJobId(databaseSwitchJob.id);
      if (databaseSwitchJob.restartRequired) {
        window.setTimeout(() => window.location.reload(), 3000);
      }
    }
    if (databaseSwitchJob.status === "failed") {
      toast.error(databaseSwitchJob.error || "数据库切换失败");
      setReportedDatabaseSwitchJobId(databaseSwitchJob.id);
    }
  }, [databaseSwitchJob, reportedDatabaseSwitchJobId, utils.system.backupSummary, utils.system.databaseSwitchStatus]);

  const createMigrationCodeMutation = trpc.system.createMigrationCode.useMutation({
    onSuccess: (data) => {
      setMigrationCode(data);
      utils.system.getMigrationCode.invalidate();
      toast.success("迁移码已生成，5 分钟内有效");
    },
    onError: (err) => toast.error(err.message || "生成迁移码失败"),
  });

  const approveMigrationRequestMutation = trpc.system.approveMigrationRequest.useMutation({
    onSuccess: () => {
      utils.system.getMigrationCode.invalidate();
      toast.success("已同意迁移请求，新面板将开始导入数据");
    },
    onError: (err) => toast.error(err.message || "同意迁移请求失败"),
  });

  const rejectMigrationRequestMutation = trpc.system.rejectMigrationRequest.useMutation({
    onSuccess: () => {
      utils.system.getMigrationCode.invalidate();
      toast.success("已拒绝迁移请求");
    },
    onError: (err) => toast.error(err.message || "拒绝迁移请求失败"),
  });

  const finishExportProgress = (next: BackupTaskProgress) => {
    setExportProgress(next);
    window.setTimeout(() => setExportProgress(null), 1800);
  };

  const finishImportProgress = (next: BackupTaskProgress) => {
    setImportProgress(next);
    window.setTimeout(() => setImportProgress(null), 2200);
  };

  const startBackupSaveCooldown = () => {
    setBackupSaveCooldown(true);
    if (backupSaveCooldownTimerRef.current !== null) {
      window.clearTimeout(backupSaveCooldownTimerRef.current);
    }
    backupSaveCooldownTimerRef.current = window.setTimeout(() => {
      backupSaveCooldownTimerRef.current = null;
      setBackupSaveCooldown(false);
    }, 1500);
  };

  useEffect(() => () => {
    if (backupSaveCooldownTimerRef.current !== null) {
      window.clearTimeout(backupSaveCooldownTimerRef.current);
    }
  }, []);

  const exportBackupMutation = trpc.system.exportPanelBackup.useMutation({
    onSuccess: (data) => {
      const backupFile: TextDownloadFile = {
        filename: data.filename,
        content: data.content,
        mimeType: data.mimeType || "application/json;charset=utf-8",
      };
      setExportProgress({
        percent: 92,
        step: "正在准备下载文件",
        detail: `备份文件 ${data.filename} 已生成，浏览器即将保存。`,
        status: "running",
      });
      setBackupPassword("");
      setBackupPasswordConfirm("");
      setPendingBackupDownload(backupFile);
      startBackupSaveCooldown();
      try {
        downloadTextFile(backupFile.filename, backupFile.content, backupFile.mimeType);
        finishExportProgress({
          percent: 100,
          step: "备份文件已生成",
          detail: "已请求浏览器保存；若 Safari 没有开始下载，可点击“再次保存已生成备份”。",
          status: "success",
        });
        toast.success("备份文件已生成");
        for (const warning of data.warnings || []) toast.warning(warning);
      } catch {
        finishExportProgress({
          percent: 100,
          step: "备份已生成，浏览器保存失败",
          detail: "无需重新导出，请点击“再次保存已生成备份”重试。",
          status: "error",
        });
        toast.error("备份已生成，但浏览器未能保存文件，请点击重新保存");
      }
    },
    onError: (err) => {
      finishExportProgress({
        percent: 100,
        step: "备份生成失败",
        detail: err.message || "服务器生成备份失败",
        status: "error",
      });
      toast.error(err.message || "服务器生成备份失败");
    },
  });

  const importBackupMutation = trpc.system.importPanelBackup.useMutation({
    onSuccess: async (result) => {
      const insertedRows = Number(result.insertedRows || 0);
      const updatedRows = Number(result.updatedRows || 0);
      const reusedRows = Number(result.reusedRows || 0);
      const skippedRows = Number(result.skippedRows || 0);
      const validation = result.agentValidation;
      const validationText = validation?.requestedHosts
        ? ` 已请求 ${validation.requestedHosts} 台 Agent 重新检查连接和 Mimic 环境，${validation.pendingHosts || 0} 台离线主机将在重新连接后上报。`
        : "";
      setImportProgress({
        percent: 88,
        step: "正在刷新面板数据",
        detail: "备份已导入，正在更新当前页面的数据概览。",
        status: "running",
      });
      setShowImportConfirm(false);
      setImportPassword("");
      setImportContent("");
      setImportFilename("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await utils.system.backupSummary.invalidate();
      finishImportProgress({
        percent: 100,
        step: result.alreadyImported
          ? "已阻止重复导入"
          : result.partial
          ? "备份已部分恢复"
          : result.mode === "incremental"
          ? "增量导入完成"
          : "备份恢复完成",
        detail: result.alreadyImported
          ? "该备份文件已经导入过，本次未再次写入数据。"
          : `其余可用数据已经导入：新增 ${insertedRows} 条，更新 ${updatedRows} 条，复用 ${reusedRows} 条，跳过 ${skippedRows} 条。${validationText}`,
        status: "success",
      });
      if (result.alreadyImported) {
        toast.warning("该备份已经导入过，已阻止重复写入");
      } else if (result.partial) {
        toast.warning(result.warnings?.[0] || `备份已部分恢复，跳过 ${skippedRows} 条；其余数据已经导入`);
      } else {
        toast.success(result.mode === "incremental" ? "增量导入完成，当前面板数据已保留" : "备份恢复完成");
      }
    },
    onError: (err) => {
      finishImportProgress({
        percent: 100,
        step: "备份导入失败",
        detail: err.message || "导入备份失败",
        status: "error",
      });
      toast.error(err.message || "导入备份失败");
    },
  });

  useEffect(() => {
    if (!exportBackupMutation.isPending) return;
    const timer = window.setInterval(() => {
      setExportProgress((current) => {
        if (!current || current.status !== "running") return current;
        const nextPercent = Math.min(86, current.percent + (current.percent < 70 ? 3 : 1));
        return {
          percent: nextPercent,
          step: nextPercent >= 78 ? "等待服务器完成导出" : current.step,
          detail: nextPercent >= 78 ? "数据量较大时导出会多花一些时间，请保持当前页面打开。" : current.detail,
          status: "running",
        };
      });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [exportBackupMutation.isPending]);

  useEffect(() => {
    if (!importBackupMutation.isPending) return;
    const timer = window.setInterval(() => {
      setImportProgress((current) => {
        if (!current || current.status !== "running") return current;
        const nextPercent = Math.min(84, current.percent + (current.percent < 65 ? 3 : 1));
        return {
          percent: nextPercent,
          step: nextPercent >= 74 ? "等待服务器完成导入" : current.step,
          detail: nextPercent >= 74 ? "备份文件较大时恢复会多花一些时间，请不要关闭页面。" : current.detail,
          status: "running",
        };
      });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [importBackupMutation.isPending]);
  const startPanelMigrationMutation = trpc.system.startPanelMigration.useMutation({
    onSuccess: (job) => {
      setMigrationJobId(job.id);
      setReportedMigrationJobId(null);
      setShowOnlineConfirm(false);
      toast.success("在线迁移任务已开始");
    },
    onError: (err) => toast.error(err.message || "启动在线迁移失败"),
  });

  const testDatabaseSwitchMutation = trpc.system.testDatabaseSwitchTarget.useMutation({
    onSuccess: (data, variables) => {
      setTestedDatabaseSwitchKey(JSON.stringify(variables));
      setDatabaseSwitchValidationError("");
      toast.success(data.message || "目标数据库连接及写入权限测试通过");
    },
    onError: (err) => {
      setTestedDatabaseSwitchKey("");
      const message = err.message || "目标数据库连接或迁移写入权限验证失败";
      setDatabaseSwitchValidationError(message);
      toast.error(message);
    },
  });

  useEffect(() => {
    setDatabaseSwitchValidationError("");
  }, [databaseSwitchConfigKey]);

  const startDatabaseSwitchMutation = trpc.system.startDatabaseSwitch.useMutation({
    onSuccess: (job) => {
      setDatabaseSwitchJobId(job.id);
      setReportedDatabaseSwitchJobId(null);
      setShowDatabaseSwitchConfirm(false);
      toast.success("数据库迁移切换任务已开始");
    },
    onError: (err) => toast.error(err.message || "启动数据库切换失败"),
  });

  const copyMigrationCode = async (code: string) => {
    /*
      走共享实现。原来这里自己拼 textarea 挂到 document.body 上 ——
      而这个复制按钮在弹窗里，弹窗有焦点陷阱，会把焦点抢回去。
      共享那份专门把临时元素挂在打开着的弹窗内，就是为了这个。
    */
    if (await copyTextToClipboard(code)) toast.success("迁移码已复制");
    else toast.error(clipboardNeedsManualCopy() ? "当前是 http 访问，浏览器限制了剪贴板，请手动选中复制" : "复制失败，请手动选中迁移码复制");
  };

  const migrationCountdown = getMigrationCodeCountdown(migrationCode, migrationCodeTick);
  const migrationRequest = migrationCode?.pendingRequest;
  const displayBackupSummary = backupSummary
    ? normalizeBackupSummaryCache(backupSummary)
    : cachedBackupSummary || zeroBackupSummary;
  const backupSummaryReady = !!backupSummary;
  const hasExistingData = !!displayBackupSummary.hasExistingData;

  const handleExportBackup = () => {
    if (backupPassword.length < 8) {
      toast.error("备份密码至少需要 8 位");
      return;
    }
    if (backupPassword !== backupPasswordConfirm) {
      toast.error("两次输入的备份密码不一致");
      return;
    }
    setExportProgress({
      percent: 12,
      step: "正在读取面板数据",
      detail: "正在整理用户、主机、规则、隧道和系统配置。",
      status: "running",
    });
    window.setTimeout(() => {
      setExportProgress((current) => current?.status === "running"
        ? { percent: 42, step: "正在裁剪低价值数据", detail: "正在跳过日志、历史探测和临时统计数据，减小备份体积。", status: "running" }
        : current);
    }, 700);
    window.setTimeout(() => {
      setExportProgress((current) => current?.status === "running"
        ? { percent: 68, step: "正在加密备份内容", detail: "备份文件会使用当前输入的密码加密保存。", status: "running" }
        : current);
    }, 1600);
    exportBackupMutation.mutate({ password: backupPassword, includeProxy: backupIncludeProxy });
  };

  const handleRetryBackupDownload = () => {
    if (!pendingBackupDownload || backupSaveCooldown) return;
    startBackupSaveCooldown();
    try {
      downloadTextFile(
        pendingBackupDownload.filename,
        pendingBackupDownload.content,
        pendingBackupDownload.mimeType,
      );
      finishExportProgress({
        percent: 100,
        step: "已再次请求浏览器保存",
        detail: "若下载仍未开始，请检查当前浏览器对该站点的下载权限。",
        status: "success",
      });
      toast.success("已再次请求浏览器保存加密备份");
    } catch {
      finishExportProgress({
        percent: 100,
        step: "浏览器保存失败",
        detail: "请检查当前浏览器的下载权限后再次重试。",
        status: "error",
      });
      toast.error("当前浏览器未能保存文件，请检查该站点的下载权限");
    }
  };

  const handleBackupFileChange = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error("备份文件过大");
      return;
    }
    const text = await file.text();
    setImportContent(text);
    setImportFilename(file.name);
  };

  const openImportConfirm = () => {
    if (!backupSummaryReady) {
      toast.info("正在读取当前面板数据，请稍后再导入");
      return;
    }
    if (!importContent) {
      toast.error("请选择备份文件");
      return;
    }
    if (!importPassword) {
      toast.error("请输入备份密码");
      return;
    }
    setShowImportConfirm(true);
  };

  const confirmImportBackup = () => {
    setImportProgress({
      percent: 15,
      step: "正在读取备份文件",
      detail: importFilename ? `正在处理 ${importFilename}。` : "正在处理已选择的备份文件。",
      status: "running",
    });
    window.setTimeout(() => {
      setImportProgress((current) => current?.status === "running"
        ? { percent: 36, step: "正在解密备份内容", detail: "正在使用备份密码校验并解密文件。", status: "running" }
        : current);
    }, 700);
    window.setTimeout(() => {
      setImportProgress((current) => current?.status === "running"
        ? { percent: 62, step: "正在写入面板数据", detail: "正在恢复主机、规则、隧道和转发组数据。", status: "running" }
        : current);
    }, 1600);
    importBackupMutation.mutate({
      content: importContent,
      password: importPassword,
      targetPanelUrl: panelUrl || undefined,
      confirmed: true,
    });
  };

  const openOnlineConfirm = () => {
    if (!backupSummaryReady) {
      toast.info("正在读取当前面板数据，请稍后再迁移");
      return;
    }
    if (!onlineMigration.oldPanelUrl.trim() || !onlineMigration.migrationCode.trim() || !onlineMigration.targetPanelUrl.trim()) {
      toast.error("请填写旧面板地址、迁移码和新面板访问地址");
      return;
    }
    setShowOnlineConfirm(true);
  };

  const handleTestDatabaseSwitch = () => {
    setTestedDatabaseSwitchKey("");
    setDatabaseSwitchValidationError("");
    testDatabaseSwitchMutation.mutate(databaseSwitchConfig);
  };

  const openDatabaseSwitchConfirm = () => {
    if (databaseSwitchStatus?.blockedReason) {
      toast.error(databaseSwitchStatus.blockedReason);
      return;
    }
    if (!backupSummaryReady) {
      toast.info("正在读取当前面板数据，请稍后再切换");
      return;
    }
    if (!isDatabaseSwitchTested) {
      toast.error("请先验证目标数据库连接和写入权限，通过后才能开始切换");
      return;
    }
    if (databaseSwitchRunning || startDatabaseSwitchMutation.isPending) {
      toast.info("已有数据库切换任务正在执行");
      return;
    }
    setShowDatabaseSwitchConfirm(true);
  };

  return (
    <div className="space-y-4">
      {/*
        原来顶上是五张数字卡片（用户 / 主机 / 规则 / 隧道 / 转发组），下面紧跟一条提示
        「已有业务数据，迁移按增量执行」。这五个数不是要盯着看的指标，是那句话的**依据**
        —— 为什么是增量、增量会保留哪些东西。放回那句话里：一行字说清，不占五个框。
      */}
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>
          {!backupSummaryReady && backupSummaryLoading
            ? "已展示缓存数据，正在后台刷新"
            : hasExistingData
              ? "当前面板已有业务数据，迁移将按增量方式执行"
              : "当前面板没有业务数据，可作为完整恢复执行"}
        </AlertTitle>
        <AlertDescription>
          <span className="block tabular-nums text-foreground">
            {[
              `${displayBackupSummary.userCount ?? 0} 个用户`,
              `${displayBackupSummary.hostCount ?? 0} 台主机`,
              `${displayBackupSummary.ruleCount ?? 0} 条规则`,
              `${displayBackupSummary.tunnelCount ?? 0} 条隧道`,
              `${displayBackupSummary.forwardGroupCount ?? 0} 个转发组`,
            ].join(" · ")}
          </span>
          <span className="block">
            {backupSummaryReady
              ? "增量迁移会保留新面板现有主机、用户、规则和订单数据，并把旧面板数据追加导入；重复的用户账号、主机 Token、订单号、兑换码会复用现有记录。"
              : "首次进入没有缓存时会先显示 0；接口返回真实数据后会自动更新并缓存，后续进入可直接展示上次统计。"}
          </span>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 @[58rem]:grid-cols-2">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4 text-primary" />
              旧面板迁移码
            </CardTitle>
            <CardDescription>
              在旧面板生成迁移码，并审批新面板发起的在线迁移请求。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {migrationCode ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">迁移码</p>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <code className="break-all font-mono text-lg font-semibold tracking-widest">{migrationCode.code}</code>
                  <Button variant="outline" size="sm" onClick={() => copyMigrationCode(migrationCode.code)}>
                    <Copy className="mr-2 h-3.5 w-3.5" />
                    复制
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>有效至 {new Date(migrationCode.expiresAt).toLocaleTimeString()}</span>
                  <Badge variant={migrationCountdown > 0 ? "outline" : "secondary"}>
                    剩余 {formatCountdown(migrationCountdown)}
                  </Badge>
                </div>
                {migrationRequest?.status === "pending" && (
                  <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] bg-[var(--fx-warn-soft)] p-3">
                    <p className="text-sm font-medium text-[var(--fx-warn-text)]">收到新面板迁移请求</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      目标面板：{migrationRequest.targetPanelUrl}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      迁移内容：{panelMigrationScopeLabel(migrationRequest.dataScope || "full")}
                      {migrationRequest.directSqliteRequested ? " · SQLite 快速传输" : ""}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => approveMigrationRequestMutation.mutate({ requestId: migrationRequest.id })}
                        disabled={approveMigrationRequestMutation.isPending || rejectMigrationRequestMutation.isPending}
                      >
                        同意迁移
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => rejectMigrationRequestMutation.mutate({ requestId: migrationRequest.id })}
                        disabled={approveMigrationRequestMutation.isPending || rejectMigrationRequestMutation.isPending}
                      >
                        拒绝
                      </Button>
                    </div>
                  </div>
                )}
                {migrationRequest?.status === "approved" && (
                  <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] p-3 text-sm text-[var(--fx-healthy-text)]">
                    已同意迁移请求，正在等待新面板拉取数据。
                  </div>
                )}
                {migrationRequest?.status === "rejected" && (
                  <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    已拒绝本次迁移请求。
                  </div>
                )}
              </div>
            ) : (
              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertTitle>一次性迁移码</AlertTitle>
                <AlertDescription>迁移码 5 分钟有效，使用后失效。</AlertDescription>
              </Alert>
            )}
            <Button onClick={() => createMigrationCodeMutation.mutate()} disabled={createMigrationCodeMutation.isPending}>
              生成迁移码
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MoveRight className="h-4 w-4 text-primary" />
              在线迁移接收
            </CardTitle>
            <CardDescription>
              拉取旧面板数据，并在新面板运行验证通过后完成接管。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label>迁移内容</Label>
              <Tabs
                value={onlineMigration.dataScope}
                onValueChange={(value) => setOnlineMigration({ ...onlineMigration, dataScope: value as PanelMigrationScope })}
              >
                <TabsList className="grid h-auto w-full grid-cols-2">
                  <TabsTrigger value="essential">关键数据迁移</TabsTrigger>
                  <TabsTrigger value="full">全量迁移</TabsTrigger>
                </TabsList>
              </Tabs>
              <p className="text-xs text-muted-foreground">
                {onlineMigration.dataScope === "essential"
                  ? "跳过监控、延迟、测试和审计历史，迁移速度更快。"
                  : "保留全部数据；空 SQLite 目标会自动使用数据库快速传输。"}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField className="space-y-2">
                <Label>旧面板地址</Label>
                <Input
                  value={onlineMigration.oldPanelUrl}
                  onChange={(e) => setOnlineMigration({ ...onlineMigration, oldPanelUrl: e.target.value })}
                  placeholder="https://old.example.com"
                />
              </FormField>
              <FormField className="space-y-2">
                <Label>旧面板迁移码</Label>
                <Input
                  value={onlineMigration.migrationCode}
                  onChange={(e) => setOnlineMigration({ ...onlineMigration, migrationCode: e.target.value.toUpperCase() })}
                  placeholder="迁移码"
                />
              </FormField>
            </div>
            <FormField className="space-y-2">
              <Label>新面板访问地址</Label>
              <Input
                value={onlineMigration.targetPanelUrl}
                onChange={(e) => setOnlineMigration({ ...onlineMigration, targetPanelUrl: e.target.value })}
                placeholder={panelUrl}
              />
            </FormField>
            {migrationJob && (
              <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{migrationJob.step}</span>
                  <span>{migrationJob.progress}%</span>
                </div>
                <Progress value={migrationJob.progress} className="mt-3" />
                <p className="mt-2 text-xs text-muted-foreground">
                  {migrationJob.error || migrationJob.message || "验证完成前请保持新旧面板可访问。"}
                </p>
              </div>
            )}
            <Button className="gap-2" onClick={openOnlineConfirm} disabled={startPanelMigrationMutation.isPending}>
              <MoveRight className="h-4 w-4" />
              开始在线迁移
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-primary" />
            数据库在线切换
          </CardTitle>
          <CardDescription>
            在 SQLite、MySQL、PostgreSQL 之间迁移当前面板数据，连接和写入权限验证通过后才能开始。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            三种数据库原来是三张可点的卡片，下面一条「数据库版本要求」的提示框把三种的要求
            一起列出来，再下面是一个套在卡片里的灰框装着字段 —— 三层框。它就是三选一：一个
            分段控件，下面一行只说选中那一种的要求，字段直接跟着。
          */}
          <SettingList>
            <SettingRow
              label="当前数据库"
              description="目标数据库需要为空库；迁移完成后面板会自动重启或刷新连接。"
              control={(
                <span className="text-secondary-type font-medium">
                  {databaseSwitchStatus?.currentType
                    ? databaseSwitchStatus.currentType === "sqlite"
                      ? "SQLite"
                      : databaseSwitchStatus.currentType === "mysql"
                        ? "MySQL"
                        : "PostgreSQL"
                    : "未识别"}
                </span>
              )}
            />
            <SettingRow
              label="切换到"
              control={(
                <Badge variant={isDatabaseSwitchTested ? "default" : "outline"} className="w-fit">
                  {isDatabaseSwitchTested ? "连接与写入已验证" : "等待测试"}
                </Badge>
              )}
            >
              <SegmentedControl<DatabaseType>
                ariaLabel="目标数据库"
                className="grid grid-cols-3 gap-1"
                value={databaseSwitchType}
                options={(["sqlite", "mysql", "postgresql"] as DatabaseType[]).map((type) => ({ value: type, label: type === "sqlite" ? "SQLite" : type === "mysql" ? "MySQL" : "PostgreSQL" }))}
                onChange={(type) => {
                  setDatabaseSwitchType(type);
                  setTestedDatabaseSwitchKey("");
                }}
              />
              <p className="text-meta text-muted-foreground">
                {databaseSwitchType === "sqlite"
                  ? "本地数据文件，无需额外服务。"
                  : databaseSwitchType === "mysql"
                    ? "外部 MySQL 数据库，需要 8.0.13 或更高版本。"
                    : "外部 PostgreSQL 数据库，建议 12 或更高版本。"}
              </p>
            </SettingRow>
          </SettingList>

          <div className="grid gap-4">

            {databaseSwitchStatus?.blockedReason && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>当前环境暂不支持面板内切换</AlertTitle>
                <AlertDescription>{databaseSwitchStatus.blockedReason}</AlertDescription>
              </Alert>
            )}

            {databaseSwitchType === "sqlite" ? (
              <FormField className="space-y-2">
                <Label>SQLite 数据文件</Label>
                <Input
                  value={databaseSwitchSqlitePath}
                  onChange={(e) => {
                    setDatabaseSwitchSqlitePath(e.target.value);
                    setTestedDatabaseSwitchKey("");
                  }}
                  placeholder={actualDefaultSqlitePath}
                />
              </FormField>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                  <FormField className="space-y-2">
                    <Label>地址</Label>
                    <Input
                      value={databaseSwitchExternal.host}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({ ...databaseSwitchExternal, host: e.target.value });
                        setTestedDatabaseSwitchKey("");
                      }}
                      placeholder="127.0.0.1"
                    />
                  </FormField>
                  <FormField className="space-y-2">
                    <Label>端口</Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={databaseSwitchExternal.port}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({
                          ...databaseSwitchExternal,
                          port: Number(e.target.value || databaseSwitchExternalDefaultPort),
                        });
                        setTestedDatabaseSwitchKey("");
                      }}
                    />
                  </FormField>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField className="space-y-2">
                    <Label>数据库名</Label>
                    <Input
                      value={databaseSwitchExternal.database}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({ ...databaseSwitchExternal, database: e.target.value });
                        setTestedDatabaseSwitchKey("");
                      }}
                    />
                  </FormField>
                  <FormField className="space-y-2">
                    <Label>用户名</Label>
                    <Input
                      value={databaseSwitchExternal.user}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({ ...databaseSwitchExternal, user: e.target.value });
                        setTestedDatabaseSwitchKey("");
                      }}
                    />
                  </FormField>
                </div>
                <FormField className="space-y-2">
                  <Label>密码</Label>
                  <PasswordInput
                    value={databaseSwitchExternal.password}
                    onChange={(e) => {
                      setDatabaseSwitchExternal({ ...databaseSwitchExternal, password: e.target.value });
                      setTestedDatabaseSwitchKey("");
                    }}
                  />
                </FormField>
                <SettingList>
                  <SettingRow
                    asLabel
                    label="启用 SSL"
                    description="远程数据库或云数据库可按需开启。"
                    control={(
                      <Checkbox aria-label="启用 SSL"
                        checked={databaseSwitchExternal.ssl}
                        onCheckedChange={(ssl) => {
                          setDatabaseSwitchExternal({ ...databaseSwitchExternal, ssl });
                          setTestedDatabaseSwitchKey("");
                        }}
                      />
                    )}
                  />
                </SettingList>
              </div>
            )}

            {databaseSwitchValidationError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>目标数据库验证失败，迁移未启动</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p className="whitespace-pre-wrap break-words">{databaseSwitchValidationError}</p>
                  <p>请修正目标账号或数据库权限并重新验证。验证通过前不会读取、写入或切换业务数据。</p>
                </AlertDescription>
              </Alert>
            )}

            {databaseSwitchJob && (
              <div className={cn(
                "rounded-lg border p-4",
                databaseSwitchFailed
                  ? "border-destructive/35 bg-destructive/5"
                  : databaseSwitchSucceeded
                    ? "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[color-mix(in_srgb,var(--fx-healthy)_5%,transparent)]"
                    : "border-primary/15 bg-primary/5",
              )}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-2.5">
                    {databaseSwitchFailed ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    ) : databaseSwitchSucceeded ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--fx-healthy-text)]" />
                    ) : databaseSwitchRunning ? (
                      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                    ) : (
                      <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{databaseSwitchJob.step}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {databaseSwitchJob.stageIndex && databaseSwitchJob.stageTotal
                          ? `第 ${databaseSwitchJob.stageIndex}/${databaseSwitchJob.stageTotal} 步 · `
                          : ""}
                        {databaseSwitchJob.sourceType || "未识别"} → {databaseSwitchJob.targetType || databaseSwitchConfig.type}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      variant={databaseSwitchFailed ? "destructive" : databaseSwitchSucceeded ? "default" : databaseSwitchRunning ? "secondary" : "outline"}
                    >
                      {databaseSwitchFailed ? "已失败" : databaseSwitchSucceeded ? "已完成" : databaseSwitchRunning ? "执行中" : "等待中"}
                    </Badge>
                    <span className="text-sm tabular-nums">{databaseSwitchJob.progress}%</span>
                  </div>
                </div>
                <Progress
                  value={databaseSwitchJob.progress}
                  className={cn(
                    "mt-3 h-2",
                    databaseSwitchFailed && "[&>div]:bg-destructive",
                    databaseSwitchSucceeded && "[&>div]:bg-[var(--fx-healthy)]",
                  )}
                />
                <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
                  <p>{databaseSwitchJob.detail || databaseSwitchJob.error || databaseSwitchJob.message || "数据库迁移切换正在执行，请不要重复提交。"}</p>
                  {(databaseSwitchJob.currentTable
                    || typeof databaseSwitchJob.totalRows === "number"
                    || typeof databaseSwitchJob.totalTables === "number") && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                      {databaseSwitchJob.currentTable && <span>当前表：<code>{databaseSwitchJob.currentTable}</code></span>}
                      {typeof databaseSwitchJob.totalRows === "number" && (
                        <span>数据行：{databaseSwitchJob.processedRows || 0}/{databaseSwitchJob.totalRows}</span>
                      )}
                      {typeof databaseSwitchJob.totalTables === "number" && (
                        <span>数据表：{databaseSwitchJob.processedTables || 0}/{databaseSwitchJob.totalTables}</span>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                    <span>耗时：{databaseSwitchElapsed}</span>
                    {databaseSwitchRunning && <span>最后进度更新：{databaseSwitchUpdatedAgo}前</span>}
                    {databaseSwitchJob.finishedAt && <span>任务已结束，不会继续在后台执行</span>}
                  </div>
                  {databaseSwitchJob.message && databaseSwitchJob.message !== databaseSwitchJob.detail && !databaseSwitchFailed && (
                    <p>{databaseSwitchJob.message}</p>
                  )}
                  {databaseSwitchFailed
                    && databaseSwitchJob.errorDetail
                    && databaseSwitchJob.errorDetail !== databaseSwitchJob.error && (
                      <p className="text-destructive">
                        数据库原始错误：<code className="break-all">{databaseSwitchJob.errorDetail}</code>
                      </p>
                    )}
                  {databaseSwitchJob.suggestion && (
                    <div className="border-l-2 border-[color-mix(in_srgb,var(--fx-warn)_60%,transparent)] pl-3 text-[var(--fx-warn-text)]">
                      <p>{databaseSwitchJob.suggestion}</p>
                      {databaseSwitchJob.suggestionCommand && (
                        <code className="mt-1 block select-all break-all font-mono text-[11px] text-foreground">
                          {databaseSwitchJob.suggestionCommand}
                        </code>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={handleTestDatabaseSwitch}
                disabled={testDatabaseSwitchMutation.isPending || databaseSwitchRunning || !!databaseSwitchStatus?.blockedReason}
              >
                {testDatabaseSwitchMutation.isPending ? "验证中..." : "验证连接与权限"}
              </Button>
              <Button
                className="gap-2"
                onClick={openDatabaseSwitchConfirm}
                disabled={!isDatabaseSwitchTested || databaseSwitchRunning || startDatabaseSwitchMutation.isPending || !!databaseSwitchStatus?.blockedReason}
              >
                <MoveRight className="h-4 w-4" />
                开始迁移切换
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 @[58rem]:grid-cols-2">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-primary" />
              加密数据导出
            </CardTitle>
            <CardDescription>
              导出一份离线备份文件，文件内容会使用你设置的备份密码加密。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField className="space-y-2">
                <Label>备份密码</Label>
                <PasswordInput value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} placeholder="至少 8 位" />
              </FormField>
              <FormField className="space-y-2">
                <Label>确认备份密码</Label>
                <PasswordInput value={backupPasswordConfirm} onChange={(e) => setBackupPasswordConfirm(e.target.value)} />
              </FormField>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={backupIncludeProxy} onCheckedChange={(checked) => setBackupIncludeProxy(checked === true)} className="mt-0.5" />
              <span className="min-w-0">
                包含订阅与代理节点
                <span className="block text-meta text-muted-foreground">
                  始终包含主机、转发规则、隧道、转发组、用户与套餐、系统设置；不含流量历史、延迟记录和日志（新面板会重新积累）。
                  只迁转发时可以取消勾选：节点自动绑定的转发导入后变成普通转发。
                </span>
              </span>
            </label>
            <Alert>
              <Lock className="h-4 w-4" />
              <AlertTitle>请妥善保存备份密码</AlertTitle>
              <AlertDescription>备份文件不保存明文数据，忘记密码将无法解密恢复。</AlertDescription>
            </Alert>
            <BackupTaskProgressView progress={exportProgress} />
            <div className="flex flex-wrap gap-2">
              <Button className="gap-2" onClick={handleExportBackup} disabled={exportBackupMutation.isPending}>
                {exportBackupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {exportBackupMutation.isPending ? "正在导出..." : "导出加密备份"}
              </Button>
              {pendingBackupDownload && (
                <Button variant="outline" className="gap-2" onClick={handleRetryBackupDownload} disabled={backupSaveCooldown}>
                  {backupSaveCooldown ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {backupSaveCooldown ? "请稍候..." : "再次保存已生成备份"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4 text-primary" />
              离线导入恢复
            </CardTitle>
            <CardDescription>
              旧面板离线时，可通过加密备份文件恢复并接管旧主机。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <FormField className="space-y-2">
              <Label>备份文件</Label>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".fwxbak,application/json"
                onChange={(e) => handleBackupFileChange(e.target.files?.[0])}
              />
              {importFilename && <p className="text-xs text-muted-foreground">已选择：{importFilename}</p>}
            </FormField>
            <FormField className="space-y-2">
              <Label>备份密码</Label>
              <PasswordInput value={importPassword} onChange={(e) => setImportPassword(e.target.value)} />
            </FormField>
            <BackupTaskProgressView progress={importProgress} />
            <Button className="gap-2" onClick={openImportConfirm} disabled={importBackupMutation.isPending}>
              {importBackupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {importBackupMutation.isPending ? "正在导入..." : "导入并恢复"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showImportConfirm} onOpenChange={setShowImportConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--fx-warn-text)]" />
              确认导入备份
            </DialogTitle>
            <DialogDescription>
              导入后会接管备份内已有主机，旧面板的主机、规则、隧道和转发组会迁移到当前面板。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>{hasExistingData ? "将执行增量导入" : "将执行完整恢复"}</AlertTitle>
            <AlertDescription>
              {hasExistingData
                ? "当前面板已有数据会被保留，备份内数据会增量追加；重复数据会尽量复用现有记录。"
                : "当前面板没有业务数据，导入后会保留当前管理员账户，并以备份数据作为当前面板数据。"}
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImportConfirm(false)} disabled={importBackupMutation.isPending}>
              取消
            </Button>
            <Button
              onClick={confirmImportBackup}
              disabled={importBackupMutation.isPending}
            >
              {importBackupMutation.isPending ? "正在导入..." : "确认导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showOnlineConfirm} onOpenChange={setShowOnlineConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--fx-warn-text)]" />
              确认在线迁移
            </DialogTitle>
            <DialogDescription>
              新面板将连接旧面板拉取数据，并在旧面板审批后执行迁移。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>{panelMigrationScopeLabel(onlineMigration.dataScope)}</AlertTitle>
            <AlertDescription>
              {hasExistingData ? "当前面板数据会保留并执行增量合并；" : "目标面板验证通过后才会接管；"}
              旧面板数据不会自动删除。
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOnlineConfirm(false)} disabled={startPanelMigrationMutation.isPending}>
              取消
            </Button>
            <Button
              onClick={() => startPanelMigrationMutation.mutate({
                oldPanelUrl: onlineMigration.oldPanelUrl.trim(),
                migrationCode: onlineMigration.migrationCode.trim(),
                targetPanelUrl: onlineMigration.targetPanelUrl.trim(),
                dataScope: onlineMigration.dataScope,
                confirmed: true,
              })}
              disabled={startPanelMigrationMutation.isPending}
            >
              确认迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDatabaseSwitchConfirm} onOpenChange={setShowDatabaseSwitchConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--fx-warn-text)]" />
              确认切换数据库
            </DialogTitle>
            <DialogDescription>
              面板会把当前数据迁移到目标数据库，完成后自动重启或刷新连接。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>请确认目标数据库为空库</AlertTitle>
            <AlertDescription>
              迁移会保留当前数据 ID；如果目标数据库已有业务数据，后端会阻止切换以避免覆盖或混合数据。
            </AlertDescription>
          </Alert>
          <Alert className="border-primary/20 bg-primary/5 text-primary">
            <Database className="h-4 w-4" />
            <AlertTitle>请确认数据库版本</AlertTitle>
            <AlertDescription>
              MySQL 需要 8.0.13 或以上版本；PostgreSQL 建议 12 或以上版本。
            </AlertDescription>
          </Alert>
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">当前数据库</span>
              <code>{databaseSwitchStatus?.currentType || "-"}</code>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-muted-foreground">目标数据库</span>
              <code>{databaseSwitchConfig.type}</code>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDatabaseSwitchConfirm(false)}
              disabled={startDatabaseSwitchMutation.isPending}
            >
              取消
            </Button>
            <Button
              onClick={() => startDatabaseSwitchMutation.mutate({
                target: databaseSwitchConfig,
                confirmed: true,
              })}
              disabled={startDatabaseSwitchMutation.isPending || !isDatabaseSwitchTested}
            >
              确认切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
