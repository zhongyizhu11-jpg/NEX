import assert from "node:assert/strict";
import test from "node:test";
import { describeSessionDevice } from "./sessionDevices";
import { isBlockedByMaintenance, maintenanceErrorMessage, normalizeMaintenanceMessage } from "./maintenance";

test("已登录设备：从 User-Agent 读出「系统 · 浏览器」", () => {
  const cases: Array<[string, string]> = [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Windows · Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0", "Windows · Edge"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "Mac · Safari"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Linux · Firefox"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36", "Android · Chrome"],
    ["curl/8.5.0", "curl"],
  ];
  for (const [ua, expected] of cases) assert.equal(describeSessionDevice(ua, "browser"), expected, ua);
  assert.equal(describeSessionDevice("anything", "mobile"), "NEX App");
  assert.equal(describeSessionDevice("Mozilla/5.0 Telegram", "browser"), "Telegram");
  assert.equal(describeSessionDevice("", "browser"), "未知设备");
  assert.equal(describeSessionDevice(null, "telegram"), "Telegram");
});

test("维护模式：只挡已开启时的非管理员，提示带上管理员写的说明", () => {
  const on = { enabled: true, message: "升级数据库，约 10 分钟" };
  assert.equal(isBlockedByMaintenance(on, { role: "user" }), true);
  assert.equal(isBlockedByMaintenance(on, { role: "admin" }), false);
  assert.equal(isBlockedByMaintenance(on, null), false);
  assert.equal(isBlockedByMaintenance({ enabled: false, message: "" }, { role: "user" }), false);
  assert.equal(maintenanceErrorMessage(on), "面板维护中，请稍后再来：升级数据库，约 10 分钟");
  assert.equal(maintenanceErrorMessage({ enabled: true, message: "" }), "面板维护中，请稍后再来");
  assert.equal(normalizeMaintenanceMessage("  多行\n说明  "), "多行 说明");
  assert.equal(normalizeMaintenanceMessage("x".repeat(500)).length, 200);
});
