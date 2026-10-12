/*
  WebDAV（坚果云、Nextcloud、群晖、Alist……）。只用 PUT / PROPFIND / GET / DELETE / MKCOL。

  PROPFIND 的回包是 XML，命名空间前缀各家不一样（D: / d: / lp1: / 不带），这里按标签本名
  匹配、不认前缀，解析成「文件名 + 大小 + 修改时间」。
*/

export type WebdavEntry = { name: string; size: number; modifiedAt: number | null; isCollection: boolean; href: string };

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** 找一个标签（不管前缀）的内容；自闭合的返回空串；没有返回 null。 */
function findTag(xml: string, name: string): string | null {
  const open = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*?(/?)>`, "i");
  const match = open.exec(xml);
  if (!match) return null;
  if (match[1] === "/") return "";
  const rest = xml.slice(match.index + match[0].length);
  const close = new RegExp(`</(?:[\\w.-]+:)?${name}\\s*>`, "i").exec(rest);
  return close ? rest.slice(0, close.index) : null;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 解析 PROPFIND（Depth: 1）的 multistatus。
 *
 * 每个 response 的 href 取最后一段当文件名（目录自身那一条 href 以 / 结尾，取出来是空名，
 * 由调用方过滤掉）。只认 200 的 propstat —— 有的服务器把拿不到的属性放在 404 的 propstat 里。
 */
export function parseWebdavPropfind(xml: string): WebdavEntry[] {
  const entries: WebdavEntry[] = [];
  const responseRe = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = responseRe.exec(xml))) {
    const block = match[1];
    const href = decodeXml((findTag(block, "href") || "").trim());
    if (!href) continue;
    let props = "";
    const propstatRe = /<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat\s*>/gi;
    let propstat: RegExpExecArray | null;
    while ((propstat = propstatRe.exec(block))) {
      const status = findTag(propstat[1], "status") || "";
      if (!status || /\s2\d\d\s/.test(` ${status} `)) props += propstat[1];
    }
    if (!props) props = block;
    const resourceType = findTag(props, "resourcetype") || "";
    const isCollection = /<(?:[\w.-]+:)?collection\b/i.test(resourceType) || href.endsWith("/");
    const path = safeDecodeUri(href.replace(/^[a-z]+:\/\/[^/]+/i, ""));
    const name = path.replace(/\/+$/, "").split("/").pop() || "";
    const sizeText = (findTag(props, "getcontentlength") || "").trim();
    const modifiedText = (findTag(props, "getlastmodified") || "").trim();
    const modified = Date.parse(modifiedText);
    entries.push({
      name,
      size: Number(sizeText) || 0,
      modifiedAt: Number.isFinite(modified) ? modified : null,
      isCollection,
      href,
    });
  }
  return entries;
}

/** 目录地址统一以 / 结尾，文件地址 = 目录 + 编码后的文件名。 */
export function webdavFolderUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function webdavFileUrl(folder: string, name: string): string {
  return `${webdavFolderUrl(folder)}${encodeURIComponent(name)}`;
}

export const WEBDAV_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`;

export function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}
