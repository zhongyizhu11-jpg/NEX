import zlib from "node:zlib";
import { crc32 } from "../zipArchive";

/*
  测试用：按 ZIP 的中央目录把每个条目读出来（支持只存和 deflate），顺带核对 CRC。
  主题包的 readUiThemeArchive 只收主题包允许的文件类型（.xml 不在其中），xlsx 测试用这一份。
*/
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    if (content.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(content) !== expectedCrc) throw new Error(`crc mismatch for ${name}`);
    files.set(name, content);
  }
  return files;
}

/**
 * 很朴素的 XML 良构检查：标签成对且嵌套正确、属性值都加了引号、& 只出现在合法实体里、
 * 没有 XML 1.0 不允许的控制字符。够用来抓「忘了转义」「标签没闭合」这类错。
 */
export function assertWellFormedXml(xml: string, label = "xml") {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) throw new Error(`${label}: contains invalid control characters`);
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body)) throw new Error(`${label}: unescaped &`);
  const stack: string[] = [];
  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let roots = 0;
  while ((match = tagPattern.exec(body))) {
    const between = body.slice(last, match.index);
    if (between.includes("<") || between.includes(">")) throw new Error(`${label}: stray markup near ${JSON.stringify(between.slice(0, 40))}`);
    last = tagPattern.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`${label}: </${name}> closes <${open}>`);
    } else if (!selfClosing) {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) roots += 1;
  }
  const tail = body.slice(last);
  if (tail.includes("<") || tail.includes(">")) throw new Error(`${label}: stray markup at end`);
  if (stack.length) throw new Error(`${label}: unclosed <${stack.join("> <")}>`);
  if (roots !== 1) throw new Error(`${label}: expected one root element, got ${roots}`);
}
