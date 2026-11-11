import { hanCount, type PatternRule } from "./translate";

/*
  词典写不全的几类拼接文字：数字 + 单位、相对时间、日期。词典（带 {0} 的模板）先试，这里兜底。
  每条都锚定整段，对不上就放过——宁可留中文，也不把半句话改成中英混排。
*/

const plural = (count: string, one: string, many = `${one}s`) => (count === "1" ? one : many);

// 「3天2小时5分钟」「12 秒」「1.5 小时」这种纯时长
const DURATION_UNITS: ReadonlyArray<[RegExp, string]> = [
  [/毫秒/g, "ms"],
  [/小时/g, "h"],
  [/分钟/g, "min"],
  [/分/g, "min"],
  [/秒/g, "s"],
  [/天/g, "d"],
  [/周/g, "w"],
];

export const PATTERNS: readonly PatternRule[] = [
  {
    re: /^(\d+(?:\.\d+)?) ?(秒|分钟|小时|天|周|个月|年)前$/,
    to: (m) => {
      const unit = { 秒: "second", 分钟: "minute", 小时: "hour", 天: "day", 周: "week", 个月: "month", 年: "year" }[m[2]] ?? "";
      return `${m[1]} ${plural(m[1], unit)} ago`;
    },
  },
  {
    re: /^(\d+(?:\.\d+)?) ?(秒|分钟|小时|天|周|个月|年)后$/,
    to: (m) => {
      const unit = { 秒: "second", 分钟: "minute", 小时: "hour", 天: "day", 周: "week", 个月: "month", 年: "year" }[m[2]] ?? "";
      return `in ${m[1]} ${plural(m[1], unit)}`;
    },
  },
  {
    re: /^(?:\d+(?:\.\d+)?\s*(?:毫秒|小时|分钟|分|秒|天|周)\s*)+$/,
    to: (m) => {
      let out = m[0];
      for (const [re, unit] of DURATION_UNITS) out = out.replace(re, unit);
      return out.replace(/(\d)\s+(?=[a-z])/g, "$1");
    },
  },
  { re: /^(\d+) ?个$/, to: (m) => m[1] },
  { re: /^(\d+) ?条$/, to: (m) => `${m[1]} ${plural(m[1], "item")}` },
  { re: /^(\d+) ?台$/, to: (m) => `${m[1]} ${plural(m[1], "host")}` },
  { re: /^(\d+) ?人$/, to: (m) => `${m[1]} ${plural(m[1], "user")}` },
  { re: /^(\d+) ?次$/, to: (m) => `${m[1]} ${plural(m[1], "time")}` },
  { re: /^(\d+) ?天$/, to: (m) => `${m[1]} ${plural(m[1], "day")}` },
  { re: /^(\d+) ?项$/, to: (m) => `${m[1]} ${plural(m[1], "item")}` },
  { re: /^共 ?(\d+) ?(?:条|项|个)$/, to: (m) => `${m[1]} total` },
  { re: /^已选 ?(\d+) ?(?:条|项|个|台)?$/, to: (m) => `${m[1]} selected` },
  { re: /^第 ?(\d+) ?页$/, to: (m) => `Page ${m[1]}` },
  { re: /^步骤 ?(\d+)$/, to: (m) => `Step ${m[1]}` },
  { re: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, to: (m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` },
  { re: /^(\d{4})年(\d{1,2})月$/, to: (m) => `${m[1]}-${m[2].padStart(2, "0")}` },
  { re: /^(\d{1,2})月(\d{1,2})日$/, to: (m) => `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` },
  { re: /^每月 ?(\d{1,2}) ?日$/, to: (m) => `Day ${m[1]} of each month` },
  {
    // 探测服务卡片上的「Ping · 每 60 秒 · 电信」：间隔是摘要里的一段，交给下面的「 · 」逐段翻
    re: /^每 ?(\d+) ?(秒|分钟|小时|天)$/,
    to: (m) => {
      const unit = { 秒: "second", 分钟: "minute", 小时: "hour", 天: "day" }[m[2]] ?? "";
      return `every ${m[1]} ${plural(m[1], unit)}`;
    },
  },
  {
    // 「A · B · C」「A；B」「入口 → 中转 → 出口」：界面上一行摘要常这样拼（类型 · 跳数 · 状态）。各段本来就是独立的词，逐段翻；
    // 打头那段翻不了（规则名、主机名）就原样留着。
    re: /^.+(?: · |；| → ).+$/,
    to: (m, part) => {
      const separator = [" · ", "；", " → "].find((item) => m[0].includes(item)) ?? " · ";
      const segments = m[0].split(separator);
      const translated = segments.map((segment) => part(segment));
      if (!translated.some((segment, index) => segment !== segments[index])) return null;
      // 只有打头那段可以留着中文（多半是规则名、主机名）；后面还有没翻的说明就整段不动，免得半中半英
      if (translated.some((segment, index) => index > 0 && hanCount(segment) > 0)) return null;
      return translated.join(separator === "；" ? "; " : separator);
    },
  },
  {
    // 地图上的「🇭🇰 香港」：国旗留着，后面的地名照词典翻
    re: /^(\p{Regional_Indicator}{2}\s*)(.+)$/u,
    to: (m, part) => {
      const name = part(m[2]);
      return name === m[2] ? null : `${m[1]}${name}`;
    },
  },
  {
    // 「3 台主机、1 条隧道、4 条转发」：顿号列出来的几项，每一项都翻得了才换（主机名列表这种翻不全的原样留着）
    re: /^[^、]+(?:、[^、]+)+$/,
    to: (m, part) => {
      const items = m[0].split("、");
      const translated = items.map((item) => part(item));
      return translated.every((item) => hanCount(item) === 0) ? translated.join(", ") : null;
    },
  },
  {
    // 「浅色白雾（%）」「AES-128（推荐）」：括号前面翻得了就翻，括号里也翻（翻不了且有中文就放过）
    re: /^(.+?)\s?（([^（）]*)）$/,
    to: (m, part) => {
      const head = part(m[1]);
      if (head === m[1] && hanCount(m[1]) > 0) return null;
      const inner = part(m[2]);
      if (hanCount(inner) > 0) return null;
      return `${head} (${inner})`;
    },
  },
  {
    // 「标签：值」——标签在词典里就换标签，值也是词典里的中文就一起换（「状态：在线」）；
    // 值里剩下的中文比标签还多（一整句说明没翻）就不换，免得只翻出个「Traffic:」
    re: /^([^：:]{1,24})[：:]\s?(.+)$/,
    to: (m, part) => {
      const label = part(m[1]);
      if (label === m[1]) return null;
      const value = part(m[2]);
      if (hanCount(value) >= Math.max(1, hanCount(m[1]))) return null;
      return `${label}: ${value}`;
    },
  },
];
