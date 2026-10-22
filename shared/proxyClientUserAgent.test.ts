import assert from "node:assert/strict";
import test from "node:test";

import {
  clientCapabilityReason,
  clientFamilyUnsupportedReason,
  clientSupportsCapability,
  compareClientVersion,
  detectProxyClient,
  proxyClientFamiliesInUserAgentTable,
} from "./proxyClientUserAgent";

/** 每家一个真实样本（来自各客户端源码 / 抓包），认错一家就是一批用户拿到读不懂的格式。 */
const SAMPLES: Array<[string, string, string]> = [
  ["clash-verge/v1.7.7", "mihomo", "clash"],
  ["Clash Verge/2.0.3 (Windows)", "mihomo", "clash"],
  ["mihomo/v1.18.10", "mihomo", "clash"],
  ["clash.meta/1.18.0", "mihomo", "clash"],
  ["FlClash/0.8.70", "mihomo", "clash"],
  ["Mihomo Party/1.5.0", "mihomo", "clash"],
  ["ClashMetaForAndroid/2.11.2.Meta", "mihomo", "clash"],
  ["ClashX Meta/1.4.8", "mihomo", "clash"],
  ["ClashX/1.118.0", "clash-premium", "clash"],
  ["ClashforWindows/0.20.39", "clash-premium", "clash"],
  ["Stash/2.6.0 Clash/1.9.0", "stash", "clash"],
  ["SFA/1.9.3 (sing-box 1.9.3; Android)", "singbox", "singbox"],
  ["sing-box 1.10.0", "singbox", "singbox"],
  ["Karing/1.0.8", "karing", "singbox"],
  ["HiddifyNext/2.5.7 (sing-box 1.9)", "hiddify", "base64"],
  ["NekoBox/1.3.6", "nekobox", "base64"],
  ["Shadowrocket/2070 CFNetwork/1568 Darwin/24.1.0", "shadowrocket", "shadowrocket"],
  ["Quantumult%20X/1.0.30 (iPhone)", "quantumultx", "quantumultx"],
  ["Surge iOS/3000", "surge", "surge"],
  ["Surge Mac/2700", "surge", "surge"],
  ["Surfboard/2.24.0", "surfboard", "surge"],
  ["Egern/1.20", "egern", "surge"],
  ["Loon/700", "loon", "loon"],
  ["v2rayN/6.45", "v2rayn", "v2rayjson"],
  ["v2rayN/6.23", "v2rayn", "base64"],
  ["v2rayNG/1.8.29", "v2rayng", "v2rayjson"],
  ["v2rayNG/1.8.20", "v2rayng", "base64"],
  ["Happ/1.63.1 (iOS)", "happ", "v2rayjson"],
  ["Happ/1.50.0 (iOS)", "happ", "base64"],
  ["Streisand/1.6", "streisand", "base64"],
  ["v2RayTun/4.1.2", "v2raytun", "base64"],
];

test("每家客户端的 UA 都认得出，并给对格式", () => {
  for (const [ua, family, target] of SAMPLES) {
    const client = detectProxyClient(ua);
    assert.equal(client.family, family, ua);
    assert.equal(client.target, target, ua);
  }
});

test("版本号从 UA 里取出来，按数字比较", () => {
  assert.equal(detectProxyClient("v2rayNG/1.8.29").version, "1.8.29");
  assert.equal(detectProxyClient("clash-verge/v1.7.7").version, "1.7.7");
  assert.equal(compareClientVersion("1.8.29", "1.8.3"), 1);
  assert.equal(compareClientVersion("6.40", "6.4"), 1);
  assert.equal(compareClientVersion("1.0", "1.0.0"), 0);
});

test("认不出的 UA：浏览器标成 browser，别的标 unknown，格式交给调用方回落", () => {
  const browser = detectProxyClient("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  assert.equal(browser.family, "browser");
  assert.equal(browser.browser, true);
  assert.equal(browser.target, null);
  const unknown = detectProxyClient("curl/8.4.0");
  assert.equal(unknown.family, "unknown");
  assert.equal(unknown.target, null);
  assert.equal(detectProxyClient("").family, "unknown");
});

test("flag 参数能强制指定客户端，UA 认不出时用它", () => {
  assert.equal(detectProxyClient("curl/8.4.0", "clash").target, "clash");
  assert.equal(detectProxyClient("curl/8.4.0", "qx").family, "quantumultx");
  assert.equal(detectProxyClient("curl/8.4.0", "nonsense").family, "unknown");
});

test("版本门控：低版本不给它没有的协议，版本认不出时不门控", () => {
  assert.equal(clientSupportsCapability({ family: "v2rayng", version: "1.9.0" }, "hysteria2"), false);
  assert.equal(clientSupportsCapability({ family: "v2rayng", version: "1.9.5" }, "hysteria2"), true);
  assert.equal(clientSupportsCapability({ family: "v2rayng", version: "" }, "hysteria2"), true);
  assert.equal(clientSupportsCapability({ family: "mihomo", version: "1.18.0" }, "anytls"), false);
  assert.equal(clientSupportsCapability({ family: "mihomo", version: "1.19.2" }, "xhttp"), true);
  const reason = clientCapabilityReason(detectProxyClient("v2rayNG/1.9.0"), "hysteria2");
  assert.match(reason, /v2rayNG 1\.9\.0 不支持 Hysteria2/);
  assert.equal(clientCapabilityReason(detectProxyClient("v2rayNG/1.9.5"), "hysteria2"), "");
});

test("原版 Clash 整个家族没有 VLESS / REALITY，按家族挡", () => {
  const client = detectProxyClient("ClashX/1.118.0");
  assert.match(clientFamilyUnsupportedReason(client, "vless"), /原版 Clash 不支持 VLESS/);
  assert.equal(clientFamilyUnsupportedReason(detectProxyClient("clash-verge/v1.7.7"), "vless"), "");
});

test("识别表覆盖了全部家族（除了浏览器和未知）", () => {
  const families = new Set(proxyClientFamiliesInUserAgentTable());
  for (const family of ["mihomo", "clash-premium", "stash", "singbox", "karing", "hiddify", "nekobox", "shadowrocket", "quantumultx", "surge", "surfboard", "egern", "loon", "v2rayn", "v2rayng", "happ", "streisand", "v2raytun"]) {
    assert.ok(families.has(family as any), family);
  }
});
