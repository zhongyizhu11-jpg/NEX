import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";

/**
 * 主机管理 ··· 菜单里的「全部重启」（#15）。
 *
 * 菜单项一点，菜单就关了、这个组件也跟着卸载 —— 所以后面的确认、下发、等结果都不挂在
 * 组件状态上：确认框是全局的（useConfirmDialog），请求走 utils.client（不依赖组件还在），
 * 进度用同一条 toast 原地更新。
 *
 * 服务端：trpc.ops.hostOps.restartAllPreview / restartAll / restartAllStatus。
 */

const POLL_MS = 2_000;
const MAX_WAIT_MS = 4 * 60 * 1000;

export default function RestartAllMenuItem(_props: Record<string, never>) {
  const confirm = useConfirmDialog();
  const utils = trpc.useUtils();

  const run = async () => {
    let preview;
    try {
      preview = await utils.client.ops.hostOps.restartAllPreview.query();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读不到主机列表");
      return;
    }
    if (preview.targets.length === 0) {
      toast.info("没有可以重启的在线主机", {
        description: preview.skipped.length > 0 ? `跳过 ${preview.skipped.length} 台：离线或 Agent 太旧（需要 2.2.216）` : undefined,
      });
      return;
    }
    const skippedText = preview.skipped.slice(0, 6).map((item) => `${item.name}（${item.reason}）`).join("、");
    const ok = await confirm({
      title: "全部重启",
      tone: "destructive",
      confirmText: `重启 ${preview.targets.length} 台`,
      description: (
        <div className="flex flex-col gap-1.5 text-left">
          <p>
            {preview.targets.length} 台在线主机上，面板管理的所有转发进程（realm、gost、socat、nginx、FXP 隧道……）各重启一次。
          </p>
          <p>正在连着的人会断开几秒，客户端会自己重连。</p>
          {preview.skipped.length > 0 ? (
            <p>
              跳过 {preview.skipped.length} 台：{skippedText}
              {preview.skipped.length > 6 ? " 等" : ""}。Agent 要 2.2.216 以上、并且在线。
            </p>
          ) : null}
        </div>
      ),
    });
    if (!ok) return;

    let requestId: string;
    try {
      requestId = (await utils.client.ops.hostOps.restartAll.mutate()).requestId;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下发失败");
      return;
    }
    const toastId = toast.loading(`正在重启 ${preview.targets.length} 台主机上的转发…`);
    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      try {
        const status = await utils.client.ops.hostOps.restartAllStatus.query({ requestId });
        if (status.finished) {
          const hasProblem = status.results.some((item) => item.status !== "done" || item.failed.length > 0);
          (hasProblem ? toast.warning : toast.success)(status.summary, { id: toastId, duration: 10_000 });
          return;
        }
        toast.loading(status.summary, { id: toastId });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "查不到进度", { id: toastId });
        return;
      }
    }
    toast.warning("等了 4 分钟还有主机没回应，结果可以在「监控 › 事件」里看", { id: toastId });
  };

  return (
    <DropdownMenuItem onSelect={() => void run()}>
      <RotateCcw className="h-4 w-4" />全部重启
    </DropdownMenuItem>
  );
}
