import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import type { TopologyNode } from "@shared/networkTopology";
import { manualNodeId, TOPOLOGY_MANUAL_LIMITS } from "@shared/topologyManual";

/*
  网络拓扑的「标注外部专线」（shared/topologyManual.ts）：自己画上没装 Agent 的外部节点
  （IPLC / IEPL 的另一端、上游机房……），再把它和已有的主机、外部目标连起来。

  只是给自己看的标注：每个账号各画各的，不会修改任何转发配置、不下发 Agent、不参与探测；
  跟着面板备份 / 迁移走。至少一头要是外部节点（不在两台主机之间画假线，免得和真实转发混在一起）。
*/

type Endpoint = { ref: string; label: string };

export function TopologyManualEditor({ open, onOpenChange, graphNodes }: { open: boolean; onOpenChange: (open: boolean) => void; graphNodes: readonly TopologyNode[] }) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const manual = trpc.topology.manual.useQuery(undefined, { enabled: open, staleTime: 5_000 });
  const hostOptions = trpc.hosts.options.useQuery(undefined, { enabled: open, staleTime: 30_000 });
  const refresh = () => {
    void utils.topology.manual.invalidate();
    void utils.topology.graph.invalidate();
  };
  const onError = (error: { message: string }) => toast.error(error.message);
  const createNode = trpc.topology.createManualNode.useMutation({ onSuccess: () => { refresh(); setNodeForm({ label: "", note: "", country: "" }); toast.success("已添加外部节点"); }, onError });
  const updateNode = trpc.topology.updateManualNode.useMutation({ onSuccess: () => { refresh(); setEditingId(null); setNodeForm({ label: "", note: "", country: "" }); toast.success("已保存"); }, onError });
  const deleteNode = trpc.topology.deleteManualNode.useMutation({ onSuccess: refresh, onError });
  const createLink = trpc.topology.createManualLink.useMutation({ onSuccess: () => { refresh(); setLinkForm({ from: "", to: "", label: "" }); toast.success("已添加连线"); }, onError });
  const deleteLink = trpc.topology.deleteManualLink.useMutation({ onSuccess: refresh, onError });

  const [nodeForm, setNodeForm] = useState({ label: "", note: "", country: "" });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [linkForm, setLinkForm] = useState({ from: "", to: "", label: "" });

  const nodes = manual.data?.nodes || [];
  const links = manual.data?.links || [];
  const manualEndpoints: Endpoint[] = nodes.map((node) => ({ ref: manualNodeId(node.id), label: `外部 · ${node.label}` }));
  const otherEndpoints: Endpoint[] = useMemo(() => {
    const out: Endpoint[] = [];
    for (const host of (hostOptions.data as Array<{ id: unknown; name?: unknown }> | undefined) || []) out.push({ ref: `host:${Number(host.id)}`, label: `主机 · ${String(host.name || host.id)}` });
    for (const node of graphNodes) if (node.kind === "target") out.push({ ref: node.id, label: `目标 · ${node.label}` });
    return out;
  }, [hostOptions.data, graphNodes]);
  const allEndpoints = [...manualEndpoints, ...otherEndpoints];
  const endpointLabel = (ref: string) => allEndpoints.find((item) => item.ref === ref)?.label || ref;

  const submitNode = () => {
    const payload = { label: nodeForm.label.trim(), note: nodeForm.note.trim() || null, country: nodeForm.country.trim() || null };
    if (!payload.label) { toast.error("请填写节点名称"); return; }
    if (editingId) updateNode.mutate({ ...payload, id: editingId });
    else createNode.mutate(payload);
  };
  const submitLink = () => {
    if (!linkForm.from || !linkForm.to) { toast.error("请选择连线的两头"); return; }
    createLink.mutate({ fromRef: linkForm.from, toRef: linkForm.to, label: linkForm.label.trim() || null });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88svh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>标注外部专线</DialogTitle>
          <DialogDescription>
            在拓扑图上画出没装 Agent 的外部节点（比如 IPLC 的另一端）和它们的连线。只是给自己看的标注：不会修改任何转发配置，也不会下发给 Agent。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <section className="space-y-2">
            <p className="text-sm font-medium">外部节点 · {nodes.length}/{TOPOLOGY_MANUAL_LIMITS.nodes}</p>
            {nodes.length === 0 ? <p className="text-meta text-muted-foreground">还没有。先加一个节点，再把它连到主机或目标上。</p> : null}
            <ul className="space-y-1">
              {nodes.map((node) => (
                <li key={node.id} className="flex min-w-0 items-center gap-2 rounded-md bg-[var(--fx-l2-group)] px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{node.label}{node.country ? ` · ${node.country}` : ""}{node.note ? <span className="ml-1 text-meta text-muted-foreground">{node.note}</span> : null}</span>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setEditingId(node.id); setNodeForm({ label: node.label, note: node.note || "", country: node.country || "" }); }}>编辑</Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`删除 ${node.label}`}
                    onClick={async () => {
                      if (await confirm({ title: "删除外部节点", description: `删除「${node.label}」和连着它的标注连线？不影响任何真实配置。`, confirmText: "删除", tone: "destructive" })) deleteNode.mutate({ id: node.id });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_auto]">
              <div className="space-y-1"><Label htmlFor="topo-manual-label">名称</Label><Input id="topo-manual-label" value={nodeForm.label} maxLength={TOPOLOGY_MANUAL_LIMITS.label} placeholder="例如：沪日 IPLC 日本端" onChange={(e) => setNodeForm({ ...nodeForm, label: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="topo-manual-note">备注</Label><Input id="topo-manual-note" value={nodeForm.note} maxLength={TOPOLOGY_MANUAL_LIMITS.note} placeholder="可选" onChange={(e) => setNodeForm({ ...nodeForm, note: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="topo-manual-country">国家码</Label><Input id="topo-manual-country" value={nodeForm.country} maxLength={2} placeholder="JP" onChange={(e) => setNodeForm({ ...nodeForm, country: e.target.value.toUpperCase() })} /></div>
              <div className="flex items-end gap-1">
                <Button size="sm" onClick={submitNode} disabled={createNode.isPending || updateNode.isPending}>{editingId ? "保存" : "添加"}</Button>
                {editingId ? <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setNodeForm({ label: "", note: "", country: "" }); }}>取消</Button> : null}
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium">连线 · {links.length}/{TOPOLOGY_MANUAL_LIMITS.links}</p>
            <ul className="space-y-1">
              {links.map((link) => (
                <li key={link.id} className="flex min-w-0 items-center gap-2 rounded-md bg-[var(--fx-l2-group)] px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{endpointLabel(link.fromRef)} → {endpointLabel(link.toRef)}{link.label ? <span className="ml-1 text-meta text-muted-foreground">{link.label}</span> : null}</span>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="删除连线" onClick={() => deleteLink.mutate({ id: link.id })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            {nodes.length === 0 ? (
              <p className="text-meta text-muted-foreground">先加一个外部节点才能连线（至少一头要是外部节点）。</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="space-y-1">
                  <Label>从</Label>
                  <Select value={linkForm.from} onValueChange={(value) => setLinkForm({ ...linkForm, from: value })}>
                    <SelectTrigger aria-label="连线起点"><SelectValue placeholder="选择" /></SelectTrigger>
                    <SelectContent>{allEndpoints.map((item) => <SelectItem key={item.ref} value={item.ref}>{item.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>到</Label>
                  <Select value={linkForm.to} onValueChange={(value) => setLinkForm({ ...linkForm, to: value })}>
                    <SelectTrigger aria-label="连线终点"><SelectValue placeholder="选择" /></SelectTrigger>
                    <SelectContent>{allEndpoints.filter((item) => item.ref !== linkForm.from).map((item) => <SelectItem key={item.ref} value={item.ref}>{item.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1"><Label htmlFor="topo-manual-link-label">说明</Label><Input id="topo-manual-link-label" value={linkForm.label} maxLength={TOPOLOGY_MANUAL_LIMITS.label} placeholder="例如：IPLC 100M" onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })} /></div>
                <div className="flex items-end"><Button size="sm" onClick={submitLink} disabled={createLink.isPending}>添加</Button></div>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
