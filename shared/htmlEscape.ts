/*
  HTML 转义，两个口径，按用在哪里挑：

  - escapeHtmlText：只转 & < >。放进标签之间的文本用，Telegram 的 HTML 模式也用这个 ——
    Telegram 要求的就是这三个，引号原样写就行。
  - escapeHtmlAttr：再加上双引号、单引号。拼进属性值（value="…"、href="…"）时必须用这个，
    否则一个引号就能把属性截断。

  原来各个文件各写一份，有的转引号有的不转，同一段文字在不同地方转出来不一样。
*/

export function escapeHtmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(value: unknown): string {
  return escapeHtmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
