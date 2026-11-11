import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";

import { formatBytes } from "@shared/formatBytes";
import { HOST_RESOURCE_ALERT_MODE_OPTIONS, type HostResourceAlertMode } from "@shared/resourceAlert";
import { TRAFFIC_SHUTDOWN_REASON_LABELS, type TrafficShutdownBlockReason } from "@shared/hostTrafficShutdown";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime } from "@/lib/formatTime";
import { trpc } from "@/lib/trpc";

/*
  主机编辑 › 其他配置 › 「Agent 连接与保护」（只给管理员，见 server/routers/hostAgent.ts）：
  - Agent 面板连接地址：这台主机的 Agent 改连哪个面板地址（反代、不同线路），安装 / 升级命令也用它；
  - 流量阈值关机：本周期流量到比例后让 Agent 关掉整台机器（默认关，开启前要再确认一次）；
  - 资源告警：本机跟随全局 / 始终监控 / 不监控，CPU、内存、磁盘阈值可以单独填；
  - Agent 安装实例：同 Token 在另一台机器上安装会接管这台主机，这里看当前实例、必要时解除绑定。

  这几项改了要各自刷新缓存、叫醒 Agent，所以单独保存，不跟着主机表单的「保存」走。
*/

type Draft = {
  agentPanelUrlEnabled: boolean;
  agentPanelUrl: string;
  trafficShutdownEnabled: boolean;
  trafficShutdownThresholdPercent: number;
  alertMode: HostResourceAlertMode;
  cpuPercent: string;
  memoryPercent: string;
  diskPercent: string;
};

const BOX = "mt-2.5 space-y-2 rounded-md bg-muted/35 px-3 py-2.5";

function thresholdText(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function parseThreshold(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const n = Math.round(Number(text));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function sameDraft(a: Draft, b: Draft) {
  return (Object.keys(a) as Array<keyof Draft>).every((key) => a[key] === b[key]);
}

function PercentInput({ label, value, placeholder, onChange, disabled }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="flex h-8 w-20 shrink-0 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
      <Input
        aria-label={label}
        className="h-8 min-w-0 rounded-none border-0 px-2 text-right tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="flex h-8 shrink-0 items-center border-l border-border/60 bg-muted/50 px-1.5 text-sm text-muted-foreground">%</span>
    </div>
  );
}

export default function HostAgentManagementSection({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const query = trpc.hostAgent.get.useQuery({ hostId }, { staleTime: 10_000, refetchOnWindowFocus: false });
  const data = query.data;
  const initial = useMemo<Draft | null>(() => data ? {
    agentPanelUrlEnabled: data.panelUrl.enabled,
    agentPanelUrl: data.panelUrl.url,
    trafficShutdownEnabled: data.trafficShutdown.enabled,
    trafficShutdownThresholdPercent: data.trafficShutdown.thresholdPercent,
    alertMode: data.resourceAlert.override?.mode ?? "inherit",
    cpuPercent: thresholdText(data.resourceAlert.override?.cpuPercent),
    memoryPercent: thresholdText(data.resourceAlert.override?.memoryPercent),
    diskPercent: thresholdText(data.resourceAlert.override?.diskPercent),
  } : null, [data]);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (initial) setDraft(initial); }, [initial]);

  const save = trpc.hostAgent.save.useMutation({
    onSuccess: () => {
      toast.success("Agent 连接与保护设置已保存");
      void utils.hostAgent.get.invalidate({ hostId });
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const resetInstallation = trpc.hostAgent.resetInstallation.useMutation({
    onSuccess: () => {
      toast.success("已解除实例绑定，下一个上报的 Agent 会重新登记");
      void utils.hostAgent.get.invalidate({ hostId });
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  if (query.isLoading) {
    return (
      <div className={BOX}>
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取 Agent 连接与保护设置…</p>
      </div>
    );
  }
  if (!data || !draft || !initial) {
    return (
      <div className={BOX}>
        <p className="text-xs text-muted-foreground">Agent 连接与保护设置读取失败。</p>
        <Button size="sm" variant="outline" onClick={() => { void query.refetch(); }}>重试</Button>
      </div>
    );
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));
  const dirty = !sameDraft(draft, initial);
  const trafficLimit = data.trafficShutdown.trafficLimit;
  const usedPercent = trafficLimit > 0 ? Math.round((data.trafficShutdown.usedBytes / trafficLimit) * 100) : null;
  const shutdownStatus = data.trafficShutdown.triggeredThisCycle
    ? `本周期已触发（${formatDateTime(data.trafficShutdown.triggeredAt)}）。表示已授权关机，不代表确认关机成功。`
    : data.trafficShutdown.enabled
      ? (data.trafficShutdown.status === "due" ? "已到阈值，等待 Agent 下一轮执行" : TRAFFIC_SHUTDOWN_REASON_LABELS[data.trafficShutdown.status as TrafficShutdownBlockReason] || "")
      : "";

  const toggleShutdown = async (checked: boolean) => {
    if (!checked) {
      update("trafficShutdownEnabled", false);
      return;
    }
    const confirmed = await confirmDialog({
      title: "开启流量阈值关机",
      tone: "destructive",
      confirmText: "我已了解，开启",
      description: (
        <div className="space-y-2">
          <p>本周期流量达到阈值后，Agent 会执行 <code>shutdown -h now</code> / <code>poweroff</code>，<b>关闭整台机器</b>，这台机器上的所有服务都会中断，不只是停止转发。</p>
          <p>关机不等故障转移、不等 DDNS 切换；面板不会自动开机，需要到服务商控制台手动开机。每个流量周期最多触发一次，流量重置或者关掉开关再打开保存后才会重新生效。</p>
          <p>保存后生效；如果现在的用量已经达到阈值，Agent 下一轮（约 1 分钟内）就会关机。</p>
        </div>
      ),
    });
    if (confirmed) update("trafficShutdownEnabled", true);
  };

  const submit = () => {
    const thresholds = [draft.cpuPercent, draft.memoryPercent, draft.diskPercent].map(parseThreshold);
    if (thresholds.some((value) => value !== null && value !== 0 && value < 50)) {
      toast.error("告警阈值留空（跟随全局）、填 0（不报）或 50–100 之间的数");
      return;
    }
    const override = draft.alertMode === "inherit" && thresholds.every((value) => value === null)
      ? null
      : { mode: draft.alertMode, cpuPercent: thresholds[0], memoryPercent: thresholds[1], diskPercent: thresholds[2] };
    save.mutate({
      hostId,
      agentPanelUrlEnabled: draft.agentPanelUrlEnabled,
      agentPanelUrl: draft.agentPanelUrl.trim() || null,
      trafficShutdownEnabled: draft.trafficShutdownEnabled,
      trafficShutdownThresholdPercent: Math.min(100, Math.max(1, Math.round(draft.trafficShutdownThresholdPercent) || 100)),
      resourceAlertOverride: override,
    });
  };

  const resetBinding = async () => {
    const confirmed = await confirmDialog({
      title: "解除 Agent 实例绑定",
      description: "清掉这台主机记着的当前实例和已被接管的实例，之后第一个来上报的 Agent 重新登记。要把主机换回原来那台机器时用：先停掉现在这台机器上的 Agent，解除绑定后再重启原机器上的 Agent。",
      confirmText: "解除绑定",
    });
    if (confirmed) resetInstallation.mutate({ hostId });
  };

  const global = data.resourceAlert.global;
  return (
    <div data-fx-setting-box="" className={BOX} data-host-agent-management="">
      <div className="flex items-center gap-2">
        <PlugZap className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Label className="text-sm font-medium">Agent 连接与保护</Label>
        <span className="text-xs text-muted-foreground">单独保存</span>
      </div>

      {/* Agent 面板连接地址 */}
      <div className="space-y-1.5 border-t border-border/50 pt-2">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <Label className="text-sm">Agent 面板连接地址</Label>
            <p data-fx-help="" className="text-xs text-muted-foreground">
              默认跟随「面板公开地址」{data.panelUrl.globalPanelUrl ? `（${data.panelUrl.globalPanelUrl}）` : ""}。填一个反代到同一面板的地址，这台主机的安装 / 升级命令和在线 Agent 都改用它。
            </p>
          </div>
          <Checkbox aria-label="使用独立的 Agent 面板连接地址" checked={draft.agentPanelUrlEnabled} onCheckedChange={(checked) => update("agentPanelUrlEnabled", checked)} />
        </div>
        <Input
          className="h-8"
          placeholder="例如: https://cn-entry.example.com:8443"
          value={draft.agentPanelUrl}
          disabled={!draft.agentPanelUrlEnabled}
          onChange={(event) => update("agentPanelUrl", event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Agent 先用自己的 Token 验证新地址，通了才切换并写进配置，不通继续用原地址。
          {data.panelUrl.agentSupported
            ? (data.panelUrl.enabled ? ` 当前下发：${data.panelUrl.advertisedPanelUrl || "—"}` : "")
            : ` 在线切换需要 Agent ${data.panelUrl.requiredAgentVersion} 以上（当前 ${data.agentVersion || "未知"}）；更旧的 Agent 继续用原地址，可以用新地址重新执行安装命令。`}
        </p>
      </div>

      {/* 流量阈值关机 */}
      <div className="space-y-1.5 border-t border-border/50 pt-2">
        <div className="flex min-h-8 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <Label className="text-sm">流量阈值关机</Label>
            <p data-fx-help="" className="text-xs text-muted-foreground">
              本周期已用流量达到套餐流量的这个比例时关闭整台机器。
              {trafficLimit > 0
                ? ` 当前 ${formatBytes(data.trafficShutdown.usedBytes)} / ${formatBytes(trafficLimit)}${usedPercent !== null ? `（${usedPercent}%）` : ""}。`
                : " 需要先在上面设置大于 0 的套餐流量。"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PercentInput
              label="流量阈值关机比例（%）"
              value={String(draft.trafficShutdownThresholdPercent)}
              disabled={!draft.trafficShutdownEnabled}
              onChange={(value) => update("trafficShutdownThresholdPercent", Math.min(100, Math.max(1, Math.round(Number(value)) || 1)))}
            />
            <Checkbox
              aria-label="流量阈值关机"
              checked={draft.trafficShutdownEnabled}
              disabled={!draft.trafficShutdownEnabled && trafficLimit <= 0}
              onCheckedChange={(checked) => { void toggleShutdown(checked); }}
            />
          </div>
        </div>
        {draft.trafficShutdownEnabled ? (
          <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>达到阈值会关闭整台机器、中断所有服务，不等故障转移和 DDNS；需要在服务商控制台手动开机。仅支持以 root 运行的 Linux Agent（{data.trafficShutdown.requiredAgentVersion} 以上）。</span>
          </p>
        ) : null}
        {shutdownStatus ? <p className="text-xs text-muted-foreground" data-host-traffic-shutdown-status="">{shutdownStatus}</p> : null}
        {data.trafficShutdown.agentLastError ? <p className="break-words text-xs text-[var(--fx-down-text)]">Agent：{data.trafficShutdown.agentLastError}</p> : null}
      </div>

      {/* 资源告警（本机） */}
      <div className="space-y-1.5 border-t border-border/50 pt-2">
        <div className="flex min-h-8 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <Label className="text-sm">资源告警（本机）</Label>
            <p data-fx-help="" className="text-xs text-muted-foreground">
              {global.enabled
                ? `全局 CPU ${global.cpuPercent}% · 内存 ${global.memoryPercent}% · 磁盘 ${global.diskPercent}%（0 = 不报）；这台主机现在${data.resourceAlert.inScope ? "在" : "不在"}监控范围内。`
                : "全局资源告警没有开启，这里的设置要等全局开启后才生效。"}
            </p>
          </div>
          <Select value={draft.alertMode} onValueChange={(value) => update("alertMode", value as HostResourceAlertMode)}>
            <SelectTrigger aria-label="本机资源告警" className="h-8 w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOST_RESOURCE_ALERT_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {([
            ["CPU", "cpuPercent", global.cpuPercent],
            ["内存", "memoryPercent", global.memoryPercent],
            ["磁盘", "diskPercent", global.diskPercent],
          ] as const).map(([label, key, fallback]) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{label}</span>
              <PercentInput
                label={`本机${label}告警阈值（%）`}
                value={draft[key]}
                placeholder={String(fallback)}
                disabled={draft.alertMode === "off"}
                onChange={(value) => update(key, value)}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">阈值留空跟随全局，填 0 表示这台不报这一项。</p>
      </div>

      {/* Agent 安装实例 */}
      <div className="flex min-h-8 flex-col gap-2 border-t border-border/50 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-sm">Agent 安装实例</Label>
          <p data-fx-help="" className="text-xs text-muted-foreground">
            {data.installation.current
              ? `当前实例 ${data.installation.current}${data.installation.retiredCount ? `，已接管下线 ${data.installation.retiredCount} 个旧实例` : ""}${data.installation.changedAt ? `（${formatDateTime(data.installation.changedAt)}）` : ""}。`
              : "还没有登记实例（Agent 未升级或还没上报）。"}
            同一 Token 在另一台机器上安装会接管这台主机，旧机器停止同步、保留已有转发。
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={resetInstallation.isPending || (!data.installation.current && !data.installation.retiredCount)} onClick={() => { void resetBinding(); }}>
          解除绑定
        </Button>
      </div>

      <div className="flex justify-end gap-2 border-t border-border/50 pt-2">
        <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={() => setDraft(initial)}>还原</Button>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={submit}>
          {save.isPending ? "保存中…" : "保存这几项"}
        </Button>
      </div>
    </div>
  );
}
