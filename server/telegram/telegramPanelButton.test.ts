import assert from "node:assert/strict";
import test from "node:test";
import { formatRuleTestResult, mainMenuKeyboard, panelButton, webAppOpenKeyboard } from "./telegramBot";

/**
 * Telegram 的 Web App 按钮只收 https。面板是 http://IP:端口 时，带 web_app 的键盘整条被拒，
 * 「返回菜单」直接报「操作失败」。这里钉住：http 地址一律退成普通链接按钮。
 */
test("http panel urls never become web_app buttons", () => {
  const http = "http://154.36.174.85:9810/login?tgWebApp=1";
  const https = "https://panel.example.com/login?tgWebApp=1";

  assert.deepEqual(panelButton("🌐 面板", http), { text: "🌐 面板", url: http });
  assert.deepEqual(panelButton("🌐 面板", https), { text: "🌐 面板", web_app: { url: https } });

  const flat = (markup: ReturnType<typeof webAppOpenKeyboard>) => markup.inline_keyboard.flat();
  assert.ok(flat(webAppOpenKeyboard(http)).every((button) => !("web_app" in button)));
  assert.ok(flat(webAppOpenKeyboard(https)).some((button) => "web_app" in button));
  assert.ok(flat(mainMenuKeyboard({ role: "user" }, http)).every((button) => !("web_app" in button)));
  assert.ok(flat(mainMenuKeyboard({ role: "admin" }, https)).some((button) => "web_app" in button));
});

test("测延迟：落地不通时也列出隧道段延迟，看得出断在哪", () => {
  const text = formatRuleTestResult({ id: 9, name: "广港hkt2" }, {
    status: "failed",
    message: JSON.stringify({
      kind: "forward-via-tunnel",
      message: "隧道整体链路测试 失败",
      tunnelLatencyMs: 7,
      details: [{ success: false, message: "目标 TCP不可达或超时", routeLabel: "出口 -> 目标 hk:24895", fromHostId: 2 }],
      totalLatencyMs: null,
    }),
  });
  assert.match(text, /隧道段：7 ms/);
  assert.match(text, /出口 -&gt; 目标 hk:24895：不通/);
});
