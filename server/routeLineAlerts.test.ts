import assert from "node:assert/strict";
import test from "node:test";

import { switchAlert } from "./routeLineViews";

/*
  线路工作台「最近告警」那一行：Agent 在面板给的中转原因外面再包一层「relay down: 」，
  这里剥掉外层再写，不再出现「relay down: 东京 → 落地」这种半截英文。
*/

const row = (reason: string) => ({ kind: "switch", reason, ruleId: 7, createdAt: new Date("2026-11-08T08:00:00Z"), fromLabel: "主线路", toLabel: "备用线路" });

test("切换原因包了两层 relay down：只写里面那句", () => {
  assert.equal(switchAlert(row("relay down: relay down: 东京中转 → 落地"), "广港")?.text, "东京中转 → 落地");
  assert.equal(switchAlert(row("relay down: 东京中转 → 落地"), "广港")?.text, "东京中转 → 落地", "只有一层的和原来一样");
  assert.equal(switchAlert(row("relay down: maintenance: HK2"), "广港")?.text, "HK2 维护中");
  assert.equal(switchAlert(row("relay down: relay down: 东京中转 → 落地; same exit ip"), "广港")?.action, "已换到同出口 IP 的备用");
  assert.equal(switchAlert(row("relay down:"), "广港")?.text, "广港 中转异常");
});
