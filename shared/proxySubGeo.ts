/**
 * 订阅「按访客就近」排序（2.3.520）要的几样：访客在哪、节点入口在哪、两点之间多远。
 *
 * 访客的位置只能从面板自带的离线库（ip2region）查：拉订阅的是终端用户，它的 IP 一个都不能发给第三方
 * （server/ipGeoPrivacy.test.ts 钉着这件事）。离线库只给「国家|省|市」，没有经纬度，所以再对到随包带的
 * 城市表（shared/geoCities.ts）上：对得上市就用市，国内对不上市就用省会，再不行就用这个国家在表里的第一个
 * 城市（都是首都或最大的机房城市）。精度到城市就够了 —— 排的是「东京还是洛杉矶更近」，不是两个机房谁近几公里；
 * 美国这种大国查不到城市时只能粗排。
 */

import { GEO_CITIES, type GeoCity } from "./geoCities";

export type ProxySubVisitorGeo = {
  /** ISO 3166-1 alpha-2，大写 */
  countryCode: string;
  lat: number;
  lng: number;
};

/** 离线库查出来的归属地（server/ipRegionOffline.ts 的 OfflineIpRegion 的子集）。 */
export type ProxySubOfflineRegion = {
  countryCode: string;
  region?: string | null;
  city?: string | null;
};

const EARTH_RADIUS_KM = 6371;

/** 两点之间的大圆距离（公里）。 */
export function greatCircleKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 「深圳市」「广东省」「香港特别行政区」→「深圳」「广东」「香港」，好和城市表对。 */
function placeStem(value: unknown): string {
  return String(value || "").trim().toLowerCase()
    .replace(/(特别行政区|自治区|自治州|地区|市|省|县|区)$/u, "")
    .trim();
}

function cityMatches(city: GeoCity, stem: string): boolean {
  if (!stem) return false;
  const name = city.name.toLowerCase();
  const nameEn = city.nameEn.toLowerCase();
  return name === stem || nameEn === stem || name.startsWith(stem) || stem.startsWith(name);
}

/** 离线库常给的是省：市对不上时用省会（只列城市表里有的）。 */
const CN_PROVINCE_CAPITALS: Record<string, string> = {
  广东: "广州", 浙江: "杭州", 江苏: "南京", 四川: "成都", 湖北: "武汉", 福建: "福州", 山东: "济南", 河南: "郑州",
  湖南: "长沙", 陕西: "西安", 广西: "南宁", 云南: "昆明", 贵州: "贵阳", 黑龙江: "哈尔滨", 吉林: "长春", 辽宁: "沈阳",
  新疆: "乌鲁木齐", 西藏: "拉萨", 海南: "海口", 河北: "石家庄", 山西: "太原", 内蒙古: "呼和浩特", 安徽: "合肥",
  江西: "南昌", 甘肃: "兰州", 青海: "西宁", 宁夏: "银川",
};

/**
 * 离线库把香港、澳门、台湾记在「中国」下面（国家代码 CN，省份写「香港特别行政区」「台湾省」）。城市表里它们是
 * 各自的代码：按省份换过来，不然香港的访客会被当成在北京。
 */
const CN_SEPARATE_REGIONS: Record<string, string> = { 香港: "HK", 澳门: "MO", 台湾: "TW" };

function provinceCapital(provinceStem: string): string {
  // 「广西壮族」「宁夏回族」这类带民族名的也认：按开头对。
  const hit = Object.entries(CN_PROVINCE_CAPITALS).find(([province]) => provinceStem.startsWith(province));
  return hit ? hit[1] : "";
}

/**
 * 离线库的归属地 → 一个坐标。先对市，再对省（省会常常就是表里那个城市），最后退到这个国家的第一个城市；
 * 国家不在城市表里就是 null（排序退回按地区）。
 */
export function proxySubVisitorGeoFromRegion(region: ProxySubOfflineRegion | null | undefined): ProxySubVisitorGeo | null {
  let countryCode = String(region?.countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  const provinceStem = placeStem(region?.region);
  if (countryCode === "CN" && CN_SEPARATE_REGIONS[provinceStem]) countryCode = CN_SEPARATE_REGIONS[provinceStem];
  const cities = GEO_CITIES.filter((city) => city.code === countryCode);
  if (cities.length === 0) return null;
  const picked = [placeStem(region?.city), provinceStem, countryCode === "CN" ? provinceCapital(provinceStem) : ""]
    .map((stem) => cities.find((city) => cityMatches(city, stem)))
    .find((city) => !!city) || cities[0];
  return { countryCode, lat: picked.lat, lng: picked.lng };
}

/** 缓存键里的访客格子：国家 + 四舍五入到 1° 的经纬度。同一座城市的访客拿同一份缓存。 */
export function proxySubVisitorBucket(geo: ProxySubVisitorGeo): { cc: string; lat: number; lng: number } {
  return { cc: geo.countryCode, lat: Math.round(geo.lat), lng: Math.round(geo.lng) };
}

/** 主机上存的微度坐标（hosts.geoLatitudeMicro / geoLongitudeMicro）→ 度；缺一个就是没有。 */
export function coordinatesFromMicro(latMicro: unknown, lngMicro: unknown): { lat: number; lng: number } | null {
  const missing = (value: unknown) => value === null || value === undefined || value === "";
  if (missing(latMicro) || missing(lngMicro)) return null;
  const lat = Number(latMicro);
  const lng = Number(lngMicro);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat: lat / 1_000_000, lng: lng / 1_000_000 };
}
