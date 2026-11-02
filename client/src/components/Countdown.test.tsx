import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Countdown, formatCountdown, secondsLeft } from "./Countdown";

test("剩余秒数向上取整，到点和没有截止时间都是 0", () => {
  assert.equal(secondsLeft(10_500, 10_000), 1);
  assert.equal(secondsLeft(10_000, 10_000), 0);
  assert.equal(secondsLeft(9_000, 10_000), 0);
  assert.equal(secondsLeft(0, 10_000), 0);
  assert.equal(formatCountdown(65), "1:05");
  assert.equal(formatCountdown(0), "0:00");
});

test("倒计时组件把剩余秒数交给渲染函数", () => {
  const html = renderToStaticMarkup(<Countdown deadlineMs={Date.now() + 90_000}>{(left) => `剩余 ${formatCountdown(left)}`}</Countdown>);
  assert.match(html, /剩余 1:(29|30)/);
  assert.equal(renderToStaticMarkup(<Countdown deadlineMs={0}>{(left) => String(left)}</Countdown>), "0");
});

test("布局不再自己存每秒更新的时间戳", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "DashboardLayout.tsx"), "utf8");
  assert.doesNotMatch(source, /setTelegramBindTick|setTwoFactorSetupTick|setUpgradeAnnouncementCountdown/);
});
