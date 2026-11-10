import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusDot } from "@/components/network/StatusDot";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  HOST_REPLACE_CATEGORY_LABELS,
  defaultHostReplaceResolution,
  type HostReplaceCategory,
  type HostReplaceResolution,
} from "@shared/hostReplace";
import { AlertTriangle, ArrowRight, Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

/**
 * 主机替换向导（换 VPS）：选新机 → 看会搬什么 → 搬完（能撤回）。
 *
 * 一个对话框三步，不做成单独的页面：这件事一年做几次，做的时候只关心三件事 ——
 * 搬哪台、会不会撞、搬完还要自己弄什么。冲突默认「换一个空闲端口」，能换就换，换不了只能跳过。
 */
type Step = "pick" | "preview" | "done";

export type HostReplaceTarget = { id: number; name?: string | null };

type ExecuteResult = {
  recordId: number;
  counts: Partial<Record<HostReplaceCategory, number>>;
  skipped: string[];
  bridged: number;
  bridgeHours: number;
  maintenanceSet: boolean;
  manual: Array<{ kind: string; label: string; detail: string }>;
};

function Notice({ tone, children }: { tone: "warn" | "danger"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-2.5 text-xs",
        tone === "danger"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

export default function HostReplaceDialog({
  open,
  onOpenChange,
  host,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: HostReplaceTarget | null;
}) {
  const oldHostId = Number(host?.id || 0);
  const [step, setStep] = useState<Step>("pick");
  const [newHostId, setNewHostId] = useState<number | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, HostReplaceResolution>>({});
  const [bridge, setBridge] = useState(true);
  const [maintenance, setMaintenance] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const confirmDialog = useConfirmDialog();
  const utils = trpc.useUtils();

  // 弹窗是复用的：每次打开都从第一步开始，别把上一台的选择带过来。
  useEffect(() => {
    if (!open) return;
    setStep("pick");
    setNewHostId(null);
    setResolutions({});
    setBridge(true);
    setMaintenance(false);
    setResult(null);
  }, [open, oldHostId]);

  const candidates = trpc.hostReplace.candidates.useQuery({ oldHostId }, { enabled: open && oldHostId > 0, refetchOnWindowFocus: false });
  const records = trpc.hostReplace.records.useQuery({ hostId: oldHostId }, { enabled: open && oldHostId > 0 && step === "pick", refetchOnWindowFocus: false });
  const preview = trpc.hostReplace.preview.useQuery(
    { oldHostId, newHostId: Number(newHostId || 0) },
    { enabled: open && step === "preview" && !!newHostId, refetchOnWindowFocus: false, retry: false },
  );
  const data = preview.data;

  // 每拿到一份新预览，冲突的处理回到默认（重新预览后建议端口可能变了）。
  useEffect(() => {
    if (!data) return;
    setResolutions(Object.fromEntries(data.conflicts.map((conflict) => [conflict.key, defaultHostReplaceResolution(conflict)])));
  }, [data]);

  const afterWrite = () => Promise.all([
    utils.hosts.invalidate(),
    utils.rules.invalidate(),
    utils.tunnels.invalidate(),
    utils.forwardGroups.invalidate(),
    utils.hostReplace.invalidate(),
  ]);

  const execute = trpc.hostReplace.execute.useMutation({
    onSuccess: (value) => {
      setResult(value as ExecuteResult);
      setStep("done");
      void afterWrite();
    },
    onError: (error) => {
      toast.error(error.message || "替换失败");
      // 指纹对不上（预览之后有人改过）：直接重新预览。
      if (error.data?.code === "CONFLICT") void preview.refetch();
    },
  });
  const undo = trpc.hostReplace.undo.useMutation({
    onSuccess: (value) => {
      if (value.report.length > 0) toast.warning(`撤回了 ${value.reverted} 项；${value.report.length} 项之后被改过或端口被占，没动`);
      else toast.success("已撤回，引用都改回了旧机");
      void afterWrite();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message || "撤回失败"),
  });

  const newHost = useMemo(() => candidates.data?.find((item) => item.id === newHostId) || null, [candidates.data, newHostId]);
  const lastUndoable = (records.data || []).find((row) => row.status === "done" && row.oldHostId === oldHostId) || null;
  const totalItems = data ? data.items.length : 0;
  const busy = execute.isPending || undo.isPending;

  const runUndo = async (recordId: number) => {
    const ok = await confirmDialog({
      title: "撤回这次替换",
      description: "把这次改到新机上的规则、隧道、组成员、线路改回旧机。之后又被改过的项不会动。",
      confirmText: "撤回",
      tone: "destructive",
    });
    if (ok) undo.mutate({ recordId });
  };

  const runExecute = () => {
    if (!data || !newHostId) return;
    const resolutionInput = Object.fromEntries(data.conflicts.map((conflict) => {
      const action = resolutions[conflict.key] || defaultHostReplaceResolution(conflict);
      return [conflict.key, { action, port: action === "newPort" ? conflict.suggestedPort : null }];
    }));
    execute.mutate({ oldHostId, newHostId, fingerprint: data.fingerprint, resolutions: resolutionInput, bridge, maintenance });
  };

  const oldName = host?.name || `主机 #${oldHostId}`;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>替换到另一台主机</DialogTitle>
          <DialogDescription>
            {step === "pick" && `把「${oldName}」上的规则、隧道、组成员、线路整体搬到新机。旧机保留，可以撤回。`}
            {step === "preview" && (newHost ? `${oldName} → ${newHost.name}` : "")}
            {step === "done" && "搬完了。下面是要你自己处理的。"}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" && (
          <div className="space-y-3">
            <SectionTitle>新机（要先接入面板、在线）</SectionTitle>
            <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-0.5" role="radiogroup" aria-label="选新机">
              {candidates.isLoading && <p className="py-4 text-center text-xs text-muted-foreground">正在读主机列表…</p>}
              {(candidates.data || []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={newHostId === item.id}
                  disabled={!item.online}
                  onClick={() => setNewHostId(item.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    newHostId === item.id ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/40",
                    !item.online && "cursor-not-allowed opacity-50",
                  )}
                >
                  <StatusDot health={item.online ? "healthy" : "down"} label={item.online ? "在线" : "离线"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.address || "没有地址"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{!item.online ? "离线" : item.maintenance ? "维护中" : ""}</span>
                  {newHostId === item.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              ))}
              {candidates.data && candidates.data.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">没有别的主机，先接入新机</p>}
            </div>
            {lastUndoable && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
                <span className="min-w-0 truncate text-muted-foreground">
                  上次换到「{lastUndoable.newHostName}」（{new Date(lastUndoable.createdAt * 1000).toLocaleString()}）
                </span>
                <Button size="sm" variant="ghost" className="h-7 shrink-0" disabled={busy} onClick={() => void runUndo(lastUndoable.id)}>
                  撤回
                </Button>
              </div>
            )}
          </div>
        )}

        {step === "preview" && (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-0.5">
            {preview.isLoading && (
              <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />正在清点旧机上的东西…
              </p>
            )}
            {preview.error && <Notice tone="danger">{preview.error.message}</Notice>}
            {data && (
              <>
                {data.blockers.map((text) => <Notice key={text} tone="danger">{text}</Notice>)}
                {totalItems === 0 && data.blockers.length === 0 && <p className="text-xs text-muted-foreground">旧机上没有能自动搬的东西。</p>}
                {data.categories.length > 0 && (
                  <div className="divide-y divide-border/50 rounded-lg border border-border/60">
                    {data.categories.map((item) => (
                      <div key={item.category} className="flex items-start gap-3 px-3 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm">{HOST_REPLACE_CATEGORY_LABELS[item.category]}</span>
                          <span className="block text-xs text-muted-foreground">{item.note}</span>
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">{item.count}</span>
                      </div>
                    ))}
                  </div>
                )}

                {data.conflicts.length > 0 && (
                  <div className="space-y-1.5">
                    <SectionTitle>冲突（{data.conflicts.length}）</SectionTitle>
                    {data.conflicts.map((conflict) => {
                      const value = resolutions[conflict.key] || defaultHostReplaceResolution(conflict);
                      return (
                        <div key={conflict.key} className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2">
                          <p className="text-sm">{conflict.label}</p>
                          <p className="text-xs text-muted-foreground">{conflict.detail}</p>
                          {conflict.options.includes("newPort") ? (
                          <SegmentedControl
                            ariaLabel={`${conflict.label}怎么处理`}
                            value={value}
                            onChange={(next) => setResolutions((current) => ({ ...current, [conflict.key]: next }))}
                            listClassName="grid grid-cols-2 gap-1"
                            options={[
                              { value: "newPort", label: `换成 ${conflict.suggestedPort}` },
                              { value: "skip", label: "这一项不搬" },
                            ]}
                          />
                          ) : (
                            <p className="text-xs font-medium text-foreground">这一项不搬，留在旧机上</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {data.warnings.map((text) => <Notice key={text} tone="warn">{text}</Notice>)}

                {data.manual.length > 0 && (
                  <div className="space-y-1">
                    <SectionTitle>不会自动搬，要你自己处理</SectionTitle>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {data.manual.map((item, index) => (
                        <li key={`${item.kind}-${index}`}><span className="text-foreground">{item.label}</span>：{item.detail}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                  {data.bridgeHours > 0 && (
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox className="mt-0.5" checked={bridge} onCheckedChange={setBridge} disabled={busy} />
                      <span>
                        旧地址先转到新机 {data.bridgeHours} 小时
                        <span className="block text-xs text-muted-foreground">连旧 IP 的客户端不会马上断（旧机得还能用）</span>
                      </span>
                    </label>
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox className="mt-0.5" checked={maintenance} onCheckedChange={setMaintenance} disabled={busy} />
                    <span>
                      搬完把旧机设为维护
                      <span className="block text-xs text-muted-foreground">不再被线路和转发组选用；撤回时一起取消</span>
                    </span>
                  </label>
                </div>
              </>
            )}
          </div>
        )}

        {step === "done" && result && (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-0.5">
            <div className="divide-y divide-border/50 rounded-lg border border-border/60">
              {(Object.entries(result.counts) as Array<[HostReplaceCategory, number]>).map(([category, count]) => (
                <div key={category} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" />{HOST_REPLACE_CATEGORY_LABELS[category]}</span>
                  <span className="tabular-nums">{count}</span>
                </div>
              ))}
              {Object.keys(result.counts).length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">没有搬任何东西</p>}
            </div>
            {result.bridged > 0 && (
              <p className="text-xs text-muted-foreground">旧机上 {result.bridged} 个老端口会先转到新机 {result.bridgeHours} 小时。</p>
            )}
            {result.maintenanceSet && <p className="text-xs text-muted-foreground">旧机已设为维护。</p>}
            {result.skipped.length > 0 && (
              <div className="space-y-1">
                <SectionTitle>没搬的（{result.skipped.length}）</SectionTitle>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {result.skipped.map((text) => <li key={text}>{text}</li>)}
                </ul>
              </div>
            )}
            {result.manual.length > 0 && (
              <div className="space-y-1">
                <SectionTitle>还要你自己处理</SectionTitle>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {result.manual.map((item, index) => (
                    <li key={`${item.kind}-${index}`}><span className="text-foreground">{item.label}</span>：{item.detail}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">替换记录保留 30 天，这期间可以从旧机的菜单里撤回。</p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {step === "pick" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button disabled={!newHostId} onClick={() => setStep("preview")}>
                看看会搬什么<ArrowRight className="h-4 w-4" />
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setStep("pick")}>上一步</Button>
              <Button disabled={busy || !data || data.blockers.length > 0 || totalItems === 0} onClick={runExecute}>
                {execute.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                开始替换
              </Button>
            </>
          )}
          {step === "done" && result && (
            <>
              <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => void runUndo(result.recordId)}>
                撤回这次替换
              </Button>
              <Button onClick={() => onOpenChange(false)}>完成</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
