import zlib from "node:zlib";

/*
  不依赖第三方库的 ZIP 写入：主题包（server/uiThemePackage.ts）和账单 Excel 导出（server/xlsxWriter.ts）共用。

  原来只有主题包那一份「只存不压」的 writeZip，主题包都很小，不压无所谓；Excel 导出几万行的 XML
  不压能有几十 MB，所以这里加了 deflate（node:zlib 自带，不算新依赖）。两边的条目名规矩不一样
  （主题包只收安全路径，xlsx 必须有 [Content_Types].xml 这种带方括号的名字），名字由调用方自己把关，
  这里只拒绝明显会出事的写法（空名、绝对路径、..）。
*/

/* ── CRC32：ZIP 每个文件都带一个，读的时候核对、写的时候算。不用 zlib.crc32（Node 22.2 才有）。 ── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntries = Record<string, string | Buffer> | ReadonlyArray<readonly [string, string | Buffer]>;

export type WriteZipOptions = {
  /** true：每个条目用 deflate 压缩（压出来反而更大的条目照样只存）。默认只存不压。 */
  deflate?: boolean;
};

function assertEntryName(name: string) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`invalid zip entry name: ${name}`);
  }
}

/** 写一个 ZIP（不支持 ZIP64：单个文件和整个包都不能超过 4GB，这里用到的都远小于它）。 */
export function writeZipArchive(entries: ZipEntries, options: WriteZipOptions = {}): Buffer {
  const list = Array.isArray(entries) ? entries : Object.entries(entries as Record<string, string | Buffer>);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 固定成 1980-01-01：同样的内容打出来的包逐字节相同
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const [name, value] of list) {
    assertEntryName(name);
    const nameBytes = Buffer.from(name, "utf8");
    const content = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const checksum = crc32(content);
    let method = 0;
    let stored = content;
    if (options.deflate && content.length > 0) {
      const compressed = zlib.deflateRawSync(content, { level: 6 });
      if (compressed.length < content.length) {
        method = 8;
        stored = compressed;
      }
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix，2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0x8000 | 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
