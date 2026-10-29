import assert from "node:assert/strict";
import test from "node:test";
import { PROXY_SUB_EMPTY_SCOPE } from "../../../../shared/proxySubTokenScope";
import { describeProxySubScope } from "./ProxySubTokenDialogs";

test("内容范围顶上那句：空范围不念，设了什么念什么", () => {
  assert.deepEqual(describeProxySubScope({ ...PROXY_SUB_EMPTY_SCOPE }, []), []);
  const parts = describeProxySubScope({
    ...PROXY_SUB_EMPTY_SCOPE,
    templateIds: [1, 2],
    excludeTemplateIds: [3],
    protocols: ["vless", "trojan"],
    include: "香港|HK",
    excludeDirect: true,
  }, ["HK", "JP"]);
  assert.deepEqual(parts, ["只要 2 个节点", "排除 1 个节点", "协议 VLESS、Trojan", "地区 🇭🇰 香港、🇯🇵 日本", "名字含「香港|HK」", "不要直连"]);
});
