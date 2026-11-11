import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatMoneyCents } from "@shared/formatMoney";
import {
  HOST_COST_CURRENCIES,
  HOST_COST_MAX_CENTS,
  hostCycleLabel,
  hostMonthlyCostCents,
  normalizeHostBandwidthBilling,
  normalizeHostCostCents,
  normalizeHostCostCurrency,
  type HostBandwidthBilling,
  type HostCostCurrency,
} from "@shared/hostLedger";

/*
  主机编辑框「其他配置」里的费用（主机账本用，shared/hostLedger.ts）。

  默认收起：大多数时候人打开编辑框是来改别的，费用填一次就不动了。收起时那一行写着填了什么
  （「¥90.00 / 季 · 每月 ¥30.00」），不用点开也知道填没填。
  金额按「每期」填 —— 机房账单上写的就是一期多少钱，让人自己除以 3 是给人找错的机会。
*/

export type HostCostForm = {
  /** 每期费用，按元输入（可带两位小数）；空 = 没填。 */
  amount: string;
  currency: HostCostCurrency;
  bandwidthBilling: HostBandwidthBilling;
  /** 95 单价，元 / Mbps / 月。 */
  p95Price: string;
};

export const defaultHostCostForm: HostCostForm = { amount: "", currency: "CNY", bandwidthBilling: "fixed", p95Price: "" };

const CURRENCY_LABELS: Record<HostCostCurrency, string> = {
  CNY: "人民币",
  USD: "美元",
  EUR: "欧元",
  HKD: "港币",
  JPY: "日元",
  GBP: "英镑",
};

function centsToInput(value: unknown) {
  const cents = normalizeHostCostCents(value);
  if (cents <= 0) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function hostCostFormFrom(host: Record<string, unknown> | null | undefined): HostCostForm {
  return {
    amount: centsToInput(host?.costCents),
    currency: normalizeHostCostCurrency(host?.costCurrency),
    bandwidthBilling: normalizeHostBandwidthBilling(host?.bandwidthBilling),
    p95Price: centsToInput(host?.p95PriceCents),
  };
}

/** "90" / "90.5" / "" → 分；格式不对返回 null。 */
function parseMoneyInput(text: string): number | null {
  const value = text.trim();
  if (!value) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const cents = Math.round(Number(value) * 100);
  return cents <= HOST_COST_MAX_CENTS ? cents : null;
}

/** 表单 → hosts.create / update 的那四个字段；填错了返回错误文案。 */
export function hostCostPayload(form: HostCostForm):
  | { costCents: number; costCurrency: HostCostCurrency; bandwidthBilling: HostBandwidthBilling; p95PriceCents: number }
  | { error: string } {
  const costCents = parseMoneyInput(form.amount);
  if (costCents === null) return { error: "每期费用填一个金额，最多两位小数" };
  const p95PriceCents = form.bandwidthBilling === "p95" ? parseMoneyInput(form.p95Price) : 0;
  if (p95PriceCents === null) return { error: "95 单价填一个金额，最多两位小数" };
  return { costCents, costCurrency: form.currency, bandwidthBilling: form.bandwidthBilling, p95PriceCents };
}

function summaryText(form: HostCostForm, cycleMonths: number) {
  const cents = parseMoneyInput(form.amount);
  const parts: string[] = [];
  if (cents && cents > 0) {
    const cycle = hostCycleLabel(cycleMonths);
    parts.push(`${formatMoneyCents(cents, form.currency)} / ${cycle}`);
    if (cycleMonths > 1) parts.push(`每月 ${formatMoneyCents(Math.round(hostMonthlyCostCents(cents, cycleMonths)), form.currency)}`);
  }
  if (form.bandwidthBilling === "p95") parts.push("按 95 值计费");
  return parts.length > 0 ? parts.join(" · ") : "没填";
}

const inputGroupClass = "flex h-8 min-w-0 overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring";
const inputClass = "h-8 min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 py-1 focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0";
const suffixClass = "flex h-full shrink-0 items-center border-l border-border/60 bg-muted/50 px-2.5 text-sm text-muted-foreground";

export function HostCostFields({
  value,
  cycleMonths,
  onChange,
  className,
  defaultOpen = false,
}: {
  value: HostCostForm;
  /** 表单里当前选的账单周期：「每期」是每多少个月。 */
  cycleMonths: number;
  onChange: (next: HostCostForm) => void;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const cycle = hostCycleLabel(cycleMonths);
  return (
    <div className={cn("min-w-0 rounded-md border border-border/50", className)} data-testid="host-cost-fields">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="shrink-0 text-sm font-medium">费用</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summaryText(value, cycleMonths)}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="grid min-w-0 gap-2.5 border-t border-border/40 px-3 pb-3 pt-2.5 md:grid-cols-2">
          <FormField className="min-w-0 space-y-1">
            <Label className="text-sm">每期费用</Label>
            <div className="flex min-w-0 gap-2">
              <div className={cn(inputGroupClass, "flex-1")}>
                <Input
                  className={inputClass}
                  type="text"
                  inputMode="decimal"
                  placeholder="例如: 90"
                  aria-label="每期费用"
                  value={value.amount}
                  onChange={(event) => onChange({ ...value, amount: event.target.value })}
                />
                <span className={suffixClass}>/ {cycle}</span>
              </div>
              <Select value={value.currency} onValueChange={(next) => onChange({ ...value, currency: normalizeHostCostCurrency(next) })}>
                <SelectTrigger aria-label="币种" className="h-8 w-24 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOST_COST_CURRENCIES.map((currency) => (
                    <SelectItem key={currency} value={currency}>{CURRENCY_LABELS[currency]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FormField>
          <FormField className="min-w-0 space-y-1">
            <Label className="text-sm">带宽计费</Label>
            <Select value={value.bandwidthBilling} onValueChange={(next) => onChange({ ...value, bandwidthBilling: normalizeHostBandwidthBilling(next) })}>
              <SelectTrigger className="h-8 min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">只有固定费用</SelectItem>
                <SelectItem value="p95">另按 95 值计费</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {value.bandwidthBilling === "p95" ? (
            <FormField className="min-w-0 space-y-1 md:col-span-2">
              <Label className="text-sm">95 单价</Label>
              <div className={inputGroupClass}>
                <Input
                  className={inputClass}
                  type="text"
                  inputMode="decimal"
                  placeholder="例如: 3"
                  aria-label="95 单价"
                  value={value.p95Price}
                  onChange={(event) => onChange({ ...value, p95Price: event.target.value })}
                />
                <span className={suffixClass}>/ Mbps / 月</span>
              </div>
              <p data-fx-help="" className="text-xs text-muted-foreground">
                开了之后面板每 5 分钟记一次这台的网卡速率，按账单日切月算 95 值，账本里看估算。
              </p>
            </FormField>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
