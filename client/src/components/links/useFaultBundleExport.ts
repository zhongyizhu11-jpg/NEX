import { useState } from "react";
import { toast } from "sonner";
import { downloadTextFile } from "@/lib/fileDownload";
import { trpc } from "@/lib/trpc";

export type FaultBundleKind = "rule" | "tunnel" | "forwardGroup";

/**
 * 「导出故障包」（server/faultBundle.ts）：把这条规则 / 隧道 / 转发组的诊断结论、脱敏配置、
 * 沿线主机状态和最近的事件打成一个 JSON 下载，交给技术支持或 AI 分析。只读，不打扰主机。
 */
export function useFaultBundleExport() {
  const utils = trpc.useUtils();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const exportBundle = async (kind: FaultBundleKind, id: number) => {
    const key = `${kind}:${id}`;
    if (pendingKey) return;
    setPendingKey(key);
    try {
      const result = await utils.diagnostics.faultBundle.fetch({ kind, id }, { staleTime: 0 });
      downloadTextFile(result.filename, JSON.stringify(result.bundle, null, 2), "application/json;charset=utf-8");
      toast.success("故障包已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出故障包失败");
    } finally {
      setPendingKey(null);
    }
  };
  return { exportBundle, pending: pendingKey !== null };
}
