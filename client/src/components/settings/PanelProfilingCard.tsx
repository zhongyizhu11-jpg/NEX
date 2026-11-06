import { useEffect, useState } from "react";
import { Activity, Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { trpc } from "@/lib/trpc";
import { formatBytes } from "@shared/formatBytes";

/*
  系统设置 › 面板日志 › 性能剖析（server/panelProfiling.ts）。

  面板变慢时，管理员在这里采一份 CPU 剖析或拍一张堆快照，下载下来用 Chrome DevTools 打开看。
  默认关；打开后一小时自己关，关的时候采好的文件一起删。文件走单独的下载路由
  （GET /api/ops/profiling/:id/download），只认网页上的管理员会话。
*/

const CPU_SECONDS_OPTIONS = [10, 30, 60, 120] as const;

function captureTime(value: number) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function minutesLeft(until: number, now: number) {
  return Math.max(1, Math.ceil((until - now) / 60_000));
}

export default function PanelProfilingCard() {
  const utils = trpc.useUtils();
  const [cpuSeconds, setCpuSeconds] = useState<number>(30);
  const [now, setNow] = useState(() => Date.now());
  const statusQuery = trpc.ops.profiling.status.useQuery(undefined, {
    retry: false,
    // 有一份在采时两秒看一次（采完马上能下载）；平时半分钟一次，够看「还剩几分钟自动关」。
    refetchInterval: (query) => {
      const data = query.state.data;
      const running = !!data?.busy || !!data?.captures.some((capture) => capture.status === "running");
      return running ? 2_000 : 30_000;
    },
  });
  const status = statusQuery.data;
  const enabledUntil = Number(status?.enabledUntil || 0);
  const enabled = enabledUntil > now;

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const refresh = () => {
    setNow(Date.now());
    void utils.ops.profiling.status.invalidate();
  };
  const setEnabled = trpc.ops.profiling.setEnabled.useMutation({
    onSuccess: (_result, input) => {
      toast.success(input.enabled ? "已开启性能剖析，一小时后自动关闭" : "已关闭性能剖析，采好的文件已删除");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const captureCpu = trpc.ops.profiling.captureCpu.useMutation({
    onSuccess: (capture) => {
      toast.success(`开始采 CPU 剖析，${capture.seconds ?? cpuSeconds} 秒后可以下载`);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const captureHeap = trpc.ops.profiling.captureHeap.useMutation({
    onSuccess: () => {
      toast.success("正在拍堆快照，面板会停顿几秒");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = trpc.ops.profiling.remove.useMutation({
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });

  // 不是管理员（或接口不可用）时整张卡不出现。
  if (statusQuery.isError) return null;

  const busy = status?.busy ?? null;
  const captures = status?.captures ?? [];
  const limits = status?.limits;
  const heapUsedMb = status ? Math.round(status.heapUsedBytes / 1_048_576) : 0;
  const pending = setEnabled.isPending || captureCpu.isPending || captureHeap.isPending;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-primary" />
          性能剖析
        </CardTitle>
        <CardDescription>
          面板变慢时采一份 CPU 剖析或拍一张堆快照，下载后用 Chrome DevTools 打开。默认关闭，开启一小时后自动关闭。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SettingList>
          <SettingRow
            asLabel
            label="开启性能剖析"
            keepDescription
            description={enabled ? `还剩约 ${minutesLeft(enabledUntil, now)} 分钟自动关闭；关闭时采好的文件一起删除` : "关闭时不能采集，也不能下载"}
            control={(
              <Checkbox
                aria-label="开启性能剖析"
                checked={enabled}
                disabled={setEnabled.isPending || !status}
                onCheckedChange={(value) => setEnabled.mutate({ enabled: value === true })}
              />
            )}
          />
          {enabled ? (
            <>
              <SettingRow
                label="CPU 剖析"
                keepDescription
                description="采样期间面板照常工作，只是稍慢一点"
                control={(
                  <span className="flex items-center gap-2">
                    <Select value={String(cpuSeconds)} onValueChange={(value) => setCpuSeconds(Number(value))}>
                      <SelectTrigger className="h-8 w-[88px]" aria-label="采集时长">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CPU_SECONDS_OPTIONS.map((seconds) => (
                          <SelectItem key={seconds} value={String(seconds)}>{seconds} 秒</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !!busy}
                      onClick={() => captureCpu.mutate({ seconds: cpuSeconds })}
                    >
                      开始采集
                    </Button>
                  </span>
                )}
              />
              <SettingRow
                label="堆快照"
                keepDescription
                description={`拍的时候面板会停顿几秒；现在堆用了 ${heapUsedMb} MB，文件大约是它的一到两倍`}
                control={(
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !!busy}
                    onClick={() => captureHeap.mutate()}
                  >
                    拍快照
                  </Button>
                )}
              />
            </>
          ) : null}
        </SettingList>

        {enabled && captures.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">采好的文件</div>
            <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
              {captures.map((capture) => {
                const title = capture.kind === "cpu" ? `CPU 剖析 · ${capture.seconds ?? "?"} 秒` : "堆快照";
                const running = capture.status === "running";
                const failed = capture.status === "failed";
                return (
                  <li key={capture.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground">{title}</div>
                      <div className={failed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                        {captureTime(capture.startedAt)}
                        {" · "}
                        {running ? (
                          <span className="inline-flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            正在采集
                          </span>
                        ) : failed ? `失败：${capture.error || "未知原因"}` : formatBytes(capture.bytes)}
                      </div>
                    </div>
                    {capture.status === "ready" ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/ops/profiling/${capture.id}/download`} download={capture.filename}>
                          <Download className="h-3.5 w-3.5" />
                          下载
                        </a>
                      </Button>
                    ) : null}
                    {!running ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`删除${title}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate({ id: capture.id })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {limits ? (
              <p className="text-xs text-muted-foreground">
                文件保留 {limits.retentionMinutes} 分钟，最多留 {limits.maxCaptures} 份；里面有面板内存的原样内容（含会话和密钥），用完请删除。
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
