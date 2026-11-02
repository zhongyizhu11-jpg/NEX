import type { ReactNode } from "react";

/**
 * 窄屏上「标签 + 值」的一行，四个页面原来各存一份一样的实现
 * （账单、套餐管理、流量计费配置、支付对接）。
 *
 * 左列固定 4.75rem 是为了让同一张卡里的几行标签左右对齐；值那一列
 * `min-w-0` + `break-words` 是关键 —— 少了它，一个长 token 或长域名会把整行
 * 撑出屏幕，手机上就变成横向滚动。
 */
function MobileInfoRow({
  label,
  children,
  valueClassName = "",
}: {
  label: string;
  children: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid grid-cols-[4.75rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className={`min-w-0 text-right break-words ${valueClassName}`}>{children}</div>
    </div>
  );
}

export default MobileInfoRow;
