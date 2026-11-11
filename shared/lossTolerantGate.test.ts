import test from "node:test";
import assert from "node:assert/strict";
import { lossTolerantBlockerMessage, lossTolerantBlockers } from "./lossTolerantGate";

test("抗丢包：隧道上每台 Agent 和 FXP 都够新时不拦", () => {
  const hosts = [
    { id: 1, name: "入口", agentVersion: "2.2.254", fxpVersion: "2.2.140" },
    { id: 2, name: "出口", agentVersion: "2.2.260", fxpVersion: "2.2.141" },
  ];
  assert.deepEqual(lossTolerantBlockers(hosts, [1, 2, 2]), []);
});

test("抗丢包：有一台旧或没上报版本，就点名拦下并说清差什么", () => {
  const hosts = [
    { id: 1, name: "入口", agentVersion: "2.2.254", fxpVersion: "2.2.139" },
    { id: 2, name: "出口", agentVersion: "2.2.252", fxpVersion: null },
  ];
  const blockers = lossTolerantBlockers(hosts, [1, 2, 3]);
  assert.deepEqual(blockers.map((b) => [b.hostId, b.missing]), [[1, ["fxp"]], [2, ["agent", "fxp"]], [3, ["agent", "fxp"]]]);
  const message = lossTolerantBlockerMessage(blockers);
  assert.match(message, /入口（要 FXP 2\.2\.140 以上）/);
  assert.match(message, /#3/);
});
