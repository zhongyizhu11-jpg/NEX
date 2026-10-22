/**
 * 够用的 YAML 子集解析器，专门读 Clash / mihomo 订阅里的 `proxies:` 列表。
 *
 * 不引第三方 YAML 库：面板到现在都没依赖它，外部订阅这一个用途也用不到锚点、
 * 多文档、标签那些。支持的就是订阅里实际出现的那些写法：
 *
 *   - 块映射 / 块序列（按缩进）
 *   - 行内映射 `{ name: x, type: ss }` 和行内序列 `[h2, http/1.1]`
 *   - 单引号 / 双引号字符串（双引号里的 \" \\ \n 转义）
 *   - 裸标量：true / false / null / 数字 / 其它按字符串
 *   - `#` 注释（引号外）
 *
 * 不支持的（多行标量 | >、锚点 & *、标签 !!）遇到就当普通字符串，不抛错。
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

type Line = { indent: number; text: string; raw: string };

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  for (const raw of String(source || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*$/.test(raw)) continue;
    const withoutComment = stripComment(raw);
    if (!withoutComment.trim()) continue;
    const indent = raw.match(/^ */)?.[0].length || 0;
    lines.push({ indent, text: withoutComment.trim(), raw });
  }
  return lines;
}

function parseScalar(text: string): YamlValue {
  const value = text.trim();
  if (value === "") return "";
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
    return value.slice(1, -1).replace(/\\(["\\nrt/])/g, (_whole, ch: string) => ({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t", "/": "/" }[ch] || ch));
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (value === "null" || value === "~" || value === "Null") return null;
  if (/^[-+]?(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return parseFlowSequence(value);
  if (value.startsWith("{") && value.endsWith("}")) return parseFlowMapping(value);
  return value;
}

/** 按逗号切行内集合，引号和括号里的逗号不算。 */
function splitFlow(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += body[index + 1] || "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "[" || char === "{") {
      depth += 1;
      current += char;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

function parseFlowSequence(text: string): YamlValue[] {
  return splitFlow(text.slice(1, -1)).map(parseScalar);
}

function splitKeyValue(text: string): [string, string] | null {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0 && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
    }
  }
  return null;
}

function parseFlowMapping(text: string): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {};
  for (const item of splitFlow(text.slice(1, -1))) {
    const pair = splitKeyValue(item);
    if (!pair) continue;
    out[unquoteKey(pair[0])] = parseScalar(pair[1]);
  }
  return out;
}

function unquoteKey(key: string): string {
  const scalar = parseScalar(key);
  return typeof scalar === "string" ? scalar : String(scalar);
}

/** 递归解析从 start 起、缩进 ≥ baseIndent 的块；返回值和消费到的行号。 */
function parseBlock(lines: Line[], start: number, baseIndent: number): { value: YamlValue; next: number } {
  if (start >= lines.length) return { value: null, next: start };
  const first = lines[start];
  if (first.indent < baseIndent) return { value: null, next: start };
  if (first.text.startsWith("- ") || first.text === "-") return parseSequence(lines, start, first.indent);
  return parseMapping(lines, start, first.indent);
}

function parseSequence(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      // 不该出现的更深缩进：当成上一项的延续（容错），跳过。
      index += 1;
      continue;
    }
    if (!(line.text.startsWith("- ") || line.text === "-")) break;
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    if (!rest) {
      const nested = parseBlock(lines, index + 1, indent + 1);
      items.push(nested.value);
      index = nested.next;
      continue;
    }
    // `- name: x` 这种：序列项本身是个映射，首键在同一行，其余键在下面更深的缩进。
    const pair = rest.startsWith("{") || rest.startsWith("[") || rest.startsWith('"') || rest.startsWith("'") ? null : splitKeyValue(rest);
    if (pair) {
      // 把这一行当作缩进 indent + 2 的映射首行来解析。
      const virtual: Line = { indent: indent + 2, text: rest, raw: line.raw };
      const spliced = [virtual, ...lines.slice(index + 1)];
      const parsed = parseMapping(spliced, 0, indent + 2);
      items.push(parsed.value);
      index = index + parsed.next;
      continue;
    }
    items.push(parseScalar(rest));
    index += 1;
  }
  return { value: items, next: index };
}

function parseMapping(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const out: { [key: string]: YamlValue } = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      index += 1;
      continue;
    }
    if (line.text.startsWith("- ")) break;
    const pair = splitKeyValue(line.text);
    if (!pair) {
      index += 1;
      continue;
    }
    const key = unquoteKey(pair[0]);
    if (pair[1] === "") {
      const nextLine = lines[index + 1];
      if (nextLine && (nextLine.indent > indent || (nextLine.indent === indent && nextLine.text.startsWith("- ")))) {
        const nested = nextLine.indent === indent
          ? parseSequence(lines, index + 1, indent)
          : parseBlock(lines, index + 1, nextLine.indent);
        out[key] = nested.value;
        index = nested.next;
        continue;
      }
      out[key] = null;
      index += 1;
      continue;
    }
    out[key] = parseScalar(pair[1]);
    index += 1;
  }
  return { value: out, next: index };
}

export function parseMiniYaml(source: string): YamlValue {
  const lines = splitLines(source);
  if (lines.length === 0) return null;
  return parseBlock(lines, 0, lines[0].indent).value;
}
