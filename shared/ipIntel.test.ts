import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIpIntelFamilyView,
  ipIntelHttpReason,
  ipRiskLevel,
  judgeNativeIp,
  normalizeIpType,
  normalizeStoredIpIntelInfo,
  parseAbuseIpdb,
  parseIpapiIs,
  parseIpinfo,
  parseProxycheck,
  parseRipestatCountry,
  type IpIntelProviderResult,
} from "./ipIntel";

// 各家响应的样例（照官方文档的形状裁剪，地址用文档保留段）
const IPAPI_IS = {
  ip: "203.0.113.7",
  is_mobile: false,
  is_datacenter: true,
  is_tor: false,
  is_proxy: false,
  is_vpn: false,
  is_abuser: false,
  company: { name: "Example Hosting", abuser_score: "0.0039 (Low)", type: "hosting" },
  asn: { asn: 64500, org: "Example Hosting LLC", country: "us", type: "hosting", abuser_score: "0.01 (Low)" },
  location: { country_code: "JP", state: "Tokyo", city: "Tokyo", timezone: "Asia/Tokyo" },
};
const IPINFO_FREE = { ip: "203.0.113.7", city: "Tokyo", region: "Tokyo", country: "JP", org: "AS64500 Example Hosting LLC", timezone: "Asia/Tokyo" };
const PROXYCHECK = {
  status: "ok",
  "203.0.113.7": { asn: "AS64500", provider: "Example Hosting LLC", isocode: "JP", city: "Tokyo", proxy: "no", type: "Hosting", risk: 33 },
};
const ABUSEIPDB = { data: { ipAddress: "203.0.113.7", abuseConfidenceScore: 72, countryCode: "JP", usageType: "Data Center/Web Hosting/Transit", isp: "Example Hosting", totalReports: 18, isTor: false } };
const RIPESTAT = { status: "ok", data: { resource: "203.0.113.7", located_resources: [{ resource: "203.0.113.0/24", location: "US" }] } };

function ok(provider: IpIntelProviderResult["provider"], info: any): IpIntelProviderResult {
  return { provider, family: 4, via: "agent", address: "203.0.113.7", checkedAt: 1000, ok: true, reason: null, info };
}

test("ipapi.is：基础信息、类型、滥用分折成 0~100、ASN 注册国家算弱证据", () => {
  const parsed = parseIpapiIs(JSON.stringify(IPAPI_IS));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.info.asn, "AS64500");
  assert.equal(parsed.info.countryCode, "JP");
  assert.equal(parsed.info.city, "Tokyo");
  assert.equal(parsed.info.regCountryCode, "US");
  assert.equal(parsed.info.regLevel, "asn");
  assert.equal(parsed.info.ipType, "datacenter");
  assert.equal(parsed.info.riskScore, 0);
  assert.equal(parsed.info.flags.hosting, true);
  assert.equal(parseIpapiIs({ error: "Rate limit exceeded" }).ok, false);
  assert.equal(parseIpapiIs("<html>").ok, false);
  const mobile = parseIpapiIs({ ...IPAPI_IS, is_mobile: true, company: { type: "isp" } });
  assert.equal(mobile.ok && mobile.info.ipType, "mobile");
});

test("IPinfo 免费版：org 里拆出 ASN；bogon 不当结果", () => {
  const parsed = parseIpinfo(IPINFO_FREE);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.info.asn, "AS64500");
  assert.equal(parsed.info.org, "Example Hosting LLC");
  assert.equal(parsed.info.ipType, null, "免费版没有类型就是 null，不猜");
  assert.equal(parseIpinfo({ ip: "10.0.0.1", bogon: true }).ok, false);
  const paid = parseIpinfo({ ...IPINFO_FREE, asn: { asn: "AS64501", name: "Paid", type: "isp" }, privacy: { vpn: true, proxy: false, tor: false, hosting: false } });
  assert.ok(paid.ok && paid.info.asn === "AS64501" && paid.info.ipType === "residential" && paid.info.flags.vpn === true);
});

test("proxycheck：结果挂在 IP 键下；denied 是失败不是结论", () => {
  const parsed = parseProxycheck(PROXYCHECK, "203.0.113.7");
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.info.riskScore, 33);
  assert.equal(parsed.info.ipType, "datacenter");
  assert.equal(parsed.info.flags.proxy, false);
  assert.equal(parsed.info.countryCode, "JP");
  const denied = parseProxycheck({ status: "denied", message: "1000 free queries exhausted" }, "203.0.113.7");
  assert.equal(denied.ok, false);
  assert.match(!denied.ok ? denied.reason : "", /exhausted/);
});

test("AbuseIPDB、RIPEstat", () => {
  const abuse = parseAbuseIpdb(ABUSEIPDB);
  assert.ok(abuse.ok && abuse.info.riskScore === 72 && abuse.info.ipType === "datacenter" && abuse.info.flags.abuser === true);
  assert.equal(parseAbuseIpdb({ errors: [{ detail: "Authentication failed", status: 401 }] }).ok, false);
  const ripe = parseRipestatCountry(RIPESTAT);
  assert.ok(ripe.ok && ripe.info.regCountryCode === "US" && ripe.info.regLevel === "ip");
  assert.equal(parseRipestatCountry({ status: "ok", data: { located_resources: [] } }).ok, false);
});

test("类型归一：各家写法 → 家宽 / 机房 / 商业 / 移动 …", () => {
  assert.equal(normalizeIpType("Fixed Line ISP"), "residential");
  assert.equal(normalizeIpType("Mobile ISP"), "mobile");
  assert.equal(normalizeIpType("Wireless"), "mobile");
  assert.equal(normalizeIpType("Residential"), "residential");
  assert.equal(normalizeIpType("isp"), "residential");
  assert.equal(normalizeIpType("Business"), "business");
  assert.equal(normalizeIpType("Commercial"), "business");
  assert.equal(normalizeIpType("hosting"), "datacenter");
  assert.equal(normalizeIpType("University/College/School"), "education");
  assert.equal(normalizeIpType("Content Delivery Network"), "cdn");
  assert.equal(normalizeIpType("government"), "government");
  assert.equal(normalizeIpType("Search Engine Spider"), "other");
  assert.equal(normalizeIpType(""), null);
  assert.equal(ipRiskLevel(0), "low");
  assert.equal(ipRiskLevel(50), "medium");
  assert.equal(ipRiskLevel(90), "high");
  assert.equal(ipRiskLevel(null), null);
});

test("原生 / 广播：使用地 vs 注册地，证据列出来；不够或矛盾就待确认", () => {
  const ipapi = parseIpapiIs(IPAPI_IS);
  const ripe = parseRipestatCountry(RIPESTAT);
  const ipinfo = parseIpinfo(IPINFO_FREE);
  assert.ok(ipapi.ok && ripe.ok && ipinfo.ok);
  if (!ipapi.ok || !ripe.ok || !ipinfo.ok) return;

  const broadcast = judgeNativeIp([ok("ipapi_is", ipapi.info), ok("ipinfo", ipinfo.info), ok("ripestat", ripe.info)]);
  assert.equal(broadcast.verdict, "broadcast");
  assert.equal(broadcast.usageCountry, "JP");
  assert.equal(broadcast.registrationCountry, "US");
  assert.ok(broadcast.evidence.some((item) => item.provider === "ripestat" && item.kind === "registration" && item.level === "ip"));

  const nativeRipe = parseRipestatCountry({ status: "ok", data: { located_resources: [{ location: "JP" }] } });
  assert.ok(nativeRipe.ok);
  if (!nativeRipe.ok) return;
  assert.equal(judgeNativeIp([ok("ipapi_is", ipapi.info), ok("ripestat", nativeRipe.info)]).verdict, "native");

  // 没有 RIPEstat：退到 ipapi.is 的 ASN 注册国家，并说明证据较弱
  const weak = judgeNativeIp([ok("ipapi_is", ipapi.info)]);
  assert.equal(weak.verdict, "broadcast");
  assert.match(weak.reason, /证据较弱/);

  // 使用地互相矛盾 → 待确认
  const conflict = judgeNativeIp([ok("ipapi_is", ipapi.info), ok("ipinfo", { ...ipinfo.info, countryCode: "SG" }), ok("ripestat", ripe.info)]);
  assert.equal(conflict.verdict, "unknown");
  assert.match(conflict.reason, /不一致/);

  // 只有失败的结果 → 待确认，不是结论
  const failed: IpIntelProviderResult = { provider: "ipapi_is", family: 4, via: "agent", address: null, checkedAt: 1, ok: false, reason: "被限流（HTTP 429）", info: null };
  assert.equal(judgeNativeIp([failed]).verdict, "unknown");
});

test("一个协议族的汇总视图：按数据源排序、基础信息取第一家有的；存库的读回来", () => {
  const ipinfo = parseIpinfo(IPINFO_FREE);
  const proxy = parseProxycheck(PROXYCHECK, "203.0.113.7");
  assert.ok(ipinfo.ok && proxy.ok);
  if (!ipinfo.ok || !proxy.ok) return;
  const view = buildIpIntelFamilyView(4, "203.0.113.7", [
    ok("proxycheck", proxy.info),
    ok("ipinfo", ipinfo.info),
    { ...ok("ipinfo", ipinfo.info), family: 6 },
  ]);
  assert.deepEqual(view.providers.map((item) => item.provider), ["ipinfo", "proxycheck"]);
  assert.equal(view.basic.asn, "AS64500");
  assert.equal(view.basic.source, "ipinfo");
  assert.equal(view.checkedAt, 1000);

  const roundTrip = normalizeStoredIpIntelInfo(JSON.parse(JSON.stringify(proxy.info)));
  assert.deepEqual(roundTrip, proxy.info);
  assert.equal(normalizeStoredIpIntelInfo("not json"), null);
  assert.equal(ipIntelHttpReason(200), null);
  assert.match(ipIntelHttpReason(429) || "", /限流/);
});
