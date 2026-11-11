import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { billingCalendarParts } from "../shared/billingTime";
import { buildXlsx, type XlsxCellValue, type XlsxSheet } from "./xlsxWriter";

/*
  账单流水 Excel 导出（上游 2.3.286）：管理员可导出全部或指定用户，普通用户只能导出自己的。

  一份文件三张表，和页面上看到的对得上：
    · 账单流水：余额流水 + 支付订单 + 套餐记录合在一起（账单页 / 钱包页「账单」那一栏的口径）；
    · 余额流水：每一笔余额变动和变动后的余额；
    · 支付订单：在线支付的订单（含没付款的）。

  看谁的只在这里按登录的人定：普通用户传什么 userId 都按自己算（和 billing.ledgerPage 一样），
  不让「改一下请求参数」导出别人的账。
*/

/** 一次导出的上限（三张表里最大的那张是账单流水，它的行数 = 另外两张 + 套餐记录）。 */
export const BILLING_EXPORT_MAX_ROWS = 50_000;

type Viewer = { id: number; role: string };

export type BillingExportInput = {
  viewer: Viewer;
  /** 管理员要导出的用户；不传 = 全部用户。普通用户传了也不认。 */
  userId?: number | null;
  includeCancelledSubscriptions?: boolean;
};

type Row = Record<string, unknown>;

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function userLabel(row: Row) {
  const username = String(row?.username || "").trim();
  const name = String(row?.name || "").trim();
  if (username && name && name !== username) return `${name}（${username}）`;
  return name || username || (row?.userId ? `#${row.userId}` : "-");
}

const cents = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : null;
};

const time = (value: unknown): XlsxCellValue => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : null;
};

function fileStamp(now: Date) {
  const p = billingCalendarParts(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

export async function resolveBillingExportScope(input: BillingExportInput) {
  const isAdmin = input.viewer.role === "admin";
  const targetUserId = isAdmin ? (input.userId ? Number(input.userId) : undefined) : Number(input.viewer.id);
  if (!isAdmin && !(targetUserId && targetUserId > 0)) throw new TRPCError({ code: "FORBIDDEN", message: "无权导出账单" });
  return { isAdmin, targetUserId };
}

export async function buildBillingExport(input: BillingExportInput, now = new Date()) {
  const { isAdmin, targetUserId } = await resolveBillingExportScope(input);
  const includeCancelledSubscriptions = input.includeCancelledSubscriptions !== false;
  if (isAdmin && targetUserId !== undefined && !(await db.getUserById(targetUserId))) {
    throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
  }
  const counts = await db.countBillingExportRows({ targetUserId, isAdmin, includeCancelledSubscriptions });
  if (counts.ledger > BILLING_EXPORT_MAX_ROWS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: isAdmin && targetUserId === undefined
        ? `要导出的账单记录有 ${counts.ledger} 条，超过单次导出上限 ${BILLING_EXPORT_MAX_ROWS} 条，请选择一个用户分开导出`
        : `要导出的账单记录有 ${counts.ledger} 条，超过单次导出上限 ${BILLING_EXPORT_MAX_ROWS} 条，请联系管理员处理`,
    });
  }
  const data = await db.listBillingExportData({
    targetUserId,
    isAdmin,
    includeCancelledSubscriptions,
    limit: BILLING_EXPORT_MAX_ROWS,
  });

  const sheets: XlsxSheet[] = [
    {
      name: "账单流水",
      columns: [
        { header: "时间", type: "datetime", width: 20 },
        { header: "用户", width: 18 },
        { header: "类别", width: 12 },
        { header: "项目", width: 30 },
        { header: "说明", width: 34 },
        { header: "金额", type: "money", width: 12 },
        { header: "币种", width: 8 },
        { header: "变动后余额", type: "money", width: 13 },
        { header: "状态", width: 10 },
        { header: "关联订单号", width: 26 },
      ],
      rows: (data.ledger as Row[]).map((item) => [
        time(item.createdAt),
        userLabel(item),
        text(item.category),
        text(item.title),
        item.description === "-" ? "" : text(item.description),
        cents(item.amountCents),
        text(item.currency) || "CNY",
        item.kind === "balance" ? cents(item.balanceAfterCents) : null,
        text(item.statusLabel),
        text(item.paymentOrderNo),
      ]),
    },
    {
      name: "余额流水",
      columns: [
        { header: "时间", type: "datetime", width: 20 },
        { header: "用户", width: 18 },
        { header: "类型", width: 14 },
        { header: "金额", type: "money", width: 12 },
        { header: "变动后余额", type: "money", width: 13 },
        { header: "说明", width: 40 },
        { header: "关联订单号", width: 26 },
        { header: "操作人 ID", type: "integer", width: 10 },
      ],
      rows: (data.transactions as Row[]).map((tx) => [
        time(tx.createdAt),
        userLabel(tx),
        text(tx.typeLabel),
        cents(tx.amountCents),
        cents(tx.balanceAfterCents),
        text(tx.description),
        text(tx.paymentOrderNo),
        tx.operatorUserId ? Number(tx.operatorUserId) : null,
      ]),
    },
    {
      name: "支付订单",
      columns: [
        { header: "创建时间", type: "datetime", width: 20 },
        { header: "支付时间", type: "datetime", width: 20 },
        { header: "用户", width: 18 },
        { header: "订单号", width: 26 },
        { header: "类型", width: 10 },
        { header: "标题", width: 30 },
        { header: "渠道", width: 10 },
        { header: "支付方式", width: 10 },
        { header: "金额", type: "money", width: 12 },
        { header: "币种", width: 8 },
        { header: "优惠金额", type: "money", width: 11 },
        { header: "状态", width: 10 },
        { header: "网关流水号", width: 28 },
      ],
      rows: (data.orders as Row[]).map((order) => [
        time(order.createdAt),
        time(order.paidAt),
        userLabel(order),
        text(order.outTradeNo),
        text(order.orderTypeLabel),
        text(order.subject),
        text(order.provider),
        text(order.paymentType),
        cents(order.amountCents),
        text(order.currency) || "CNY",
        Number(order.discountAmountCents || 0) > 0 ? cents(order.discountAmountCents) : null,
        text(order.statusLabel),
        text(order.tradeNo),
      ]),
    },
  ];
  const who = targetUserId === undefined ? "all" : `user${targetUserId}`;
  return {
    filename: `billing-${who}-${fileStamp(now)}.xlsx`,
    buffer: buildXlsx(sheets, { now }),
    counts: { ledger: data.ledger.length, balance: data.transactions.length, payment: data.orders.length },
  };
}
