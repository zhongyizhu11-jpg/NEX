import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Pause, Play, Trash2 } from "lucide-react";

import { CollapsibleSection } from "@/components/hosts/HostDetailDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { downloadTextFile } from "@/lib/fileDownload";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";

/*
  主机详情里的「实时日志」：不用 SSH，直接看 Agent、gost 运行时、隧道、Nginx、内核和 FXP 的日志。

  默认收起：点开才开始拉，关掉（或关掉详情弹窗）就不再拉，Agent 半分钟后回到平时的节奏。
  开着时每 2 秒问一次面板，面板那头每 5 秒问一次 Agent，所以新日志大约 5 秒内出现。
  只给管理员（调用方已经判断过）。
*/

const MAX_CLIENT_LINES = 2_000;

const SOURCE_LABELS: Record<string, string> = {
  agent: "Agent",
  runtime: "gost 运行时",
  tunnel: "隧道运行时",
  nginx: "Nginx Stream",
  kernel: "内核",
};

function sourceLabel(source: string) {
  if (source.startsWith("fxp:")) return `FXP · ${source.slice(4).replace(/^fxp-/, "").replace(/\.log$/, "")}`;
  return SOURCE_LABELS[source] || source;
}

type Line = { seq: number; text: string };

function HostLogsViewer({ hostId }: { hostId: number }) {
  const [source, setSource] = useState("agent");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  // 已经拿到的最后一个序号，记着是哪个来源的：换来源后到下一次渲染前发出去的请求也不会带错序号。
  const cursorRef = useRef<{ source: string; seq: number }>({ source, seq: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const utils = trpc.useUtils();

  const status = trpc.ops.hostLogs.status.useQuery({ hostId }, { staleTime: 30_000 });
  /*
    序号不进查询键：以前 afterSeq 放在参数里，每拉到一批键就变一次，缓存里一批一条，看得越久占的内存越多。
    现在键只有主机和来源，请求时再带上当前序号；不看了（关掉、换来源）这条缓存就丢掉。
  */
  const poll = useQuery({
    queryKey: ["ops.hostLogs.poll", hostId, source],
    queryFn: () => {
      const cursor = cursorRef.current;
      const afterSeq = cursor.source === source ? cursor.seq : 0;
      return utils.client.ops.hostLogs.poll.query({ hostId, source, afterSeq });
    },
    enabled: !paused && !!status.data,
    refetchInterval: pollingInterval("live"),
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    placeholderData: (previous) => previous,
  });

  // 换来源：清空，重新从头拿。
  useEffect(() => {
    cursorRef.current = { source, seq: 0 };
    setLines([]);
  }, [source]);

  useEffect(() => {
    const data = poll.data;
    // 刚换了来源时，上一个来源的回包可能还在路上：不是当前来源的丢掉。
    if (!data || data.source !== source) return;
    if (data.lines.length > 0) {
      const cursor = cursorRef.current;
      cursorRef.current = { source, seq: Math.max(cursor.source === source ? cursor.seq : 0, data.nextSeq) };
      setLines((current) => {
        const known = current.length > 0 ? current[current.length - 1].seq : 0;
        const fresh = data.lines.filter((line) => line.seq > known);
        if (fresh.length === 0) return current;
        const next = current.concat(fresh);
        return next.length > MAX_CLIENT_LINES ? next.slice(next.length - MAX_CLIENT_LINES) : next;
      });
    }
  }, [poll.data, source]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const sources = useMemo(() => {
    const reported = poll.data?.sources ?? status.data?.sources ?? null;
    const list = reported && reported.length > 0 ? reported : ["agent", "runtime", "tunnel", "nginx", "kernel"];
    return list.includes(source) ? list : [source, ...list];
  }, [poll.data?.sources, status.data?.sources, source]);

  const needle = filter.trim().toLowerCase();
  const visible = needle ? lines.filter((line) => line.text.toLowerCase().includes(needle)) : lines;

  const download = () => {
    downloadTextFile(`host-${hostId}-${source.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`, `${lines.map((line) => line.text).join("\n")}\n`);
  };

  if (status.isLoading) return <div className="text-meta text-muted-foreground">正在读取…</div>;

  const hint = poll.isError
    ? (poll.error?.message || "读取失败")
    : poll.data?.error
      ? `Agent：${poll.data.error}`
      : poll.data?.waiting
        ? (status.data?.online === false ? "主机离线，拿不到日志" : "正在等 Agent 回报（几秒钟）…")
        : paused
          ? "已暂停"
          : `实时更新中 · ${lines.length} 行`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-8 w-32 shrink-0" aria-label="日志来源">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((item) => <SelectItem key={item} value={item}>{sourceLabel(item)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          aria-label="筛选日志"
          placeholder="筛选关键字"
          className="h-8 min-w-0 flex-1"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={() => setPaused((value) => !value)} aria-label={paused ? "继续" : "暂停"}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={() => setLines([])} aria-label="清屏">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={download} disabled={lines.length === 0} aria-label="下载">
          <Download className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="h-72 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-[1.45]"
        role="log"
        aria-live="off"
      >
        {visible.length === 0 ? (
          <div className="text-muted-foreground">{needle && lines.length > 0 ? "没有匹配的行" : "还没有日志"}</div>
        ) : (
          visible.map((line) => <div key={line.seq} className="whitespace-pre-wrap break-all">{line.text}</div>)
        )}
      </div>
      <div className="text-meta text-muted-foreground">{hint}。日志里的密码、token 已打码。</div>
    </div>
  );
}

export default function HostLogsSection({ host }: { host: any }) {
  const hostId = Number(host?.id || 0);
  if (hostId <= 0) return null;
  return (
    <CollapsibleSection title="实时日志" summary="Agent、运行时、隧道、内核">
      <HostLogsViewer hostId={hostId} />
    </CollapsibleSection>
  );
}
