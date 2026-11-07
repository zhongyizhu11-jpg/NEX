import { toast } from "sonner";

import { formatAgo } from "@shared/dashboardAttention";
import { formatBytes } from "@shared/formatBytes";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { CollapsibleSection, Row } from "./HostDetailDialog";

/*
  主机详情「更多」里的「Agent 运行状态」：Agent 进程自己的内存、协程、GC 停顿，进程内 UDP 中继的
  会话数和上限，这台机器有没有 AES 硬件加速；管理员还能临时打开 Agent 的性能剖析（pprof）。

  数据随心跳来（server/ops/agentRuntime.ts，只在内存里），老 Agent 不报这一份，这一节就不出现。
  性能剖析只在那台机器的 127.0.0.1 上开，到点 Agent 自己关；面板这里只是开关和看状态。
*/

const n = (value: number) => value.toLocaleString("zh-CN");

function formatClock(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export default function HostAgentRuntimeSection({ hostId, isAdmin }: { hostId: number; isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const { data } = trpc.agentRuntime.get.useQuery({ hostId }, { retry: false, refetchInterval: 15_000, refetchOnWindowFocus: false });
  const setPprof = trpc.agentRuntime.setPprof.useMutation({
    onSuccess: (result) => {
      toast.success(result.until > 0 ? `已通知 Agent 打开性能剖析，${formatClock(result.until)} 自动关闭` : "已通知 Agent 关闭性能剖析");
      void utils.agentRuntime.get.invalidate({ hostId });
    },
    onError: (error) => toast.error(error.message),
  });
  const stats = data?.stats;
  if (!stats) return null;

  const memory = stats.rssBytes ? formatBytes(stats.rssBytes) : formatBytes(stats.heapBytes);
  const udp = stats.udpSessions;
  const pprof = data?.pprof;
  const report = pprof?.report;
  const requestedUntil = pprof?.requestedUntil || 0;
  const running = !!(report?.running || stats.pprof?.running);
  const runningAddr = report?.addr || stats.pprof?.addr || "";
  const runningUntil = report?.until || stats.pprof?.until || requestedUntil;

  let pprofText = "关";
  if (running) pprofText = `开着 · ${runningAddr || "127.0.0.1"} · ${formatClock(runningUntil)} 自动关`;
  else if (requestedUntil > 0) pprofText = "等 Agent 打开…";
  else if (report?.error) pprofText = `没开成：${report.error}`;

  return (
    <CollapsibleSection title="Agent 运行状态" summary={`内存 ${memory} · 协程 ${n(stats.goroutines)}`}>
      <Row label="常驻内存" value={stats.rssBytes ? `${memory}（Go 堆 ${formatBytes(stats.heapBytes)}）` : `Go 堆 ${memory}`} />
      <Row label="协程" value={n(stats.goroutines)} />
      <Row label="GC 停顿" value={`最长 ${n(stats.gcPauseMaxUs)} µs · 累计 ${n(stats.gcCount)} 轮 / ${n(stats.gcPauseTotalMs)} ms`} />
      {udp ? (
        <Row
          label="UDP 中继会话"
          value={`${n(udp.active)} / 上限 ${n(udp.cap)}${udp.evicted || udp.rejected ? ` · 回收 ${n(udp.evicted)} · 拒绝 ${n(udp.rejected)}` : ""}`}
        />
      ) : null}
      {stats.cpuAes !== null ? (
        <Row label="AES 硬件加速" value={stats.cpuAes ? "有 · 隧道优先 AES-256-GCM" : "没有 · 隧道会协商 ChaCha20"} />
      ) : null}
      {isAdmin && pprof ? (
        <>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="shrink-0 text-meta text-muted-foreground">性能剖析</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-right text-secondary-type tabular-nums text-foreground">{pprofText}</span>
              {running || requestedUntil > 0 ? (
                <Button size="sm" variant="outline" disabled={setPprof.isPending} onClick={() => setPprof.mutate({ hostId, minutes: 0 })}>
                  关掉
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={setPprof.isPending} onClick={() => setPprof.mutate({ hostId, minutes: pprof.defaultMinutes })}>
                  开 {pprof.defaultMinutes} 分钟
                </Button>
              )}
            </span>
          </div>
          {running ? (
            <p className="break-all text-meta text-muted-foreground">
              只在这台机器上能访问：登录后执行 go tool pprof http://{runningAddr || "127.0.0.1:6060"}/debug/pprof/profile?seconds=30
            </p>
          ) : null}
        </>
      ) : null}
      <p className="text-meta text-muted-foreground">{formatAgo(Date.now() - stats.updatedAt)}随心跳更新</p>
    </CollapsibleSection>
  );
}
