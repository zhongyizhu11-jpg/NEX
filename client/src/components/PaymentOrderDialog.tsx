import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { paymentPollOutcome, pendingPaymentOrderFrom, type PaymentOrderLike, type PendingPaymentOrder } from "@/lib/paymentOrder";
import { trpc } from "@/lib/trpc";
import { ExternalLink, RefreshCw, WalletCards } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const POLL_INTERVAL_MS = 3000;

/**
 * 在线支付下单之后的那一步：有二维码就渲染二维码（微信 Native / 支付宝当面付），
 * 有支付链接就新标签页打开，并在弹窗里留一个能点的链接 —— 浏览器拦掉弹窗时用户还有路可走。
 * 等待期间轮询订单状态，付完自动关掉并通知调用方刷新数据。
 */
export function usePaymentOrderDialog(options: { onPaid?: () => void } = {}) {
  const [order, setOrder] = useState<PendingPaymentOrder | null>(null);

  /** 下单成功后调用；返回 false 表示这一单既没二维码也没链接（不需要用户继续操作）。 */
  const launch = useCallback((created: PaymentOrderLike | null | undefined) => {
    const pending = pendingPaymentOrderFrom(created);
    if (!pending) return false;
    if (!pending.qrCode && pending.payUrl) {
      window.open(pending.payUrl, "_blank", "noopener,noreferrer");
    }
    setOrder(pending);
    return true;
  }, []);

  const dialog = (
    <PaymentOrderDialog order={order} onClose={() => setOrder(null)} onPaid={options.onPaid} />
  );
  return { order, launch, close: () => setOrder(null), dialog };
}

function PaymentOrderDialog({
  order,
  onClose,
  onPaid,
}: {
  order: PendingPaymentOrder | null;
  onClose: () => void;
  onPaid?: () => void;
}) {
  const utils = trpc.useUtils();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const onPaidRef = useRef(onPaid);
  const onCloseRef = useRef(onClose);
  onPaidRef.current = onPaid;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!order?.qrCode) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(order.qrCode, { width: 220, margin: 1, color: { dark: "#000", light: "#fff" } })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [order?.qrCode]);

  // 等待期间轮询订单状态，完成后自动关闭对话框
  const outTradeNo = order?.outTradeNo;
  useEffect(() => {
    if (!outTradeNo) return;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await utils.client.payment.queryOrder.query({ outTradeNo });
        if (stopped) return;
        const outcome = paymentPollOutcome(result?.status);
        if (outcome === "paid") {
          stopped = true;
          onCloseRef.current();
          toast.success("已支付");
          onPaidRef.current?.();
        } else if (outcome === "closed") {
          stopped = true;
          onCloseRef.current();
          toast.error("订单已失效，请重新下单");
        }
      } catch {
        // 轮询失败静默忽略，继续等待
      }
    };
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [outTradeNo, utils]);

  const hasQr = !!order?.qrCode;
  return (
    <Dialog open={!!order} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WalletCards className="h-5 w-5" />
            {hasQr ? "扫码支付" : "完成支付"}
          </DialogTitle>
          <DialogDescription>
            {order?.subject
              ? `支付 ${order.subject}`
              : hasQr ? "请使用支付宝或微信扫码完成支付" : "已在新标签页打开支付页面"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col items-center gap-4 py-2">
          {hasQr && (
            <>
              {qrDataUrl ? (
                <div className="rounded-lg border border-border/40 bg-white p-3 shadow-sm">
                  <img src={qrDataUrl} alt="支付二维码" width={220} height={220} />
                </div>
              ) : (
                <div className="flex h-[220px] w-[220px] items-center justify-center rounded-lg border border-border/40">
                  <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
              <p className="text-sm text-muted-foreground">请使用支付宝 / 微信扫描二维码</p>
            </>
          )}
          {order?.payUrl && (
            <div className="w-full min-w-0 rounded-lg border bg-background/70 p-3">
              <div className="mb-2 text-sm text-muted-foreground">
                {hasQr ? "也可以打开支付页面完成支付" : "如果支付页面没有自动打开（可能被浏览器拦截），请点击下方按钮"}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <code className="min-w-0 truncate text-xs" title={order.payUrl}>{order.payUrl}</code>
                <Button asChild variant="outline" size="sm">
                  <a href={order.payUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    打开支付页
                  </a>
                </Button>
              </div>
            </div>
          )}
          <div className="flex w-full items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span>正在等待支付结果，付款后将自动更新……</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{hasQr ? "取消" : "关闭"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
