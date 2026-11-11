/**
 * 落地入站表单「REALITY 高级」里的「检查目标 / 扫描候选」（规则见 shared/realityDestCheck.ts）。
 *
 * 检查从落地机自己发起（Agent 2.2.255 起的 realitycheck 扩展模块）：面板那台机器测出来的结果说明不了落地机
 * 连不连得上、DNS 有没有被污染。结果只放在面板内存里，这个框关掉就没了 —— 它只是帮人挑一个能偷的目标。
 *
 * 选中一个能用的候选，就把它填进「要偷的握手域名」，并清掉「握手目标」（候选都是同名域名的 443）。
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Radar, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  REALITY_DEST_CANDIDATE_LIST_VERSION,
  REALITY_DEST_CANDIDATES,
  realityDestCheckVerdict,
  type RealityDestCheckResult,
} from "@shared/realityDestCheck";

type Props = {
  hostId: number;
  serverName: string;
  realityDest: string;
  /** 表单留空时的默认握手域名。 */
  defaultServerName: string;
  onPick: (serverName: string) => void;
};

/** 最多等这么久（Agent 一轮 60 秒，再加上扩展通道的间隔）。 */
const POLL_LIMIT_MS = 100_000;

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("rounded-[var(--fx-radius-pill)] bg-muted/60 px-1.5 text-[11px] leading-4", ok ? "text-[var(--fx-healthy-text)]" : "text-[var(--fx-down-text)]")}>
      {label}
    </span>
  );
}

export function RealityDestChecker({ hostId, serverName, realityDest, defaultServerName, onPick }: Props) {
  const [runId, setRunId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [scanning, setScanning] = useState(false);
  const start = trpc.proxyInbounds.realityCheckStart.useMutation({
    onSuccess: (result) => {
      setRunId(result.runId);
      setStartedAt(Date.now());
    },
    onError: (error) => toast.error(error.message || "检查没能开始"),
  });
  const timedOut = !!runId && Date.now() - startedAt > POLL_LIMIT_MS;
  const result = trpc.proxyInbounds.realityCheckResult.useQuery(
    { runId: runId || "" },
    {
      enabled: !!runId,
      refetchInterval: (query) => {
        const data = query.state.data as { status?: string } | null | undefined;
        if (data?.status === "done" || Date.now() - startedAt > POLL_LIMIT_MS) return false;
        return 1500;
      },
      refetchOnWindowFocus: false,
    },
  );
  // 换了主机，旧结果就不是这台机器测的了。
  useEffect(() => {
    setRunId(null);
  }, [hostId]);

  const data = result.data || null;
  const done = data?.status === "done";
  const busy = start.isPending || (!!runId && !done && !timedOut);
  const results = (data?.results || []) as RealityDestCheckResult[];

  const run = (candidates: boolean) => {
    if (!hostId) {
      toast.error("先选一台主机：检查是从那台机器上发起的");
      return;
    }
    setScanning(candidates);
    start.mutate({ hostId, candidates, serverName: serverName.trim() || defaultServerName, realityDest: realityDest.trim() || undefined });
  };

  return (
    <div className="space-y-2" data-testid="reality-dest-checker">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(false)}>
          {busy && !scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          检查目标
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(true)}>
          {busy && scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
          扫描候选（{REALITY_DEST_CANDIDATES.length} 个）
        </Button>
      </div>
      <p data-fx-help="" className="text-xs text-muted-foreground">
        让这台落地机去连目标，看 TLS 1.3、X25519、h2 和证书；四样都有才适合偷。候选清单 {REALITY_DEST_CANDIDATE_LIST_VERSION}，要 Agent 2.2.255 起。
      </p>
      {busy && runId ? <p className="text-xs text-muted-foreground">落地机正在检查…</p> : null}
      {timedOut && !done ? <p className="text-xs text-[var(--fx-warn-text)]">等了很久没有结果：落地机可能离线了，或者 Agent 太旧。</p> : null}
      {done && results.length > 0 ? (
        <ul className="space-y-1.5">
          {results.map((item) => {
            const verdict = realityDestCheckVerdict(item);
            const name = item.serverName;
            const current = (serverName.trim() || defaultServerName).toLowerCase() === name;
            return (
              <li key={`${item.dest}|${name}`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/35 px-2 py-1.5 text-xs">
                <span className="min-w-0 truncate font-medium">{item.dest}</span>
                {item.reachable ? (
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <Flag ok={item.tls13} label="TLS 1.3" />
                    <Flag ok={item.x25519} label="X25519" />
                    <Flag ok={item.h2} label="h2" />
                    <Flag ok={item.certValid} label="证书" />
                  </span>
                ) : null}
                <span className={item.feasible ? "text-[var(--fx-healthy-text)]" : "text-muted-foreground"}>
                  {verdict}{item.feasible && item.latencyMs > 0 ? ` · ${item.latencyMs} ms` : ""}
                </span>
                {item.feasible && !current ? (
                  <Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => onPick(name)}>
                    用这个
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
