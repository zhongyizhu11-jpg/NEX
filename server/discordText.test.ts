import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities, escapeDiscordMarkdown, telegramHtmlToDiscordText, truncateDiscordText } from "./discordText";

test("Telegram HTML 的格式换成 Discord Markdown", () => {
  assert.equal(
    telegramHtmlToDiscordText("<b>🔴 NEX 主机离线</b>\n\n<b>主机</b>：东京 1\n<b>地址</b>：<code>203.0.113.9</code>"),
    "**🔴 NEX 主机离线**\n\n**主机**：东京 1\n**地址**：`203.0.113.9`",
  );
  assert.equal(telegramHtmlToDiscordText("<i>斜体</i> <u>下划线</u> <s>删除</s>"), "*斜体* __下划线__ ~~删除~~");
  assert.equal(telegramHtmlToDiscordText('<a href="https://panel.example.com/tickets?id=3">在面板中查看</a>'), "[在面板中查看](https://panel.example.com/tickets?id=3)");
  assert.equal(telegramHtmlToDiscordText("第一行<br>第二行"), "第一行\n第二行");
  assert.equal(telegramHtmlToDiscordText("<pre>line1\nline2</pre>"), "```\nline1\nline2\n```");
  assert.equal(telegramHtmlToDiscordText("<b> 前后空格 </b>"), "**前后空格**");
});

test("用户填的内容（已经 HTML 转义）不能变成格式、链接或代码块", () => {
  // 工单标题里写了 Markdown 链接、粗体、@everyone
  const title = "[点我领奖](https://evil.example) **紧急** @everyone `x`";
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = telegramHtmlToDiscordText(`<b>工单</b>：#3 ${escaped}`);
  assert.equal(text, "**工单**：#3 \\[点我领奖\\]\\(https://evil.example\\) \\*\\*紧急\\*\\* @everyone \\`x\\`");
  // 尖括号（Discord 的 <@id>、<t:...> 语法）也转义
  assert.equal(telegramHtmlToDiscordText("&lt;@123456789012345678&gt;"), "\\<@123456789012345678\\>");
  // 行首的 # 和 - 不会变成标题、列表
  assert.equal(telegramHtmlToDiscordText("# 大标题\n- 列表"), "\\# 大标题\n\\- 列表");
  // 只认 http(s) 链接
  assert.equal(telegramHtmlToDiscordText('<a href="javascript:alert(1)">点</a>'), "点");
  // 链接里的括号不会提前闭合
  assert.equal(telegramHtmlToDiscordText('<a href="https://x.example/a)b">看</a>'), "[看](https://x.example/a%29b)");
  // 代码里的反引号换掉，跳不出代码块
  assert.equal(telegramHtmlToDiscordText("<code>a`b</code>"), "`aˋb`");
  // 不认识的标签丢掉、文字留下
  assert.equal(telegramHtmlToDiscordText('<span class="x">文字</span><script>1</script>'), "文字1");
});

test("HTML 实体正确解开", () => {
  assert.equal(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F600;"), "a & b <c> \"d\" 'e' 😀");
  assert.equal(decodeHtmlEntities("&bogus; &#0;"), "&bogus; &#0;");
  assert.equal(escapeDiscordMarkdown("a_b*c"), "a\\_b\\*c");
});

test("超过 2000 字在换行处截断并注明", () => {
  const long = Array.from({ length: 300 }, (_, i) => `第 ${i} 行内容`).join("\n");
  const text = telegramHtmlToDiscordText(long);
  assert.ok(text.length <= 2000, String(text.length));
  assert.match(text, /完整内容请到面板查看）$/);
  assert.equal(truncateDiscordText("短"), "短");
  const slashy = truncateDiscordText(`${"x".repeat(1969)}\\*${"y".repeat(100)}`, 2000);
  assert.ok(!/(^|[^\\])\\\n/.test(slashy), "不会留下半个转义");
});
