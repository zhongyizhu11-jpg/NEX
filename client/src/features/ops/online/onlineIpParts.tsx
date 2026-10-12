import { useEffect } from "react";
import { Ban } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  在线 IP 页和「用户 › 在线 IP」对话框共用的几块：一行 IP、连了多久、封禁跳转、正在看的心跳。
*/

/** 「连了多久」：12 秒 / 8 分钟 / 3 小时 20 分 / 2 天 4 小时。 */
export function formatConnectedFor(sinceSeconds: number, nowMs = Date.now()) {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - Number(sinceSeconds || 0));
  if (seconds < 60) return "刚连上";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

export function regionText(region: string | null | undefined) {
  return region || "未知";
}

/** 「在线 3 个 IP / 上限 4」；不限就只说在线几个。 */
export function limitText(count: number, limit: number) {
  return limit > 0 ? `${count} 个 IP / 上限 ${limit}` : `${count} 个 IP · 不限`;
}

/**
 * 开着的时候每 20 秒告诉面板「有人在看」，Agent 就从 60 秒一报改成 10 秒一报。
 * 页面在后台（切走标签页）时不续，省得没人看也一直高频。
 */
export function useOnlineIpsWatch(enabled = true) {
  const watch = trpc.ops.onlineIps.watch.useMutation();
  const mutate = watch.mutate;
  useEffect(() => {
    if (!enabled) return;
    const ping = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      mutate();
    };
    ping();
    const timer = window.setInterval(ping, 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, mutate]);
}

/** 「封禁」：IP 封禁那一页由别的功能负责，这里只带着 IP 跳过去，它读 block 参数预填。 */
export function BlockIpButton({ ip, onNavigate, className }: { ip: string; onNavigate?: () => void; className?: string }) {
  const [, setLocation] = useLocation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("h-7 shrink-0 gap-1 px-2 text-[12.5px] text-[var(--fx-down-text)]", className)}
      onClick={() => {
        onNavigate?.();
        setLocation(`/insights?tab=blocked&block=${encodeURIComponent(ip)}`);
      }}
      title={`封禁 ${ip}`}
    >
      <Ban className="h-3.5 w-3.5" aria-hidden="true" />
      封禁
    </Button>
  );
}

export type LiveIpRow = {
  ip: string;
  region: string | null;
  hostId: number;
  hostName: string;
  port: number;
  target: string;
  conns: number;
  since: number;
};

/**
 * 一行在线 IP。后三列定宽：每行是各自的网格，列宽跟内容走的话上下对不齐。
 * 桌面（≥640px）是一行六列；手机上叠成三行：IP + 封禁 / 地区 · 主机 · 规则 / 连接数 · 时长。
 * 不用表格：一张五列的表在 390px 宽的手机上只能横着滑。
 */
export function LiveIpRowItem({ row, onNavigate, showHost = true }: { row: LiveIpRow; onNavigate?: () => void; showHost?: boolean }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2.5 sm:grid sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.6fr)_5.5rem_7rem_4.5rem] sm:items-center sm:gap-3 sm:py-2">
      <div className="flex min-w-0 items-center justify-between gap-2 sm:contents">
        <span className="min-w-0 truncate font-mono text-[13px] text-foreground" title={row.ip}>{row.ip}</span>
        <BlockIpButton ip={row.ip} onNavigate={onNavigate} className="sm:hidden" />
      </div>
      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground sm:text-[13px]">
        {regionText(row.region)}
        <span className="sm:hidden">{showHost ? ` · ${row.hostName}` : ""} · {row.target}</span>
      </span>
      <span className="hidden min-w-0 truncate text-[13px] text-muted-foreground sm:block" title={`${row.hostName} · ${row.target}`}>
        {showHost ? `${row.hostName} · ` : ""}{row.target}
      </span>
      <span className="text-[12px] tabular-nums text-muted-foreground sm:text-right sm:text-[13px]">
        {row.conns} 条连接<span className="sm:hidden"> · 连了 {formatConnectedFor(row.since)}</span>
      </span>
      <span className="hidden whitespace-nowrap text-right text-[13px] tabular-nums text-muted-foreground sm:block">{formatConnectedFor(row.since)}</span>
      <BlockIpButton ip={row.ip} onNavigate={onNavigate} className="hidden sm:inline-flex" />
    </li>
  );
}

/** 有些主机的 Agent 太旧，在线 IP 里看不到它们。 */
export function OutdatedAgentNotice({ hosts, minVersion }: { hosts: Array<{ id: number; name: string }>; minVersion: string }) {
  if (hosts.length === 0) return null;
  const names = hosts.slice(0, 6).map((h) => h.name).join("、");
  return (
    <p className="rounded-[var(--fx-radius-surface)] bg-[var(--fx-warn-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--fx-warn-text)]">
      需要升级 Agent 才能看到在线 IP：{names}{hosts.length > 6 ? ` 等 ${hosts.length} 台` : ""}（要 {minVersion} 或更新）。
    </p>
  );
}
