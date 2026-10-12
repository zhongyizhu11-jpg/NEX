/*
  地区规则（#4）用的国家 / 地区代码表：ISO 3166-1 alpha-2。

  只放代码，不另带一份中文名表 —— 中文名走 shared/placeNameZh 的 countryNameZh
  （城市表里的国名，没有再问 Intl.DisplayNames zh-CN），和地图那边叫法一致。
  服务端用这张表校验输入：代码会拼进下载地址，不在表里的一律不收。
*/
import { countryNameZh } from "./placeNameZh";

export const FIREWALL_COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ "
  + "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR "
  + "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP "
  + "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT "
  + "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW "
  + "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG "
  + "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** 选择框里排在最前面的那几个：用这个面板的人最常挑的。 */
export const FIREWALL_COMMON_COUNTRIES: readonly string[] = [
  "CN", "HK", "TW", "MO", "US", "JP", "KR", "SG", "RU", "DE", "GB", "FR", "NL", "CA", "AU",
  "IN", "VN", "TH", "MY", "ID", "PH", "BR", "IR", "TR", "UA",
];

const CODE_SET = new Set(FIREWALL_COUNTRY_CODES);

export function isFirewallCountryCode(value: unknown): boolean {
  return typeof value === "string" && CODE_SET.has(value.toUpperCase());
}

/** 去重、大写、只留认识的代码、排序。 */
export function normalizeFirewallCountries(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    const code = String(item || "").trim().toUpperCase();
    if (CODE_SET.has(code)) out.add(code);
  }
  return Array.from(out).sort();
}

export function countryFlagEmoji(code: string | null | undefined): string {
  const text = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(text)) return "";
  return Array.from(text).map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65)).join("");
}

/** 「🇭🇰 香港」这样的显示名；不认识的代码原样返回。 */
export function firewallCountryLabel(code: string): string {
  const name = countryNameZh(code) || code;
  const flag = countryFlagEmoji(code);
  return flag ? `${flag} ${name}` : name;
}

export function firewallCountryName(code: string): string {
  return countryNameZh(code) || code;
}

export type FirewallMode = "off" | "block" | "allow";
export const FIREWALL_MODES: readonly FirewallMode[] = ["off", "block", "allow"] as const;

/** 主机单独的设置：跟随全局 / 本机单独规则 / 本机不限制。 */
export type FirewallHostPolicy = "follow" | "custom" | "off";
export const FIREWALL_HOST_POLICIES: readonly FirewallHostPolicy[] = ["follow", "custom", "off"] as const;

/** 封禁时长。 */
export type FirewallBlockExpiry = "1h" | "1d" | "7d" | "forever";
export const FIREWALL_BLOCK_EXPIRY_SECONDS: Record<FirewallBlockExpiry, number | null> = {
  "1h": 3600,
  "1d": 86400,
  "7d": 7 * 86400,
  forever: null,
};

/** 能用地区规则 / IP 封禁的最低 Agent 版本（扩展通道，见 server/ops/agentExt.ts）。 */
export const FIREWALL_MIN_AGENT_VERSION = "2.2.216";

/** 国家 IP 段的出处，界面底部注明。 */
export const FIREWALL_COUNTRY_DATA_ATTRIBUTION =
  "国家 IP 段来自 ipdeny.com；下载不到时改用 GitHub 上的 ipverse/country-ip-blocks（CC0，数据源自各大洲 RIR）。开了 GitHub 加速时先走加速地址。";
