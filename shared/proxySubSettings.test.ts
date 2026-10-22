import assert from "node:assert/strict";
import test from "node:test";

import { applyRulesetMirror, normalizeDomains, parseProxySubSettings, PROXY_SUB_DEFAULT_SETTINGS, serializeProxySubSettings } from "./proxySubSettings";

test("缺的键用默认值；类型按字段解析；越界的数夹回区间", () => {
  const settings = parseProxySubSettings({
    "proxySub.updateIntervalHours": "6",
    "proxySub.deviceLimitEnabled": "true",
    "proxySub.domains": "https://a.example.com/\nb.example.com:8443\n\nnot a url",
    "proxySub.cacheTtlSec": "99999",
    "proxySub.testUrl": "ftp://bad",
    "proxySub.rulesetMirror": "https://ghproxy.example.com/",
  });
  assert.equal(settings.updateIntervalHours, 6);
  assert.equal(settings.deviceLimitEnabled, true);
  assert.deepEqual(settings.domains, ["https://a.example.com", "https://b.example.com:8443"]);
  assert.equal(settings.cacheTtlSec, 3600);
  assert.equal(settings.testUrl, PROXY_SUB_DEFAULT_SETTINGS.testUrl);
  assert.equal(settings.rulesetMirror, "https://ghproxy.example.com");
  assert.equal(settings.rateLimitPerMinute, PROXY_SUB_DEFAULT_SETTINGS.rateLimitPerMinute);
});

test("序列化只写传了的字段，键带 proxySub. 前缀", () => {
  const record = serializeProxySubSettings({ announce: "hi", domains: ["https://x.example.com"], infoNodesDefault: true });
  assert.deepEqual(record, { "proxySub.announce": "hi", "proxySub.domains": "https://x.example.com", "proxySub.infoNodesDefault": "true" });
});

test("备用域名去重、只留 origin、最多十个", () => {
  assert.deepEqual(normalizeDomains(["https://a.example.com/path", "https://a.example.com", "http://b.example.com"]), ["https://a.example.com", "http://b.example.com"]);
  assert.equal(normalizeDomains(Array.from({ length: 20 }, (_item, index) => `https://h${index}.example.com`)).length, 10);
});

test("规则集镜像：替换式和 ghproxy 式都认，panel 和空不改", () => {
  const url = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs";
  assert.equal(applyRulesetMirror(url, ""), url);
  assert.equal(applyRulesetMirror(url, "panel"), url);
  assert.equal(applyRulesetMirror(url, "https://raw.fastgit.org"), "https://raw.fastgit.org/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs");
  assert.equal(applyRulesetMirror(url, "https://ghproxy.example.com"), `https://ghproxy.example.com/${url}`);
  assert.equal(applyRulesetMirror(url, "https://panel.example.com/api/sub/ruleset"), "https://panel.example.com/api/sub/ruleset/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs");
  assert.equal(applyRulesetMirror("https://other.example.com/x", "https://raw.fastgit.org"), "https://other.example.com/x");
});
