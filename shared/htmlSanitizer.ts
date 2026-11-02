import { escapeHtmlAttr } from "./htmlEscape";

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr"]);
const ALLOWED_ATTRS = new Set(["class", "href", "rel", "target", "title"]);
const URL_ATTRS = new Set(["href"]);

export function escapeHtml(content: string) {
  return escapeHtmlAttr(content || "");
}

function decodeBasicEntities(value: string) {
  return String(value || "")
    .replace(/&colon;/gi, ":")
    .replace(/&#0*58;/gi, ":")
    .replace(/&#x0*3a;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&#0*9;/gi, "\t")
    .replace(/&#x0*9;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&#0*10;/gi, "\n")
    .replace(/&#x0*a;/gi, "\n")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function isSafeUrl(value: string) {
  const normalized = decodeBasicEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, "").trim();
  return /^(https?:|mailto:|tel:|\/|#)/i.test(normalized);
}

function sanitizeAttributes(rawAttrs: string, tagName: string) {
  const attrs: string[] = [];
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rawAttrs))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) continue;
    if ((name === "class" && tagName !== "code") || (name === "target" && tagName !== "a") || (name === "rel" && tagName !== "a")) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
    const safeValue = escapeHtml(value).replace(/\r?\n/g, " ");
    attrs.push(`${name}="${safeValue}"`);
  }
  if (tagName === "a") {
    const hasTarget = attrs.some((attr) => attr.startsWith("target="));
    const hasRel = attrs.some((attr) => attr.startsWith("rel="));
    if (!hasTarget) attrs.push('target="_blank"');
    if (!hasRel) attrs.push('rel="noopener noreferrer"');
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

const TAG_AT_CURSOR = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/y;

function renderAllowedTag(closing: string | undefined, rawName: string, rawAttrs: string) {
  const tagName = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(tagName)) return "";
  if (closing) return VOID_TAGS.has(tagName) ? "" : `</${tagName}>`;
  return `<${tagName}${sanitizeAttributes(rawAttrs || "", tagName)}>`;
}

/**
 * 白名单过滤。
 *
 * 逐个扫描，而不是对整段做一次正则替换：以前删掉一个不允许的标签之后，左右两边的
 * 文字会拼成一个新标签（`<<x>img src=x onerror=…>` → `<img src=x onerror=…>`），
 * 再过几遍也一样。现在输出里的每个 `<` 要么是这里重新生成的白名单标签，要么被转义
 * 成 `&lt;` —— 怎么拼都拼不出新标签。
 */
export function sanitizeHtml(input: string) {
  const withoutDangerousBlocks = String(input || "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math)\b[^>]*\/?\s*>/gi, "");

  let output = "";
  let cursor = 0;
  while (cursor < withoutDangerousBlocks.length) {
    const next = withoutDangerousBlocks.indexOf("<", cursor);
    if (next < 0) {
      output += withoutDangerousBlocks.slice(cursor);
      break;
    }
    output += withoutDangerousBlocks.slice(cursor, next);
    TAG_AT_CURSOR.lastIndex = next;
    const match = TAG_AT_CURSOR.exec(withoutDangerousBlocks);
    if (!match) {
      output += "&lt;";
      cursor = next + 1;
      continue;
    }
    output += renderAllowedTag(match[1], match[2], match[3]);
    cursor = TAG_AT_CURSOR.lastIndex;
  }
  return output;
}
