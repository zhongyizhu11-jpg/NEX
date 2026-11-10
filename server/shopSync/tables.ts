import { col, type TableDef } from "../ops/tableDefs";

/*
  商城对接的两张表（设置 › 进阶 › 商城对接，逻辑在 server/shopSync/service.ts）。

  shop_sync_users：商城用户 ↔ NEX 用户的绑定，一个商城用户一行。
    externalUserId：商城那边的用户 id，绑定只认它 —— 商城里改了邮箱不会换绑，用户自己在 NEX 里也改不了。
    localUserId：绑到的 NEX 用户；先收到停用、还没开通过的商城用户这里是空（只记一条停用时间，挡迟到的开通）。
    createdByShop：这个 NEX 账号是不是对接时新建的。只有新建的才把订阅地址回给商城；
      认领来的老账号不回 —— 万一认领错了人，至少不会把别人的订阅地址交出去。
    subscriptionId：对接开出来、现在由商城管着的那条 user_subscriptions；只动这一条，
      用户在 NEX 里自己买的、管理员手动给的都不碰。
    activatedAt / stoppedAt：最近一次生效的开通 / 停用发生在商城的什么时间，判乱序用（shared/shopSync.ts）。
  shop_sync_orders：每一次回调一行，orderId 唯一 —— 这就是幂等键：同一个订单号再来，原样回上次的结果，不会再开一次。
    status：processing / applied / ignored / unmapped / failed；后两种允许同一个订单号重试。
    设置里「最近同步」就是按 updatedAt 倒序读这张表。

  两张都要跟着备份迁移走：丢了绑定，商城下次来会再建一个用户；丢了订单记录，重发的续费会再叠一次。
*/
export const shopSyncTables: TableDef[] = [
  {
    name: "shop_sync_users",
    columns: [
      col("id", "id"),
      col("externalUserId", "varchar", { length: 128, notNull: true }),
      col("email", "varchar", { length: 255 }),
      col("localUserId", "int"),
      col("createdByShop", "int", { notNull: true, default: 0 }),
      col("subscriptionId", "int"),
      col("shopPlanId", "varchar", { length: 64 }),
      col("status", "varchar", { length: 16, notNull: true, default: "active" }),
      col("activatedAt", "epoch"),
      col("stoppedAt", "epoch"),
      col("lastOrderId", "varchar", { length: 128 }),
      col("lastError", "text"),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["externalUserId"], ["localUserId"]],
  },
  {
    name: "shop_sync_orders",
    columns: [
      col("id", "id"),
      col("orderId", "varchar", { length: 128, notNull: true }),
      col("externalUserId", "varchar", { length: 128, notNull: true }),
      col("email", "varchar", { length: 255 }),
      col("action", "varchar", { length: 16, notNull: true }),
      col("shopPlanId", "varchar", { length: 64 }),
      col("planId", "int"),
      col("status", "varchar", { length: 16, notNull: true, default: "processing" }),
      col("kind", "varchar", { length: 16 }),
      col("message", "text"),
      col("occurredAt", "epoch"),
      col("localUserId", "int"),
      col("subscriptionId", "int"),
      col("expiresAt", "epoch"),
      col("attempts", "int", { notNull: true, default: 1 }),
      col("createdAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["orderId"]],
    indexes: [["externalUserId"], ["updatedAt"]],
  },
];

export const shopSyncMigrationTables: string[] = ["shop_sync_users", "shop_sync_orders"];
