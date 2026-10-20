import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  normalizeTunnelParallelStreams,
  TUNNEL_PARALLEL_STREAM_OPTIONS,
  TUNNEL_PARALLEL_STREAMS_ENTRY_AGENT_VERSION,
} from "@shared/tunnelParallelStreams";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * 隧道的「单连接多路并发」（shared/tunnelParallelStreams.ts）。
 *
 * 一排档位按钮（单路 / 2 / 3 / 4 / 6 / 8 路），说清楚它适合什么线路、代价是什么。
 * 沿线 Agent 太旧时保存照样成功、按单路跑，这里把要升级的主机列出来。
 */
export default function TunnelParallelStreamsDialog({ tunnel, onClose }: {
  tunnel: { id: number; name: string; parallelStreams?: unknown } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(1);
  useEffect(() => {
    if (tunnel) setValue(normalizeTunnelParallelStreams(tunnel.parallelStreams));
  }, [tunnel]);
  const mutation = trpc.tunnels.setParallelStreams.useMutation({
    onSuccess: (result) => {
      void utils.tunnels.list.invalidate();
      if (result.parallelStreams < 2) toast.success("已改回单路");
      else if (result.outdatedHosts.length > 0) {
        toast.warning(`已保存为 ${result.parallelStreams} 路并发；${result.outdatedHosts.join("、")} 的 Agent 还太旧，升级前先按单路跑`);
      } else toast.success(`已开启 ${result.parallelStreams} 路并发：每条连接拆到 ${result.parallelStreams} 条并行连接上`);
      onClose();
    },
    onError: (error) => toast.error(error.message || "设置失败"),
  });

  return (
    <Dialog open={!!tunnel} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>单连接多路并发{tunnel ? ` · ${tunnel.name}` : ""}</DialogTitle>
          <DialogDescription data-fx-help="">
            入口把每条客户端连接拆成几片，从几条并行连接同时发到出口，出口按顺序拼回去，目标看到的数据和单路一模一样。
            适合按单条 TCP 限速、或者丢包让单条连接跑不快的跨境线路：一条下载也能用上几条连接的带宽。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">每条连接拆成</Label>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="并发路数">
              {TUNNEL_PARALLEL_STREAM_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={value === option}
                  onClick={() => setValue(option)}
                  className={cn(
                    "h-8 min-w-[3.25rem] rounded-md border px-2.5 text-sm transition-colors",
                    value === option ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option === 1 ? "单路" : `${option} 路`}
                </button>
              ))}
            </div>
          </div>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>路数不是越多越好：线路本身没有按连接限速时，多拆只会多一点头部开销。一般 2–4 路就够。</li>
            <li>只拆 TCP；UDP 照旧。改了之后新连接生效，正在传的连接不受影响。</li>
            <li>需要入口 Agent {TUNNEL_PARALLEL_STREAMS_ENTRY_AGENT_VERSION} 或更新（中转、出口 2.2.194 起）。版本不够时先按单路跑，不会断流。</li>
          </ul>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button
            type="button"
            disabled={!tunnel || mutation.isPending}
            onClick={() => tunnel && mutation.mutate({ id: Number(tunnel.id), streams: value })}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
