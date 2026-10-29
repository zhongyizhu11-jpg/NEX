import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProxySubCustomGroups,
  PROXY_SUB_BUILTIN_PRELUDES,
  PROXY_SUB_TEMPLATE_TARGETS,
  renderProxySubTemplatePrelude,
  validateProxySubTemplate,
} from "./proxySubTemplates";

const vars = { appName: "NEX", panelUrl: "https://p", subUrl: "https://p/api/sub/t", username: 'a"b', expireDate: "2026-12-31", dataLeft: "10 GB", testUrl: "http://t/204", mainGroup: "NEX" };

test("内置模板本身都能通过校验", () => {
  for (const target of PROXY_SUB_TEMPLATE_TARGETS) {
    const verdict = validateProxySubTemplate({ target, prelude: PROXY_SUB_BUILTIN_PRELUDES[target], customGroups: [] });
    assert.ok(verdict.ok, `${target}: ${verdict.ok ? "" : verdict.error}`);
  }
});

test("占位符替换；sing-box 里的值会按 JSON 转义", () => {
  assert.equal(renderProxySubTemplatePrelude("# {{app_name}} · {{username}} · {{test_url}}", vars, "clash"), '# NEX · a"b · http://t/204');
  const json = renderProxySubTemplatePrelude('{"a":"{{username}}","unknown":"{{nope}}"}', vars, "singbox");
  assert.deepEqual(JSON.parse(json), { a: 'a"b', unknown: "{{nope}}" });
  const rendered = renderProxySubTemplatePrelude(PROXY_SUB_BUILTIN_PRELUDES.singbox, vars, "singbox");
  assert.equal(JSON.parse(rendered).dns.servers[0].detour, "NEX");
});

test("校验：Clash 不能带 proxies 等键；sing-box 必须是 JSON 对象；iOS 四家要以 [General] 开头", () => {
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "proxies:\n  - name: x", customGroups: [] }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "mixed-port: 7890\n", customGroups: [] }).ok, true);
  assert.equal(validateProxySubTemplate({ target: "singbox", prelude: "[1,2]", customGroups: [] }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "singbox", prelude: "{not json", customGroups: [] }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "singbox", prelude: '{"log":{"level":"{{username}}"}}', customGroups: [] }).ok, true);
  assert.equal(validateProxySubTemplate({ target: "surge", prelude: "loglevel = notify", customGroups: [] }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "quantumultx", prelude: "[general]\nx=1", customGroups: [] }).ok, true);
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [{ name: "a,b", type: "select", filter: "" }] }).ok, false);
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [{ name: "ok", type: "nope" as any, filter: "" }] }).ok, false);
});

test("自定义组的归一化", () => {
  const groups = normalizeProxySubCustomGroups([{ name: " 香港 ", type: "url-test", filter: "hk|港", includeGroups: "yes" }, { name: "", type: "select" }, { name: "x", type: "bogus" }]);
  assert.deepEqual(groups, [
    { name: "香港", type: "url-test", filter: "hk|港", match: "regex", includeGroups: false },
    { name: "x", type: "select", filter: "", match: "regex", includeGroups: false },
  ]);
  // 关键词模式：认得的留下，认不得的回到正则（老模板没这个字段）。
  assert.equal(normalizeProxySubCustomGroups([{ name: "a", type: "select", match: "all" }])[0].match, "all");
  assert.equal(normalizeProxySubCustomGroups([{ name: "a", type: "select", match: "bogus" }])[0].match, "regex");
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [{ name: "a", type: "select", filter: "regex:(", match: "any" }] }).ok, false, "关键词模式里的正则要合法");
  assert.equal(validateProxySubTemplate({ target: "clash", prelude: "", customGroups: [{ name: "a", type: "select", filter: "香港, !IPLC", match: "all" }] }).ok, true);
});
