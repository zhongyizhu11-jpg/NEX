import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/*
  账单 Excel 导出跑在真的 SQLite 上：谁能导出谁的、导出来的文件长什么样、超过上限怎么说。
*/

const setup = String.raw`
  const billing = await import(url("server/repositories/billingRepository.ts"));
  const { billingRouter } = await import(url("server/routers/billing.ts"));
  const { readZipEntries, assertWellFormedXml } = await import(url("server/testing/zipReader.ts"));
  await exec("INSERT INTO users (id, username, name, password, role, balanceCents) VALUES (1, 'admin', '管理员', 'h', 'admin', 0)");
  await exec("INSERT INTO users (id, username, name, password, role, balanceCents) VALUES (2, 'alice', 'Alice', 'h', 'user', 0)");
  await exec("INSERT INTO users (id, username, name, password, role, balanceCents) VALUES (3, 'bob', '=cmd|calc', 'h', 'user', 0)");
  const context = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
  const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
  const alice = { id: 2, username: "alice", role: "user", accountEnabled: true };
  await billing.addUserBalance(2, 1234, { type: "admin_recharge", description: "alice 充值" });
  await billing.addUserBalance(3, 5678, { type: "admin_recharge", description: "=HYPERLINK(\"http://evil\")" });
  await billing.createPaymentOrder({ outTradeNo: "ORDER-ALICE", userId: 2, provider: "stripe", paymentType: "stripe", status: "pending", subject: "alice 的单", amountCents: 990, orderType: "balance" });
  await billing.createPaymentOrder({ outTradeNo: "ORDER-BOB", userId: 3, provider: "stripe", paymentType: "stripe", status: "pending", subject: "bob 的单", amountCents: 880, orderType: "balance" });
  const sheetsOf = (exported) => {
    const files = readZipEntries(Buffer.from(exported.dataBase64, "base64"));
    for (const [name, content] of files) assertWellFormedXml(content.toString("utf8"), name);
    return [1, 2, 3].map((index) => files.get("xl/worksheets/sheet" + index + ".xml").toString("utf8"));
  };
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "billing-export", setup, quiet: true });
}

test("普通用户只能导出自己的账：传别人的 userId 也只按自己算", () => {
  runInDatabase(String.raw`
    const exported = await billingRouter.createCaller(context(alice)).exportXlsx({ userId: 3 });
    assert.match(exported.filename, /^billing-user2-\d{8}-\d{6}\.xlsx$/);
    assert.deepEqual(exported.counts, { ledger: 2, balance: 1, payment: 1 });
    const [ledger, balance, payment] = sheetsOf(exported);
    for (const sheet of [ledger, balance, payment]) {
      assert.doesNotMatch(sheet, /bob|ORDER-BOB|cmd\|calc|HYPERLINK/);
    }
    assert.match(balance, /alice 充值/);
    assert.match(balance, /<v>12.34<\/v>/);
    assert.match(payment, /ORDER-ALICE/);
    assert.match(payment, /<v>9.9<\/v>/);
    assert.match(ledger, /ORDER-ALICE/);
  `);
});

test("管理员可以导出全部或指定用户，危险文字写成带前导单引号的字符串", () => {
  runInDatabase(String.raw`
    const caller = billingRouter.createCaller(context(admin));
    const all = await caller.exportXlsx();
    assert.match(all.filename, /^billing-all-/);
    assert.deepEqual(all.counts, { ledger: 4, balance: 2, payment: 2 });
    const [, balance] = sheetsOf(all);
    assert.match(balance, /alice 充值/);
    assert.doesNotMatch(balance, /<f>/);
    assert.match(balance, /t="inlineStr" s="4"><is><t xml:space="preserve">=HYPERLINK/);
    assert.match(balance, /t="inlineStr" s="4"><is><t xml:space="preserve">=cmd\|calc（bob）/);

    const onlyBob = await caller.exportXlsx({ userId: 3 });
    assert.deepEqual(onlyBob.counts, { ledger: 2, balance: 1, payment: 1 });
    const [ledger] = sheetsOf(onlyBob);
    assert.doesNotMatch(ledger, /alice|ORDER-ALICE/);
    await assert.rejects(() => caller.exportXlsx({ userId: 999 }), /用户不存在/);
  `);
});

test("超过 50000 条时给出明确提示，不导出残缺的表", () => {
  runInDatabase(String.raw`
    await exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000) INSERT INTO balance_transactions (userId, type, amountCents, balanceAfterCents, createdAt) SELECT 3, 'admin_recharge', 1, i, 1700000000 FROM n");
    const caller = billingRouter.createCaller(context(admin));
    await assert.rejects(() => caller.exportXlsx(), /超过单次导出上限 50000 条，请选择一个用户分开导出/);
    // 只导 alice 的不受 bob 那几万条影响
    const exported = await billingRouter.createCaller(context(alice)).exportXlsx();
    assert.equal(exported.counts.ledger, 2);
  `);
});
