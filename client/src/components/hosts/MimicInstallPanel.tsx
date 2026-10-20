import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { isAgentVersionAtLeast } from "@shared/version";
import {
  buildMimicManualCommands,
  mimicFailureReason,
  mimicFailureReasonText,
  normalizeMimicDownloadProxy,
} from "@shared/mimicAssets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyTextFromElement } from "@/lib/clipboard";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  主机的 mimic UDP 混淆环境：现在什么状态、一键安装 / 修复（2.3.439，Agent 2.2.223 起）。

  主机详情里一节、隧道编辑开了 mimic 时按参与的主机各一行（compact）。以前面板只会说
  「请手动安装 mimic/mimic-dkms」，现在点一下：面板给这台主机排任务，Agent 下一次心跳取走
  在机器上跑安装脚本，这里每 3 秒拉一次进度。安装状态在面板内存里留 30 分钟，刷新页面还在。

  2.3.443：文字收到最少——能用时只有「就绪 · 版本」和「重新安装」，以前的失败记录不再挂着；
  失败时一行原因（下载不到 / 缺头文件 / 编译失败），下面「代理安装」「手动安装」「日志」按需展开。
  国内机连不上 GitHub：面板会替它转发安装包（哈希钉死），还不行就填个代理或复制手动命令。
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

const PROXY_STORAGE_KEY = "nex.mimicInstallProxy";

function readSavedProxy() {
  try {
    return window.localStorage.getItem(PROXY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveProxy(value: string) {
  try {
    if (value) window.localStorage.setItem(PROXY_STORAGE_KEY, value);
    else window.localStorage.removeItem(PROXY_STORAGE_KEY);
  } catch {
    // 无痕模式等：不记也行
  }
}

function CommandBlock({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta text-muted-foreground">{label}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
          onClick={async () => {
            const ok = await copyTextFromElement(ref.current, text);
            if (ok) toast.success("已复制");
            else toast.error("复制失败，手动选中复制");
          }}
        >
          <Copy className="h-3 w-3" aria-hidden="true" />复制
        </button>
      </div>
      <pre ref={ref} className="mt-0.5 overflow-x-auto whitespace-pre rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-foreground/80">{text}</pre>
    </div>
  );
}

type Section = "" | "log" | "proxy" | "manual";

export default function MimicInstallPanel({ host, canManage, compact = false }: { host: MimicHost; canManage: boolean; compact?: boolean }) {
  const utils = trpc.useUtils();
  const hostId = Number(host.id);
  const [watching, setWatching] = useState(false);
  const [section, setSection] = useState<Section>("");
  const [proxy, setProxy] = useState(() => readSavedProxy());
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
      setSection("log");
      void statusQuery.refetch();
    },
    onError: (error) => toast.error(error.message || "没能排上安装任务"),
  });

  const status = mimicStatusText(host);
  const ready = host.mimicAvailable === true;
  const agentSupported = isAgentVersionAtLeast(host.agentVersion, MIMIC_INSTALL_AGENT_VERSION);
  const mode = modeFor(host);
  const buttonLabel = ready ? "重新安装" : mode === "repair" ? "修复 mimic" : "安装 mimic";
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

  // 已经能用了，上次失败的记录就别再摆出来（手动装好以后页面还挂着「上次安装失败」一大段）
  const failed = !!task && !active && task.status !== "success";
  const showFailure = failed && !ready;
  const showSuccess = !!task && task.status === "success" && !active;
  const failureText = showFailure
    ? task!.status === "timeout"
      ? task!.error || "安装超时"
      : mimicFailureReasonText(mimicFailureReason(task!.error, task!.output))
    : "";

  const logLines = String(task?.output || "").split("\n").filter(Boolean);
  const logTail = compact ? logLines.slice(-12) : logLines.slice(-60);
  const showLogLink = logLines.length > 0 && (active || showFailure || showSuccess);
  const showHelpLinks = canManage && !ready && !active;

  // App 里页面在 capacitor://localhost，要用登录时填的面板地址，否则命令指向 localhost
  const panelUrl = mobileAuth.panelOrigin();
  const commands = useMemo(() => buildMimicManualCommands({ panelUrl, proxy }), [panelUrl, proxy]);
  const normalizedProxy = normalizeMimicDownloadProxy(proxy);

  const toggle = (next: Section) => setSection((current) => (current === next ? "" : next));
  const startInstall = (withProxy: boolean) => {
    if (withProxy) {
      if (!normalizedProxy) {
        toast.error("代理地址格式：socks5h://IP:端口 或 http://IP:端口");
        return;
      }
      saveProxy(normalizedProxy);
    }
    install.mutate({ hostIds: [hostId], mode, proxy: withProxy ? normalizedProxy || "" : "" });
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", compact && "text-xs")}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 truncate">
          {compact ? <span className="mr-1.5 font-medium text-foreground">{String(host.name || `主机 ${hostId}`)}</span> : null}
          <span className={cn("text-secondary-type", toneClass)} title={status.detail}>{status.label}</span>
          {showSuccess && ready ? <span className="ml-2 text-meta text-[var(--fx-healthy-text)]">已装好</span> : null}
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant={ready ? "outline" : "default"}
            className="h-7 shrink-0 px-2.5 text-xs"
            disabled={active || install.isPending || !!disabledReason}
            title={disabledReason || undefined}
            onClick={() => startInstall(false)}
          >
            {active ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />{taskStatusText(task!.status)}</> : buttonLabel}
          </Button>
        ) : null}
      </div>
      {!compact && disabledReason && canManage && !ready ? <p className="text-meta text-muted-foreground">{disabledReason}</p> : null}
      {showFailure ? <p className="text-meta text-[var(--fx-warn-text)]">{failureText}</p> : null}
      {showLogLink || showHelpLinks ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
          {showHelpLinks && !disabledReason ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => toggle("proxy")}>代理安装</button>
          ) : null}
          {showHelpLinks ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => toggle("manual")}>手动安装</button>
          ) : null}
          {showLogLink ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => toggle("log")}>
              {section === "log" ? "收起日志" : "日志"}
            </button>
          ) : null}
        </div>
      ) : null}
      {section === "proxy" && showHelpLinks && !disabledReason ? (
        <div className="flex min-w-0 items-center gap-2">
          <Input
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="socks5h://127.0.0.1:1080"
            className="h-7 min-w-0 flex-1 text-xs"
            aria-label="下载代理"
          />
          <Button type="button" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={install.isPending} onClick={() => startInstall(true)}>
            用代理安装
          </Button>
        </div>
      ) : null}
      {section === "manual" && showHelpLinks ? (
        <div className="space-y-1.5">
          {commands.panel ? <CommandBlock label="经面板下载（推荐）" text={commands.panel} /> : null}
          <CommandBlock label="直接从 GitHub（Debian / Ubuntu）" text={commands.github} />
        </div>
      ) : null}
      {section === "log" && logLines.length > 0 ? (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-foreground/80">{logTail.join("\n")}</pre>
      ) : null}
    </div>
  );
}

/** 隧道编辑里：开了 mimic 时参与链路的每台主机一行。 */
export function MimicHostsStatus({ hosts, canManage }: { hosts: MimicHost[]; canManage: boolean }) {
  if (hosts.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-border/50 bg-background/60 px-3 py-2">
      <p data-fx-help="" className="text-xs text-muted-foreground">参与链路的主机都要有 mimic 环境；缺的可以在这里直接装，装完保存即可。</p>
      {hosts.map((host) => (
        <MimicInstallPanel key={host.id} host={host} canManage={canManage} compact />
      ))}
    </div>
  );
}
