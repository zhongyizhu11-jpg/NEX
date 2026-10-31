import assert from "node:assert/strict";
import test from "node:test";

import { landingDraftError, landingDraftFrom, landingInputFromDraft } from "./LandingPoolFields";
import { routeNodeOptionLabel, routeNodeOptionsOf } from "../rules/routeLineOptions";

/*
  节点池弹窗「落地」那一块（2.3.500）：草稿 ↔ 接口入参。凭据不从前端走；分享发的那几份不送（服务端照留）。
*/

test("新建默认 VLESS + REALITY + Vision、443、一个默认用户", () => {
  const draft = landingDraftFrom(null);
  assert.equal(draft.protocol, "vless");
  assert.equal(draft.security, "reality");
  assert.equal(draft.flow, "xtls-rprx-vision");
  assert.equal(draft.port, "443");
  assert.deepEqual(draft.users.map((user) => user.name), ["默认"]);
  assert.equal(landingDraftError(draft), "");
});

test("入参只带这个协议用得上的：SS 没有用户、补默认加密方式；REALITY 的握手域名和流控只在 REALITY 下送", () => {
  const ss = landingInputFromDraft({ ...landingDraftFrom(null), protocol: "shadowsocks", security: "none", flow: "xtls-rprx-vision", method: "" });
  assert.equal(ss.method, "2022-blake3-aes-128-gcm");
  assert.equal("users" in ss, false);
  assert.equal(ss.flow, "");
  const plain = landingInputFromDraft({ ...landingDraftFrom(null), security: "none", serverName: "x.example.com", transport: "ws", path: "/ray", host: "cdn.example.com" });
  assert.equal(plain.serverName, "");
  assert.equal(plain.path, "/ray");
  assert.equal(plain.host, "cdn.example.com");
  const grpc = landingInputFromDraft({ ...landingDraftFrom(null), security: "none", transport: "grpc", path: "svc", host: "h" });
  assert.equal(grpc.host, "", "gRPC 没有 Host");
});

test("分享发的用户不送（服务端照留）；没有自己的用户、端口不对不让存", () => {
  const draft = landingDraftFrom({
    protocol: "vless", port: 8443, transport: "tcp", security: "reality", flow: "", serverName: "", path: "", host: "", method: "", snellVersion: 0,
    users: [{ id: 1, name: "我", shared: false }, { id: 2, name: "小王", shared: true }],
  });
  assert.deepEqual(landingInputFromDraft(draft).users, [{ id: 1, name: "我" }]);
  assert.equal(landingDraftError({ ...draft, users: draft.users.filter((user) => user.shared) }), "至少留一个用户");
  assert.match(landingDraftError({ ...draft, port: "70000" }), /端口/);
});

test("节点选项：池节点带着池，标成「池 · 名字 · N 台」", () => {
  const options = routeNodeOptionsOf([
    { id: 1, name: "HK 粘贴", address: "1.2.3.4", port: 443, protocol: "vless", isEnabled: true },
    { id: 2, name: "亚太落地池", address: "198.18.0.30", port: 443, protocol: "vless", isEnabled: true, landingPool: { id: 9, name: "亚太落地池", members: 3, ready: 2 } },
    { id: 3, name: "没地址", address: "", port: 443, isEnabled: true },
  ]);
  assert.deepEqual(options.map((option) => option.id), [1, 2]);
  assert.equal(routeNodeOptionLabel(options[0]), "HK 粘贴");
  assert.equal(routeNodeOptionLabel(options[1]), "池 · 亚太落地池 · 2 台");
});
