import assert from "node:assert/strict";
import test from "node:test";

import { customRulesToRouteRules, formatProxyCustomRules, parseProxyCustomRules } from "./proxySubCustomRules";

test("七种类型都认，注释和空行跳过", () => {
  const text = [
    "# 注释",
    "DOMAIN,example.com,DIRECT",
    "DOMAIN-SUFFIX,OpenAI.com,🤖 AI 服务",
    "DOMAIN-KEYWORD,google,PROXY",
    "",
    "IP-CIDR,10.1.0.0/16,DIRECT,no-resolve",
    "IP-CIDR6,2001:db8::/32,direct",
    "GEOIP,jp,proxy",
    "GEOSITE,netflix,🎥 奈飞视频",
  ].join("\n");
  const parsed = parseProxyCustomRules(text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rules.length, 7);
  assert.equal(parsed.rules[1].value, "openai.com");
  assert.equal(parsed.rules[3].noResolve, true);
  assert.equal(parsed.rules[5].value, "JP");
  assert.equal(parsed.rules[5].target, "PROXY");
  // 去向保留原样（分类组名带 emoji），PROXY 归一成大写。
  assert.equal(parsed.rules[1].target, "🤖 AI 服务");
  assert.equal(parsed.rules[2].target, "PROXY");
});

test("写坏的行报出来，其余照收；没有 /mask 的 IP 补成单个地址", () => {
  const parsed = parseProxyCustomRules([
    "PROCESS-NAME,chrome,DIRECT",
    "DOMAIN,not a domain,DIRECT",
    "IP-CIDR,300.1.1.1/8,DIRECT",
    "IP-CIDR,1.2.3.4,DIRECT",
    "GEOIP,JPN,DIRECT",
    "DOMAIN-SUFFIX,example.com",
    "DOMAIN-SUFFIX,example.com,DIRECT,whatever",
  ].join("\n"));
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].value, "1.2.3.4/32");
  assert.deepEqual(parsed.errors.map((item) => item.line), [1, 2, 3, 5, 6, 7]);
});

test("转成路由规则：PROXY 换主选择器，不认识的组名回落到主选择器", () => {
  const parsed = parseProxyCustomRules("DOMAIN-SUFFIX,a.com,PROXY\nDOMAIN-SUFFIX,b.com,🇭🇰 香港\nDOMAIN-SUFFIX,c.com,不存在的组\nGEOIP,PRIVATE,DIRECT");
  const rules = customRulesToRouteRules(parsed.rules, { mainGroupName: "NEX", knownTargets: new Set(["🇭🇰 香港", "DIRECT", "REJECT"]) });
  assert.deepEqual(rules.map((rule) => rule.target), ["NEX", "🇭🇰 香港", "NEX", "DIRECT"]);
  assert.equal(rules[0].type, "domain");
  assert.equal((rules[3] as any).code, "PRIVATE");
});

test("格式化回文本是规范化后的写法", () => {
  const parsed = parseProxyCustomRules("ip-cidr,10.0.0.0/8,direct,NO-RESOLVE\ndomain-suffix,.Example.COM.,proxy");
  assert.equal(formatProxyCustomRules(parsed.rules), "IP-CIDR,10.0.0.0/8,direct,no-resolve\nDOMAIN-SUFFIX,example.com,PROXY");
});

test("条数有上限", () => {
  const text = Array.from({ length: 502 }, (_item, index) => `DOMAIN,a${index}.com,DIRECT`).join("\n");
  const parsed = parseProxyCustomRules(text, { maxRules: 500 });
  assert.equal(parsed.rules.length, 500);
  assert.equal(parsed.errors.length, 2);
});
