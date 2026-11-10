import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { MAX_PRODUCT_STOCK, productStock, productStockText, type ProductStockInput } from "@shared/productStock";

/*
  套餐和按量计费资源的库存展示。管理页、商店两边用同一套组件，「还剩多少 / 是否售罄」
  的判断都来自 shared/productStock —— 和服务端拦下单用的是同一个函数。
*/

/**
 * 商店卡片上的库存徽标：售罄 → 「已售罄」，限量 → 「剩余 N」，不限 → 「库存 ∞」。
 *
 * `held`：查看者自己已经占着一份（按量资源）。这时即使别人看到的是售罄，对他也不构成限制，
 * 写「已售罄」会让他以为自己的规则要出问题，所以改写成「已占用」。
 */
export function ProductStockBadge({
  product,
  held = false,
  className,
}: {
  product: ProductStockInput;
  held?: boolean;
  className?: string;
}) {
  const stock = productStock(product);
  if (held) return <Badge variant="outline" tone="up" className={className}>已占用</Badge>;
  if (stock.soldOut) return <Badge variant="destructive" className={className}>已售罄</Badge>;
  if (stock.unlimited) return <Badge variant="secondary" className={className} title="库存不限">库存 ∞</Badge>;
  return <Badge variant="outline" className={className}>剩余 {stock.remaining}</Badge>;
}

/**
 * 管理页上的一句话库存：「已售 3 · 剩余 7」「已售 3 · 剩余 ∞」，卖完了后面跟一个「已售罄」。
 * 按量资源的占用单位是账号，不是销量，所以前半句的说法由调用方给（`usedLabel`）。
 */
export function ProductStockSummary({
  product,
  usedLabel = "已售",
  className,
}: {
  product: ProductStockInput;
  usedLabel?: string;
  className?: string;
}) {
  const stock = productStock(product);
  return (
    <span className={cn("inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 tabular-nums", className)}>
      <span>{usedLabel} {stock.used} · 剩余 {productStockText(product)}</span>
      {stock.soldOut ? <Badge variant="destructive" size="sm">已售罄</Badge> : null}
    </span>
  );
}

/** 「库存总量」/「每账号规则上限」这类输入：非负整数，0 = 不限。 */
export function ProductStockField({
  label,
  value,
  onChange,
  help,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help: string;
  className?: string;
}) {
  return (
    <FormField className={cn("space-y-2", className)}>
      <Label>{label}</Label>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_PRODUCT_STOCK}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0 为不限"
      />
      <p data-fx-help="" className="text-xs text-muted-foreground">{help}</p>
    </FormField>
  );
}

/** 表单里的字符串 → 提交给服务端的非负整数（空、负数、非数字都按 0 = 不限）。 */
export function parseProductStockInput(value: string) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(MAX_PRODUCT_STOCK, number);
}
