/*
  把发给 Telegram 的通知正文（Telegram 的 HTML 子集）转成 Discord 私信能用的文字。

  面板的通知都是先拼 Telegram HTML（<b>、<i>、<code>、<a href>…，用户填的内容已经 HTML 转义过），
  Discord 不认 HTML，认的是自己那套 Markdown。直接把标签剥掉会丢掉粗体和链接；直接把用户内容
  塞进 Markdown 又会让人用工单标题之类的地方伪造格式和链接（比如 [点这里](https://evil)）。

  所以这里自己解析一遍：认得的标签换成 Markdown 记号，**标签之间的文字先解开 HTML 实体，再把
  Markdown 特殊字符全部用反斜杠转义**；链接只接受 http(s)，别的协议只留文字。
  @everyone / @here / <@id> 这类提及另外靠发送时的 allowed_mentions: { parse: [] } 挡住，不会真的提醒到人。
*/

export const DISCORD_MESSAGE_MAX_LENGTH = 2000;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

export function decodeHtmlEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** 文字里的 Markdown 记号全部转义，Discord 会原样显示。 */
export function escapeDiscordMarkdown(text: string) {
  return text
    .replace(/([\\*_`~|[\]()<>])/g, "\\$1")
    // 行首的 #（标题）、-/+（列表）、数字加点（有序列表）只在行首有意义
    .replace(/^(\s*)([#\-+]|\d+\.)/gm, (_match, space: string, mark: string) => `${space}\\${mark}`);
}

function safeHttpUrl(value: string) {
  const text = decodeHtmlEntities(value).trim();
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    // 链接放进 Markdown 的 (…) 里：括号、空白要编码，免得提前闭合
    return url.toString().replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  } catch {
    return "";
  }
}

const WRAP: Record<string, string> = {
  b: "**", strong: "**",
  i: "*", em: "*",
  u: "__", ins: "__",
  s: "~~", strike: "~~", del: "~~",
  "tg-spoiler": "||",
};

type Frame = { tag: string; out: string; href?: string; raw?: boolean };

/** Telegram HTML → Discord Markdown（不超过 2000 字，超了在换行处截断并注明）。 */
export function telegramHtmlToDiscordText(html: string, maxLength = DISCORD_MESSAGE_MAX_LENGTH) {
  const source = String(html ?? "");
  const stack: Frame[] = [{ tag: "#root", out: "" }];
  const top = () => stack[stack.length - 1];
  const inRaw = () => stack.some((frame) => frame.raw);
  const appendText = (text: string) => {
    if (!text) return;
    const decoded = decodeHtmlEntities(text);
    top().out += inRaw() ? decoded.replace(/`/g, "ˋ") : escapeDiscordMarkdown(decoded);
  };
  const closeFrame = (frame: Frame) => {
    const inner = frame.out;
    let rendered: string;
    if (frame.tag === "a") {
      rendered = frame.href && inner.trim() ? `[${inner}](${frame.href})` : inner;
    } else if (frame.tag === "code") {
      rendered = inner ? `\`${inner}\`` : "";
    } else if (frame.tag === "pre") {
      rendered = `\n\`\`\`\n${inner.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n`;
    } else if (frame.tag === "blockquote") {
      rendered = `\n${inner.split("\n").map((line) => `> ${line}`).join("\n")}\n`;
    } else if (WRAP[frame.tag]) {
      // 空白放到记号外面：Discord 不认「** 文字**」
      const match = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      rendered = match[2] ? `${match[1]}${WRAP[frame.tag]}${match[2]}${WRAP[frame.tag]}${match[3]}` : inner;
    } else {
      rendered = inner;
    }
    top().out += rendered;
  };

  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)\/?>/g;
  let last = 0;
  for (let match = tagPattern.exec(source); match; match = tagPattern.exec(source)) {
    appendText(source.slice(last, match.index));
    last = tagPattern.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attrs = match[3] || "";
    if (tag === "br") {
      top().out += "\n";
      continue;
    }
    const known = tag === "a" || tag === "code" || tag === "pre" || tag === "blockquote" || !!WRAP[tag] || (tag === "span" && /tg-spoiler/.test(attrs));
    if (!known) continue; // 不认识的标签丢掉，里面的文字照留
    const name = tag === "span" ? "tg-spoiler" : tag;
    if (!closing) {
      const frame: Frame = { tag: name, out: "" };
      if (name === "a") {
        const href = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
        frame.href = href ? safeHttpUrl(href[2] ?? href[3] ?? "") : "";
      }
      if (name === "code" || name === "pre") frame.raw = true;
      stack.push(frame);
      continue;
    }
    // 关闭标签：找到最近的同名标签，把中间没关的一起关掉；找不到就忽略
    const index = stack.map((frame) => frame.tag).lastIndexOf(name === "span" ? "tg-spoiler" : name);
    if (index <= 0) continue;
    while (stack.length > index) closeFrame(stack.pop()!);
  }
  appendText(source.slice(last));
  while (stack.length > 1) closeFrame(stack.pop()!);

  const text = stack[0].out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return truncateDiscordText(text, maxLength);
}

const TRUNCATED_NOTICE = "\n…（内容太长，完整内容请到面板查看）";

export function truncateDiscordText(text: string, maxLength = DISCORD_MESSAGE_MAX_LENGTH) {
  if (text.length <= maxLength) return text;
  const budget = maxLength - TRUNCATED_NOTICE.length;
  let cut = text.lastIndexOf("\n", budget);
  if (cut < budget * 0.5) cut = budget;
  // 别把一个转义反斜杠或代理对劈成两半
  let head = text.slice(0, cut);
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  if (/(^|[^\\])\\$/.test(head)) head = head.slice(0, -1);
  return `${head}${TRUNCATED_NOTICE}`;
}
