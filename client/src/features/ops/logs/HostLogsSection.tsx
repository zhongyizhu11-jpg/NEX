import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, Trash2 } from "lucide-react";

import { Section } from "@/components/hosts/HostDetailDialog";
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
  const afterSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const status = trpc.ops.hostLogs.status.useQuery({ hostId }, { staleTime: 30_000 });
  const poll = trpc.ops.hostLogs.poll.useQuery(
    { hostId, source, afterSeq: afterSeqRef.current },
    {
      enabled: !paused && !!status.data?.supported,
      refetchInterval: pollingInterval("live"),
      refetchIntervalInBackground: false,
      retry: false,
      staleTime: 0,
      placeholderData: (previous) => previous,
    },
  );

  // 换来源：清空，重新从头拿。
  useEffect(() => {
    afterSeqRef.current = 0;
    setLines([]);
  }, [source]);

  useEffect(() => {
    const data = poll.data;
    // 刚换了来源时，上一个来源的回包可能还在路上：不是当前来源的丢掉。
    if (!data || data.source !== source) return;
    if (data.lines.length > 0) {
      afterSeqRef.current = Math.max(afterSeqRef.current, data.nextSeq);
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
  if (status.data && !status.data.supported) {
    return <div className="text-meta text-muted-foreground">需要把这台主机的 Agent 升级到 {status.data.minAgentVersion} 或更新。</div>;
  }

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
      <div className="flex flex-wrap items-center gap-2">
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-8 w-44" aria-label="日志来源">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((item) => <SelectItem key={item} value={item}>{sourceLabel(item)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          aria-label="筛选日志"
          placeholder="筛选关键字"
          className="h-8 w-36"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setPaused((value) => !value)} aria-label={paused ? "继续" : "暂停"}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setLines([])} aria-label="清屏">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={download} disabled={lines.length === 0} aria-label="下载">
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
  const [open, setOpen] = useState(false);
  if (hostId <= 0) return null;
  return (
    <Section title="实时日志">
      {open ? (
        <>
          <HostLogsViewer hostId={hostId} />
          <button
            type="button"
            className="self-start text-meta font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setOpen(false)}
          >
            收起
          </button>
        </>
      ) : (
        <button
          type="button"
          className="self-start text-meta font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setOpen(true)}
        >
          查看这台主机的实时日志（Agent、运行时、隧道、内核）
        </button>
      )}
    </Section>
  );
}
