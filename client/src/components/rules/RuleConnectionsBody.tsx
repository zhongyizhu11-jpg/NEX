import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { formatBytes } from "@shared/formatBytes";
import type { RuleConnectionRow, RuleConnectionsSnapshot } from "@shared/ruleConnections";

/*
  诊断对话框的「连接」页签：这条规则此刻谁连着。

  不是面板存的数 —— 面板只有累计连接数。点开这一页就排一个任务让入口机的 Agent 现场读一遍
  （shared/ruleConnections），等它随下一次心跳取走、读完回报，几秒到十几秒；之后想再看点「刷新」。
  来源、本机地址、协议、到目前为止的字节数（有 ss / conntrack 计数时才有）。
*/

const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_3rem_minmax(0,1.3fr)] sm:items-center sm:gap-2";

/** 窄屏两行（来源 + 协议 / 本机 + 流量），宽屏一行四列；sm:order-* 把两种顺序对上。 */
function Row({ row }: { row: RuleConnectionRow }) {
  const bytes = row.bytesIn !== undefined || row.bytesOut !== undefined
    ? `↓ ${formatBytes(row.bytesIn ?? 0)} · ↑ ${formatBytes(row.bytesOut ?? 0)}`
    : "—";
  return (
    <li className={`${ROW_GRID} py-2 text-[13px]`} data-testid="rule-connection-row">
      <span className="min-w-0 truncate font-mono text-foreground sm:order-1" title={row.peer}>{row.peer}</span>
      <span className="justify-self-end text-xs uppercase text-muted-foreground sm:order-3 sm:justify-self-start">{row.protocol}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground sm:order-2 sm:text-[13px]" title={row.local}>{row.local}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs tabular-nums text-muted-foreground sm:order-4 sm:text-left" title="客户端发来 · 发给客户端（有计数的机器才有）">{bytes}</span>
    </li>
  );
}

export function RuleConnectionsList({ snapshot }: { snapshot: RuleConnectionsSnapshot }) {
  if (snapshot.rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">此刻没有连接{snapshot.error ? `（${snapshot.error}）` : ""}</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-meta text-muted-foreground">
        {snapshot.truncated ? `共 ${snapshot.total} 条，只列前 ${snapshot.rows.length} 条（按流量排）` : `${snapshot.total} 条`}
        {` · 来自 ${snapshot.source.includes("conntrack") ? "conntrack" : "/proc/net/tcp"}${snapshot.source.includes("ss") ? " + ss" : ""}`}
      </p>
      <div className={`hidden ${ROW_GRID} border-b border-border pb-1 text-xs text-muted-foreground sm:grid`}>
        <span>来源</span><span>本机</span><span>协议</span><span>流量</span>
      </div>
      <ul className="divide-y divide-border">
        {snapshot.rows.map((row, index) => <Row key={`${row.peer}-${index}`} row={row} />)}
      </ul>
    </div>
  );
}

export function RuleConnectionsBody({ ruleId, active }: { ruleId: number; active: boolean }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RuleConnectionsSnapshot | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const start = trpc.rules.connectionsStart.useMutation({
    onSuccess: (data) => { setTaskId(data.taskId); setFailure(null); },
    onError: (error) => { setFailure(error.message || "取不到连接清单"); setTaskId(null); },
  });
  const status = trpc.rules.connectionsStatus.useQuery(
    { taskId: taskId || "" },
    { enabled: !!taskId && active, refetchInterval: (query) => {
      const state = query.state.data?.status;
      return state === "done" || state === "timeout" || query.state.data === null ? false : 1000;
    } },
  );
  useEffect(() => {
    const data = status.data;
    if (!data) return;
    if (data.status === "done" && data.snapshot) {
      setSnapshot(data.snapshot);
      setTaskId(null);
    } else if (data.status === "timeout") {
      setFailure(data.error || "Agent 没在时限内回报");
      setTaskId(null);
    }
  }, [status.data]);
  // 第一次切到这一页就取一次；之后由「刷新」触发。
  useEffect(() => {
    if (active && !snapshot && !taskId && !start.isPending && !failure) start.mutate({ ruleId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ruleId]);
  const busy = start.isPending || !!taskId;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="rule-connections">
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta text-muted-foreground">
          {snapshot ? `取自 ${new Date(snapshot.at).toLocaleTimeString("zh-CN", { hour12: false })}` : busy ? "正在让机器上的 Agent 读一遍…" : "点刷新取这条规则此刻的连接"}
        </p>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => { setFailure(null); start.mutate({ ruleId }); }}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />刷新
        </Button>
      </div>
      {failure ? <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">{failure}</p> : null}
      {snapshot ? <RuleConnectionsList snapshot={snapshot} /> : busy ? <DataSectionLoading /> : null}
      <p className="text-meta text-muted-foreground">走隧道的规则看的是入口那一段（客户端连进来的那头）；内核转发（iptables / nftables）和 UDP 从 conntrack 读。</p>
    </div>
  );
}
