import { executeRaw, quoteDbIdentifier } from "../dbRuntime";
import { applyShopSyncEvent, saveShopSyncConfig } from "./service";

/**
 * 开发面板的商城对接演示（只在 FORWARDX_DEV_PANEL=1 时由 server/devPanel.ts 调）：
 * 打开对接、配两条映射，再走真实流程灌几条回调 —— 新购、续费、重复回调、没映射、乱序，
 * 设置页的「最近同步」才有东西可看。
 */
export async function seedShopSyncDevData(input: { starterPlanId: number; proPlanId: number }) {
  const q = quoteDbIdentifier;
  await executeRaw(`DELETE FROM ${q("shop_sync_orders")}`);
  await executeRaw(`DELETE FROM ${q("shop_sync_users")}`);
  await saveShopSyncConfig({
    enabled: true,
    shop: "xboard",
    linkExistingByEmail: false,
    plans: [{ shopPlanId: "1", planId: input.starterPlanId }, { shopPlanId: "2", planId: input.proPlanId }],
  });
  const now = Math.floor(Date.now() / 1000);
  const events = [
    { action: "open", orderId: "2026111000001", user: { externalId: "1001", email: "mei@shop.example" }, shopPlanId: "1", occurredAt: now - 7200 },
    { action: "open", orderId: "2026111000002", user: { externalId: "1002", email: "kai@shop.example" }, shopPlanId: "2", occurredAt: now - 5400 },
    { action: "renew", orderId: "2026111000003", user: { externalId: "1001" }, shopPlanId: "1", durationDays: 30, occurredAt: now - 3600 },
    { action: "open", orderId: "2026111000004", user: { externalId: "1003", email: "lin@shop.example" }, shopPlanId: "5", occurredAt: now - 1800 },
    { action: "stop", orderId: "refund-2026111000005", user: { externalId: "1004", email: "yu@shop.example" }, occurredAt: now - 600 },
    { action: "open", orderId: "2026111000005", user: { externalId: "1004", email: "yu@shop.example" }, shopPlanId: "1", occurredAt: now - 900 },
  ] as const;
  for (const event of events) {
    await applyShopSyncEvent({ ...event, user: { ...event.user } }).catch((error) => {
      console.warn(`[DevPanel] shop sync demo ${event.orderId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
