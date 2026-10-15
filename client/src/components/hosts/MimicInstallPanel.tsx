import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { isAgentVersionAtLeast } from "@shared/version";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  主机的 mimic UDP 混淆环境：现在什么状态、一键安装 / 修复（2.3.439，Agent 2.2.223 起）。

  主机详情里一节、隧道编辑开了 mimic 时按参与的主机各一行（compact）。以前面板只会说
  「请手动安装 mimic/mimic-dkms」，现在点一下：面板给这台主机排任务，Agent 下一次心跳取走
  在机器上跑安装脚本，这里每 3 秒拉一次进度，装完把输出尾巴和重新检测的结果摆出来。
  安装状态在面板内存里留 30 分钟，刷新页面还在。
*/

export const MIMIC_INSTALL_AGENT_VERSION = "2.2.223";

type MimicHost = {
  id: number;
  name?: string | null;
  isOnline?: boolean | null;
  agentVersion?: string | null;
  mimicAvailable?: boolean | null;
  mimicStatus?: string | null;
  mimicVersion?: string | null;
  mimicMessage?: string | null;
};

export function mimicStatusText(host: MimicHost): { label: string; tone: "ok" | "warn" | "muted"; detail?: string } {
  if (host.mimicAvailable === true) {
    return { label: host.mimicVersion ? `就绪 · v${String(host.mimicVersion).replace(/^v/, "")}` : "就绪", tone: "ok" };
  }
  const status = String(host.mimicStatus || "").trim();
  const detail = String(host.mimicMessage || "").trim() || undefined;
  switch (status) {
    case "command-missing":
      return { label: "未安装", tone: "warn", detail };
    case "kernel-module-missing":
      return { label: "内核模块缺失（多半是内核升级后没重编）", tone: "warn", detail };
    case "kernel-module-load-failed":
      return { label: "内核模块加载失败", tone: "warn", detail };
    case "command-unusable":
      return { label: "mimic 命令不能用", tone: "warn", detail };
    case "unsupported-os":
      return { label: "系统不支持", tone: "muted", detail };
    case "module-check-unavailable":
      return { label: "无法检测内核模块", tone: "warn", detail };
    case "":
      return { label: "未检测（Agent 旧或还没上报）", tone: "muted" };
    default:
      return { label: "不可用", tone: "warn", detail };
  }
}

function modeFor(host: MimicHost): "install" | "repair" {
  const status = String(host.mimicStatus || "");
  // 已经能用时按钮是「重新安装」：发 repair，安装脚本才会跳过「已经装好」直接重装包
  if (host.mimicAvailable === true) return "repair";
  if (status === "kernel-module-missing" || status === "kernel-module-load-failed" || status === "command-unusable") return "repair";
  return "install";
}

function taskStatusText(status: string) {
  switch (status) {
    case "queued": return "等待 Agent 取走";
    case "running": return "安装中";
    case "success": return "完成";
    case "error": return "失败";
    case "timeout": return "超时";
    default: return status;
  }
}

export default function MimicInstallPanel({ host, canManage, compact = false }: { host: MimicHost; canManage: boolean; compact?: boolean }) {
  const utils = trpc.useUtils();
  const hostId = Number(host.id);
  const [watching, setWatching] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const statusQuery = trpc.hosts.mimicInstallStatus.useQuery({ hostIds: [hostId] }, {
    enabled: canManage && hostId > 0,
    refetchInterval: watching ? 3000 : 30_000,
    refetchOnWindowFocus: false,
  });
  const task = useMemo(() => (statusQuery.data || []).find((item) => Number(item.hostId) === hostId) || null, [statusQuery.data, hostId]);
  const active = !!task && (task.status === "queued" || task.status === "running");
  useEffect(() => {
    if (active && !watching) setWatching(true);
    if (!active && watching) {
      setWatching(false);
      // 装完了主机上报的 mimic 状态会变，让列表和详情拿到新值
      void utils.hosts.list.invalidate();
      void utils.hosts.options.invalidate();
    }
  }, [active, watching, utils]);

  const install = trpc.hosts.installMimic.useMutation({
    onSuccess: (data) => {
      const mine = data.results.find((item) => Number(item.hostId) === hostId);
      if (mine && !mine.ok) {
        toast.error(mine.error || "没能排上安装任务");
        return;
      }
      setWatching(true);
      setShowLog(true);
      void statusQuery.refetch();
    },
    onError: (error) => toast.error(error.message || "没能排上安装任务"),
  });

  const status = mimicStatusText(host);
  const agentSupported = isAgentVersionAtLeast(host.agentVersion, MIMIC_INSTALL_AGENT_VERSION);
  const mode = modeFor(host);
  const buttonLabel = host.mimicAvailable === true ? "重新安装" : mode === "repair" ? "修复 mimic" : "安装 mimic";
  const disabledReason = !host.isOnline
    ? "主机离线"
    : !agentSupported
      ? `Agent 升到 ${MIMIC_INSTALL_AGENT_VERSION} 以上才能一键安装`
      : status.tone === "muted" && String(host.mimicStatus || "") === "unsupported-os"
        ? "这台机器的系统不支持 mimic"
        : "";

  const toneClass = status.tone === "ok"
    ? "text-[var(--fx-healthy-text)]"
    : status.tone === "warn"
      ? "text-[var(--fx-warn-text)]"
      : "text-muted-foreground";

  const logLines = String(task?.output || "").split("\n").filter(Boolean);
  const logTail = compact ? logLines.slice(-8) : logLines.slice(-40);

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", compact && "text-xs")}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          {compact ? <span className="mr-1.5 font-medium text-foreground">{String(host.name || `主机 ${hostId}`)}</span> : null}
          <span className={cn("text-secondary-type", toneClass)} title={status.detail}>{status.label}</span>
          {task && !active ? (
            <span className={cn("ml-2 text-meta", task.status === "success" ? "text-[var(--fx-healthy-text)]" : "text-[var(--fx-warn-text)]")}>
              上次{task.mode === "repair" ? "修复" : "安装"}{taskStatusText(task.status)}
            </span>
          ) : null}
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant={host.mimicAvailable === true ? "outline" : "default"}
            className="h-7 shrink-0 px-2.5 text-xs"
            disabled={active || install.isPending || !!disabledReason}
            title={disabledReason || undefined}
            onClick={() => install.mutate({ hostIds: [hostId], mode })}
          >
            {active ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />{taskStatusText(task!.status)}</> : buttonLabel}
          </Button>
        ) : null}
      </div>
      {!compact && status.detail ? <p className="text-meta text-muted-foreground">{status.detail}</p> : null}
      {!compact && disabledReason && canManage ? <p className="text-meta text-muted-foreground">{disabledReason}</p> : null}
      {task ? (
        <div className="min-w-0">
          {task.error ? <p className="text-meta text-[var(--fx-warn-text)]">{task.error}</p> : null}
          {task.environment && !active ? (
            <p className="text-meta text-muted-foreground">
              重新检测：{task.environment.available ? `就绪${task.environment.version ? ` · v${task.environment.version}` : ""}` : task.environment.message || task.environment.status}
            </p>
          ) : null}
          {logLines.length > 0 ? (
            <>
              <button type="button" className="text-meta text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowLog((value) => !value)}>
                {showLog ? "收起日志" : `查看日志（${logLines.length} 行）`}
              </button>
              {showLog ? (
                <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-foreground/80">{logTail.join("\n")}</pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 隧道编辑里：开了 mimic 时参与链路的每台主机一行。 */
export function MimicHostsStatus({ hosts, canManage }: { hosts: MimicHost[]; canManage: boolean }) {
  if (hosts.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-border/50 bg-background/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">参与链路的主机都要有 mimic 环境；缺的可以在这里直接装，装完保存即可。</p>
      {hosts.map((host) => (
        <MimicInstallPanel key={host.id} host={host} canManage={canManage} compact />
      ))}
    </div>
  );
}
