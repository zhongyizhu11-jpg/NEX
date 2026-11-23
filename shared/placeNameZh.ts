import { GEO_CITIES, geoCountryNameZh, type GeoCity } from "./geoCities";

/**
 * 地图上给人看的地名，一律中文。
 *
 * 主机的位置有两个来源：按 IP 自动查（geoRegion 多半是英文的省 / 州：「Guangdong」「New South Wales」
 * 「Taipei City」，几家服务都是 region 优先、没有才给 city）和手动选城市（存的是城市表里的中文名）。
 * 以前图上直接写 geoRegion，于是「Guangdong · 香港 ×4」这种中英混排。这里按下面的顺序换成中文：
 *
 *   1. 手动定位的、或者本来就是中文的 —— 原样
 *   2. region 正好是城市表（shared/geoCities）里的城市（「Hong Kong」「Taipei City」→ 香港、台北）；
 *      有坐标时还得离这个城市不远（「Washington」州的机器在西雅图，不写成华盛顿）
 *   3. 坐标离同一国家里最近的城市不到 150 km —— 用那个城市（IP 服务给的坐标是城市级的，比省名准；
 *      悉尼的机器 region 是「New South Wales」，图上写「悉尼」）
 *   4. region 是常见的省 / 州 / 都道府县 —— 查下面那张英中对照表（「Guangdong」→ 广东）
 *   5. 国家 / 地区的中文名（城市表的国名，没有就问浏览器的 Intl.DisplayNames）
 *   6. 都不行才写原文
 *
 * 纯函数（Intl 在 node 里也有），在 node 里测。
 */

export type PlaceInput = {
  countryCode?: string | null;
  region?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** 手动定位：region 是用户选的中文城市名或自己写的名字，不改 */
  manual?: boolean | null;
};

/** 坐标离城市多近才算「就是这个城市」：机房常在城郊、IP 服务的坐标也只到城市级 */
const PLACE_NEAREST_CITY_KM = 150;

/**
 * 常被 IP 定位写进 region 的省 / 州 → 中文。键是 normalizeRegionKey 之后的样子（小写、去掉
 * 「Province」「City」「Prefecture」这类后缀）。只收常见的：中国各省区、港澳台、美国各州、
 * 澳大利亚各州、日本都道府县，再加几个机房多的国家的大区；城市级的名字走城市表。
 */
const REGION_ZH: Record<string, string> = {
  // 中国
  beijing: "北京", tianjin: "天津", shanghai: "上海", chongqing: "重庆",
  hebei: "河北", shanxi: "山西", shaanxi: "陕西", liaoning: "辽宁", jilin: "吉林", heilongjiang: "黑龙江",
  jiangsu: "江苏", zhejiang: "浙江", anhui: "安徽", fujian: "福建", jiangxi: "江西", shandong: "山东",
  henan: "河南", hubei: "湖北", hunan: "湖南", guangdong: "广东", hainan: "海南", sichuan: "四川",
  guizhou: "贵州", yunnan: "云南", gansu: "甘肃", qinghai: "青海",
  guangxi: "广西", "inner mongolia": "内蒙古", "nei mongol": "内蒙古", tibet: "西藏", xizang: "西藏",
  ningxia: "宁夏", xinjiang: "新疆",
  "hong kong": "香港", hongkong: "香港", macau: "澳门", macao: "澳门", taiwan: "台湾",
  // 台湾的县市（Taipei City 这种城市表里有的会先在城市表里命中）
  keelung: "基隆", yilan: "宜兰", hualien: "花莲", taitung: "台东", pingtung: "屏东", miaoli: "苗栗",
  nantou: "南投", yunlin: "云林", chiayi: "嘉义",
  // 美国
  alabama: "亚拉巴马", alaska: "阿拉斯加", arizona: "亚利桑那", arkansas: "阿肯色", california: "加利福尼亚",
  colorado: "科罗拉多", connecticut: "康涅狄格", delaware: "特拉华", florida: "佛罗里达", georgia: "佐治亚",
  hawaii: "夏威夷", idaho: "爱达荷", illinois: "伊利诺伊", indiana: "印第安纳", iowa: "艾奥瓦", kansas: "堪萨斯",
  kentucky: "肯塔基", louisiana: "路易斯安那", maine: "缅因", maryland: "马里兰", massachusetts: "马萨诸塞",
  michigan: "密歇根", minnesota: "明尼苏达", mississippi: "密西西比", missouri: "密苏里", montana: "蒙大拿",
  nebraska: "内布拉斯加", nevada: "内华达", "new hampshire": "新罕布什尔", "new jersey": "新泽西",
  "new mexico": "新墨西哥", "new york": "纽约", "north carolina": "北卡罗来纳", "north dakota": "北达科他",
  ohio: "俄亥俄", oklahoma: "俄克拉何马", oregon: "俄勒冈", pennsylvania: "宾夕法尼亚", "rhode island": "罗得岛",
  "south carolina": "南卡罗来纳", "south dakota": "南达科他", tennessee: "田纳西", texas: "得克萨斯", utah: "犹他",
  vermont: "佛蒙特", virginia: "弗吉尼亚", washington: "华盛顿", "west virginia": "西弗吉尼亚",
  wisconsin: "威斯康星", wyoming: "怀俄明", "district of columbia": "华盛顿特区",
  // 澳大利亚
  "new south wales": "新南威尔士", victoria: "维多利亚", queensland: "昆士兰", "western australia": "西澳大利亚",
  "south australia": "南澳大利亚", tasmania: "塔斯马尼亚", "northern territory": "北领地",
  "australian capital territory": "澳大利亚首都领地",
  // 日本（都道府县，IP 服务写「Tokyo」「Osaka」，也有带 -to / -fu / -ken 的）
  hokkaido: "北海道", aomori: "青森", iwate: "岩手", miyagi: "宫城", akita: "秋田", yamagata: "山形", fukushima: "福岛",
  ibaraki: "茨城", tochigi: "栃木", gunma: "群马", saitama: "埼玉", chiba: "千叶", tokyo: "东京", kanagawa: "神奈川",
  niigata: "新潟", toyama: "富山", ishikawa: "石川", fukui: "福井", yamanashi: "山梨", nagano: "长野", gifu: "岐阜",
  shizuoka: "静冈", aichi: "爱知", mie: "三重", shiga: "滋贺", kyoto: "京都", osaka: "大阪", hyogo: "兵库", nara: "奈良",
  wakayama: "和歌山", tottori: "鸟取", shimane: "岛根", okayama: "冈山", hiroshima: "广岛", yamaguchi: "山口",
  tokushima: "德岛", kagawa: "香川", ehime: "爱媛", kochi: "高知", fukuoka: "福冈", saga: "佐贺", nagasaki: "长崎",
  kumamoto: "熊本", oita: "大分", miyazaki: "宫崎", kagoshima: "鹿儿岛", okinawa: "冲绳",
  // 韩国、加拿大、德国、英国、新加坡 —— 机房多的几个大区
  seoul: "首尔", gyeonggi: "京畿道", incheon: "仁川", busan: "釜山",
  ontario: "安大略", quebec: "魁北克", "british columbia": "不列颠哥伦比亚", alberta: "艾伯塔",
  hesse: "黑森", hessen: "黑森", bavaria: "巴伐利亚", bayern: "巴伐利亚", "north rhine-westphalia": "北莱茵-威斯特法伦",
  "nordrhein-westfalen": "北莱茵-威斯特法伦", berlin: "柏林", england: "英格兰", scotland: "苏格兰", wales: "威尔士",
  "central singapore": "新加坡", singapore: "新加坡",
};

/** region 的比较键：小写、去重音、去掉行政区划后缀（「Taipei City」「Guangdong Province」「Tokyo-to」） */
export function normalizeRegionKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`.]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(special administrative region|autonomous region|zhuang|hui|uyghur|uygur|province|prefecture|municipality|metropolis|city|county|state|region|sar)\b/g, "")
    .replace(/-(to|fu|ken|do)$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CJK = /[㐀-鿿]/;

function hasCjk(value: string) {
  return CJK.test(value);
}

/** 两点之间的大圆距离（km） */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR;
  const dLng = (bLng - aLng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 离坐标最近的城市（国家给了就只在这个国家里找），超过 maxKm 返回 null */
export function nearestGeoCity(lat: number, lng: number, countryCode?: string | null, maxKm = PLACE_NEAREST_CITY_KM): GeoCity | null {
  const code = String(countryCode || "").trim().toUpperCase();
  let best: GeoCity | null = null;
  let bestKm = Infinity;
  for (const city of GEO_CITIES) {
    if (code && city.code !== code) continue;
    const km = distanceKm(lat, lng, city.lat, city.lng);
    if (km < bestKm) { bestKm = km; best = city; }
  }
  return best && bestKm <= maxKm ? best : null;
}

/** region 是城市表里的哪个城市（中英文名都认，后缀去掉再比） */
function cityByRegion(region: string, countryCode: string): GeoCity | null {
  const lower = region.trim().toLowerCase();
  const key = normalizeRegionKey(region);
  const pool = countryCode ? GEO_CITIES.filter((city) => city.code === countryCode) : GEO_CITIES;
  return pool.find((city) => city.nameEn.toLowerCase() === lower || city.name === region.trim())
    ?? pool.find((city) => normalizeRegionKey(city.nameEn) === key)
    ?? null;
}

let displayNames: Intl.DisplayNames | null | undefined;

/**
 * 国家 / 地区的中文名：先查城市表那份国名（「中国香港」这种去掉「中国」，图上就写「香港」「台湾」），
 * 没有再问浏览器（Intl.DisplayNames zh-CN）。都不认识返回 null。
 */
export function countryNameZh(countryCode: string | null | undefined): string | null {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const bundled = geoCountryNameZh(code);
  if (bundled && bundled !== code) return bundled.replace(/^中国(?=香港|澳门|台湾)/, "");
  if (displayNames === undefined) {
    // fallback: "none"：不认识的代码给 undefined，不给原样的「XQ」
    try { displayNames = new Intl.DisplayNames(["zh-CN"], { type: "region", fallback: "none" }); } catch { displayNames = null; }
  }
  try {
    const name = displayNames?.of(code);
    if (name && name !== code) return name.replace(/特别行政区$/, "").replace(/^中国(?=香港|澳门|台湾)/, "");
  } catch { /* 不认识的代码 */ }
  return null;
}

/** 按上面的顺序挑一个中文地名；什么都没有返回 null */
export function resolvePlaceNameZh(input: PlaceInput): string | null {
  const region = String(input.region || "").trim();
  const code = String(input.countryCode || "").trim().toUpperCase();
  if (region && (input.manual || hasCjk(region))) return region;
  const point = typeof input.lat === "number" && typeof input.lng === "number" && Number.isFinite(input.lat) && Number.isFinite(input.lng)
    ? { lat: input.lat, lng: input.lng }
    : null;
  if (region) {
    // 同名的州和城市（region 是「Washington」州、坐标在西雅图）：坐标离这个城市太远就不认它，往下按坐标找
    const city = cityByRegion(region, code);
    if (city && (!point || distanceKm(point.lat, point.lng, city.lat, city.lng) <= PLACE_NEAREST_CITY_KM)) return city.name;
  }
  if (point) {
    const city = nearestGeoCity(point.lat, point.lng, code || null);
    if (city) return city.name;
  }
  if (region) {
    const zh = REGION_ZH[normalizeRegionKey(region)] ?? REGION_ZH[region.trim().toLowerCase()];
    if (zh) return zh;
  }
  const country = countryNameZh(code);
  if (country) return country;
  return region || null;
}

/** 主机 / 落地目标那一行定位字段（微度坐标）→ 中文地名 */
export function hostPlaceNameZh(host: {
  geoManual?: boolean | null;
  geoCountryCode?: string | null;
  geoRegion?: string | null;
  geoLatitudeMicro?: number | null;
  geoLongitudeMicro?: number | null;
} | null | undefined): string | null {
  if (!host) return null;
  const lat = host.geoLatitudeMicro != null && Number.isFinite(Number(host.geoLatitudeMicro)) ? Number(host.geoLatitudeMicro) / 1e6 : null;
  const lng = host.geoLongitudeMicro != null && Number.isFinite(Number(host.geoLongitudeMicro)) ? Number(host.geoLongitudeMicro) / 1e6 : null;
  return resolvePlaceNameZh({ countryCode: host.geoCountryCode, region: host.geoRegion, lat, lng, manual: !!host.geoManual });
}
