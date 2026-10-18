import { useMemo } from "react";
import { Check, CircleHelp, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { proxyClientCompatibility, summarizeProxyClientCompatibility } from "@shared/proxyClientCompatibility";
import { PROXY_NODE_PROTOCOL_LABELS, type ProxyNodeProtocol } from "@shared/proxyNode";
import { PROXY_INBOUND_SECURITY_LABELS, type ProxyInboundSecurity } from "@shared/proxyInbound";

/**
 * 代理入站上的客户端兼容（#19）：一张逐家的 ✓ / ✗ / ? 表，✗ 和 ? 都写原因 —— 光说「用不了」没用，
 * 用户要知道是协议、传输还是 REALITY 卡住了，才知道该换客户端还是改入站。
 *
 * 以前行里放一枚「所有客户端 / 8/12 款客户端」小标，点开是这张表；手机上那枚小标（按钮被撑到 44px 高）
 * 把节点名挤得只剩一两个字，用户要求拿掉（2026-10-18）。现在从节点行的 ⋯ 菜单「客户端兼容」打开。
 */
export function InboundCompatibilityDialog({ inbound, onClose }: { inbound: any | null; onClose: () => void }) {
  const open = !!inbound;
  const results = useMemo(
    () => proxyClientCompatibility(inbound || {}),
    [inbound?.protocol, inbound?.transport, inbound?.security, inbound?.flow, inbound?.method, inbound?.snellVersion, inbound?.obfs],
  );
  const summary = useMemo(() => summarizeProxyClientCompatibility(results), [results]);

  const protocolLabel = PROXY_NODE_PROTOCOL_LABELS[inbound?.protocol as ProxyNodeProtocol] || String(inbound?.protocol || "");
  const securityLabel = inbound?.security && inbound.security !== "none"
    ? PROXY_INBOUND_SECURITY_LABELS[inbound.security as ProxyInboundSecurity] || inbound.security
    : "";
  const transportLabel = inbound?.transport && inbound.transport !== "tcp" ? String(inbound.transport) : "";

  return (
    <>
      <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>客户端兼容{inbound?.name ? ` · ${inbound.name}` : ""}</DialogTitle>
            <DialogDescription>
              {[protocolLabel, transportLabel, securityLabel].filter(Boolean).join(" · ")}
              {" —— "}
              {summary.okCount} 款能用
              {summary.noCount > 0 ? `，${summary.noCount} 款用不了` : ""}
              {summary.unknownCount > 0 ? `，${summary.unknownCount} 款没核实` : ""}
            </DialogDescription>
          </DialogHeader>
          <ul className="-mx-1 grid min-h-0 grid-cols-1 gap-1.5 overflow-y-auto px-1 sm:grid-cols-2">
            {results.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 items-start gap-2 rounded-md bg-[var(--fx-l3-control-fill)] px-2.5 py-2"
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                    row.ok === true && "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
                    row.ok === false && "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
                    row.ok === null && "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
                  )}
                  aria-label={row.ok === true ? "能用" : row.ok === false ? "用不了" : "没核实"}
                >
                  {row.ok === true ? <Check className="h-3 w-3" /> : row.ok === false ? <X className="h-3 w-3" /> : <CircleHelp className="h-3 w-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-foreground">{row.label}</span>
                  {row.why ? <span className="block text-[11.5px] leading-4 text-muted-foreground">{row.why}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[11.5px] leading-4 text-muted-foreground">
            按各家手册和面板生成的订阅判断；「没核实」的请以客户端实际为准。
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
