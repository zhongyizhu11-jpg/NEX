import { getFormatLocale } from "@/i18n";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatAgo } from "@shared/dashboardAttention";
import {
  evaluateNetTune,
  NETTUNE_CUSTOM_AGENT_VERSION,
  NETTUNE_EDITABLE_KEYS,
  NETTUNE_GROUP_LABELS,
  NETTUNE_KEY_CC,
  NETTUNE_KEY_QDISC,
  NETTUNE_QDISC_CHOICES,
  netTuneKeyLabel,
  normalizeNetTuneSetting,
  type NetTuneGroup,
  type NetTuneItem,
  type NetTuneItemStatus,
} from "@shared/netTune";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import { CollapsibleSection, Row } from "./HostDetailDialog";
import { StatusChip } from "./HostNetProfileSection";

/*
  主机详情 › 更多 › 网络调优（只给管理员）：这台机器的转发相关内核参数现在是多少、哪几项没达标，
  一键按安装脚本那套规则调好（Agent 2.2.250 起，见 shared/netTune.ts）。

  「检查」只读；「一键调优」只往更适合转发的方向调、已经更好的值保留、自选的拥塞控制算法不动，
  并写进 /etc/sysctl.d/99-forwardx-network.conf，重启后还在。
  Agent 2.2.255 起还能「逐项设置」（自己填每一项的值）和「还原」（回到面板第一次改这台机器之前的值）。
*/

const MODE_TEXT: Record<string, string> = { apply: "调优", set: "设置", restore: "还原", check: "检查" };

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
      ? `正在${MODE_TEXT[status.pending.mode ?? (status.pending.apply ? "apply" : "check")] ?? "检查"}…`
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const setValues = trpc.ops.netTune.set.useMutation({
    onSuccess: () => {
      setEditing(false);
      void utils.ops.netTune.status.invalidate({ hostId });
    },
    onError: (error) => toast.error(error.message),
  });
  const restore = trpc.ops.netTune.restore.useMutation({
    onSuccess: () => void utils.ops.netTune.status.invalidate({ hostId }),
    onError: (error) => toast.error(error.message),
  });
  const evaluation = useMemo(() => (status?.latest?.values ? evaluateNetTune(status.latest.values) : null), [status?.latest]);

  if (!status) return <p className="text-meta text-muted-foreground">正在读取…</p>;

  const pending = status.pending;
  const latest = status.latest;
  const lastApply = status.lastApply;
  const busy = !!pending || run.isPending || setValues.isPending || restore.isPending;
  const supportsCustom = status.supportsCustom === true;
  const rawValues = latest?.values ?? {};
  const editableKeys = NETTUNE_EDITABLE_KEYS.filter((key) => rawValues[key] !== undefined);
  const startEditing = () => {
    setDraft(Object.fromEntries(editableKeys.map((key) => [key, rawValues[key]])));
    setEditing(true);
  };
  const saveDraft = () => {
    const changed: Record<string, string> = {};
    try {
      for (const key of editableKeys) {
        const value = (draft[key] ?? "").trim();
        if (value.split(/\s+/).join(" ") === rawValues[key]) continue;
        changed[key] = normalizeNetTuneSetting(key, value);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "有一项填得不对");
      return;
    }
    if (Object.keys(changed).length === 0) {
      toast.info("没有改动");
      setEditing(false);
      return;
    }
    void confirmDialog({
      title: `改这台机器的 ${Object.keys(changed).length} 项内核参数`,
      description: `${Object.keys(changed).map((key) => `${netTuneKeyLabel(key)} → ${changed[key]}`).join("；")}。立即生效并写进 /etc/sysctl.d，重启后还在；内核不接受的值会自动改回原值。改之前 Agent 会存一份原值，以后能「还原」。`,
      confirmText: "保存",
    }).then((confirmed) => {
      if (confirmed) setValues.mutate({ hostId, values: changed });
    });
  };
  const startRestore = () => {
    void confirmDialog({
      title: "还原调优前的参数",
      description: "把这台机器的内核网络参数改回面板第一次改它之前的值，并删掉面板写的 sysctl.d / modprobe.d 文件。安装 Agent 时自动做的那次调优不算，那一次的原值没有留。",
      confirmText: "还原",
      tone: "destructive",
    }).then((confirmed) => {
      if (confirmed) restore.mutate({ hostId });
    });
  };
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
        <p className="text-meta text-[var(--fx-warn-text)]">上一次{MODE_TEXT[status.timedOut.mode ?? (status.timedOut.apply ? "apply" : "check")]} 3 分钟没有回音：Agent 可能不在线或连不上面板。</p>
      ) : null}
      {latest?.error && latest !== lastApply ? <p className="text-meta text-[var(--fx-down-text)]">{latest.error}</p> : null}

      {lastApply && lastApply.finishedAt ? (
        <div className="rounded-md border border-border/60 px-3 py-2 text-meta">
          <div className="text-foreground">
            {checkedAgo(lastApply.finishedAt)}{MODE_TEXT[lastApply.mode ?? "apply"] ?? "调优"}：{lastApply.error ? lastApply.error : lastApply.changed?.length ? `改了 ${lastApply.changed.length} 项` : "没有需要改的"}
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

      {editing ? (
        <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/60 p-2.5">
          <div className="text-xs text-muted-foreground">逐项设置：改哪项填哪项，数字参数的段数要和现在一样（TCP 窗口是三段）。</div>
          {editableKeys.map((key) => (
            <label key={key} className="flex min-w-0 items-center justify-between gap-3" title={key}>
              <span className="min-w-0 truncate text-meta text-muted-foreground">{netTuneKeyLabel(key)}</span>
              {key === NETTUNE_KEY_QDISC ? (
                <select
                  className="h-8 w-48 rounded-md border border-border bg-background px-2 font-mono text-xs"
                  value={draft[key] ?? ""}
                  onChange={(event) => setDraft((old) => ({ ...old, [key]: event.target.value }))}
                >
                  {[...new Set([draft[key] ?? "", ...NETTUNE_QDISC_CHOICES])].filter(Boolean).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                </select>
              ) : key === NETTUNE_KEY_CC && rawValues["net.ipv4.tcp_available_congestion_control"] ? (
                <select
                  className="h-8 w-48 rounded-md border border-border bg-background px-2 font-mono text-xs"
                  value={draft[key] ?? ""}
                  onChange={(event) => setDraft((old) => ({ ...old, [key]: event.target.value }))}
                >
                  {[...new Set([draft[key] ?? "", ...rawValues["net.ipv4.tcp_available_congestion_control"].split(/\s+/), "bbr"])].filter(Boolean).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                </select>
              ) : (
                <Input
                  className="h-8 w-48 font-mono text-xs"
                  value={draft[key] ?? ""}
                  onChange={(event) => setDraft((old) => ({ ...old, [key]: event.target.value }))}
                  aria-label={netTuneKeyLabel(key)}
                />
              )}
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={busy || !status.online} onClick={saveDraft}>
              {setValues.isPending || pending?.mode === "set" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存设置
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run.mutate({ hostId, apply: false })}>
          {pending?.mode === "check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          检查
        </Button>
        <Button size="sm" disabled={busy || !status.online} onClick={startApply}>
          {pending?.mode === "apply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          一键调优
        </Button>
        {evaluation && supportsCustom && !editing ? (
          <Button size="sm" variant="outline" disabled={busy || !status.online} onClick={startEditing}>逐项设置</Button>
        ) : null}
        {supportsCustom && latest?.hasBackup ? (
          <Button size="sm" variant="outline" disabled={busy || !status.online} onClick={startRestore}>
            {pending?.mode === "restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            还原调优前
          </Button>
        ) : null}
        {evaluation ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "只看要调的" : "全部参数"}
          </Button>
        ) : null}
        {latest?.finishedAt ? <span className="text-meta text-muted-foreground">{checkedAgo(latest.finishedAt)}检查</span> : null}
      </div>
      {evaluation && !supportsCustom ? (
        <p className="text-meta text-muted-foreground">逐项设置和还原要 Agent {NETTUNE_CUSTOM_AGENT_VERSION} 或更新。</p>
      ) : null}
    </div>
  );
}
