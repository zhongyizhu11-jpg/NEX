import { useEffect, useState } from "react";
import { Activity, Copy, Eye, EyeOff, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { OptimisticSwitch } from "@/components/ui/switch";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { copyTextToClipboard } from "@/lib/clipboard";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import { buildPrometheusScrapeConfig } from "./scrapeConfig";

/**
 * 设置 › 进阶 › 指标导出。
 *
 * 一个开关；开了以后多三行：抓取口令、可以直接抄的 Prometheus 配置、规则明细上限。
 * 口令平时只显示打码后的样子，点「显示」才从服务端取（那一下会进操作审计）；复制出去的配置里是完整口令。
 * 指标有哪些、怎么导入 Grafana 仪表盘在文档里（docs/guide/metrics.md），这里不展开。
 */
export default function MetricsExportSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const stateQuery = trpc.ops.metricsExport.get.useQuery();
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const setState = (next: NonNullable<typeof stateQuery.data>) => utils.ops.metricsExport.get.setData(undefined, next);
  const updateMutation = trpc.ops.metricsExport.update.useMutation({ onSuccess: setState });
  const revealMutation = trpc.ops.metricsExport.revealToken.useMutation();
  const resetMutation = trpc.ops.metricsExport.resetToken.useMutation();
  /** 完整口令：只在点了「显示」、复制或重置之后才有，点「隐藏」就丢掉。 */
  const [token, setToken] = useState<string | null>(null);
  const [maxRules, setMaxRules] = useState("");

  const state = stateQuery.data;
  const savedMaxRules = state?.maxRules;
  useEffect(() => {
    if (savedMaxRules !== undefined) setMaxRules(String(savedMaxRules));
  }, [savedMaxRules]);

  const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
  const panelUrl = (systemSettings?.panelPublicUrl && systemSettings.panelPublicUrl.trim()) || mobileAuth.panelOrigin();

  const toggle = async (enabled: boolean) => {
    await updateMutation.mutateAsync({ enabled });
    if (!enabled) setToken(null);
    toast.success(enabled ? "指标导出已开启" : "指标导出已关闭，/metrics 不再响应");
  };

  const fullToken = async () => token ?? (await revealMutation.mutateAsync()).token;

  const toggleReveal = async () => {
    if (token) {
      setToken(null);
      return;
    }
    try {
      setToken(await fullToken());
    } catch (error) {
      toast.error(errorText(error, "读取口令失败"));
    }
  };

  /** 复制要完整口令：先取、再复制。取完那一刻浏览器不让复制（手机上常见）就把口令亮出来，让人手动选。 */
  const copy = async (build: (value: string) => string, done: string) => {
    try {
      const value = await fullToken();
      if (await copyTextToClipboard(build(value))) {
        toast.success(done);
      } else {
        setToken(value);
        toast.error("没复制成功，口令已经显示出来，可以手动选中复制");
      }
    } catch (error) {
      toast.error(errorText(error, "复制失败"));
    }
  };

  const reset = async () => {
    const confirmed = await confirmDialog({
      title: "重置抓取口令",
      description: "旧口令立刻失效，Prometheus 在换上新口令之前抓不到数据。",
      confirmText: "重置",
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      const next = await resetMutation.mutateAsync();
      const { token: nextToken, ...rest } = next;
      setState(rest);
      setToken(nextToken);
      toast.success("口令已重置，记得把 Prometheus 里的也换掉");
    } catch (error) {
      toast.error(errorText(error, "重置失败"));
    }
  };

  const saveMaxRules = async () => {
    const text = maxRules.trim();
    if (!state || !/^\d+$/.test(text) || Number(text) > state.maxRulesLimit) {
      toast.error(`上限填 0 到 ${state?.maxRulesLimit ?? 2000} 之间的整数`);
      return;
    }
    try {
      const next = await updateMutation.mutateAsync({ maxRules: Number(text) });
      toast.success(next.maxRules > 0 ? `规则不超过 ${next.maxRules} 条时逐条导出` : "只导出汇总，不逐条导出规则");
    } catch (error) {
      toast.error(errorText(error, "保存失败"));
    }
  };

  const path = state?.path ?? "/metrics";
  const shownToken = token ?? state?.tokenMasked ?? "";
  const scrapeConfig = (value: string) => buildPrometheusScrapeConfig({ panelUrl, path, token: value });

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-primary" />
          指标导出
        </CardTitle>
        <CardDescription>把主机、规则和线路的状态以 Prometheus 格式放在 {path}，接进你已有的监控和 Grafana。</CardDescription>
      </CardHeader>
      <CardContent>
        <SettingList>
          <SettingRow
            label="开启指标导出"
            description="开着时带口令才能抓；关着时这个地址回 404。"
            asLabel
            control={(
              <OptimisticSwitch
                aria-label="开启指标导出"
                checked={!!state?.enabled}
                disabled={stateQuery.isLoading || !!stateQuery.error}
                onCheckedChangeAsync={toggle}
                onToggleError={(error) => toast.error(errorText(error, "切换失败"))}
              />
            )}
          />
          {state?.enabled ? (
            <>
              <SettingRow
                label="抓取口令"
                control={(
                  <>
                    <Button variant="outline" size="icon" aria-label={token ? "隐藏口令" : "显示口令"} title={token ? "隐藏口令" : "显示口令"} onClick={toggleReveal} disabled={revealMutation.isPending}>
                      {token ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button variant="outline" size="icon" aria-label="复制口令" title="复制口令" onClick={() => copy((value) => value, "口令已复制")} disabled={revealMutation.isPending}>
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="icon" aria-label="重置口令" title="重置口令" onClick={reset} disabled={resetMutation.isPending}>
                      <RotateCw className={`h-4 w-4 ${resetMutation.isPending ? "animate-spin" : ""}`} />
                    </Button>
                  </>
                )}
              >
                <code className="block break-all rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5">
                  {shownToken || "还没有口令，点右边的重置生成一个"}
                </code>
              </SettingRow>
              <SettingRow
                label="Prometheus 配置"
                description="抄进 prometheus.yml；复制出去的是带完整口令的。"
                control={(
                  <Button variant="outline" size="sm" onClick={() => copy(scrapeConfig, "配置已复制，里面带着完整口令")} disabled={revealMutation.isPending}>
                    <Copy className="h-4 w-4" />
                    复制
                  </Button>
                )}
              >
                <pre className="overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5">{scrapeConfig(shownToken)}</pre>
              </SettingRow>
              <SettingRow
                label="规则明细上限"
                description="规则多于这个数就只导出汇总，不逐条导出；0 = 只导出汇总。"
                control={(
                  <>
                    <Input
                      inputMode="numeric"
                      aria-label="规则明细上限"
                      value={maxRules}
                      onChange={(event) => setMaxRules(event.target.value.replace(/[^\d]/g, ""))}
                      onKeyDown={(event) => { if (event.key === "Enter") void saveMaxRules(); }}
                      className="w-20 tabular-nums"
                    />
                    <Button variant="outline" onClick={saveMaxRules} disabled={updateMutation.isPending || maxRules.trim() === String(savedMaxRules)}>
                      保存
                    </Button>
                  </>
                )}
              />
            </>
          ) : null}
        </SettingList>
      </CardContent>
    </Card>
  );
}
