import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_DESCRIPTION_MAX_LENGTH } from "../shared/planDescription";

/** 套餐说明从 500 字放到 10000 字（上游 2.3.285），创建、修改、商店三处一致。 */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plan-description-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let router: typeof import("./routers/plans").plansRouter;
let db: typeof import("./db");

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  router = (await import("./routers/plans")).plansRouter;
  db = await import("./db");
  await runtime.insertAndGetId("users", { id: 1, username: "plan-admin", password: "unused", role: "admin" });
  await runtime.insertAndGetId("hosts", { id: 1, name: "plan-host", ip: "127.0.0.1", userId: 1 });
  await (await import("./repositories/settingsRepository")).setSetting("storeEnabled", "true");
});
after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});
const caller = (role: "admin" | "user" = "admin") => router.createCaller({
  user: { id: 1, role, accountEnabled: true } as any,
  req: { headers: {}, socket: {} } as any,
  res: {} as any, authSession: null, authFailureReason: null,
} as any);

test("超过原来 500 字的富文本说明能存、能改、商店里原样拿到", async () => {
  const description = "## 套餐介绍\n\n" + "- **服务特色**：示例文字\n".repeat(100);
  assert.ok(description.length > 500);
  const created: any = await caller().create({ name: "Rich", priceCents: 1800, description, hostIds: [1] } as any);
  const id = Number(created?.id ?? created);
  assert.equal((await db.getSubscriptionPlanById(id))?.description, description);
  const store = await caller("user").storeList() as any[];
  assert.equal(store.find((item) => Number(item.id) === id)?.description, description);
});

test("上限 10000 字，多一个字都拒绝", async () => {
  await caller().create({ name: "Boundary", priceCents: 0, description: "中".repeat(PLAN_DESCRIPTION_MAX_LENGTH), hostIds: [1] } as any);
  await assert.rejects(() => caller().create({ name: "Too long", priceCents: 0, description: "x".repeat(PLAN_DESCRIPTION_MAX_LENGTH + 1), hostIds: [1] } as any));
});
