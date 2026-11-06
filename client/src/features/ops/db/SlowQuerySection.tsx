import { useEffect, useState } from "react";
import { RefreshCw, Timer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { trpc } from "@/lib/trpc";

const DB_LABEL: Record<string, string> = { sqlite: "SQLite", mysql: "MySQL", postgresql: "PostgreSQL" };

function formatAgo(at: number) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

/**
 * 设置 › 进阶 › 慢查询（批次 2 · 第 19 项）。
 *
 * 超过阈值的 SQL 按语句归并（参数抹掉），按累计耗时排：哪种语句最拖面板一眼能看出来。
 * 数据只在内存里（面板重启清空），见 server/slowQueryLog.ts。
 */
export default function SlowQuerySection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.slowQueries.list.useQuery(undefined, { refetchOnWindowFocus: false });
  const setThreshold = trpc.ops.slowQueries.setThreshold.useMutation();
  const clear = trpc.ops.slowQueries.clear.useMutation();
  const [threshold, setThresholdText] = useState("");
  const saved = query.data?.savedThresholdMs;
  useEffect(() => {
    if (saved !== undefined) setThresholdText(String(saved));
  }, [saved]);

  const save = async () => {
    const value = Number(threshold.trim());
    if (!/^\d+$/.test(threshold.trim()) || value > 60000) {
      toast.error("阈值填 0 到 60000 之间的整数（毫秒，0 = 不记）");
      return;
    }
    try {
      const result = await setThreshold.mutateAsync({ thresholdMs: value });
      await utils.ops.slowQueries.list.invalidate();
      toast.success(result.thresholdMs > 0 ? `超过 ${result.thresholdMs} 毫秒的语句会记下来` : "已关闭慢查询记录");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const clearAll = async () => {
    try {
      await clear.mutateAsync();
      await utils.ops.slowQueries.list.invalidate();
      toast.success("已清空");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清空失败");
    }
  };

  const data = query.data;
  const entries = data?.entries ?? [];

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="h-4 w-4 text-primary" />
          慢查询
        </CardTitle>
        <CardDescription>
          执行超过阈值的数据库语句按种类归并，按累计耗时排序。只记语句结构，不记参数；面板重启后清空。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading || !data ? (
          query.error ? (
            <DataSectionError label="慢查询" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} minHeight="min-h-[96px]" />
          ) : (
            <DataSectionLoading label="正在加载慢查询" minHeight="min-h-[96px]" />
          )
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-meta text-muted-foreground">
                  阈值（毫秒，0 = 不记）· 当前数据库 {DB_LABEL[String(data.dbKind)] || data.dbKind || "—"}
                  {data.envOverride ? ` · 环境变量 FORWARDX_SLOW_QUERY_MS 生效中：${data.thresholdMs} 毫秒` : ""}
                </span>
                <Input
                  inputMode="numeric"
                  aria-label="慢查询阈值（毫秒）"
                  value={threshold}
                  onChange={(event) => setThresholdText(event.target.value.replace(/[^\d]/g, ""))}
                  className="tabular-nums sm:max-w-[12rem]"
                />
              </label>
              <div className="flex gap-2">
                <Button onClick={save} disabled={setThreshold.isPending || threshold.trim() === String(saved)}>
                  {setThreshold.isPending ? "保存中…" : "保存"}
                </Button>
                <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching} aria-label="刷新">
                  <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="outline" onClick={clearAll} disabled={clear.isPending || entries.length === 0} aria-label="清空">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {entries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--fx-stroke-weak)] p-4 text-center text-sm text-muted-foreground">
                {data.thresholdMs > 0 ? `${formatAgo(data.since)}以来没有超过 ${data.thresholdMs} 毫秒的语句` : "慢查询记录已关闭"}
              </div>
            ) : (
              <ul className="space-y-2">
                {entries.slice(0, 50).map((entry) => (
                  <li key={entry.fingerprint} className="min-w-0 rounded-lg border border-[var(--fx-stroke-weak)] p-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-muted-foreground tabular-nums">
                      <span className="font-medium text-foreground">{entry.count} 次</span>
                      <span>平均 {entry.avgMs} ms</span>
                      <span>最长 {entry.maxMs} ms</span>
                      <span>累计 {(entry.totalMs / 1000).toFixed(1)} s</span>
                      <span>{formatAgo(entry.lastAt)}</span>
                      {entry.errors > 0 ? <span className="text-destructive">出错 {entry.errors} 次</span> : null}
                    </div>
                    <code className="mt-1 block max-h-24 overflow-y-auto break-all font-mono text-xs leading-5 text-foreground">
                      {entry.fingerprint}
                    </code>
                    {entry.caller ? (
                      <div className="mt-1 truncate text-meta text-muted-foreground" title={entry.caller}>来自 {entry.caller}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
