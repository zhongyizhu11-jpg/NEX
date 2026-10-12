import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_SWITCH_MIN_SAMPLES,
  AUTO_SWITCH_WINDOW_MINUTES,
  OfflineSampler,
  joinHostPort,
  normalizeThreshold,
  panelAddrFromUrl,
  relayAllowList,
  relayCandidateIssue,
  relayStatusLine,
  shouldAutoSwitch,
  type RelayConfigRow,
} from "./agentRelayLogic";

const row = (hostId: number, viaHostId: number | null = null): RelayConfigRow => ({
  hostId, viaHostId, autoViaHostId: null, autoThresholdMinutes: 3, autoSwitchedAt: null, listenPort: null,
});

test("relay candidates: no self, new online agents only, no two-level chains", () => {
  const configs = new Map<number, RelayConfigRow>([[3, row(3, 4)], [5, row(5, 1)]]);
  const fresh = { agentVersion: "2.2.216", online: true };
  assert.equal(relayCandidateIssue({ id: 1, ...fresh }, 1, new Map()), "不能经由自己");
  assert.equal(relayCandidateIssue({ id: 2, agentVersion: "2.2.215", online: true }, 1, new Map()), "Agent 需要 2.2.216 以上");
  assert.equal(relayCandidateIssue({ id: 2, agentVersion: "2.2.216", online: false }, 1, new Map()), "离线");
  // 3 自己经由 4：不能再给别人当中转。
  assert.equal(relayCandidateIssue({ id: 3, ...fresh }, 7, configs), "它自己也在经由别的主机");
  // 1 正在给 5 当中转：1 不能再经由别人。
  assert.equal(relayCandidateIssue({ id: 2, ...fresh }, 1, configs), "这台正在给别的主机当中转");
  assert.equal(relayCandidateIssue({ id: 2, agentVersion: "2.3.0", online: true }, 7, configs), null);
});

test("relay allow list takes IP literals and reported public IPs only", () => {
  assert.deepEqual(
    relayAllowList([
      { ip: "203.0.113.5", ipv4: "203.0.113.5", ipv6: "2001:DB8::1", publicIps: ["198.51.100.9"] },
      { ip: "hk.example.com", ipv4: null, ipv6: "[2001:db8::2]" },
    ]),
    ["198.51.100.9", "2001:db8::1", "2001:db8::2", "203.0.113.5"],
  );
});

test("panel address and host:port formatting match the agent", () => {
  assert.equal(panelAddrFromUrl("http://1.2.3.4:9810"), "1.2.3.4:9810");
  assert.equal(panelAddrFromUrl("https://Panel.Example.com/x"), "panel.example.com:443");
  assert.equal(panelAddrFromUrl("https://[2001:db8::1]:8443"), "[2001:db8::1]:8443");
  assert.equal(panelAddrFromUrl("not a url"), "");
  assert.equal(joinHostPort("2001:db8::1", 20001), "[2001:db8::1]:20001");
  assert.equal(joinHostPort("tokyo.example.com", 20001), "tokyo.example.com:20001");
});

test("auto switch needs enough samples and offline minutes over the threshold", () => {
  const sampler = new OfflineSampler();
  for (let i = 0; i < AUTO_SWITCH_MIN_SAMPLES - 1; i += 1) sampler.record(1, false);
  assert.equal(shouldAutoSwitch(sampler.stats(1), 3), false, "too few samples");
  sampler.record(1, true);
  assert.equal(shouldAutoSwitch(sampler.stats(1), 3), true);
  assert.equal(shouldAutoSwitch(sampler.stats(1), 10), false);

  // 窗口只留 4 小时：早先的离线会滚出去。
  for (let i = 0; i < AUTO_SWITCH_WINDOW_MINUTES; i += 1) sampler.record(1, true);
  assert.deepEqual(sampler.stats(1), { samples: AUTO_SWITCH_WINDOW_MINUTES, offlineMinutes: 0 });
  sampler.keepOnly([2]);
  assert.deepEqual(sampler.stats(1), { samples: 0, offlineMinutes: 0 });
  assert.equal(normalizeThreshold(10), 10);
  assert.equal(normalizeThreshold(7), 3);
});

test("status line follows the agent's report", () => {
  const base = { supported: true, configuredViaName: "东京-1", reportAgeSeconds: 10 };
  assert.equal(relayStatusLine({ ...base, supported: false, report: null }).text, "需要把 Agent 升级到 2.2.216");
  assert.equal(relayStatusLine({ ...base, configuredViaName: null, report: { via: "" } }).text, "现在：直连");
  assert.equal(relayStatusLine({ ...base, report: { via: "1.2.3.4:20001", viaActive: true } }).text, "现在：经由 东京-1");
  const failed = relayStatusLine({ ...base, report: { via: "1.2.3.4:20001", fallbackActive: true, lastError: "连不上中转" } });
  assert.equal(failed.text, "中转失败，已退回直连");
  assert.equal(failed.tone, "warn");
  assert.equal(failed.detail, "连不上中转");
  assert.equal(relayStatusLine({ ...base, report: { via: "1.2.3.4:20001", fallbackActive: true } }).text, "正在试连中转");
  assert.match(relayStatusLine({ ...base, reportAgeSeconds: 900, report: { via: "1.2.3.4:20001", viaActive: true } }).text, /15 分钟前/);
});
