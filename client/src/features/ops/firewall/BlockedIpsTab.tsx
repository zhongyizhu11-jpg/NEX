import { useEffect, useState } from "react";
import { Ban, Loader2, Plus } from "lucide-react";
import { useSearch } from "wouter";
import { toast } from "sonner";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { cn } from "@/lib/utils";
import type { FirewallBlockExpiry } from "@shared/firewallCountries";
import { formatDateTime } from "./firewallUi";

/*
  监控 › IP 封禁（#5）：被封的地址连不上任何主机上的规则入口和落地入站端口。
  「在线 IP」那边的封禁按钮跳到 /insights?tab=blocked&block=<ip>，这里读到 block 就直接打开封禁对话框。
*/

const EXPIRY_OPTIONS: { value: FirewallBlockExpiry; label: string }[] = [
  { value: "1h", label: "1 小时" },
  { value: "1d", label: "1 天" },
  { value: "7d", label: "7 天" },
  { value: "forever", label: "永久" },
];

function remainingText(expiresAt: unknown, now: number) {
  if (!expiresAt) return "永久";
  const time = new Date(expiresAt as any).getTime();
  if (!Number.isFinite(time)) return "永久";
  const seconds = Math.max(0, Math.round((time - now) / 1000));
  if (seconds < 60) return "马上到期";
  if (seconds < 3600) return `还剩 ${Math.ceil(seconds / 60)} 分钟`;
  if (seconds < 86400) return `还剩 ${Math.round(seconds / 3600)} 小时`;
  return `还剩 ${Math.round(seconds / 86400)} 天`;
}

/** 读掉地址栏里的 block=…，读完从地址栏去掉（刷新页面不会再弹一次）。 */
function takeBlockParam(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const value = String(params.get("block") || "").trim();
  if (!value) return "";
  params.delete("block");
  const search = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
  return value.slice(0, 64);
}

function BlockDialog({ open, onOpenChange, initialCidr }: { open: boolean; onOpenChange: (open: boolean) => void; initialCidr: string }) {
  const utils = trpc.useUtils();
  const [cidr, setCidr] = useState(initialCidr);
  const [note, setNote] = useState("");
  const [expiry, setExpiry] = useState<FirewallBlockExpiry>("1d");
  useEffect(() => {
    if (open) {
      setCidr(initialCidr);
      setNote("");
      setExpiry("1d");
    }
  }, [open, initialCidr]);
  const block = trpc.ops.firewall.blockIp.useMutation({
    onSuccess: (result) => {
      toast.success(result.created ? `已封禁 ${result.item?.cidr || cidr}，各主机一分钟内生效` : `已更新 ${result.item?.cidr || cidr} 的封禁`);
      void utils.ops.firewall.listBlocked.invalidate();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message || "封禁失败"),
  });
  const submit = () => {
    if (!cidr.trim() || block.isPending) return;
    block.mutate({ cidr: cidr.trim(), note: note.trim(), expiry });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[var(--fx-l0-page)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>封禁 IP</DialogTitle>
          <DialogDescription>这个地址连不上任何主机上的规则和入站端口。已经连着的连接不会被掐断。</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <FormField className="space-y-1.5">
            <Label>IP 或网段</Label>
            <Input
              value={cidr}
              onChange={(event) => setCidr(event.target.value)}
              placeholder="1.2.3.4 或 1.2.3.0/24"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              className="font-mono"
              autoFocus={!initialCidr}
            />
          </FormField>
          <FormField className="space-y-1.5">
            <Label>备注（可不填）</Label>
            <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="例如 扫端口、刷流量" />
          </FormField>
          <div className="space-y-1.5">
            <span className="text-sm font-medium" id="fw-block-expiry">封多久</span>
            <div className={cn(segmentedControlClassName, "flex gap-1")} role="radiogroup" aria-labelledby="fw-block-expiry">
              {EXPIRY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={expiry === option.value}
                  onClick={() => setExpiry(option.value)}
                  className={segmentedOptionClassName(expiry === option.value, false, "h-8 flex-1 px-2 text-[13px]")}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={!cidr.trim() || block.isPending}>
              {block.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              封禁
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 监控 › IP 封禁（#5） */
export default function BlockedIpsTab(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const search = useSearch();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [initialCidr, setInitialCidr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const query = trpc.ops.firewall.listBlocked.useQuery(undefined, { refetchInterval: pollingInterval("slow") });
  const unblock = trpc.ops.firewall.unblockIp.useMutation({
    onSuccess: () => {
      toast.success("已解除封禁");
      void utils.ops.firewall.listBlocked.invalidate();
    },
    onError: (error) => toast.error(error.message || "解除失败"),
  });

  // 「在线 IP」跳过来时带着 block=<ip>：直接打开对话框并填好。
  useEffect(() => {
    const value = takeBlockParam();
    if (value) {
      setInitialCidr(value);
      setDialogOpen(true);
    }
  }, [search]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const openDialog = () => {
    setInitialCidr("");
    setDialogOpen(true);
  };

  const askUnblock = async (item: { id: number; cidr: string }) => {
    const ok = await confirm({
      title: "解除封禁",
      description: `解除后 ${item.cidr} 马上能再连上各主机的端口。`,
      confirmText: "解除封禁",
      tone: "destructive",
    });
    if (ok) unblock.mutate({ id: item.id });
  };

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-3 rounded-[var(--fx-radius-surface)] bg-[var(--fx-l1-surface)] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0 space-y-0.5">
          <p className="text-[13.5px] font-medium">对付滥用用这个；要停一个人，暂停用户。</p>
          <p className="text-[12.5px] text-muted-foreground">
            被封的地址连不上任何主机上的规则入口和落地入站端口，SSH 和内网不受影响。
            {query.data ? ` 今天一共挡掉了 ${query.data.todayBlocked.toLocaleString()} 个连接。` : ""}
          </p>
        </div>
        <Button type="button" className="shrink-0 self-start sm:self-auto" onClick={openDialog}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          封禁 IP
        </Button>
      </section>

      {query.isLoading ? (
        <DataSectionLoading label="正在读取封禁列表" />
      ) : query.error ? (
        <DataSectionError label="封禁列表" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ban className="h-5 w-5" />}
          title="还没有封禁任何 IP"
          description="发现有人扫端口、刷流量，把地址封在这里，所有主机一分钟内生效。"
          actions={<Button type="button" variant="outline" onClick={openDialog}>封禁 IP</Button>}
        />
      ) : (
        <ul className="rounded-[var(--fx-radius-surface)] bg-[var(--fx-l1-surface)] px-3 py-3 sm:px-4" aria-label="封禁列表">
          {items.map((item) => (
            <li key={item.id} className="fx-list-row flex min-w-0 items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate font-mono text-[13.5px] font-medium" title={item.cidr}>{item.cidr}</p>
                <p className="flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                  <span className={cn(item.expiresAt ? "" : "text-foreground")}>{remainingText(item.expiresAt, now)}</span>
                  {item.note ? <span className="min-w-0 break-words">{item.note}</span> : null}
                  {item.createdAt ? <span>封于 {formatDateTime(item.createdAt)}</span> : null}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={unblock.isPending && unblock.variables?.id === item.id}
                onClick={() => void askUnblock(item)}
              >
                解除封禁
              </Button>
            </li>
          ))}
        </ul>
      )}

      <BlockDialog open={dialogOpen} onOpenChange={setDialogOpen} initialCidr={initialCidr} />
    </div>
  );
}
