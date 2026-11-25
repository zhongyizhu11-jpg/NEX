/*
  用户填的正则（订阅作用域的 include / exclude、节点改名规则、自定义策略组的筛选）直接 new RegExp
  再去匹配几十个节点名。JavaScript 的正则是回溯式的，`(a+)+$`、`(\w|\d)*x` 这种写法在一个三十个字符、
  又不匹配的名字上要回溯 2^30 次 —— 一条订阅请求就把面板的事件循环卡住几分钟，而写这条规则的
  可能只是个租户。

  这里不做完整的分析，只按两条够用的规矩拦：
    - 量词套量词：一个带量词的分组里面还有量词，`(a+)+`、`(.*a)*`、`((ab)*c)+`；
    - 量词套或：一个带量词的分组里面有 `|`，`(a|aa)+`、`(\d|\w)*`（分支重叠才会爆，但分不清，一律不要；
      节点名的筛选用不到这种写法）。
  再加一个长度上限。拦下来的按「非法正则」处理，调用方照原来的样子退化成子串匹配，不会把订阅弄成 500。

  编译结果按「标志 + 源」记住：同一份模板每次渲染都要把这几条正则重新编译，几百个租户几分钟刷一次
  时不是小数。记忆表有上限，先进先出。
*/

export const SAFE_REGEX_MAX_LENGTH = 256;
const MEMO_MAX_ENTRIES = 512;

/** 后面这一段是不是量词：`*`、`+`、`?`、`{n}`、`{n,}`、`{n,m}`（`?` 紧跟 `(` 的是分组修饰，不算）。返回量词长度，不是返回 0。 */
function quantifierLength(source: string, index: number): number {
  const char = source[index];
  if (char === "*" || char === "+" || char === "?") return 1;
  if (char !== "{") return 0;
  const match = /^\{\d+(?:,\d*)?\}/.exec(source.slice(index));
  return match ? match[0].length : 0;
}

type Frame = { hasQuantifier: boolean; hasAlternation: boolean };

/**
 * 这个表达式按上面的规矩算不算安全。只看结构，不验证语法：语法错误交给 new RegExp 去报。
 */
export function isSafeRegexSource(source: string): boolean {
  if (typeof source !== "string" || source.length > SAFE_REGEX_MAX_LENGTH) return false;
  const stack: Frame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let closed: Frame | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      closed = null;
      continue;
    }
    if (char === "[") {
      // 字符类里的 ( | * + 都是字面量，整段跳过。
      index += 1;
      if (source[index] === "^") index += 1;
      if (source[index] === "]") index += 1;
      while (index < source.length && source[index] !== "]") index += source[index] === "\\" ? 2 : 1;
      index += 1;
      closed = null;
      continue;
    }
    if (char === "(") {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      index += 1;
      // `(?:`、`(?=`、`(?!`、`(?<=`、`(?<!`、`(?<name>` 的修饰部分不是量词。
      if (source[index] === "?") {
        index += 1;
        if (source[index] === "<" && source[index + 1] !== "=" && source[index + 1] !== "!") {
          const end = source.indexOf(">", index);
          index = end < 0 ? source.length : end + 1;
        } else {
          index += 1;
        }
      }
      closed = null;
      continue;
    }
    if (char === ")") {
      const frame = stack.pop();
      if (!frame) return false;
      const parent = stack[stack.length - 1];
      if (frame.hasQuantifier) parent.hasQuantifier = true;
      closed = frame;
      index += 1;
      continue;
    }
    if (char === "|") {
      stack[stack.length - 1].hasAlternation = true;
      closed = null;
      index += 1;
      continue;
    }
    const quantifier = quantifierLength(source, index);
    if (quantifier > 0) {
      // 量词落在刚关上的分组上：分组里有量词或有或，就是会爆的那种。
      if (closed && (closed.hasQuantifier || closed.hasAlternation)) return false;
      stack[stack.length - 1].hasQuantifier = true;
      index += quantifier;
      // 懒惰修饰 `+?` / `*?` / `{n}?` 不是新量词。
      if (source[index] === "?") index += 1;
      closed = null;
      continue;
    }
    closed = null;
    index += 1;
  }
  return true;
}

const memo = new Map<string, RegExp | null>();

/**
 * 编译一条用户给的正则：不安全或语法错误返回 null（调用方退化成子串匹配）；结果按「标志 + 源」记住。
 * 带 g 标志的实例共用是安全的：String.prototype.replace 每次都从头开始；要用 test() 的地方别传 g。
 */
export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  const key = `${flags}:${source}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (isSafeRegexSource(source)) {
    try {
      compiled = new RegExp(source, flags);
    } catch {
      compiled = null;
    }
  }
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, compiled);
  return compiled;
}
