import assert from "node:assert/strict";
import test from "node:test";
import { chinaCarrierOf, DOMESTIC_SPEED_SERVERS, domesticSpeedTestHints } from "./speedTestDomestic";

test("认国内三家运营商：名字优先，认不出看 ASN；云厂商是多线，返回空", () => {
  assert.equal(chinaCarrierOf("Chinanet", ""), "telecom");
  assert.equal(chinaCarrierOf("CHINANET-BACKBONE No.31,Jin-rong Street", "AS4134"), "telecom");
  assert.equal(chinaCarrierOf("China Unicom Guangdong province network", ""), "unicom");
  assert.equal(chinaCarrierOf("CHINANETCOM", ""), "unicom");
  assert.equal(chinaCarrierOf("China Mobile Communications Group Co., Ltd.", ""), "mobile");
  assert.equal(chinaCarrierOf("", "AS9808"), "mobile");
  assert.equal(chinaCarrierOf("", "4837"), "unicom");
  assert.equal(chinaCarrierOf("Shenzhen Tencent Computer Systems Company Limited", "AS45090"), "");
  assert.equal(chinaCarrierOf("Hangzhou Alibaba Advertising Co.,Ltd.", "AS37963"), "");
});

test("只有大陆的主机带国内测速点：按离主机多远排，写成列表接口那个样子", () => {
  assert.equal(domesticSpeedTestHints({ geoCountryCode: "HK" }), null);
  assert.equal(domesticSpeedTestHints({ geoCountryCode: null }), null);

  // 腾讯云广州（Po0）
  const guangzhou = domesticSpeedTestHints({ geoCountryCode: "cn", geoLatitudeMicro: 23127361, geoLongitudeMicro: 113264570, geoIsp: "Shenzhen Tencent Computer Systems Company Limited", geoAsn: "AS45090" })!;
  assert.equal(guangzhou.carrier, "");
  assert.equal(guangzhou.servers.length, DOMESTIC_SPEED_SERVERS.length);
  assert.equal(guangzhou.servers[0].host, "hntelecom5g.cn:8080");
  assert.ok(guangzhou.servers[0].distanceKm > 500 && guangzhou.servers[0].distanceKm < 650, String(guangzhou.servers[0].distanceKm));
  for (let i = 1; i < guangzhou.servers.length; i++) assert.ok(guangzhou.servers[i - 1].distanceKm <= guangzhou.servers[i].distanceKm);
  assert.deepEqual(
    guangzhou.servers.find((item) => item.host === "speedtest1.online.sh.cn:8080"),
    { url: "http://speedtest1.online.sh.cn:8080/speedtest/upload.php", host: "speedtest1.online.sh.cn:8080", name: "上海", sponsor: "上海电信", cc: "CN", distanceKm: guangzhou.servers.find((item) => item.host === "speedtest1.online.sh.cn:8080")!.distanceKm },
  );

  // 不知道在哪：不排、距离写 0；运营商从 ASN 认
  const unknown = domesticSpeedTestHints({ geoCountryCode: "CN", geoAsn: "AS4134" })!;
  assert.equal(unknown.carrier, "telecom");
  assert.equal(unknown.servers[0].host, DOMESTIC_SPEED_SERVERS[0].host);
  assert.ok(unknown.servers.every((item) => item.distanceKm === 0));
});

test("列表本身：host:port 不重复、三家都有", () => {
  const hosts = DOMESTIC_SPEED_SERVERS.map((item) => item.host);
  assert.equal(new Set(hosts).size, hosts.length);
  for (const host of hosts) assert.match(host, /^[a-z0-9.-]+:\d+$/);
  for (const carrier of ["telecom", "unicom", "mobile"] as const) assert.ok(DOMESTIC_SPEED_SERVERS.some((item) => item.carrier === carrier), carrier);
});
