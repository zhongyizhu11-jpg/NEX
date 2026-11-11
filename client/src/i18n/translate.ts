/*
  界面翻译的匹配核心（纯函数，不碰 DOM、不碰 localStorage，测试和 scripts/i18n-extract.mjs 共用）。

  词典 en.json 的键就是源码里的中文原文（空白压成一个空格、去掉首尾），值是英文。
  界面上的字很多是拼出来的（「已选 3 条」「共 12 条」），所以词典键里允许带 {0} / {n} 这种占位：
  带占位的键会编成正则，整段原文对不上时再按模板套一遍；模板抓到的那一段如果本身也是词典里的中文
  （「状态：在线」里的「在线」），顺手也换掉，其余（主机名、数字）原样塞回去。
  最后才走 patterns.ts 里手写的几条正则（时长、相对时间这类词典写不全的）。

  只认「整段对得上」：不做子串替换——半句中文半句英文比全中文更难看懂，也最容易把用户数据改坏。
*/

export type Dictionary = Readonly<Record<string, string>>;
export type TranslateValues = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface PatternRule {
  /** 必须锚定（^…$）；对的是去掉首尾空白后的原文 */
  readonly re: RegExp;
  /** 返回英文；拿不准（比如某一段还是中文）返回 null，交给下一条 */
  readonly to: (match: RegExpExecArray, translatePart: (text: string) => string) => string | null;
}

// 汉字（含扩展 A 和兼容区）。只认汉字，不认全角标点：一段只有「：」「/」的字不用翻。
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
const PLACEHOLDER_RE = /\{(\w+)\}/g;
// 汉字或中文标点：模板字面的这一头贴着它，说明占位是半个词 / 半句话的位置
const CJK_ADJACENT_RE = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff，。；：、（）「」]$/;

export function hasCjk(text: string | null | undefined): boolean {
  return !!text && HAN_RE.test(text);
}

const HAN_GLOBAL_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function hanCount(text: string | null | undefined): number {
  return text ? (text.match(HAN_GLOBAL_RE)?.length ?? 0) : 0;
}

export function normalizeSource(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 把翻译结果塞回原文的首尾空白里：React 拼文字靠这些空格，丢了会粘在一起 */
export function keepOuterWhitespace(original: string, translated: string): string {
  const lead = /^\s*/.exec(original)?.[0] ?? "";
  const trail = original.length > lead.length ? (/\s*$/.exec(original)?.[0] ?? "") : "";
  return lead + translated + trail;
}

const PUNCTUATION: Readonly<Record<string, string>> = { "。": ". ", "，": ", ", "；": "; ", "：": ": ", "、": ", " };

function englishPunctuation(text: string): string {
  return text.replace(/[。，；：、]/g, (mark) => PUNCTUATION[mark] ?? mark);
}

export function interpolate(text: string, values?: TranslateValues): string {
  if (!values) return text;
  // 一遍替换：值里本身带 {0} 的（用户起的主机名）不会被再展开一次
  return text.replace(PLACEHOLDER_RE, (placeholder, name: string) => {
    if (Array.isArray(values)) {
      const index = Number(name);
      return Number.isInteger(index) && index < values.length ? String(values[index] ?? "") : placeholder;
    }
    const record = values as Readonly<Record<string, unknown>>;
    return Object.prototype.hasOwnProperty.call(record, name) ? String(record[name] ?? "") : placeholder;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledTemplate {
  readonly re: RegExp;
  readonly names: readonly string[];
  readonly value: string;
  /** 字面部分的总长：越长越具体，先试 */
  readonly weight: number;
  /** 字面部分的汉字数 */
  readonly han: number;
  /** 开头 / 结尾是占位（「{0}隧道」「搜索{0}」）时，紧挨着占位的那个字面字符；两头都是字面就是 null */
  readonly openStartNext: string | null;
  readonly openEndPrev: string | null;
}

/** 模板的第一个 / 最后一个字面字符，用来分桶，免得每段字都把几百条模板挨个试一遍 */
function bucketKeys(key: string): { first: string | null; last: string | null } {
  const first = /^\{\w+\}/.test(key) ? null : key[0] ?? null;
  const last = /\{\w+\}$/.test(key) ? null : key[key.length - 1] ?? null;
  return { first, last };
}

export interface Translator {
  /** 整段精确匹配（不套模板、不走正则）；对不上返回 null。服务端报错只走这一条。 */
  exact(text: string): string | null;
  /** 精确 → 模板 → 正则；对不上返回 null。返回值带着原文的首尾空白。 */
  translate(text: string): string | null;
  readonly size: number;
}

const CACHE_LIMIT = 8000;

export function createTranslator(dictionary: Dictionary, patterns: readonly PatternRule[] = []): Translator {
  const exactMap = new Map<string, string>();
  const byFirst = new Map<string, CompiledTemplate[]>();
  const byLast = new Map<string, CompiledTemplate[]>();
  const loose: CompiledTemplate[] = [];

  for (const [rawKey, rawValue] of Object.entries(dictionary)) {
    const key = normalizeSource(rawKey);
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!key || !value) continue;
    exactMap.set(key, value);
    const names: string[] = [];
    const literals = key.split(PLACEHOLDER_RE).filter((_, index) => index % 2 === 0);
    if (literals.length < 2) continue;
    // 字面部分一个汉字都没有的模板（「{0} / {1}」）不用翻，也别让它把别的段落吞掉
    if (!hasCjk(literals.join(""))) continue;
    const source = key.replace(PLACEHOLDER_RE, (_, name: string) => {
      names.push(name);
      return "\u0000";
    });
    const pattern = source.split("\u0000").map(escapeRegExp).join("(.+?)");
    const compiled: CompiledTemplate = {
      re: new RegExp(`^${pattern}$`, "s"),
      names,
      value,
      weight: literals.join("").length,
      han: hanCount(literals.join("")),
      openStartNext: literals[0] === "" ? (literals[1]?.[0] ?? null) : null,
      openEndPrev: literals[literals.length - 1] === "" ? (literals[literals.length - 2]?.slice(-1) ?? null) : null,
    };
    const { first, last } = bucketKeys(key);
    if (first) {
      const list = byFirst.get(first) ?? [];
      list.push(compiled);
      byFirst.set(first, list);
    } else if (last) {
      const list = byLast.get(last) ?? [];
      list.push(compiled);
      byLast.set(last, list);
    } else {
      loose.push(compiled);
    }
  }
  const byWeight = (a: CompiledTemplate, b: CompiledTemplate) => b.weight - a.weight;
  for (const list of byFirst.values()) list.sort(byWeight);
  for (const list of byLast.values()) list.sort(byWeight);
  loose.sort(byWeight);

  const exactCore = (core: string): string | null => exactMap.get(core) ?? null;

  // 模板抓出来的那一段：能翻就换成英文（整段、模板、正则都试），否则原样（主机名、用户名、数字）。
  // 首尾带着中文标点的（「。规则流量额度已用尽」）去掉标点再试，标点换成英文的
  const translatePart = (part: string): string => {
    const core = normalizeSource(part);
    if (!hasCjk(core)) return part;
    const hit = translateCore(core);
    if (hit != null) return keepOuterWhitespace(part, hit);
    const punct = /^([。，；：、,;:]*)(.*?)([。，；：、,;:]*)$/s.exec(core);
    if (punct && (punct[1] || punct[3]) && punct[2]) {
      const inner = translateCore(punct[2]);
      if (inner != null) return keepOuterWhitespace(part, `${englishPunctuation(punct[1])}${inner}${englishPunctuation(punct[3])}`.trim());
    }
    return part;
  };

  function applyTemplates(core: string, list: readonly CompiledTemplate[] | undefined): string | null {
    if (!list) return null;
    for (const template of list) {
      const match = template.re.exec(core);
      if (!match) continue;
      const values: Record<string, string> = {};
      let rejected = false;
      let openLeftover = 0;
      template.names.forEach((name, index) => {
        const raw = match[index + 1] ?? "";
        values[name] = translatePart(raw);
        // 抓到的段没翻完（还剩中文）时，判断它是「填空」（主机名、规则名）还是模板吞了半句话：
        // · 开口的占位（「搜索{0}」「{0}隧道{1}」）紧挨着的字面是汉字或中文标点——多半把半个词吞进去了
        //   （「离线」+「前 ↓ 8 MB/s」「搜索」+「主机 / IP」）；隔着空格、引号的（「停用隧道 华南-香港」）照样是填空；
        // · 字面只有一个汉字的开口模板（「{0}月」「已{0}」）太宽，剩中文就不用。
        // 段的中间带着中文标点或「·」：那是一句话 / 一串摘要，不是一个填空，不管翻没翻完都不算
        // （只在两头的标点不算：「额度 {2}{3}」抓到的「。规则流量额度已用尽」是正常的一句补充）
        if (/[，。；：、·]/.test(raw.replace(/^[，。；：、\s]+|[，。；：、\s]+$/g, ""))) rejected = true;
        const leftover = hanCount(values[name]);
        if (!leftover) return;
        const leading = index === 0 && template.openStartNext != null;
        const trailing = index === template.names.length - 1 && template.openEndPrev != null;
        if (!leading && !trailing) return;
        openLeftover += leftover;
        if (leading && CJK_ADJACENT_RE.test(template.openStartNext ?? "")) rejected = true;
        if (trailing && CJK_ADJACENT_RE.test(template.openEndPrev ?? "")) rejected = true;
      });
      // 开口的段剩下的中文比模板自己的字面还多（「{0}隧道{1}」夹着一大段），或者字面只有一个汉字：不算
      if (rejected || (openLeftover > 0 && (openLeftover > template.han || template.han < 2))) continue;
      return interpolate(template.value, values);
    }
    return null;
  }

  function applyPatterns(core: string): string | null {
    for (const rule of patterns) {
      rule.re.lastIndex = 0;
      const match = rule.re.exec(core);
      if (!match) continue;
      const result = rule.to(match, translatePart);
      if (result != null) return result;
    }
    return null;
  }

  const cache = new Map<string, string | null>();

  function translateCore(core: string): string | null {
    const cached = cache.get(core);
    if (cached !== undefined) return cached;
    const result = exactCore(core)
      ?? applyTemplates(core, byFirst.get(core[0] ?? ""))
      ?? applyTemplates(core, byLast.get(core[core.length - 1] ?? ""))
      ?? applyTemplates(core, loose)
      ?? applyPatterns(core);
    // 缓存满了整个清掉：界面上的字来来回回就那几千条，LRU 不值这份复杂
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(core, result);
    return result;
  }

  return {
    exact(text) {
      const core = normalizeSource(text);
      if (!core) return null;
      const hit = exactCore(core);
      return hit == null ? null : keepOuterWhitespace(text, hit);
    },
    translate(text) {
      const core = normalizeSource(text);
      if (!core || !hasCjk(core)) return null;
      const hit = translateCore(core);
      if (hit != null) return keepOuterWhitespace(text, hit);
      // 多行的（悬停提示「地区\n运营商 / ASN：…\n组织：…」）一行一行翻，换行留着
      const lines = text.trim().split(/\n+/);
      if (lines.length < 2) return null;
      const translated = lines.map((line) => {
        const lineCore = normalizeSource(line);
        return hasCjk(lineCore) ? (translateCore(lineCore) ?? lineCore) : lineCore;
      });
      return translated.some((line, index) => line !== normalizeSource(lines[index])) ? keepOuterWhitespace(text, translated.join("\n")) : null;
    },
    get size() {
      return exactMap.size;
    },
  };
}
