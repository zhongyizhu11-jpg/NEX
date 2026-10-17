import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities, DISCORD_MESSAGE_MAX_CHUNKS, escapeDiscordMarkdown, splitDiscordText, telegramHtmlToDiscordText, truncateDiscordText } from "./discordText";

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

test("长通知不再截在 2000 字：整段转好，发送时按换行拆成每条 ≤ 2000 字", () => {
  const long = Array.from({ length: 300 }, (_, i) => `第 ${i} 行内容`).join("\n");
  const text = telegramHtmlToDiscordText(long);
  assert.ok(text.length > 2000, "转换这一步不截断");
  assert.doesNotMatch(text, /完整内容请到面板查看/);
  const chunks = splitDiscordText(text);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 2000 && chunk.length > 0, String(chunk.length));
  assert.equal(chunks.join("\n"), text, "按换行拆，拼回去就是原文");
  assert.deepEqual(splitDiscordText("短"), ["短"]);
  assert.deepEqual(splitDiscordText("   "), []);

  // 没有换行的一大段：硬切，但不劈开代理对、不留下半个转义。
  const emoji = "😀".repeat(1500);
  const emojiChunks = splitDiscordText(emoji);
  assert.equal(emojiChunks.join(""), emoji);
  for (const chunk of emojiChunks) assert.ok(!/[\ud800-\udbff]$/.test(chunk) && !/^[\udc00-\udfff]/.test(chunk));
  const slashy = splitDiscordText(`${"x".repeat(1999)}\\*${"y".repeat(100)}`);
  assert.ok(slashy.every((chunk) => !/(^|[^\\])\\$/.test(chunk)), "不会留下半个转义");
  assert.equal(slashy.join(""), `${"x".repeat(1999)}\\*${"y".repeat(100)}`);

  // 代码块跨了两条：前一条补上收尾的 ```，后一条重新开。
  const code = "<pre>" + Array.from({ length: 200 }, (_, i) => `line ${i} ${"z".repeat(10)}`).join("\n") + "</pre>";
  const codeChunks = splitDiscordText(telegramHtmlToDiscordText(code));
  assert.ok(codeChunks.length >= 2);
  for (const chunk of codeChunks) {
    assert.ok(chunk.length <= 2000);
    assert.equal((chunk.match(/```/g) || []).length % 2, 0, "每条里的代码块都是闭合的");
  }

  // 太长的（超过 10 条）最后一条注明去面板看。
  const huge = Array.from({ length: 3000 }, (_, i) => `第 ${i} 行内容内容内容`).join("\n");
  const hugeChunks = splitDiscordText(telegramHtmlToDiscordText(huge));
  assert.equal(hugeChunks.length, DISCORD_MESSAGE_MAX_CHUNKS);
  assert.match(hugeChunks.at(-1)!, /完整内容请到面板查看）$/);
  assert.equal(truncateDiscordText("短"), "短");
});
