import assert from "node:assert/strict";
import test from "node:test";
import { pickTabValue, tabForSearchChange } from "./urlTab";

const values = ["plans", "billing"] as const;

/**
 * 这一条是这个函数存在的理由。
 *
 * 原来的实现从 wouter 的 `useLocation()` 里 split("?") —— 那个值只有路径，
 * 于是 `?tab=billing` 一直被忽略，默默回落到默认 tab。没有任何东西会报错：
 * 一条跳转链接看起来正常，只是落在了错的地方。
 */
test("地址栏里的 tab 说了算", () => {
  assert.equal(pickTabValue("?tab=billing", null, values, "plans"), "billing");
  assert.equal(pickTabValue("tab=billing", null, values, "plans"), "billing", "不带问号也认");
  assert.equal(pickTabValue("/plans?tab=billing", null, values, "plans"), "billing", "整条地址也认");
});

test("地址栏压过上次存的 —— 别人刚发来的链接比你上次停在哪要新", () => {
  assert.equal(pickTabValue("?tab=billing", "plans", values, "plans"), "billing");
  assert.equal(pickTabValue("?tab=plans", "billing", values, "plans"), "plans");
});

test("地址栏没说就用上次存的", () => {
  assert.equal(pickTabValue("", "billing", values, "plans"), "billing");
  assert.equal(pickTabValue("?other=1", "billing", values, "plans"), "billing");
});

test("两边都没有才用默认", () => {
  assert.equal(pickTabValue("", null, values, "plans"), "plans");
  assert.equal(pickTabValue("", undefined, values, "plans"), "plans");
});

/** 认不出来的值一律当没说，不能把一个不存在的 tab 名交出去。 */
test("不在清单里的值一律丢掉", () => {
  assert.equal(pickTabValue("?tab=nonsense", null, values, "plans"), "plans");
  assert.equal(pickTabValue("?tab=nonsense", "billing", values, "plans"), "billing", "地址栏是脏的就退回存的那个");
  assert.equal(pickTabValue("", "已经删掉的tab", values, "plans"), "plans");
});

test("queryKey 可以换，别的键不干扰", () => {
  assert.equal(pickTabValue("?view=billing", null, values, "plans", "view"), "billing");
  assert.equal(pickTabValue("?tab=billing", null, values, "plans", "view"), "plans");
});

/**
 * 浏览器后退/前进只改查询串。原来 tab 只跟着 useLocation()（只有路径）重算，
 * 地址栏退回去了，页面上的 tab 纹丝不动。
 */
test("后退/前进改了 tab 参数，tab 跟着换", () => {
  assert.equal(tabForSearchChange("", "?tab=billing", values, "plans"), "billing");
  // 默认 tab 不写进地址栏：退回到没有 tab 的那一条，就是默认 tab，不能回落到上次存的 billing。
  assert.equal(tabForSearchChange("?tab=billing", "", values, "plans", { storedValue: "billing" }), "plans");
  assert.equal(tabForSearchChange("?tab=billing&page=2", "?page=2", values, "plans"), "plans");
});

test("tab 参数没变就不动 tab（别的查询参数变化不算）", () => {
  assert.equal(tabForSearchChange("", "?page=2", values, "plans"), null);
  assert.equal(tabForSearchChange("?tab=billing", "?tab=billing&page=3", values, "plans"), null);
  assert.equal(tabForSearchChange("?tab=billing", "?tab=billing", values, "plans"), null);
});

test("不清掉默认值的页面，tab 参数被去掉时退回上次存的", () => {
  assert.equal(
    tabForSearchChange("?tab=plans", "", values, "plans", { clearDefaultFromUrl: false, storedValue: "billing" }),
    "billing",
  );
});

test("链路管理每次进来都从第一个分类开始：不记上次的 tab，带 ?tab= 跳过来的也只用一次", async () => {
  const fs = await import("node:fs");
  const page = fs.readFileSync("client/src/pages/Tunnels.tsx", "utf8");
  const call = page.slice(page.indexOf("useUrlTab<TunnelSection>({"), page.indexOf("useUrlTab<TunnelSection>({") + 400);
  assert.match(call, /remember: false/);
  const hook = fs.readFileSync("client/src/hooks/useUrlTab.ts", "utf8");
  // 不记：不读也不写 localStorage；点 tab 不往地址栏写；进来时地址栏里的 tab 用完就去掉。
  assert.match(hook, /if \(!remember\) storageKey = undefined;/);
  assert.equal((hook.match(/lastSearchRef\.current = stripped;/g) || []).length, 2, "去掉 ?tab= 之前要先记下新查询串，不然会被当成后退而换回默认");
});
