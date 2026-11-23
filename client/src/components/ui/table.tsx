import * as React from "react"
import { cn } from "@/lib/utils"

/*
  表格照参考站（Vexo / New API 模型广场的表格视图）：14px、等宽数字、无斑马纹；表头 40px 灰字
  500、透明底；行 60px、1px 行线、悬停极淡灰；标签是彩色文字不是彩底 chip。行高、表头底色、
  标签样式在 workspace.css 里按 data-slot 统一给，页面自己不再各写一套。
*/

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto"><table data-slot="table" ref={ref} className={cn("w-full caption-bottom text-[14px] leading-5 tabular-nums", className)} {...props} /></div>
))
Table.displayName = "Table"

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <thead data-slot="table-header" ref={ref} className={cn("[&_tr]:border-b [&_tr]:border-[var(--fx-stroke-weak)]", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)} {...props} />
))
TableFooter.displayName = "TableFooter"

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn("border-b border-[var(--fx-stroke-weak)] transition-colors hover:bg-[color-mix(in_srgb,var(--fx-l2-group)_60%,transparent)] data-[state=selected]:bg-[var(--fx-l2-group)]", className)} {...props} />
))
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (
  <th data-slot="table-head" ref={ref} className={cn("h-10 whitespace-nowrap px-3 text-left align-middle text-[14px] font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0", className)} {...props} />
))
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (
  <td data-slot="table-cell" ref={ref} className={cn("px-3 py-2 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
))
TableCaption.displayName = "TableCaption"

export { Table, TableHeader, TableBody,  TableHead, TableRow, TableCell,  }
