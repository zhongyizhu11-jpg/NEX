import { getFormatLocale } from "@/i18n";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatAgo } from "@shared/dashboardAttention";
import {
  evaluateNetTune,
  NETTUNE_GROUP_LABELS,
  netTuneKeyLabel,
  type NetTuneGroup,
  type NetTuneItem,
  type NetTuneItemStatus,
} from "@shared/netTune";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import { CollapsibleSection, Row } from "./HostDetailDialog";
import { StatusChip } from "./HostNetProfileSection";

/*
  主机详情 › 更多 › 网络调优（只给管理员）：这台机器的转发相关内核参数现在是多少、哪几项没达标，
  一键按安装脚本那套规则调好（Agent 2.2.250 起，见 shared/netTune.ts）。

  「检查」只读；「一键调优」只往更适合转发的方向调、已经更好的值保留、自选的拥塞控制算法不动，
  并写进 /etc/sysctl.d/99-forwardx-network.conf，重启后还在。
*/

const STATUS_TONE: Record<NetTuneItemStatus, "good" | "warn" | "muted"> = { ok: "good", low: "warn", custom: "muted", missing: "muted" };
const STATUS_TEXT: Record<NetTuneItemStatus, string> = { ok: "达标", low: "偏低", custom: "自选", missing: "没有" };
const GROUP_ORDER: NetTuneGroup[] = ["congestion", "forwarding", "buffers", "conntrack", "queues", "tcp"];

function checkedAgo(sec: number | undefined) {
  if (!sec) return "";
  return formatAgo(Date.now() - sec * 1000);
}

function ItemRow({ item }: { item: NetTuneItem }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1" title={`${item.key}\n${item.hint}`}>
      <span className="min-w-0 truncate text-meta text-muted-foreground">{item.label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-right text-secondary-type tabular-nums">
        <span className="min-w-0 truncate font-mono text-xs text-foreground">{item.current ?? "—"}</span>
        {item.status === "low" ? <span className="whitespace-nowrap text-xs text-muted-foreground">→ {item.want}</span> : null}
        <StatusChip tone={STATUS_TONE[item.status]}>{STATUS_TEXT[item.status]}</StatusChip>
      </span>
    </div>
  );
}

export default function HostNetTuneSection({ host }: { host: { id?: number | string | null } }) {
  const hostId = Number(host?.id);
  const statusQuery = trpc.ops.netTune.status.useQuery({ hostId }, {
    enabled: hostId > 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.pending ? 2_000 : false),
  });
  const status = statusQuery.data;
  const evaluation = useMemo(() => (status?.latest?.values ? evaluateNetTune(status.latest.values) : null), [status?.latest]);
  const summary = !status
    ? undefined
    : status.pending
      ? (status.pending.apply ? "正在调优…" : "正在检查…")
      : evaluation
        ? (evaluation.low > 0 ? `${evaluation.low} 项可以调` : `${evaluation.ok}/${evaluation.total} 达标`)
        : "未检查";
  if (statusQuery.isError) return null;
  return (
    <CollapsibleSection title="网络调优" summary={summary}>
      <HostNetTuneBody hostId={hostId} />
    </CollapsibleSection>
  );
}

function HostNetTuneBody({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const [showAll, setShowAll] = useState(false);
  const statusQuery = trpc.ops.netTune.status.useQuery({ hostId }, { retry: false });
  const status = statusQuery.data;
  const run = trpc.ops.netTune.run.useMutation({
    onSuccess: () => void utils.ops.netTune.status.invalidate({ hostId }),
    onError: (error) => toast.error(error.message),
  });
  const evaluation = useMemo(() => (status?.latest?.values ? evaluateNetTune(status.latest.values) : null), [status?.latest]);

  if (!status) return <p className="text-meta text-muted-foreground">正在读取…</p>;

  const pending = status.pending;
  const latest = status.latest;
  const lastApply = status.lastApply;
  const busy = !!pending || run.isPending;
  const startApply = () => {
    void confirmDialog({
      title: "一键调优这台机器",
      description: "按安装脚本同一套规则调整内核网络参数：只往更适合转发的方向调，已经更好的值保留，自己选的拥塞控制算法不动。会写入 /etc/sysctl.d/99-forwardx-network.conf，立即生效，重启后还在。",
      confirmText: "调优",
    }).then((confirmed) => {
      if (confirmed) run.mutate({ hostId, apply: true });
    });
  };

  const lowItems = evaluation?.items.filter((item) => item.status === "low") ?? [];
  const grouped = GROUP_ORDER.map((group) => ({ group, items: (evaluation?.items ?? []).filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {evaluation ? (
        <>
          <Row label="拥塞控制" value={`${evaluation.congestionControl ?? "—"} · ${evaluation.qdisc ?? "—"}`} />
          <Row
            label="连接跟踪"
            value={evaluation.conntrackMax === null
              ? "没加载"
              : `${(evaluation.conntrackCount ?? 0).toLocaleString(getFormatLocale())} / ${evaluation.conntrackMax.toLocaleString(getFormatLocale())}`}
          />
          <Row label="达标" value={`${evaluation.ok} / ${evaluation.total}`} />
          {evaluation.kernel ? <Row label="内核" value={evaluation.kernel} /> : null}
        </>
      ) : (
        <p className="text-meta text-muted-foreground">还没检查过。点「检查」读出这台机器现在的转发相关参数。</p>
      )}

      {status.timedOut ? (
        <p className="text-meta text-[var(--fx-warn-text)]">上一次{status.timedOut.apply ? "调优" : "检查"} 3 分钟没有回音：Agent 可能不在线或连不上面板。</p>
      ) : null}
      {latest?.error ? <p className="text-meta text-[var(--fx-down-text)]">{latest.error}</p> : null}

      {lastApply && lastApply.finishedAt ? (
        <div className="rounded-md border border-border/60 px-3 py-2 text-meta">
          <div className="text-foreground">
            {checkedAgo(lastApply.finishedAt)}调优：{lastApply.changed?.length ? `改了 ${lastApply.changed.length} 项` : "没有需要改的"}
            {lastApply.failed?.length ? `，${lastApply.failed.length} 项没改成` : ""}
          </div>
          {lastApply.changed?.length ? (
            <div className="mt-1 text-muted-foreground">{lastApply.changed.map((change) => netTuneKeyLabel(change.key)).join("、")}</div>
          ) : null}
          {lastApply.failed?.map((failure) => (
            <div key={failure.key} className="mt-1 text-[var(--fx-down-text)]">{netTuneKeyLabel(failure.key)}：{failure.error}</div>
          ))}
          {lastApply.fileError ? <div className="mt-1 text-[var(--fx-warn-text)]">没写进配置文件（重启后会恢复）：{lastApply.fileError}</div> : null}
        </div>
      ) : null}

      {evaluation && lowItems.length > 0 && !showAll ? (
        <div className="flex min-w-0 flex-col">
          <div className="text-xs font-medium text-muted-foreground">可以调的</div>
          {lowItems.map((item) => <ItemRow key={item.key} item={item} />)}
        </div>
      ) : null}

      {evaluation && showAll ? grouped.map(({ group, items }) => (
        <div key={group} className="flex min-w-0 flex-col">
          <div className="text-xs font-medium text-muted-foreground">{NETTUNE_GROUP_LABELS[group]}</div>
          {items.map((item) => <ItemRow key={item.key} item={item} />)}
        </div>
      )) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run.mutate({ hostId, apply: false })}>
          {pending && !pending.apply ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          检查
        </Button>
        <Button size="sm" disabled={busy || !status.online} onClick={startApply}>
          {pending?.apply ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          一键调优
        </Button>
        {evaluation ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "只看要调的" : "全部参数"}
          </Button>
        ) : null}
        {latest?.finishedAt ? <span className="text-meta text-muted-foreground">{checkedAgo(latest.finishedAt)}检查</span> : null}
      </div>
    </div>
  );
}
