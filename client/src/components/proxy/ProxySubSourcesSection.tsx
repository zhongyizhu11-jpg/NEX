/**
 * 外部订阅：用户把别处的订阅地址填进来，面板定时拉取并并进自己的订阅（或透传给客户端）。
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { formatBytes } from "@shared/formatBytes";
import { PROXY_SUB_SOURCE_MODES, PROXY_SUB_SOURCE_MODE_LABELS, type ProxySubSourceMode } from "@shared/proxySubSource";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const INTERVALS: Array<{ value: number; label: string }> = [
  { value: 600, label: "10 分钟" },
  { value: 3600, label: "1 小时" },
  { value: 6 * 3600, label: "6 小时" },
  { value: 12 * 3600, label: "12 小时" },
  { value: 86400, label: "24 小时" },
  { value: 3 * 86400, label: "3 天" },
];

function timeText(value: unknown): string {
  if (!value) return "从没拉过";
  const date = new Date(value as any);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "—";
}

export default function ProxySubSourcesSection({ allowed, maxPerUser, onChanged }: { allowed: boolean; maxPerUser: number; onChanged?: () => void }) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const listQuery = trpc.proxySubscriptions.listSources.useQuery(undefined, { enabled: allowed });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<ProxySubSourceMode>("import");
  const [intervalSec, setIntervalSec] = useState(6 * 3600);
  const [userAgent, setUserAgent] = useState("");

  const refresh = () => {
    void utils.proxySubscriptions.listSources.invalidate();
    onChanged?.();
  };
  const create = trpc.proxySubscriptions.createSource.useMutation({
    onSuccess: (result) => {
      if (result.sync.ok) toast.success(`已添加，同步到 ${result.sync.nodeCount} 个节点`);
      else toast.warning(`已添加，但第一次拉取失败：${result.sync.error}`);
      setDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message || "添加失败"),
  });
  const update = trpc.proxySubscriptions.updateSource.useMutation({
    onSuccess: () => {
      toast.success("已保存");
      setDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const remove = trpc.proxySubscriptions.deleteSource.useMutation({
    onSuccess: () => {
      toast.success("已删除，它同步来的节点一并删掉了");
      refresh();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });
  const sync = trpc.proxySubscriptions.syncSource.useMutation({
    onSuccess: (result) => {
      if (!result.ok) toast.error(`拉取失败：${result.error}`);
      else if (result.unchanged) toast.success("上游没变化");
      else toast.success(`同步完成：+${result.added} 更新 ${result.updated} 移除 ${result.removed}`);
      refresh();
    },
    onError: (error) => toast.error(error.message || "同步失败"),
  });

  if (!allowed) return null;
  const sources = (listQuery.data || []) as any[];

  const openCreate = () => {
    setEditingId(null);
    setName("");
    setUrl("");
    setMode("import");
    setIntervalSec(6 * 3600);
    setUserAgent("");
    setDialogOpen(true);
  };
  const openEdit = (source: any) => {
    setEditingId(Number(source.id));
    setName(String(source.name || ""));
    setUrl(String(source.url || ""));
    setMode((PROXY_SUB_SOURCE_MODES as readonly string[]).includes(source.mode) ? source.mode : "import");
    setIntervalSec(Number(source.intervalSec || 6 * 3600));
    setUserAgent(String(source.userAgent || ""));
    setDialogOpen(true);
  };
  const submit = () => {
    if (!name.trim()) {
      toast.error("请填名字");
      return;
    }
    if (!/^https?:\/\//i.test(url.trim())) {
      toast.error("订阅地址要以 http:// 或 https:// 开头");
      return;
    }
    const payload = { name: name.trim(), url: url.trim(), mode, intervalSec, userAgent: userAgent.trim() || undefined };
    if (editingId) update.mutate({ id: editingId, ...payload, userAgent: userAgent.trim() || null });
    else create.mutate(payload);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">外部订阅</CardTitle>
          <p data-fx-help="" className="mt-1 text-xs text-muted-foreground">
            把别处的订阅地址填进来，面板定时拉取，节点并进你的订阅里；也能绑到转发上走中转。
            {maxPerUser > 0 ? `最多 ${maxPerUser} 个。` : ""}
          </p>
        </div>
        <Button size="sm" onClick={openCreate} disabled={maxPerUser > 0 && sources.length >= maxPerUser}>
          <Plus className="mr-1 h-4 w-4" />添加
        </Button>
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">还没有外部订阅。</p>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => (
              <div key={source.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{source.name}</span>
                    <Badge variant="outline">{source.mode === "provider" ? "透传" : "导入"}</Badge>
                    {source.lastStatus === "error" ? <Badge variant="destructive">拉取失败</Badge> : null}
                    {!source.isEnabled ? <Badge variant="outline">已停用</Badge> : null}
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={source.url}>{source.url}</p>
                  <p className="text-xs text-muted-foreground">
                    {source.nodeCount} 个节点 · 上次 {timeText(source.lastFetchAt)}
                    {source.upstream ? ` · 上游已用 ${formatBytes(Number(source.upstream.upload || 0) + Number(source.upstream.download || 0))}${Number(source.upstream.total || 0) > 0 ? ` / ${formatBytes(source.upstream.total)}` : ""}` : ""}
                    {source.lastError ? ` · ${source.lastError}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Switch aria-label={`${source.name} 启用`} checked={!!source.isEnabled} onCheckedChange={(checked) => update.mutate({ id: source.id, isEnabled: checked })} />
                  <Button size="sm" variant="ghost" onClick={() => sync.mutate({ id: source.id })} disabled={sync.isPending} title="立刻拉取一次">
                    <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(source)}>编辑</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await confirm({ title: `删除「${source.name}」？`, description: "它同步来的节点会一起删掉，绑在那些节点上的转发会解绑。", confirmText: "删除" });
                      if (ok) remove.mutate({ id: source.id });
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑外部订阅" : "添加外部订阅"}</DialogTitle>
            <DialogDescription className="text-xs">只收 http(s) 地址，不拉内网。正文最多 2 MB。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField className="space-y-1.5">
              <Label>名字</Label>
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="例如 某机场" />
            </FormField>
            <FormField className="space-y-1.5">
              <Label>订阅地址</Label>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" />
            </FormField>
            <FormField className="space-y-1.5">
              <Label>方式</Label>
              <Select value={mode} onValueChange={(value) => setMode(value as ProxySubSourceMode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROXY_SUB_SOURCE_MODES.map((item) => (
                    <SelectItem key={item} value={item}>{PROXY_SUB_SOURCE_MODE_LABELS[item]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField className="space-y-1.5">
                <Label>拉取间隔</Label>
                <Select value={String(intervalSec)} onValueChange={(value) => setIntervalSec(Number(value))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INTERVALS.map((item) => (
                      <SelectItem key={item.value} value={String(item.value)}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField className="space-y-1.5">
                <Label>拉取时的 User-Agent（可选）</Label>
                <Input value={userAgent} onChange={(event) => setUserAgent(event.target.value)} maxLength={200} placeholder="clash.meta" />
              </FormField>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={create.isPending || update.isPending}>{editingId ? "保存" : "添加并拉取"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
