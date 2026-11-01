/*
  大陆主机测速用的国内测速点（Agent 2.2.248 起）。

  speedtest.net 在大陆连不上（Agent 取服务器列表超时），它的列表接口对境外来的请求又不给大陆的测速点（面板在
  境外，替 Agent 去拿也拿不到），所以国内机器以前只能退到「测到面板」：量的是出境到面板那一段，几台都是二三十
  Mbps，不是机器自己的带宽。

  这里放一份国内三网的 Ookla 测速点：运营商自己架的 OoklaServer（8080 端口，/speedtest/latency.txt、
  random*.jpg、upload.php，和列表接口给的一样测），测大陆的主机（geoCountryCode = CN）时随指令带下去。Agent
  一边等列表接口一边把这份全 ping 一遍，挑同运营商里延迟最低的测；列表接口给的境外测速点不要（过了墙测出来的
  是出境那一段）。只测这台机器自己（经节点、测线路时出去的是落地，用不上）。

  列表会过时：连不上的 Agent 自己跳过；全挂了照旧退到 Cloudflare / 面板，并写明原因。
*/
import { distanceKm } from "../../shared/placeNameZh";

export type ChinaCarrier = "telecom" | "unicom" | "mobile";

type DomesticServer = {
  /** host:port */
  host: string;
  sponsor: string;
  city: string;
  carrier: ChinaCarrier;
  lat: number;
  lon: number;
};

const SHANGHAI = [31.2304, 121.4737] as const;
const CHENGDU = [30.5728, 104.0668] as const;
const HANGZHOU = [30.2741, 120.1551] as const;

function server(host: string, sponsor: string, city: string, carrier: ChinaCarrier, [lat, lon]: readonly [number, number]): DomesticServer {
  return { host, sponsor, city, carrier, lat, lon };
}

/** 国内三网的 Ookla 测速点（2026-10 核对过还在列表里的）。 */
export const DOMESTIC_SPEED_SERVERS: readonly DomesticServer[] = [
  server("speedtest1.online.sh.cn:8080", "上海电信", "上海", "telecom", SHANGHAI),
  server("4gsuzhou1.speedtest.jsinfo.net:8080", "江苏电信 5G", "苏州", "telecom", [31.2989, 120.5853]),
  server("5gnanjing.speedtest.jsinfo.net:8080", "江苏电信 5G", "南京", "telecom", [32.0603, 118.7969]),
  server("5gzhenjiang.speedtest.jsinfo.net:8080", "江苏电信 5G", "镇江", "telecom", [32.1878, 119.425]),
  server("cesu-hz.zjtelecom.com.cn:8080", "浙江电信", "杭州", "telecom", HANGZHOU),
  server("cesu-nb.zjtelecom.com.cn:8080", "浙江电信", "宁波", "telecom", [29.8683, 121.544]),
  server("vipspeedtest8.wuhan.net.cn:8080", "湖北电信 5G", "武汉", "telecom", [30.5928, 114.3055]),
  server("hntelecom5g.cn:8080", "湖南电信 5G", "长沙", "telecom", [28.2282, 112.9388]),
  server("speedtest1.sc.189.cn:8080", "四川电信", "成都", "telecom", CHENGDU),
  server("mobile.shunicomtest.com:8080", "上海联通 5G", "上海", "unicom", SHANGHAI),
  server("5g.shunicomtest.com:8080", "上海联通 5G", "上海", "unicom", SHANGHAI),
  server("beijing.unicomtest.com:8080", "北京联通", "北京", "unicom", [39.9042, 116.4074]),
  server("speedtest3.online.tj.cn:8080", "天津联通", "天津", "unicom", [39.3434, 117.3616]),
  server("cuscspeed.169ol.com:8080", "四川联通", "成都", "unicom", CHENGDU),
  server("mycuspeed.169ol.com:8080", "四川联通", "绵阳", "unicom", [31.4675, 104.6796]),
  server("speedtest.139play.com:8080", "浙江移动", "杭州", "mobile", HANGZHOU),
  server("speedtest.jsqiuying.com:8080", "江苏移动", "苏州", "mobile", [31.2989, 120.5853]),
  server("csfw.fj.chinamobile.com:8080", "福建移动", "福州", "mobile", [26.0745, 119.2965]),
  server("speedtest1.sc.chinamobile.com:8080", "四川移动", "成都", "mobile", CHENGDU),
];

const TELECOM_ASNS = new Set([4134, 4809, 4811, 4812, 4813, 4816, 23724, 134773, 134774, 136188, 140292]);
const UNICOM_ASNS = new Set([4837, 9929, 4808, 17621, 17622, 17623, 17816, 9800, 10099]);
const MOBILE_ASNS = new Set([9808, 56040, 56041, 56042, 56044, 56046, 56047, 56048, 24400, 24445, 9394, 58453, 58807]);

/**
 * 认国内三家运营商：先看 IP 归属的运营商名字，认不出再看 ASN。云厂商（腾讯云、阿里云……）是多线 BGP，返回空，
 * Agent 就只按延迟挑。
 */
export function chinaCarrierOf(isp: unknown, asn: unknown): ChinaCarrier | "" {
  const name = String(isp || "").toLowerCase();
  // 联通先认：老名字 China Netcom / CHINANETCOM 里也有 chinanet
  if (/unicom|china169|cncgroup|china ?netcom|联通/.test(name)) return "unicom";
  if (/chinanet|china ?telecom|电信/.test(name)) return "telecom";
  if (/china ?mobile|cmnet|cmcc|tietong|移动|铁通/.test(name)) return "mobile";
  const number = Number(String(asn || "").replace(/^AS/i, ""));
  if (TELECOM_ASNS.has(number)) return "telecom";
  if (UNICOM_ASNS.has(number)) return "unicom";
  if (MOBILE_ASNS.has(number)) return "mobile";
  return "";
}

export type SpeedTestHints = {
  carrier: ChinaCarrier | "";
  /** 和 speedtest.net 列表里一条一个样子（Agent 照列表的那套测）。 */
  servers: { url: string; host: string; name: string; sponsor: string; cc: "CN"; distanceKm: number }[];
};

type HostGeo = {
  geoCountryCode?: unknown;
  geoLatitudeMicro?: unknown;
  geoLongitudeMicro?: unknown;
  geoIsp?: unknown;
  geoOrg?: unknown;
  geoAsn?: unknown;
};

/** 大陆的主机测自己时带给 Agent 的：国内测速点（知道主机在哪就按距离排，带上多远）和运营商。别的返回 null。 */
export function domesticSpeedTestHints(host: HostGeo): SpeedTestHints | null {
  if (String(host.geoCountryCode || "").trim().toUpperCase() !== "CN") return null;
  const latMicro = Number(host.geoLatitudeMicro);
  const lonMicro = Number(host.geoLongitudeMicro);
  const located = host.geoLatitudeMicro != null && host.geoLongitudeMicro != null && Number.isFinite(latMicro) && Number.isFinite(lonMicro) && !(latMicro === 0 && lonMicro === 0);
  const servers = DOMESTIC_SPEED_SERVERS.map((item) => ({
    url: `http://${item.host}/speedtest/upload.php`,
    host: item.host,
    name: item.city,
    sponsor: item.sponsor,
    cc: "CN" as const,
    distanceKm: located ? Math.round(distanceKm(latMicro / 1e6, lonMicro / 1e6, item.lat, item.lon)) : 0,
  }));
  if (located) servers.sort((a, b) => a.distanceKm - b.distanceKm);
  return { carrier: chinaCarrierOf(host.geoIsp || host.geoOrg, host.geoAsn), servers };
}
