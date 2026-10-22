/**
 * 节点的地区：国家码 → 国旗 + 中文名，以及从名字里猜国家码。
 *
 * 国家码的来源按可信度排：节点上手工填的 → 落地机器的 geo（面板自己查的）→ 名字里
 * 的关键字（「香港」「HK」「🇭🇰」）。猜不出就没有，不乱标。
 */

import { countryFlagEmoji } from "./firewallCountries";
import { countryNameZh } from "./placeNameZh";

export function proxySubRegionFlag(code: string): string {
  return countryFlagEmoji(code);
}

export function proxySubRegionName(code: string): string {
  const clean = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(clean)) return "";
  return countryNameZh(clean) || clean;
}

/** 「🇭🇰 香港」；认不出的码给空串。 */
export function proxySubRegionLabel(code: string): string {
  const name = proxySubRegionName(code);
  if (!name) return "";
  const flag = proxySubRegionFlag(code);
  return flag ? `${flag} ${name}` : name;
}

/** 名字关键字表。顺序即优先级：先长词后短词，避免「新加坡」被「加」之类的误伤。 */
const KEYWORDS: ReadonlyArray<[string, RegExp]> = [
  ["HK", /香港|hong\s*kong|\bHKG?\b|🇭🇰/i],
  ["TW", /台湾|臺灣|taiwan|\bTWN?\b|🇹🇼/i],
  ["MO", /澳门|澳門|macau|macao|\bMO\b|🇲🇴/i],
  ["JP", /日本|东京|東京|大阪|japan|tokyo|osaka|\bJPN?\b|🇯🇵/i],
  ["SG", /新加坡|singapore|\bSGP?\b|🇸🇬/i],
  ["KR", /韩国|韓國|首尔|首爾|korea|seoul|\bKOR\b|\bKR\b|🇰🇷/i],
  ["US", /美国|美國|洛杉矶|洛杉磯|圣何塞|聖何塞|西雅图|西雅圖|纽约|紐約|硅谷|united\s*states|america|los\s*angeles|san\s*jose|seattle|new\s*york|\bUSA?\b|🇺🇸/i],
  ["GB", /英国|英國|伦敦|倫敦|united\s*kingdom|britain|london|\bUK\b|\bGB\b|🇬🇧/i],
  ["DE", /德国|德國|法兰克福|法蘭克福|germany|frankfurt|\bDEU?\b|🇩🇪/i],
  ["FR", /法国|法國|巴黎|france|paris|\bFRA?\b|🇫🇷/i],
  ["NL", /荷兰|荷蘭|阿姆斯特丹|netherlands|amsterdam|\bNLD?\b|🇳🇱/i],
  ["RU", /俄罗斯|俄羅斯|莫斯科|russia|moscow|\bRUS?\b|🇷🇺/i],
  ["AU", /澳大利亚|澳洲|悉尼|australia|sydney|\bAUS?\b|🇦🇺/i],
  ["CA", /加拿大|多伦多|多倫多|温哥华|溫哥華|canada|toronto|vancouver|\bCAN?\b|🇨🇦/i],
  ["IN", /印度|india|mumbai|\bIND?\b|🇮🇳/i],
  ["TR", /土耳其|伊斯坦布尔|turkey|t[uü]rkiye|istanbul|\bTUR\b|\bTR\b|🇹🇷/i],
  ["BR", /巴西|brazil|brasil|\bBRA?\b|🇧🇷/i],
  ["AR", /阿根廷|argentina|\bARG\b|\bAR\b|🇦🇷/i],
  ["MY", /马来西亚|馬來西亞|吉隆坡|malaysia|kuala|\bMYS\b|\bMY\b|🇲🇾/i],
  ["TH", /泰国|泰國|曼谷|thailand|bangkok|\bTHA\b|\bTH\b|🇹🇭/i],
  ["VN", /越南|vietnam|hanoi|\bVNM\b|\bVN\b|🇻🇳/i],
  ["PH", /菲律宾|菲律賓|philippines|manila|\bPHL\b|\bPH\b|🇵🇭/i],
  ["ID", /印尼|印度尼西亚|indonesia|jakarta|\bIDN\b|\bID\b|🇮🇩/i],
  ["AE", /阿联酋|阿聯酋|迪拜|dubai|emirates|\bUAE\b|\bAE\b|🇦🇪/i],
  ["IT", /意大利|義大利|italy|milan|\bITA\b|\bIT\b|🇮🇹/i],
  ["ES", /西班牙|spain|madrid|\bESP\b|\bES\b|🇪🇸/i],
  ["SE", /瑞典|sweden|stockholm|\bSWE\b|\bSE\b|🇸🇪/i],
  ["CH", /瑞士|switzerland|zurich|\bCHE\b|\bCH\b|🇨🇭/i],
  ["PL", /波兰|波蘭|poland|warsaw|\bPOL\b|\bPL\b|🇵🇱/i],
  ["UA", /乌克兰|烏克蘭|ukraine|kyiv|\bUKR\b|\bUA\b|🇺🇦/i],
  ["FI", /芬兰|芬蘭|finland|helsinki|\bFIN\b|\bFI\b|🇫🇮/i],
  ["IE", /爱尔兰|愛爾蘭|ireland|dublin|\bIRL\b|\bIE\b|🇮🇪/i],
  ["ZA", /南非|south\s*africa|\bZAF\b|\bZA\b|🇿🇦/i],
  ["MX", /墨西哥|mexico|\bMEX\b|\bMX\b|🇲🇽/i],
  ["CL", /智利|chile|\bCHL\b|\bCL\b|🇨🇱/i],
  ["CN", /中国|中國|大陆|大陸|china|guangzhou|shanghai|beijing|shenzhen|广州|上海|北京|深圳|杭州|成都|\bCHN\b|🇨🇳/i],
];

/** 从名字猜国家码；猜不出返回空串。 */
export function guessProxySubRegionCode(name: unknown): string {
  const text = String(name ?? "");
  if (!text) return "";
  // 名字里已经有国旗：直接读那两个区域指示符。
  const flag = text.match(/[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]/u);
  if (flag) {
    const code = Array.from(flag[0]).map((char) => String.fromCharCode((char.codePointAt(0) || 0) - 0x1f1e6 + 65)).join("");
    if (/^[A-Z]{2}$/.test(code)) return code;
  }
  for (const [code, pattern] of KEYWORDS) {
    if (pattern.test(text)) return code;
  }
  return "";
}

/** 名字里已经带着的国旗去掉（加旗帜时先清一遍，免得「🇭🇰 🇭🇰 香港」）。 */
export function stripProxySubRegionFlag(name: string): string {
  return String(name || "").replace(/[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]\s*/gu, "").trim();
}
