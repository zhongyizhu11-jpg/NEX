import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { classifyIpAddress, expandIpv6 } from "../shared/ipAddress";

/*
  终端用户 IP 的离线归属地（照上游 poouo/Forwardx server/operationsSourceGeo.ts 移植）。

  「在线 IP」里看到的是用户客户端的 IP。以前它和主机定位共用 hostGeo 的在线查询：每个用户 IP 都发给
  ipapi.co / ip-api.com / ipwho.is，其中 ip-api.com 免费档只有明文 HTTP —— 等于把用户的 IP 明文交给
  第三方。现在这类查询只查面板自带的 ip2region 离线库（server/assets/ip2region，构建时拷到 dist/geo），
  不发任何网络请求；库缺了、解不开、sha256 对不上就当查不到（界面显示「未知」），绝不退回在线查询。

  数据：lionsoul2014/ip2region 固定提交 1bf6cabfb63c1a14（MIT / Apache-2.0，见 LICENSE.txt 和
  THIRD_PARTY_NOTICES.md）。读法按 xdb 3.x 格式自己实现（不额外引依赖）：256 字节头 + 256×256 向量索引
  （每格 8 字节：段索引起止指针）+ 段索引（IPv4 每条 14 字节：起止 IP 各 4 字节小端、数据长度 2、数据指针 4；
  IPv6 每条 38 字节：起止 IP 各 16 字节大端），二分查到区间后读出「国家|省份|城市|运营商|国家代码」。

  内存：IPv4 库解压后约 11MB，IPv6 约 37MB；都是第一次用到才加载（没有 IPv6 用户就不会加载那一份）。
*/

export const IP2REGION_DATA_VERSION = "1bf6cabfb63c1a14";

const ASSETS = {
  4: { file: "ip2region_v4.xdb.gz", bytes: 11_122_642, sha256: "27ecba8c9a6d5e3b280aedbe7ee15c65372b179fbd0dad3845d8c608f2fcace1", indexSize: 14, ipBytes: 4 },
  6: { file: "ip2region_v6.xdb.gz", bytes: 37_277_813, sha256: "939f6b46bd2b8bec3cf7c5ceb8ba782266ae9b1f35b5ba7916700dec0b7506ed", indexSize: 38, ipBytes: 16 },
} as const;

type Family = keyof typeof ASSETS;

const HEADER_BYTES = 256;
const VECTOR_COLS = 256;
const VECTOR_CELL_BYTES = 8;

const decompress = promisify(gunzip);
const databases = new Map<Family, Promise<Buffer | null>>();
let lastWarningAt = 0;

export type OfflineIpRegion = {
  countryCode: string;
  countryName: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
};

function assetDirectories() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.FORWARDX_IP2REGION_DIR,
    // 打包后这段代码在 dist/index.js 里：数据在 dist/geo（esbuild.config.mjs 拷过去）。
    path.join(here, "geo"),
    // 开发 / 测试直接跑源码：server/assets/ip2region。
    path.join(here, "assets", "ip2region"),
    path.resolve(process.cwd(), "dist", "geo"),
    path.resolve(process.cwd(), "server", "assets", "ip2region"),
  ].filter((value): value is string => !!value);
}

function warnOnce(message: string) {
  if (Date.now() - lastWarningAt < 5 * 60_000) return;
  lastWarningAt = Date.now();
  console.warn(`[IpRegion] ${message}; client IP locations stay unknown, no online lookup is made`);
}

async function loadDatabase(family: Family): Promise<Buffer | null> {
  const asset = ASSETS[family];
  const override = process.env.FORWARDX_IP2REGION_DIR;
  const directory = override || assetDirectories().find((dir) => existsSync(path.join(dir, asset.file)));
  if (!directory) {
    warnOnce(`offline IPv${family} database ${asset.file} not found`);
    return null;
  }
  try {
    const content = await decompress(await readFile(path.join(directory, asset.file)), { maxOutputLength: asset.bytes });
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.length !== asset.bytes || digest !== asset.sha256) {
      warnOnce(`offline IPv${family} database failed the integrity check`);
      return null;
    }
    const version = content.readUInt16LE(0);
    const ipVersion = content.readUInt16LE(16);
    const runtimePtrBytes = content.readUInt16LE(18);
    if (version !== 3 || ipVersion !== family || runtimePtrBytes !== 4) {
      warnOnce(`offline IPv${family} database has an unsupported format`);
      return null;
    }
    console.info(`[IpRegion] offline IPv${family} database ready version=${IP2REGION_DATA_VERSION}`);
    return content;
  } catch (error) {
    warnOnce(`offline IPv${family} database could not be read (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function database(family: Family) {
  let pending = databases.get(family);
  if (!pending) {
    pending = loadDatabase(family);
    databases.set(family, pending);
  }
  return pending;
}

/** 公网地址 → 查询用的字节（IPv4 4 字节、IPv6 16 字节，都按大端）。IPv4 映射的 IPv6 按 IPv4 查。 */
export function offlineLookupKey(address: string): { family: Family; bytes: Buffer } | null {
  const text = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!text || classifyIpAddress(text) !== "public") return null;
  const v4 = text.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return { family: 4, bytes: Buffer.from(v4.slice(1, 5).map(Number)) };
  const groups = expandIpv6(text);
  if (!groups) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { family: 4, bytes: Buffer.from([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]) };
  }
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return { family: 6, bytes };
}

/** 查询地址和段索引里一个 IP 比大小。IPv4 的段索引按小端存（兼容老格式），IPv6 按大端存。 */
function compareAt(family: Family, ip: Buffer, content: Buffer, offset: number) {
  if (family === 6) return ip.compare(content, offset, offset + 16);
  for (let index = 0; index < 4; index += 1) {
    const left = ip[index];
    const right = content[offset + 3 - index];
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function searchRegion(family: Family, content: Buffer, ip: Buffer): string {
  const { indexSize, ipBytes } = ASSETS[family];
  const cell = HEADER_BYTES + (ip[0] * VECTOR_COLS + ip[1]) * VECTOR_CELL_BYTES;
  if (cell + VECTOR_CELL_BYTES > content.length) return "";
  const startPtr = content.readUInt32LE(cell);
  const endPtr = content.readUInt32LE(cell + 4);
  if (!startPtr || !endPtr || endPtr < startPtr || endPtr + indexSize > content.length) return "";
  let low = 0;
  let high = (endPtr - startPtr) / indexSize;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const pointer = startPtr + middle * indexSize;
    if (compareAt(family, ip, content, pointer) < 0) {
      high = middle - 1;
    } else if (compareAt(family, ip, content, pointer + ipBytes) > 0) {
      low = middle + 1;
    } else {
      const dataLength = content.readUInt16LE(pointer + ipBytes * 2);
      const dataPtr = content.readUInt32LE(pointer + ipBytes * 2 + 2);
      if (!dataLength || dataPtr + dataLength > content.length) return "";
      return content.toString("utf8", dataPtr, dataPtr + dataLength);
    }
  }
  return "";
}

/** 「国家|省份|城市|运营商|国家代码」；0 表示没有。 */
export function parseOfflineIpRegion(region: string): OfflineIpRegion | null {
  const parts = String(region || "").split("|");
  const code = String(parts[4] || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") return null;
  const text = (index: number) => {
    const value = String(parts[index] || "").trim();
    return value && value !== "0" ? value.slice(0, 128) : null;
  };
  return { countryCode: code, countryName: text(0), region: text(1), city: text(2), isp: text(3) };
}

/** 公网 IP 的离线归属地；内网 / 保留 / 认不出 / 离线库不可用都返回 null。从不发网络请求。 */
export async function lookupOfflineIpRegion(address: string): Promise<OfflineIpRegion | null> {
  const key = offlineLookupKey(address);
  if (!key) return null;
  const content = await database(key.family);
  if (!content) return null;
  return parseOfflineIpRegion(searchRegion(key.family, content, key.bytes));
}

/** 测试用：丢掉已加载的库，下次重新读文件。 */
export function resetOfflineIpRegionForTests() {
  databases.clear();
  lastWarningAt = 0;
}
