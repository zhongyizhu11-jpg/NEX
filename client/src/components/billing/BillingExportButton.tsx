import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { downloadBase64File } from "@/lib/fileDownload";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 「导出 Excel」按钮：账单页（管理员，按当前选的用户或全部）和钱包页（自己）共用。
 * 导出谁的最终由服务端按登录的人决定（billing.exportXlsx），这里传的 userId 只对管理员有效。
 */
export function BillingExportButton({
  userId,
  includeCancelledSubscriptions = true,
  label = "导出 Excel",
}: {
  userId?: number | null;
  includeCancelledSubscriptions?: boolean;
  label?: string;
}) {
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    try {
      const input = { userId: userId ?? null, includeCancelledSubscriptions };
      const exported = await utils.billing.exportXlsx.fetch(input, { staleTime: 0 });
      // 文件内容不留在查询缓存里：几 MB 的 base64 没必要一直占着内存。
      utils.billing.exportXlsx.reset(input).catch(() => undefined);
      downloadBase64File(exported.filename, exported.dataBase64, XLSX_MIME);
      toast.success(`已导出：账单流水 ${exported.counts.ledger} 条、余额流水 ${exported.counts.balance} 条、支付订单 ${exported.counts.payment} 条`);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "导出失败，请稍后重试");
    } finally {
      setExporting(false);
    }
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={handleExport} disabled={exporting}>
      {exporting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}
