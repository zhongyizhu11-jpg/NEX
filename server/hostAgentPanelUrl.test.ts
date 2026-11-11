import assert from "node:assert/strict";
import test from "node:test";
import { HOST_AGENT_PANEL_URL_AGENT_VERSION, hostAgentPanelUrlOverride, selectHostAgentPanelUrl } from "./hostAgentPanelUrl";

const globalPanelUrl = "https://panel.example.com";

test("没开或地址不合法：没有独立地址", () => {
  assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: false, agentPanelUrl: "https://cn.example.com" }), "");
  assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: true, agentPanelUrl: "ftp://cn.example.com" }), "");
  assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: true, agentPanelUrl: "https://u:p@cn.example.com" }), "");
  assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: true, agentPanelUrl: "https://cn.example.com/?token=x" }), "");
  assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: 1, agentPanelUrl: "https://cn.example.com:8443/nex/" }), "https://cn.example.com:8443/nex");
});

test("开着、Agent 够新、没有迁移：发主机独立地址", () => {
  const host = { agentPanelUrlEnabled: true, agentPanelUrl: "https://cn.example.com", agentVersion: HOST_AGENT_PANEL_URL_AGENT_VERSION };
  assert.equal(selectHostAgentPanelUrl({ host, globalPanelUrl, migrationActive: false }), "https://cn.example.com");
});

test("旧 Agent（收到就直接切、不验证）和迁移进行中：继续发全局地址", () => {
  const host = { agentPanelUrlEnabled: true, agentPanelUrl: "https://cn.example.com", agentVersion: "2.2.252" };
  assert.equal(selectHostAgentPanelUrl({ host, globalPanelUrl, migrationActive: false }), globalPanelUrl);
  assert.equal(selectHostAgentPanelUrl({ host: { ...host, agentVersion: "" }, globalPanelUrl, migrationActive: false }), globalPanelUrl);
  assert.equal(selectHostAgentPanelUrl({ host: { ...host, agentVersion: "9.9.9" }, globalPanelUrl, migrationActive: true }), globalPanelUrl);
  assert.equal(selectHostAgentPanelUrl({ host: null, globalPanelUrl, migrationActive: false }), globalPanelUrl);
});
