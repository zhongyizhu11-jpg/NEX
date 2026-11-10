import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { FORWARD_TYPE_LABELS, type ForwardType } from "@shared/forwardTypes";
import { formatPortSpan } from "@shared/portRange";

type BatchRow = {
  line: number;
  text: string;
  ok: boolean;
  error?: string;
  sourcePort?: number;
  sourcePortEnd?: number | null;
  targetIp?: string;
  targetPort?: number;
  targetPortEnd?: number | null;
  remark?: string;
  ruleId?: number;
};

type BatchHost = { id: number; name?: string | null; isOnline?: boolean | null };

const PLACEHOLDER = "每行：入口端口 目标:端口 [备注]\n20000-20100 10.0.0.2:20000 游戏\n30000-30010 10.0.0.3:40000-40010\n8443 [2001:db8::1]:443";

/**
 * 规则列表「批量添加」：贴多行，先看每一行能不能建（服务端逐行判），确认后一次建完，
 * 再逐行告诉你哪几行建了、哪几行没建（server/ruleBatchCreate.ts）。只建直连主机上的规则。
 */
export function RuleBatchAddDialog({
  open,
  onOpenChange,
  hosts,
  forwardTypes,
  ownerUserId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: BatchHost[];
  forwardTypes: ForwardType[];
  ownerUserId?: number;
  onCreated: () => void;
}) {
  const [hostId, setHostId] = useState<number | null>(null);
  const [forwardType, setForwardType] = useState<ForwardType>("nftables");
  const [protocol, setProtocol] = useState<"tcp" | "udp" | "both">("both");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  // 结果页：建完之后的逐行结果，和预览分开 —— 预览说「能不能」，结果说「建没建」。
  const [done, setDone] = useState(false);
  const preview = trpc.rules.batchPreview.useMutation();
  const create = trpc.rules.batchCreate.useMutation();

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setDone(false);
    if (!hostId && hosts.length > 0) setHostId(Number(hosts[0].id));
    if (!forwardTypes.includes(forwardType) && forwardTypes.length > 0) {
      setForwardType(forwardTypes.includes("nftables") ? "nftables" : forwardTypes[0]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 改了任何输入，之前的预览就作废：不能拿旧的预览去建。
  useEffect(() => {
    if (!done) setRows(null);
  }, [hostId, forwardType, protocol, text]); // eslint-disable-line react-hooks/exhaustive-deps

  const okCount = useMemo(() => (rows || []).filter((row) => row.ok).length, [rows]);
  const input = { userId: ownerUserId, hostId: Number(hostId || 0), forwardType, protocol, text };
  const busy = preview.isPending || create.isPending;

  const runPreview = async () => {
    try {
      const result = await preview.mutateAsync(input);
      setRows(result.rows);
      setDone(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "预览失败");
    }
  };
  const runCreate = async () => {
    try {
      const result = await create.mutateAsync(input);
      setRows(result.rows);
      setDone(true);
      onCreated();
      if (result.failed === 0) toast.success(result.summary);
      else if (result.created === 0) toast.error(result.summary);
      else toast.warning(result.summary);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[96svh] w-[calc(100vw-1rem)] flex-col gap-3 overflow-hidden p-4 sm:max-w-xl sm:p-5">
        <DialogHeader>
          <DialogTitle>批量添加</DialogTitle>
          <DialogDescription>端口段只能用 iptables / nftables；先预览，能建的才会建。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="col-span-2 space-y-1.5 sm:col-span-1">
              <Label>主机</Label>
              <Select value={hostId ? String(hostId) : undefined} onValueChange={(value) => setHostId(Number(value))} disabled={busy}>
                <SelectTrigger aria-label="主机"><SelectValue placeholder="选主机" /></SelectTrigger>
                <SelectContent>
                  {hosts.map((host) => (
                    <SelectItem key={host.id} value={String(host.id)}>{host.name || `主机 ${host.id}`}{host.isOnline ? "" : "（离线）"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>转发工具</Label>
              <Select value={forwardType} onValueChange={(value) => setForwardType(value as ForwardType)} disabled={busy}>
                <SelectTrigger aria-label="转发工具"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {forwardTypes.map((type) => <SelectItem key={type} value={type}>{FORWARD_TYPE_LABELS[type]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>协议</Label>
              <Select value={protocol} onValueChange={(value) => setProtocol(value as "tcp" | "udp" | "both")} disabled={busy}>
                <SelectTrigger aria-label="协议"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                  <SelectItem value="both">TCP+UDP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={PLACEHOLDER}
            className="min-h-[7.5rem] resize-y font-mono text-sm"
            disabled={create.isPending}
            aria-label="规则，每行一条"
          />
          {rows ? (
            <div className="space-y-1.5" data-testid="batch-preview">
              <p className="text-meta text-muted-foreground">
                {done
                  ? `建了 ${okCount} 条${rows.length - okCount > 0 ? `，${rows.length - okCount} 行没建` : ""}`
                  : `${okCount} 行能建${rows.length - okCount > 0 ? `，${rows.length - okCount} 行不行` : ""}`}
              </p>
              <ul className="max-h-[18rem] divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60">
                {rows.map((row) => (
                  <li key={row.line} className="flex items-start gap-2 px-2.5 py-1.5 text-sm">
                    {row.ok
                      ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--fx-healthy-text)]" />
                      : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                    <span className="w-7 shrink-0 text-meta tabular-nums text-muted-foreground">{row.line}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">
                        {row.sourcePort
                          ? `${formatPortSpan(row.sourcePort, row.sourcePortEnd)} → ${String(row.targetIp).includes(":") ? `[${row.targetIp}]` : row.targetIp}:${formatPortSpan(row.targetPort, row.targetPortEnd ?? (row.sourcePortEnd ? Number(row.targetPort) + Number(row.sourcePortEnd) - Number(row.sourcePort) : null))}`
                          : row.text}
                        {row.remark ? <span className="ml-1.5 font-sans text-muted-foreground">{row.remark}</span> : null}
                      </span>
                      {row.error ? <span className="block text-meta text-destructive">{row.error}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {done ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : (
            <>
              <Button variant="outline" onClick={runPreview} disabled={busy || !hostId || !text.trim()}>
                {preview.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                预览
              </Button>
              <Button onClick={runCreate} disabled={busy || !rows || okCount === 0} className={cn(!rows && "opacity-60")}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {rows ? `添加 ${okCount} 条` : "添加"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
