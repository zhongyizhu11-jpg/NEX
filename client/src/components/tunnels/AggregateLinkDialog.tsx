import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  AGGREGATE_LINK_MAX_RELAYS,
  AGGREGATE_LINK_MIN_RELAYS,
  aggregateLinkError,
  aggregateLinkHops,
  aggregateLinkSelectionOf,
} from "@shared/aggregateLink";
import { hostBandwidthHintMbps } from "@shared/linkWeights";

/*
  链路管理 ›「叠加」的新建 / 编辑：入口、几台中转、落地（shared/aggregateLink.ts）。底下是一条
  NEX V1 隧道、中转方式单连接叠加；其余设置（限速、端口范围……）点「更多设置」到隧道编辑框里改。
  入口哪台都行，家里常开的 Linux 也一样当普通主机选。
*/

type HostRow = { id: number | string; name?: string | null; lineBandwidthMbps?: unknown; rateLimitMbps?: unknown; egressMbps?: unknown };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要编辑的叠加；新建时为 null。 */
  tunnel: any | null;
  hosts: HostRow[];
  /** 打开完整的隧道编辑框（编辑时才有）。 */
  onMoreSettings?: (tunnel: any) => void;
};

function formatMbps(value: number) {
  if (!(value > 0)) return "";
  return value >= 1000 && value % 100 === 0 ? `${value / 1000}G` : `${value}M`;
}

export default function AggregateLinkDialog({ open, onOpenChange, tunnel, hosts, onMoreSettings }: Props) {
  const utils = trpc.useUtils();
  const [entryHostId, setEntryHostId] = useState<number | null>(null);
  const [exitHostId, setExitHostId] = useState<number | null>(null);
  const [relayHostIds, setRelayHostIds] = useState<number[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    const selection = tunnel ? aggregateLinkSelectionOf(tunnel) : { entryHostId: null, relayHostIds: [], exitHostId: null };
    setEntryHostId(selection.entryHostId ? Number(selection.entryHostId) : null);
    setExitHostId(selection.exitHostId ? Number(selection.exitHostId) : null);
    setRelayHostIds(selection.relayHostIds);
    setName(tunnel ? String(tunnel.name || "") : "");
  }, [open, tunnel]);

  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const hostName = (id: number | null) => (id ? String(hostById.get(id)?.name || `主机 ${id}`) : "");
  const selection = { entryHostId, relayHostIds, exitHostId };
  const error = aggregateLinkError(selection);
  const autoName = entryHostId && exitHostId ? `${hostName(entryHostId)} 叠加 → ${hostName(exitHostId)}`.slice(0, 128) : "";
  const relayChoices = hosts.filter((host) => Number(host.id) !== entryHostId && Number(host.id) !== exitHostId);
  const relayBandwidths = relayHostIds.map((id) => hostBandwidthHintMbps(hostById.get(id)));
  const relayBandwidthKnown = relayBandwidths.length > 0 && relayBandwidths.every((value) => value > 0);

  const done = async (message: string) => {
    toast.success(message);
    await utils.tunnels.invalidate();
    onOpenChange(false);
  };
  const create = trpc.tunnels.create.useMutation({ onSuccess: () => done("叠加已建好"), onError: (e) => toast.error(e.message || "没建成") });
  const update = trpc.tunnels.update.useMutation({ onSuccess: () => done("已保存"), onError: (e) => toast.error(e.message || "没保存成") });
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (error || !entryHostId || !exitHostId) return;
    const hopHostIds = aggregateLinkHops(selection);
    const finalName = name.trim() || autoName;
    if (tunnel) {
      update.mutate({ id: Number(tunnel.id), name: finalName, entryHostId, exitHostId, relayMode: "aggregate", hopHostIds });
    } else {
      create.mutate({ name: finalName, entryHostId, exitHostId, mode: "forwardx", forwardxVersion: "v1", relayMode: "aggregate", hopHostIds });
    }
  };

  const toggleRelay = (id: number, checked: boolean) => {
    setRelayHostIds((previous) => (checked ? [...previous.filter((item) => item !== id), id] : previous.filter((item) => item !== id)));
  };
  const pickEnd = (setter: (id: number) => void) => (value: string) => {
    const id = Number(value);
    setter(id);
    setRelayHostIds((previous) => previous.filter((item) => item !== id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tunnel ? "编辑叠加" : "新建叠加"}</DialogTitle>
          <DialogDescription>一条连接拆到几台中转同时送，在落地拼回来。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-sm">名称</Label>
            <Input className="h-9" value={name} maxLength={128} placeholder={autoName || "留空自动起名"} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm">入口</Label>
              <Select value={entryHostId ? String(entryHostId) : ""} onValueChange={pickEnd(setEntryHostId)}>
                <SelectTrigger aria-label="入口"><SelectValue placeholder="选择入口主机" /></SelectTrigger>
                <SelectContent>
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={String(host.id)} disabled={Number(host.id) === exitHostId}>{host.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">落地</Label>
              <Select value={exitHostId ? String(exitHostId) : ""} onValueChange={pickEnd(setExitHostId)}>
                <SelectTrigger aria-label="落地"><SelectValue placeholder="选择落地主机" /></SelectTrigger>
                <SelectContent>
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={String(host.id)} disabled={Number(host.id) === entryHostId}>{host.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label className="text-sm">中转（至少 {AGGREGATE_LINK_MIN_RELAYS} 台）</Label>
              {relayHostIds.length > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {relayBandwidthKnown ? `合计 ${formatMbps(relayBandwidths.reduce((sum, value) => sum + value, 0))}` : `已选 ${relayHostIds.length} 台`}
                </span>
              ) : null}
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1.5">
              {relayChoices.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">没有别的主机可选</p>
              ) : relayChoices.map((host) => {
                const id = Number(host.id);
                const checked = relayHostIds.includes(id);
                const full = !checked && relayHostIds.length >= AGGREGATE_LINK_MAX_RELAYS;
                return (
                  <label key={id} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 hover:bg-muted/50">
                    <Checkbox checked={checked} disabled={full} onCheckedChange={(next) => toggleRelay(id, next)} />
                    <span className="min-w-0 flex-1 truncate text-sm">{host.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatMbps(hostBandwidthHintMbps(host)) || "带宽未填"}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {entryHostId && exitHostId && relayHostIds.length > 0 && error ? (
            <p className="text-xs text-[var(--fx-warn-text)]" aria-live="polite">{error}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {tunnel && onMoreSettings ? (
            <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => { onOpenChange(false); onMoreSettings(tunnel); }}>
              更多设置
            </Button>
          ) : <span className="hidden sm:block" />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="button" disabled={!!error || pending} onClick={submit}>
              {pending ? "正在保存…" : tunnel ? "保存" : "建好"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
