import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import { crc32, writeZipArchive } from "./zipArchive";
import {
  UI_THEME_LIMITS,
  isSafeUiThemePath,
  parseUiThemeManifest,
  type UiThemeManifest,
} from "../shared/uiThemePackage";

/*
  界面主题包：读压缩包、校验清单、把样式收拾成能放心下发给所有人浏览器的那一份。
  （格式和来由见 shared/uiThemePackage.ts；思路照上游 poouo/Forwardx 的 server/themePackage.ts，
  但那边靠 yauzl / tar-stream / postcss，这里不想为了装主题给面板加三个运行时依赖，自己读。）

  主题是管理员装的，可样式会进每个访客的浏览器（登录页也在内），而且经常是从网上下来的别人的包。
  所以这里按「不信任」处理：
    · 压缩包只在内存里读，绝不往磁盘上解；条目数、单文件、总大小都有上限，解压时边解边数；
      加密的、带符号链接的、路径往外跳的一律拒绝。
    · 样式里不许出现能把请求发到外面去的写法：url() 只能指包里的文件（装的时候内联成 data:）、
      面板自己的 /fonts/ 字体、data: 图片和字体、#片段；@import、image-set() 这类能带地址的直接拒绝。
      CSS 没有脚本，可「属性选择器 + 外链背景图」能把输入框里的字一个个送出去，堵的就是这个。
    · 反斜杠转义只许转义标点（Tailwind 的 .md\:grid 这种类名要用）；能拼出字母的转义（\75rl 就是 url）
      拒绝，不然上面那些检查都能被绕过去。
*/

export class UiThemePackageError extends Error {}

const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
const TEXT_EXTENSIONS = [".css", ".json", ".md", ".txt"];

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;

function decodeText(bytes: Buffer, what: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new UiThemePackageError(`${what} 不是 UTF-8 文本`);
  }
}

/* ── CRC32 和写 ZIP 挪到了 server/zipArchive.ts（账单 Excel 导出也要用），这里照旧导出 crc32。 ── */
export { crc32 };

/* ── 读压缩包 ─────────────────────────────────────────────────────────── */

type ArchiveFiles = Map<string, Buffer>;

function acceptEntry(seen: Set<string>, name: string) {
  if (seen.size >= UI_THEME_LIMITS.files) throw new UiThemePackageError(`主题包里的文件太多（最多 ${UI_THEME_LIMITS.files} 个）`);
  if (!isSafeUiThemePath(name)) throw new UiThemePackageError(`主题包里有不安全的路径：${name.slice(0, 80)}`);
  const key = name.toLowerCase();
  if (seen.has(key)) throw new UiThemePackageError(`主题包里有重名的文件：${name}`);
  seen.add(key);
  const ext = path.posix.extname(name).toLowerCase();
  if (!TEXT_EXTENSIONS.includes(ext) && !ASSET_TYPES[ext]) {
    throw new UiThemePackageError(`主题包里有不支持的文件：${name}（只收 CSS、JSON、说明文字、图片和字体）`);
  }
}

function readZip(buffer: Buffer): ArchiveFiles {
  const bad = () => new UiThemePackageError("读不了这个 ZIP 文件（文件损坏或不是 ZIP）");
  // 末尾的「中央目录结束」记录：22 字节定长 + 最多 64KB 注释，从后往前找签名
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad();
  const total = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || offset === 0xffffffff || directorySize === 0xffffffff) {
    throw new UiThemePackageError("不支持 ZIP64 格式的主题包（主题包不该有这么大）");
  }
  if (offset + directorySize > eocd) throw bad();
  const files: ArchiveFiles = new Map();
  const seen = new Set<string>();
  let expanded = 0;
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw bad();
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    const fullName = decodeText(rawName, "主题包里的文件名").replace(/\\/g, "/");
    const directory = fullName.endsWith("/");
    const name = directory ? fullName.slice(0, -1) : fullName;
    if (flags & 0x1) throw new UiThemePackageError("主题包不能加密");
    // Unix 权限位里的文件类型：只收普通文件和目录（0 是没写权限位的打包工具）
    const kind = (externalAttributes >>> 16) & 0xf000;
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) throw new UiThemePackageError(`主题包里不能有链接或特殊文件：${name.slice(0, 80)}`);
    if (directory) {
      if (!isSafeUiThemePath(name)) throw new UiThemePackageError(`主题包里有不安全的路径：${name.slice(0, 80)}`);
      continue;
    }
    acceptEntry(seen, name);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new UiThemePackageError("不支持 ZIP64 格式的主题包（主题包不该有这么大）");
    }
    if (size > UI_THEME_LIMITS.fileBytes) throw new UiThemePackageError(`主题包里的 ${name} 太大（单个文件最多 ${mb(UI_THEME_LIMITS.fileBytes)}）`);
    expanded += size;
    if (expanded > UI_THEME_LIMITS.expandedBytes) throw new UiThemePackageError(`主题包解压后太大（最多 ${mb(UI_THEME_LIMITS.expandedBytes)}）`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw bad();
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buffer.length) throw bad();
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      try {
        // maxOutputLength：声明的大小是打包的人写的，不能信；真解出来超过上限就停
        content = zlib.inflateRawSync(data, { maxOutputLength: UI_THEME_LIMITS.fileBytes });
      } catch {
        throw new UiThemePackageError(`主题包里的 ${name} 解不开（损坏，或解压后超过 ${mb(UI_THEME_LIMITS.fileBytes)}）`);
      }
    } else throw new UiThemePackageError(`主题包里的 ${name} 用了不支持的压缩方式，请用普通的 ZIP（Deflate）重新打包`);
    if (content.length !== size || crc32(content) !== expectedCrc) throw new UiThemePackageError(`主题包里的 ${name} 校验不通过，压缩包可能损坏`);
    files.set(name, content);
  }
  return files;
}

function readTar(buffer: Buffer): ArchiveFiles {
  const files: ArchiveFiles = new Map();
  const seen = new Set<string>();
  let expanded = 0;
  const text = (start: number, length: number) => {
    const slice = buffer.subarray(start, start + length);
    const end = slice.indexOf(0);
    return decodeText(end >= 0 ? slice.subarray(0, end) : slice, "主题包里的文件名");
  };
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = text(offset + 124, 12).trim();
    if (!/^[0-7]*$/.test(sizeText)) throw new UiThemePackageError("读不了这个 TAR 文件（文件损坏）");
    const size = parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = text(offset + 345, 155);
    const fullName = `${prefix ? `${prefix}/` : ""}${text(offset, 100)}`.replace(/^\.\//, "");
    offset += 512;
    const dataEnd = offset + size;
    if (dataEnd > buffer.length) throw new UiThemePackageError("读不了这个 TAR 文件（文件不完整）");
    const next = offset + Math.ceil(size / 512) * 512;
    // x / g 是 pax 扩展头（macOS、新版 GNU tar 默认带），里面只是属性，跳过
    if (type === "x" || type === "g") { offset = next; continue; }
    const name = fullName.replace(/\/$/, "");
    if (type === "5") {
      if (name && name !== "." && !isSafeUiThemePath(name)) throw new UiThemePackageError(`主题包里有不安全的路径：${name.slice(0, 80)}`);
      offset = next;
      continue;
    }
    if (type !== "0" && type !== "\0") throw new UiThemePackageError(`主题包里不能有链接或特殊文件：${name.slice(0, 80)}`);
    acceptEntry(seen, name);
    if (size > UI_THEME_LIMITS.fileBytes) throw new UiThemePackageError(`主题包里的 ${name} 太大（单个文件最多 ${mb(UI_THEME_LIMITS.fileBytes)}）`);
    expanded += size;
    if (expanded > UI_THEME_LIMITS.expandedBytes) throw new UiThemePackageError(`主题包解压后太大（最多 ${mb(UI_THEME_LIMITS.expandedBytes)}）`);
    files.set(name, Buffer.from(buffer.subarray(offset, dataEnd)));
    offset = next;
  }
  return files;
}

/**
 * 压缩包外面套了一层目录（把整个文件夹拖进压缩软件、或者 GitHub 的源码包都是这样）：
 * 根目录没有 theme.json、所有文件又都在同一个顶层目录下时，把那一层去掉。
 */
function stripWrapperDirectory(files: ArchiveFiles): ArchiveFiles {
  if (files.has("theme.json") || files.size === 0) return files;
  const tops = new Set([...files.keys()].map((name) => name.split("/")[0]));
  if (tops.size !== 1) return files;
  const [top] = tops;
  if (!files.has(`${top}/theme.json`)) return files;
  const stripped: ArchiveFiles = new Map();
  for (const [name, content] of files) stripped.set(name.slice(top.length + 1), content);
  return stripped;
}

/** 读主题压缩包（ZIP、TAR.GZ / TGZ、TAR）。按文件头认格式，不看扩展名。只在内存里读。 */
export function readUiThemeArchive(buffer: Buffer): ArchiveFiles {
  if (!buffer.length) throw new UiThemePackageError("主题包是空的");
  if (buffer.length > UI_THEME_LIMITS.archiveBytes) throw new UiThemePackageError(`主题包不能超过 ${mb(UI_THEME_LIMITS.archiveBytes)}`);
  let files: ArchiveFiles;
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) files = readZip(buffer);
  else if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    let tar: Buffer;
    try {
      tar = zlib.gunzipSync(buffer, { maxOutputLength: UI_THEME_LIMITS.expandedBytes + UI_THEME_LIMITS.files * 1024 + 4096 });
    } catch {
      throw new UiThemePackageError(`这个 TAR.GZ 解不开（损坏，或解压后超过 ${mb(UI_THEME_LIMITS.expandedBytes)}）`);
    }
    files = readTar(tar);
  } else if (buffer.length >= 512 && buffer.subarray(257, 262).toString("latin1") === "ustar") files = readTar(buffer);
  else throw new UiThemePackageError("认不出这个文件：主题包要是 ZIP 或 TAR.GZ（TGZ）压缩包");
  return stripWrapperDirectory(files);
}

/* ── 写 ZIP（只存不压）：开发模板、导出已装的主题都用它。主题包都很小，不值得压。 ── */

export function writeZip(files: Record<string, string | Buffer>): Buffer {
  // 主题包的条目名比 ZIP 本身的规矩更严：只收安全路径（见 shared/uiThemePackage.ts）
  for (const name of Object.keys(files)) {
    if (!isSafeUiThemePath(name)) throw new Error(`invalid zip entry name: ${name}`);
  }
  return writeZipArchive(files);
}

/* ── 样式 ─────────────────────────────────────────────────────────────── */

const ALLOWED_AT_RULES = new Set([
  "media", "supports", "container", "layer", "scope", "keyframes", "-webkit-keyframes",
  "font-face", "property", "starting-style", "counter-style", "font-feature-values",
]);
// 这些函数能带一个地址进来，又不走下面 url() 那套检查
const FORBIDDEN_FUNCTIONS = new Set(["expression", "image-set", "-webkit-image-set", "image", "src", "paint", "element", "-moz-element"]);
const FORBIDDEN_PROPERTIES = /(?:^|[;{\s])(?:behavior|-moz-binding)\s*:/i;
// 反斜杠后面只许跟这些标点：.md\:grid、.w-1\/2、.top-\[3px\]、.\!mt-0 这类类名的写法。跟字母或十六进制数字能拼出标识符，不收。
const ESCAPABLE_PUNCTUATION = new Set([":", "/", ".", "[", "]", "%", "!", "#", ",", "+", "*", "&", "=", "~", "@"]);
const DATA_URL_PATTERN = /^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff2?|x-font-(?:ttf|woff)))[;,]/i;
const PANEL_FONT_PATTERN = /^\/fonts\/[a-zA-Z0-9_.-]+\.(?:woff2?|ttf|otf)$/;
const FRAGMENT_PATTERN = /^#[a-zA-Z][\w-]*$/;

const isIdentChar = (ch: string) => /[a-zA-Z0-9_-]/.test(ch);

function resolveUrl(raw: string, stylesheet: string, files: ArchiveFiles, budget: { bytes: number }) {
  const value = raw.trim();
  if (!value) throw new UiThemePackageError("主题样式里有空的 url()");
  if (/[\\\u0000-\u001f]/.test(value)) throw new UiThemePackageError("主题样式的 url() 里不能有转义或控制字符");
  if (DATA_URL_PATTERN.test(value) || PANEL_FONT_PATTERN.test(value) || FRAGMENT_PATTERN.test(value)) return value;
  if (/^data:/i.test(value)) throw new UiThemePackageError("主题样式里的 data: 地址只能是图片或字体");
  if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value) || /[?#%]/.test(value)) {
    throw new UiThemePackageError(`主题样式不能引用外部地址（${value.slice(0, 60)}）：图片和字体请放进主题包，用相对路径引用`);
  }
  const asset = path.posix.normalize(path.posix.join(path.posix.dirname(stylesheet), value));
  const mime = ASSET_TYPES[path.posix.extname(asset).toLowerCase()];
  const bytes = isSafeUiThemePath(asset) ? files.get(asset) : undefined;
  if (!bytes || !mime) throw new UiThemePackageError(`主题样式引用的文件不在包里，或不是支持的图片 / 字体：${value.slice(0, 80)}`);
  budget.bytes += 4 * Math.ceil(bytes.length / 3) + mime.length + 16;
  if (budget.bytes > UI_THEME_LIMITS.compiledCssBytes) {
    throw new UiThemePackageError(`主题引用的图片和字体加起来太大（内联后最多 ${mb(UI_THEME_LIMITS.compiledCssBytes)}），请压缩或减少`);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * 检查并整理一份主题样式：去掉注释、把 url() 里的包内文件内联进来、拒绝一切能往外发请求或藏东西的写法。
 * 返回的就是存库、下发给浏览器的那一份。
 */
export function compileUiThemeCss(source: string, options: { stylesheet?: string; files?: ArchiveFiles } = {}): string {
  const stylesheet = options.stylesheet || "theme.css";
  const files = options.files || new Map<string, Buffer>();
  if (Buffer.byteLength(source) > UI_THEME_LIMITS.cssBytes) {
    throw new UiThemePackageError(`主题样式太大（${stylesheet} 最多 ${Math.round(UI_THEME_LIMITS.cssBytes / 1024)}KB）`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) throw new UiThemePackageError("主题样式里有控制字符");
  if (/<\/?(?:style|script)/i.test(source)) throw new UiThemePackageError("主题样式里不能有 HTML 标签");
  const budget = { bytes: Buffer.byteLength(source) };
  let out = "";
  let code = ""; // 去掉注释、字符串内容之后的「骨架」，最后拿它查属性名
  let depth = 0;
  let i = 0;
  const length = source.length;
  const readString = (quote: string) => {
    // i 指在开头的引号上；返回引号里的原文，i 停在收尾引号后面
    let j = i + 1;
    while (j < length) {
      const ch = source[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === "\n") throw new UiThemePackageError("主题样式里有没收尾的字符串");
      if (ch === quote) break;
      j += 1;
    }
    if (j >= length) throw new UiThemePackageError("主题样式里有没收尾的字符串");
    const body = source.slice(i + 1, j);
    i = j + 1;
    return body;
  };
  while (i < length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new UiThemePackageError("主题样式里有没收尾的注释");
      i = end + 2;
      // 注释去掉后补一个空格：a/* */b 不能粘成 ab
      out += " ";
      code += " ";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const body = readString(ch);
      out += `${ch}${body}${ch}`;
      code += '""';
      continue;
    }
    if (ch === "\\") {
      const next = source[i + 1] || "";
      if (!ESCAPABLE_PUNCTUATION.has(next)) throw new UiThemePackageError("主题样式里的反斜杠只能用来转义类名里的标点（例如 .md\\:grid）");
      out += ch + next;
      code += "_";
      i += 2;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) throw new UiThemePackageError("主题样式的花括号不配对");
    }
    if (ch === "@") {
      let j = i + 1;
      while (j < length && isIdentChar(source[j])) j += 1;
      const name = source.slice(i + 1, j).toLowerCase();
      if (!ALLOWED_AT_RULES.has(name)) throw new UiThemePackageError(`主题样式不支持 @${name || "…"}`);
      out += source.slice(i, j);
      code += source.slice(i, j);
      i = j;
      continue;
    }
    if (/[a-zA-Z_-]/.test(ch) && !isIdentChar(source[i - 1] || "")) {
      let j = i + 1;
      while (j < length && isIdentChar(source[j])) j += 1;
      const word = source.slice(i, j);
      if (source[j] === "(") {
        const name = word.toLowerCase();
        if (FORBIDDEN_FUNCTIONS.has(name)) throw new UiThemePackageError(`主题样式不支持 ${name}()`);
        if (name === "url") {
          i = j + 1;
          while (i < length && /\s/.test(source[i])) i += 1;
          let argument: string;
          if (source[i] === '"' || source[i] === "'") {
            argument = readString(source[i]);
            while (i < length && /\s/.test(source[i])) i += 1;
            if (source[i] !== ")") throw new UiThemePackageError("主题样式里的 url() 写法不对");
          } else {
            const end = source.indexOf(")", i);
            if (end < 0) throw new UiThemePackageError("主题样式里的 url() 没有收尾");
            argument = source.slice(i, end);
            if (/["'(\s]/.test(argument.trim())) throw new UiThemePackageError("主题样式里的 url() 写法不对");
            i = end;
          }
          i += 1;
          out += `url("${resolveUrl(argument, stylesheet, files, budget)}")`;
          code += "url()";
          continue;
        }
      }
      out += word;
      code += word;
      i = j;
      continue;
    }
    out += ch;
    code += ch;
    i += 1;
  }
  if (depth !== 0) throw new UiThemePackageError("主题样式的花括号不配对");
  if (FORBIDDEN_PROPERTIES.test(code)) throw new UiThemePackageError("主题样式里有不支持的属性（behavior / -moz-binding）");
  const compiled = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!compiled) throw new UiThemePackageError("主题样式是空的");
  if (Buffer.byteLength(compiled) > UI_THEME_LIMITS.compiledCssBytes) {
    throw new UiThemePackageError(`主题样式内联资源后太大（最多 ${mb(UI_THEME_LIMITS.compiledCssBytes)}）`);
  }
  return `${compiled}\n`;
}

export type ParsedUiThemePackage = { manifest: UiThemeManifest; css: string; revision: string };

/** 清单 + 样式 → 能装的一套主题。files 是「包里的路径 → 内容」，压缩包和官方主题库的目录都先变成这个再进来。 */
export function buildUiThemePackage(files: ArchiveFiles): ParsedUiThemePackage {
  const manifestBytes = files.get("theme.json");
  if (!manifestBytes) throw new UiThemePackageError("主题包的根目录里没有 theme.json");
  if (manifestBytes.length > UI_THEME_LIMITS.manifestBytes) throw new UiThemePackageError("theme.json 太大");
  let raw: unknown;
  try {
    raw = JSON.parse(decodeText(manifestBytes, "theme.json"));
  } catch (error) {
    if (error instanceof UiThemePackageError) throw error;
    throw new UiThemePackageError("theme.json 不是合法的 JSON");
  }
  let manifest: UiThemeManifest;
  try {
    manifest = parseUiThemeManifest(raw);
  } catch (error) {
    throw new UiThemePackageError(error instanceof Error ? error.message : "theme.json 无效");
  }
  const stylesheet = files.get(manifest.stylesheet);
  if (!stylesheet) throw new UiThemePackageError(`主题包里找不到 theme.json 指定的样式文件 ${manifest.stylesheet}`);
  const css = compileUiThemeCss(decodeText(stylesheet, manifest.stylesheet), { stylesheet: manifest.stylesheet, files });
  const revision = createHash("sha256").update(JSON.stringify(manifest)).update("\n").update(css).digest("hex");
  return { manifest, css, revision };
}

export function parseUiThemeArchive(buffer: Buffer): ParsedUiThemePackage {
  return buildUiThemePackage(readUiThemeArchive(buffer));
}
