import assert from "node:assert/strict";
import test from "node:test";

import { routeLandingCredentialIssues, sameNodeCredential } from "./routeLandingCredentials";

const bound = { id: 1, name: "HKT", protocol: "shadowsocks", method: "2022-blake3-aes-128-gcm", password: "p1", address: "203.0.113.10", port: 443, tls: false };

test("线路组落地凭据：和订阅节点一样的不提醒，不一样的、没法确认的提醒", () => {
  const sameCred = { ...bound, id: 2, name: "HKT 池", address: "203.0.113.20", port: 8443 };
  const otherCred = { ...bound, id: 3, name: "rfc hk", password: "p2" };
  const nodesById = new Map([[2, sameCred], [3, otherCred]]);
  const issues = routeLandingCredentialIssues({
    boundNode: bound,
    nodesById,
    lines: [
      { name: "主线路", dests: [] },
      { name: "备用 1", dests: [{ dest: null, destNodeId: 1 }, { dest: { ip: "203.0.113.20", port: 8443 }, destNodeId: 2 }, { dest: { ip: "203.0.113.30", port: 443 }, destNodeId: 3 }] },
      { name: "备用 2", dests: [{ dest: { ip: "198.51.100.9", port: 1080 }, destNodeId: null }, { dest: { ip: "203.0.113.10", port: 443 }, destNodeId: null }] },
    ],
  });
  assert.deepEqual(issues, [
    { line: "备用 1", landing: "rfc hk", reason: "credential" },
    { line: "备用 2", landing: "198.51.100.9:1080", reason: "unknown" },
  ]);
  assert.equal(sameNodeCredential(bound, sameCred), true, "地址端口不同不算");
  assert.equal(sameNodeCredential(bound, { ...bound, tls: true }), false);
  assert.deepEqual(routeLandingCredentialIssues({ boundNode: null, nodesById, lines: [{ dests: [{ destNodeId: 3 }] }] }), [], "没绑订阅节点不提醒");
});
