import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { RESOURCE_ALERT_SUSTAIN_OPTIONS, type ResourceAlertConfig } from "@shared/resourceAlert";

/*
  设置 › Webhook 下方的「资源告警」：CPU / 内存 / 磁盘持续超过阈值、OOM、进程崩溃、隧道丢包时，通过 Telegram、Discord、
  邮件（可选）通知管理员，同时记进事件时间线（Webhook 的「主机」类会一起推出去）。
  阈值填 0 表示这一项不报。
*/

type Draft = ResourceAlertConfig;

function sameDraft(a: Draft, b: Draft) {
  return (Object.keys(a) as Array<keyof Draft>).every((key) => a[key] === b[key]);
}

function ThresholdInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={`${label}阈值`}
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        className="h-8 w-20 text-right"
        value={String(value)}
        onChange={(event) => {
          const n = Number(event.target.value);
          onChange(Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
        }}
      />
      <span className="text-sm text-muted-foreground">%</span>
    </div>
  );
}

export default function ResourceAlertSettings(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.resourceAlert.get.useQuery(undefined, { staleTime: 30_000 });
  const settings = query.data;
  const [draft, setDraft] = useState<Draft | null>(null);

  const reset = () => {
    if (settings) setDraft({ ...settings });
  };
  useEffect(reset, [settings]);

  const saveMutation = trpc.ops.resourceAlert.save.useMutation({
    onSuccess: (next) => {
      utils.ops.resourceAlert.get.setData(undefined, next);
      toast.success("资源告警设置已保存");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const testMutation = trpc.ops.resourceAlert.test.useMutation({
    onSuccess: () => toast.success("测试告警已发出，去 Telegram / Discord / 邮箱看看收到没有"),
    onError: (error) => toast.error(error.message || "发送失败"),
  });

  const save = (): Promise<boolean> | boolean => {
    if (!draft) return false;
    const invalid = [draft.cpuPercent, draft.memoryPercent, draft.diskPercent].some((value) => value !== 0 && value < 50);
    if (invalid) {
      toast.error("阈值填 0（不报）或 50–100 之间的数");
      return false;
    }
    return saveMutation.mutateAsync(draft).then(() => true, () => false);
  };

  const dirty = !!settings && !!draft && !sameDraft(draft, settings);
  useSaveDockItem({
    id: "ops.resourceAlert",
    label: "资源告警",
    dirty,
    pending: saveMutation.isPending,
    save,
    reset,
  });

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4 text-primary" />
              资源告警
            </CardTitle>
            <CardDescription className="mt-1">
              主机 CPU、内存、磁盘持续超过阈值，或者内存耗尽、进程崩溃、隧道丢包时通知管理员，恢复后再报一次。
            </CardDescription>
          </div>
          {settings ? (
            <Badge variant={settings.enabled ? "default" : "outline"} className="w-fit">
              {settings.enabled ? "监控中" : "已关闭"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <DataSectionLoading label="正在读取资源告警设置" minHeight="min-h-[120px]" />
        ) : query.isError || !settings || !draft ? (
          <DataSectionError label="资源告警设置" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
        ) : (
          <>
            <SettingList>
              <SettingRow
                asLabel
                label="启用资源告警"
                description="Telegram、Discord 按各自的通知开关发；每个管理员可以在机器人菜单里单独关掉「资源告警」。"
                control={<Checkbox aria-label="启用资源告警" checked={draft.enabled} onCheckedChange={(checked) => update("enabled", checked === true)} />}
              />
              <SettingRow label="CPU 阈值" description="填 0 表示不报 CPU。" control={<ThresholdInput label="CPU" value={draft.cpuPercent} onChange={(value) => update("cpuPercent", value)} />} />
              <SettingRow label="内存阈值" description="填 0 表示不报内存。" control={<ThresholdInput label="内存" value={draft.memoryPercent} onChange={(value) => update("memoryPercent", value)} />} />
              <SettingRow label="磁盘阈值" description="填 0 表示不报磁盘。" control={<ThresholdInput label="磁盘" value={draft.diskPercent} onChange={(value) => update("diskPercent", value)} />} />
              <SettingRow
                label="持续多久才报"
                description="一次冲高不报，连续超过这么久才报。"
                control={(
                  <Select value={String(draft.sustainSeconds)} onValueChange={(value) => update("sustainSeconds", Number(value))}>
                    <SelectTrigger className="h-8 w-32" aria-label="持续多久才报">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RESOURCE_ALERT_SUSTAIN_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
                      ))}
                      {RESOURCE_ALERT_SUSTAIN_OPTIONS.some((option) => option.value === draft.sustainSeconds) ? null : (
                        <SelectItem value={String(draft.sustainSeconds)}>{draft.sustainSeconds} 秒</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
              />
              <SettingRow
                label="恢复回差"
                description={`回落到阈值减去这个数以下才算恢复，免得在阈值附近来回报。`}
                control={<ThresholdInput label="恢复回差" value={draft.recoverMarginPercent} onChange={(value) => update("recoverMarginPercent", Math.min(30, value))} />}
              />
              <SettingRow
                asLabel
                label="内存耗尽（OOM）"
                description="内核 OOM killer 杀了进程时告警。需要 Agent 2.2.230 以上。"
                control={<Checkbox aria-label="内存耗尽告警" checked={draft.oomAlert} onCheckedChange={(checked) => update("oomAlert", checked === true)} />}
              />
              <SettingRow
                asLabel
                label="进程崩溃"
                description="转发、隧道运行时等 forwardx 服务崩溃后被自动重启时告警。需要 Agent 2.2.230 以上。"
                control={<Checkbox aria-label="进程崩溃告警" checked={draft.crashAlert} onCheckedChange={(checked) => update("crashAlert", checked === true)} />}
              />
              <SettingRow
                label="隧道丢包阈值"
                description="隧道探测近 10 分钟丢包率达到这个数就告警，回落到一半以下算恢复。填 0 表示不报。"
                control={<ThresholdInput label="隧道丢包" value={draft.lossPercent} onChange={(value) => update("lossPercent", value)} />}
              />
              <SettingRow
                asLabel
                label="同时发邮件"
                description="发给有邮箱的管理员，需要「设置 › 邮件」里的邮件服务已开启。"
                control={<Checkbox aria-label="同时发邮件" checked={draft.emailEnabled} onCheckedChange={(checked) => update("emailEnabled", checked === true)} />}
              />
            </SettingList>

            <div className="flex flex-wrap gap-2">
              <Button data-dock-save onClick={() => { void save(); }} disabled={saveMutation.isPending}>
                保存
              </Button>
              <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
                {testMutation.isPending ? "发送中…" : "发送测试告警"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
