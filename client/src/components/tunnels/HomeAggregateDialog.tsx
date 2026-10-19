import { useEffect, useState } from "react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { planHomeAggregate } from "@shared/homeAggregate";

/*
  链路管理 › 隧道 ›「家庭叠加」：家里一台常开的 Linux 当入口，一条连接拆到几台前置同时送，
  落地机拼回来（shared/homeAggregate.ts）。选三样，面板建好隧道和规则，订阅里自动多一个节点。
*/

type Props = { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: (tunnelId: number) => void };

function formatMbps(value: number) {
  if (!(value > 0)) return "";
  return value >= 1000 && value % 100 === 0 ? `${value / 1000}G` : `${value}M`;
}

export default function HomeAggregateDialog({ open, onOpenChange, onCreated }: Props) {
  const utils = trpc.useUtils();
  const query = trpc.homeAggregate.options.useQuery(undefined, { enabled: open, staleTime: 0 });
  const [homeId, setHomeId] = useState<number | null>(null);
  const [relayIds, setRelayIds] = useState<number[]>([]);
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) return;
    setHomeId(null);
    setRelayIds([]);
    setNodeId(null);
    setName("");
  }, [open]);

  const hosts = query.data?.hosts ?? [];
  const nodes = query.data?.nodes ?? [];
  const home = hosts.find((host) => host.id === homeId);
  const node = nodes.find((item) => item.id === nodeId);
  const relayChoices = hosts.filter((host) => host.id !== homeId && host.id !== node?.hostId);
  const relays = relayIds.map((id) => hosts.find((host) => host.id === id));
  const planned = planHomeAggregate({ home, relays, node, name });
  const relayBandwidth = relays.reduce((sum, relay) => sum + (relay?.lineBandwidthMbps || 0), 0);
  const unknownBandwidth = relays.some((relay) => !(relay?.lineBandwidthMbps));

  const create = trpc.homeAggregate.create.useMutation({
    onSuccess: async (result) => {
      toast.success(`建好了：在家连 ${result.subscriptionAddress}:${result.sourcePort}，订阅里已经有这个节点`);
      await Promise.all([utils.tunnels.invalidate(), utils.rules.invalidate(), utils.hosts.invalidate()]);
      onOpenChange(false);
      onCreated?.(result.tunnelId);
    },
    onError: (error) => toast.error(error.message || "没建成"),
  });

  const toggleRelay = (id: number, checked: boolean) => {
    setRelayIds((previous) => (checked ? [...previous.filter((item) => item !== id), id] : previous.filter((item) => item !== id)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>家庭叠加</DialogTitle>
          <DialogDescription>家里一台常开的 Linux 当入口，一条连接拆到几台前置同时送，落地拼回来。</DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <DataSectionLoading label="正在读取主机和落地" minHeight="min-h-[160px]" />
        ) : query.isError ? (
          <DataSectionError label="主机和落地" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm">家里的机器</Label>
              <Select
                value={homeId ? String(homeId) : ""}
                onValueChange={(value) => {
                  const id = Number(value);
                  setHomeId(id);
                  setRelayIds((previous) => previous.filter((item) => item !== id));
                }}
              >
                <SelectTrigger aria-label="家里的机器"><SelectValue placeholder="软路由、小主机、NAS（装好 Agent）" /></SelectTrigger>
                <SelectContent>
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={String(host.id)}>
                      {host.name}
                      {host.entryIp || host.detectedPrivateIpv4 ? <span className="ml-1.5 text-xs text-muted-foreground">{host.entryIp || host.detectedPrivateIpv4}</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">落地</Label>
              <Select
                value={nodeId ? String(nodeId) : ""}
                onValueChange={(value) => {
                  const picked = nodes.find((item) => item.id === Number(value));
                  setNodeId(Number(value));
                  if (picked) setRelayIds((previous) => previous.filter((item) => item !== picked.hostId));
                }}
              >
                <SelectTrigger aria-label="落地"><SelectValue placeholder="选一个落地节点" /></SelectTrigger>
                <SelectContent>
                  {nodes.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)} disabled={!(item.hostId > 0) || item.hostId === homeId}>
                      {item.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">{item.hostName || "不在面板主机上"}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {nodes.length === 0 ? <p className="text-xs text-muted-foreground">还没有落地节点：先在落地机上建一个入站。</p> : null}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label className="text-sm">前置（至少 {query.data?.minRelays ?? 2} 台）</Label>
                {relays.length > 0 ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {unknownBandwidth ? `已选 ${relays.length} 台` : `合计 ${formatMbps(relayBandwidth)}`}
                  </span>
                ) : null}
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1.5">
                {relayChoices.length === 0 ? (
                  <p className="p-2 text-xs text-muted-foreground">没有别的主机可选</p>
                ) : relayChoices.map((host) => {
                  const checked = relayIds.includes(host.id);
                  const full = !checked && relayIds.length >= (query.data?.maxRelays ?? 8);
                  return (
                    <label key={host.id} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 hover:bg-muted/50">
                      <Checkbox checked={checked} disabled={full} onCheckedChange={(next) => toggleRelay(host.id, next)} />
                      <span className="min-w-0 flex-1 truncate text-sm">{host.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatMbps(host.lineBandwidthMbps) || "带宽未填"}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">名称</Label>
              <Input className="h-9" value={name} maxLength={128} placeholder={planned.ok ? planned.plan.tunnel.name : "留空自动起名"} onChange={(event) => setName(event.target.value)} />
            </div>

            {home && node && relays.length >= (query.data?.minRelays ?? 2) ? (
              <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs leading-5" aria-live="polite">
                {planned.ok ? (
                  <>
                    <p>
                      订阅里会多一个节点，地址 <span className="font-mono">{planned.plan.subscriptionAddress}</span>
                      {planned.plan.homeEntryIp ? "（家里那台的内网 IP，会填进它的入口 IP）" : ""}，在家里的网络里用。
                    </p>
                    {unknownBandwidth ? <p className="text-muted-foreground">有前置没填线路带宽：开头按一样大分，跑起来以后按实测分。</p> : null}
                  </>
                ) : (
                  <p className="text-[var(--fx-warn-text)]">{planned.error}</p>
                )}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            type="button"
            disabled={!planned.ok || create.isPending}
            onClick={() => {
              if (!homeId || !nodeId) return;
              create.mutate({ homeHostId: homeId, relayHostIds: relayIds, proxyNodeId: nodeId, name: name.trim() || undefined });
            }}
          >
            {create.isPending ? "正在建…" : "建好"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
