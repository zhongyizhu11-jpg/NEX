import { useMemo, useState } from "react";
import { Copy, Loader2, Stethoscope } from "lucide-react";
import { toast } from "sonner";

import { LinkDiagnosticsChecklist } from "@/components/LinkDiagnosticsPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { copyTextToClipboard } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { formatDiagnosticsReportText, type LinkDiagnosticsReport } from "@shared/linkDiagnostics";

/*
  网络测试页的「配置体检」（server/networkConfigCheck.ts）：对着当前选中的测试主机，或这台主机上的一条规则，
  把面板里已有的状态过一遍，给出「通过 / 警告 / 失败」的清单和处理建议。

  只读：不发探测、不改配置，所以随时可以点。清单的样子和规则卡上「诊断 → 一键诊断」是同一个组件
  （LinkDiagnosticsChecklist）；一键诊断还会到主机上实测端口和目标，体检不做，规则体检时会提示去那边。
*/

const HOST_SCOPE = "host";

function portText(rule: { sourcePort: number; sourcePortEnd: number | null }) {
  return rule.sourcePortEnd && rule.sourcePortEnd > rule.sourcePort ? `${rule.sourcePort}-${rule.sourcePortEnd}` : String(rule.sourcePort);
}

export function NetworkConfigCheckPanel({ hostId, hostName }: { hostId: number; hostName: string }) {
  const [scope, setScope] = useState(HOST_SCOPE);
  const [scopeHostId, setScopeHostId] = useState(hostId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // 换了测试主机，选中的规则就不是这台的了：回到「整台主机」。
  if (scopeHostId !== hostId) {
    setScopeHostId(hostId);
    setScope(HOST_SCOPE);
  }
  const ruleId = scope.startsWith("rule:") ? Number(scope.slice(5)) : 0;

  const rules = trpc.lookingGlass.configCheckRules.useQuery(
    { hostId },
    { enabled: hostId > 0, staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
  );
  // 按钮触发才查；查询键里带着主机 / 规则，切换后不会把上一台的结果当成这一台的。
  const check = trpc.lookingGlass.configCheck.useQuery(
    ruleId > 0 ? { ruleId } : { hostId },
    { enabled: false, retry: false, refetchOnWindowFocus: false },
  );
  const report = check.data?.report as LinkDiagnosticsReport | undefined;
  const copyText = useMemo(() => (report ? formatDiagnosticsReportText(report, { title: "NEX 配置体检" }) : ""), [report]);

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Stethoscope className="h-5 w-5 text-primary" aria-hidden="true" />
          配置体检
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          检查主机的 Agent、版本、资源，以及规则的开关、运行状态和端口冲突，逐项给出处理建议。只读面板里已有的状态，不发探测、不改任何配置。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="network-config-check-scope">检查对象</Label>
            <Select value={scope} onValueChange={(value) => { setScope(value); setExpanded(new Set()); }}>
              <SelectTrigger id="network-config-check-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HOST_SCOPE}>
                  <span>整台主机</span>
                  {hostName ? <span className="text-muted-foreground"> · {hostName}</span> : null}
                </SelectItem>
                {(rules.data || []).map((rule) => (
                  <SelectItem key={rule.id} value={`rule:${rule.id}`}>
                    <span>{rule.name}</span>
                    {rule.sourcePort ? <span className="font-mono text-muted-foreground"> :{portText(rule)}</span> : null}
                    {!rule.isEnabled ? <span className="text-muted-foreground"> · <span>已停用</span></span> : !rule.isRunning ? <span className="text-[var(--fx-warn-text)]"> · <span>没在运行</span></span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button className="gap-1.5" disabled={check.isFetching} onClick={() => void check.refetch()}>
              {check.isFetching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Stethoscope className="h-4 w-4" aria-hidden="true" />}
              {check.isFetching ? "检查中…" : report ? "重新体检" : "开始体检"}
            </Button>
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={!report}
              onClick={async () => {
                if (await copyTextToClipboard(copyText)) toast.success("体检结果已复制");
                else toast.error("复制失败，请手动选中复制");
              }}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              复制结果
            </Button>
          </div>
        </div>

        {check.error && !check.isFetching ? (
          <p role="alert" className="text-sm text-[var(--fx-down-text)]">{check.error.message}</p>
        ) : null}

        {report ? (
          <>
            <LinkDiagnosticsChecklist
              report={report}
              expandedKeys={expanded}
              onToggle={(key) => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}
            />
            {(check.data?.pendingAgentChecks || 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                还有 {check.data?.pendingAgentChecks} 项要到主机上实测（端口有没有在听、防火墙、目标拨不拨得通），体检不做：到规则列表点这条规则的「诊断」→「一键诊断」。
              </p>
            )}
          </>
        ) : !check.error && !check.isFetching ? (
          <p className="text-xs text-muted-foreground">选好检查对象后点「开始体检」。</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
