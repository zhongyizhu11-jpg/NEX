import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { isAgentVersionAtLeast } from "@shared/version";
import { Section } from "@/components/hosts/HostDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";

/**
 * 主机详情「导入现有配置」（#16）。
 *
 * 装面板之前手搓的 realm / gost / socat / iptables / nftables 转发，扫出来勾选后建成规则。
 * 规则先建成停用的（原来的服务还占着端口），再一条条「停掉原服务并启用规则」：Agent 停掉
 * 那一项（停用 systemd 单元，或删掉那一条 DNAT），面板随即启用规则。没勾的一律不碰。
 *
 * 服务端：trpc.ops.hostOps.scan / scanResult / importItems / stopOriginal / stopStatus。
 */

const PROTOCOL_LABEL: Record<string, string> = { tcp: "TCP", udp: "UDP", both: "TCP+UDP" };

type StopTrack = { actionId: string };

function StopProgress({ hostId, actionId, onDone }: { hostId: number; actionId: string; onDone: (ok: boolean) => void }) {
  const query = trpc.ops.hostOps.stopStatus.useQuery(
    { hostId, actionId },
    { refetchInterval: (q) => (q.state.data && q.state.data.status !== "pending" ? false : pollingInterval("interactive")), retry: false },
  );
  const stop = query.data;
  useEffect(() => {
    if (!stop || stop.status === "pending") return;
    if (stop.ok && stop.ruleEnabled) toast.success(`${stop.message || "已停掉原服务"}，规则已启用`);
    else if (stop.ok) toast.warning(`原服务已停，但规则没能启用：${stop.enableError || "未知原因"}`);
    else toast.error(stop.error || "没能停掉原服务");
    onDone(!!stop.ok && !!stop.ruleEnabled);
    // 只在状态从 pending 变成结果的那一下提示一次。
  }, [stop?.status]);
  if (query.isError) return <span className="text-meta text-[var(--fx-warn-text)]">{query.error.message}</span>;
  return <span className="text-meta text-muted-foreground">正在停掉原服务…</span>;
}

export default function ImportExistingSection({ host }: { host: any }) {
  const hostId = Number(host?.id || 0);
  const confirm = useConfirmDialog();
  const [scanId, setScanId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stopping, setStopping] = useState<Record<string, StopTrack>>({});
  const [switched, setSwitched] = useState<Set<string>>(new Set());

  // 换了一台主机就从头来。
  useEffect(() => {
    setScanId(null);
    setSelected(new Set());
    setStopping({});
    setSwitched(new Set());
  }, [hostId]);

  const result = trpc.ops.hostOps.scanResult.useQuery(
    { hostId, scanId: scanId || "" },
    {
      enabled: !!scanId,
      retry: false,
      refetchInterval: (q) => (q.state.data && q.state.data.status !== "pending" ? false : pollingInterval("interactive")),
    },
  );

  const scan = trpc.ops.hostOps.scan.useMutation({
    onSuccess: (data) => {
      setSelected(new Set());
      setScanId(data.scanId);
    },
    onError: (error) => toast.error(error.message || "扫描失败"),
  });

  const importItems = trpc.ops.hostOps.importItems.useMutation({
    onSuccess: (data) => {
      const failed = data.results.filter((item) => !item.ok);
      if (failed.length === 0) toast.success(`已导入 ${data.imported} 条规则（先停用）`);
      else toast.warning(`导入 ${data.imported} 条，${failed.length} 条没成功：${failed[0].error || "未知原因"}`);
      setSelected(new Set());
      void result.refetch();
    },
    onError: (error) => toast.error(error.message || "导入失败"),
  });

  const stopOriginal = trpc.ops.hostOps.stopOriginal.useMutation({
    onError: (error) => toast.error(error.message || "下发失败"),
  });

  const items = result.data?.items || [];
  const forwards = useMemo(() => items.filter((item) => item.listenPort || item.importable), [items]);
  const detected = useMemo(() => items.filter((item) => !item.listenPort && !item.importable), [items]);

  if (!hostId) return null;
  const supported = isAgentVersionAtLeast(String(host?.agentVersion || ""), "2.2.216");
  if (!supported) {
    return (
      <Section title="导入现有配置">
        <p className="text-meta text-muted-foreground">需要把 Agent 升级到 2.2.216</p>
      </Section>
    );
  }

  const scanning = scan.isPending || result.data?.status === "pending" || (!!scanId && result.isLoading);
  const toggle = (key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const onStop = async (item: (typeof items)[number]) => {
    const what = item.unit ? `停用并禁用服务 ${item.unit}` : `删掉 ${item.tool} 里这条 ${item.listenPort} 端口的转发`;
    const ok = await confirm({
      title: "停掉原服务并启用规则",
      tone: "destructive",
      confirmText: "停掉并启用",
      description: (
        <div className="flex flex-col gap-1.5 text-left">
          <p>Agent 会{what}，随后面板启用导入的规则。中间会断开几秒。</p>
          {item.sharedWith > 0 ? (
            <p>这个服务里还有另外 {item.sharedWith} 条转发，会一起停掉 —— 记得把它们也导入。</p>
          ) : null}
        </div>
      ),
    });
    if (!ok || !scanId) return;
    try {
      const { actionId } = await stopOriginal.mutateAsync({ hostId, scanId, key: item.key });
      setStopping((prev) => ({ ...prev, [item.key]: { actionId } }));
    } catch {
      // onError 已经提示过
    }
  };

  const selectable = forwards.filter((item) => item.canImport);

  return (
    <Section title="导入现有配置">
      <p className="text-meta text-muted-foreground">
        找出这台机器上不是面板配的转发（realm、gost、socat、iptables、nftables），勾选后建成规则。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={scanning || !host?.isOnline} onClick={() => scan.mutate({ hostId })}>
          {scanning ? "正在扫描…" : scanId ? "重新扫描" : "扫描这台机器"}
        </Button>
        {!host?.isOnline ? <span className="text-meta text-muted-foreground">主机离线，扫描不了</span> : null}
      </div>

      {result.isError ? <p className="text-meta text-[var(--fx-warn-text)]">{result.error.message}</p> : null}
      {result.data?.status === "timeout" ? (
        <p className="text-meta text-[var(--fx-warn-text)]">Agent 一直没回结果，请稍后重新扫描</p>
      ) : null}

      {result.data?.status === "done" ? (
        forwards.length === 0 && detected.length === 0 ? (
          <p className="text-meta text-muted-foreground">没找到面板以外的转发</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {forwards.map((item) => {
              const stopTrack = stopping[item.key];
              const done = switched.has(item.key);
              return (
                <div key={item.key} className="flex min-w-0 items-start gap-2.5 rounded-md border border-[var(--fx-stroke-weak)] px-2.5 py-2">
                  <div className="pt-0.5">
                    <Checkbox
                      aria-label={`选择 ${item.tool} ${item.listenPort}`}
                      checked={selected.has(item.key)}
                      disabled={!item.canImport || importItems.isPending}
                      onCheckedChange={(checked) => toggle(item.key, checked)}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{item.tool}</Badge>
                      <span className="min-w-0 break-all text-secondary-type tabular-nums text-foreground">
                        {PROTOCOL_LABEL[item.protocol || ""] || ""} :{item.listenPort ?? "?"} → {item.target || "—"}
                      </span>
                    </div>
                    <span className="min-w-0 break-all text-meta text-muted-foreground">
                      {item.unit ? `服务 ${item.unit}${item.unitActive ? "（运行中）" : "（没在跑）"}` : item.source}
                    </span>
                    {item.blockedReason || item.reason ? (
                      <span className="text-meta text-muted-foreground">{item.blockedReason || item.reason}</span>
                    ) : null}
                    {item.note ? <span className="text-meta text-muted-foreground">{item.note}</span> : null}
                    {item.importedRuleId ? (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        {done ? (
                          <Badge className="border-transparent bg-[var(--fx-healthy-soft)] bg-none text-[var(--fx-healthy-text)]">已切到面板规则</Badge>
                        ) : (
                          <Badge variant="secondary">已导入（停用中）</Badge>
                        )}
                        {!done && stopTrack ? (
                          <StopProgress
                            hostId={hostId}
                            actionId={stopTrack.actionId}
                            onDone={(ok) => {
                              setStopping((prev) => {
                                const next = { ...prev };
                                delete next[item.key];
                                return next;
                              });
                              if (ok) setSwitched((prev) => new Set(prev).add(item.key));
                            }}
                          />
                        ) : null}
                        {!done && !stopTrack && item.canStop ? (
                          <Button size="sm" variant="outline" className="h-7" disabled={stopOriginal.isPending} onClick={() => void onStop(item)}>
                            停掉原服务并启用规则
                          </Button>
                        ) : null}
                        {!done && !item.canStop ? (
                          <span className="text-meta text-muted-foreground">没找到启动它的服务：手动停掉原进程后，到规则列表里启用</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {detected.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-1 pt-1">
                <span className="text-meta font-medium text-muted-foreground">检测到但不能导入</span>
                {detected.map((item) => (
                  <span key={item.key} className="min-w-0 break-all text-meta text-muted-foreground">
                    {item.tool} · {item.source}
                    {item.reason && item.reason !== "检测到但不能导入" ? ` · ${item.reason}` : ""}
                  </span>
                ))}
              </div>
            ) : null}

            {selectable.length > 0 ? (
              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={importItems.isPending}
                  onClick={() => setSelected(selected.size === selectable.length ? new Set() : new Set(selectable.map((item) => item.key)))}
                >
                  {selected.size === selectable.length ? "全不选" : "全选"}
                </Button>
                <Button
                  size="sm"
                  disabled={selected.size === 0 || importItems.isPending || !scanId}
                  onClick={() => scanId && importItems.mutate({ hostId, scanId, keys: Array.from(selected) })}
                >
                  {importItems.isPending ? "导入中…" : `导入为规则（${selected.size}）`}
                </Button>
              </div>
            ) : null}
            {selectable.length > 0 ? (
              <p className="text-meta text-muted-foreground">导入的规则先是停用的；原来的服务还占着端口，逐条点「停掉原服务并启用规则」切过来。</p>
            ) : null}
          </div>
        )
      ) : null}
    </Section>
  );
}
