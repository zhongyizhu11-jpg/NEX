import assert from "node:assert/strict";
import test from "node:test";
import {
  UNLOCK_EXTENDED_AGENT_VERSION,
  unlockDisplayLabel,
  unlockRegionText,
  unlockRegionTone,
  unlockServiceSupported,
  normalizeUnlockFamily,
  normalizeUnlockResults,
  normalizeUnlockSchedule,
  unlockChipText,
  unlockScheduleIntervalSeconds,
  UNLOCK_SERVICES,
} from "./unlockCheck";

test("Agent 报上来的结果：只认服务表里的服务和四种状态，地区码要合格，按服务表排序", () => {
  const results = normalizeUnlockResults([
    { service: "claude", status: "blocked", region: "hk", detail: "不支持这个地区", ms: 120.4 },
    { service: "netflix", status: "ok", region: "Hong Kong", detail: "全解锁\u0000\n", ms: -1 },
    { service: "netflix", status: "blocked" },
    { service: "not_a_service", status: "ok" },
    { service: "chatgpt", status: "maybe", region: "USA", detail: "x".repeat(500) },
    "garbage",
    null,
  ]);
  assert.deepEqual(results?.map((r) => r.service), ["netflix", "chatgpt", "claude"]);
  assert.deepEqual(results?.[0], { service: "netflix", status: "ok", region: null, detail: "全解锁", ms: null });
  assert.equal(results?.[1].status, "unknown");
  assert.equal(results?.[1].region, "USA");
  assert.equal(results?.[1].detail.length, 160);
  assert.equal(results?.[2].region, "HK");
  assert.equal(results?.[2].ms, 120);
  assert.equal(normalizeUnlockResults({}), null);
  assert.deepEqual(normalizeUnlockResults([]), []);
});

test("主机卡摘要：NF 全解 · GPT ✓ · Claude ✗，没测的服务不出现", () => {
  assert.equal(
    unlockChipText([
      { service: "claude", status: "blocked" },
      { service: "chatgpt", status: "ok" },
      { service: "netflix", status: "ok" },
      { service: "disney", status: "ok" },
    ]),
    "NF 全解 · GPT ✓ · Claude ✗",
  );
  assert.equal(unlockChipText([{ service: "netflix", status: "partial" }, { service: "gemini", status: "unknown" }]), "NF 自制 · Gemini ?");
  assert.equal(unlockChipText([{ service: "chatgpt", status: "partial" }]), "GPT 半");
  assert.equal(unlockChipText([]), "");
});

test("family / 计划检测的取值兜底", () => {
  assert.equal(normalizeUnlockFamily("ipv6"), "ipv6");
  assert.equal(normalizeUnlockFamily("v6"), "auto");
  assert.equal(normalizeUnlockSchedule("weekly"), "weekly");
  assert.equal(normalizeUnlockSchedule("hourly"), "off");
  assert.equal(unlockScheduleIntervalSeconds("off"), null);
  assert.equal(unlockScheduleIntervalSeconds("daily"), 86400);
  assert.equal(new Set(UNLOCK_SERVICES.map((s) => s.id)).size, UNLOCK_SERVICES.length);
});

test("服务表和 Agent 的 unlockServices 一一对应", async () => {
  const fs = await import("node:fs");
  const go = fs.readFileSync(new URL("../agent/unlock_check.go", import.meta.url), "utf8");
  const table = go.slice(go.indexOf("var unlockServices = []unlockService{"), go.indexOf("// ---------------------------------------------------------------- HTTP"));
  const goIds = Array.from(table.matchAll(/ID: "([a-z_]+)"/g), (m) => m[1]).sort();
  assert.deepEqual(goIds, UNLOCK_SERVICES.map((s) => s.id).sort());
});

test("带地区的显示：解锁 / 仅自制 / 屏蔽 / 检测失败，地区按主机所在地上色", () => {
  assert.equal(unlockDisplayLabel("netflix", "ok"), "解锁");
  assert.equal(unlockDisplayLabel("netflix", "partial"), "仅自制");
  assert.equal(unlockDisplayLabel("chatgpt", "partial"), "部分解锁");
  assert.equal(unlockDisplayLabel("disney", "blocked"), "屏蔽");
  assert.equal(unlockDisplayLabel("claude", "unknown"), "检测失败");
  assert.equal(unlockRegionText("steam", "usd"), "币种 USD");
  assert.equal(unlockRegionText("netflix", "jp"), "JP");
  assert.equal(unlockRegionText("netflix", ""), null);

  assert.equal(unlockRegionTone("netflix", "JP", "JP"), "match");
  assert.equal(unlockRegionTone("netflix", "US", "JP"), "mismatch");
  assert.equal(unlockRegionTone("tiktok", "CN", "HK"), "china");
  assert.equal(unlockRegionTone("gemini", "JPN", "JP"), "match", "三位码折成两位再比");
  assert.equal(unlockRegionTone("steam", "EUR", "DE"), "match");
  assert.equal(unlockRegionTone("steam", "USD", "SG"), "mismatch");
  assert.equal(unlockRegionTone("steam", "CNY", "HK"), "china");
  assert.equal(unlockRegionTone("netflix", "JP", null), "none", "不知道主机在哪就不上色");
  assert.equal(unlockRegionTone("netflix", null, "JP"), "none");
});

test("新加的四项要 Agent 2.2.255", () => {
  const added = UNLOCK_SERVICES.filter((def) => def.sinceAgent === UNLOCK_EXTENDED_AGENT_VERSION).map((def) => def.id);
  assert.deepEqual(added, ["prime_video", "spotify", "steam", "bilibili_hmt"]);
  const steam = UNLOCK_SERVICES.find((def) => def.id === "steam")!;
  assert.equal(unlockServiceSupported(steam, "2.2.252"), false);
  assert.equal(unlockServiceSupported(steam, "2.2.255"), true);
  assert.equal(unlockServiceSupported(steam, "2.3.0"), true);
  assert.equal(unlockServiceSupported(steam, null), false);
  assert.equal(unlockServiceSupported(UNLOCK_SERVICES[0], null), true);
  const results = normalizeUnlockResults([{ service: "steam", status: "ok", region: "USD" }, { service: "bilibili_hmt", status: "blocked" }]);
  assert.deepEqual(results?.map((r) => [r.service, r.region]), [["steam", "USD"], ["bilibili_hmt", null]]);
});
