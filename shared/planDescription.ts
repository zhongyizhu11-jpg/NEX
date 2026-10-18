/*
  套餐说明（上游 2.3.285）：支持 Markdown 和安全的 HTML，商店卡片按富文本展示。

  上限 10000 字：全是四字节字符时也放得进 MySQL 的 TEXT（65535 字节）。
  原来是 500 字纯文本，写不下一段像样的介绍。
*/
export const PLAN_DESCRIPTION_MAX_LENGTH = 10_000;

/** 编辑器里「插入模板」用的一段示例，管理员照着改就行。 */
export const PLAN_DESCRIPTION_TEMPLATE = [
  "### 适合谁",
  "",
  "- 日常网页、视频、游戏加速",
  "- 需要固定端口的个人或小团队",
  "",
  "### 线路说明",
  "",
  "- 入口：**广州 / 深圳** 多入口",
  "- 落地：香港原生 IP",
  "",
  "> 说明只是展示用，实际权益以上面的端口、流量、限速为准。",
].join("\n");

/**
 * 管理端列表里的一行摘要：去掉 HTML 标签和 Markdown 记号，只留文字。
 * 说明现在能写到一万字的排版，列表里原样贴出来会把卡片撑爆。
 */
export function planDescriptionSummary(text: unknown, maxLength = 80) {
  const plain = String(text || "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}
