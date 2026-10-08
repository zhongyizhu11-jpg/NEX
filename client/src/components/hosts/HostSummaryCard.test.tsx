import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HostFootRow, ResourceRow } from "./HostSummaryCard";
import { deriveHostVitals } from "./useHostVitals";

const now = 1_700_000_000_000;
const metric = { recordedAt: new Date(now - 5000).toISOString(), cpuUsage: 18, memoryUsage: 42, diskUsage: 36, networkSpeedIn: 8_420_000, networkSpeedOut: 11_600_000 };

test("在线：左边是此刻速率，右边是这台上挂着几条转发、几条线路经过", () => {
  const host = { id: 1, name: "HK entry 01", isOnline: true, lastHeartbeat: now - 5000, ruleCount: 6, tunnelCount: 2 };
  const html = renderToStaticMarkup(<HostFootRow host={host} vitals={deriveHostVitals(host, [metric])} now={now} />);
  assert.match(html, /↓ [\d.]+ MB\/s · ↑ [\d.]+ MB\/s/);
  assert.match(html, /fx-host-foot-links[^>]*>6 条转发 · 2 条线路经过/);
  assert.doesNotMatch(html, /data-tone="down"/);
});

test("离线：写离线多久，右边改成受影响的转发数（灰）", () => {
  const host = { id: 2, name: "US backup 04", isOnline: false, lastHeartbeat: now - 30 * 60_000, ruleCount: 2, tunnelCount: 1 };
  const html = renderToStaticMarkup(<HostFootRow host={host} vitals={deriveHostVitals(host, [metric])} now={now} />);
  assert.match(html, /data-tone="down"/);
  assert.match(html, /离线 30 分钟/);
  assert.match(html, /fx-host-foot-links" data-muted="">2 条转发受影响/);
});

test("老服务端没给数：右边什么都不画；一条都没有：写「还没有转发」", () => {
  const host = { id: 3, name: "n", isOnline: true, lastHeartbeat: now };
  const html = renderToStaticMarkup(<HostFootRow host={host} vitals={deriveHostVitals(host, [metric])} now={now} />);
  assert.doesNotMatch(html, /fx-host-foot-links/);
  const empty = renderToStaticMarkup(<HostFootRow host={{ ...host, ruleCount: 0, tunnelCount: 0 }} vitals={deriveHostVitals(host, [metric])} now={now} />);
  assert.match(empty, /还没有转发/);
});

test("规格格底部有细条：条长跟数字走，≥70% 琥珀、≥90% 红", () => {
  const host = { id: 4, name: "TYO exit", isOnline: true, lastHeartbeat: now - 5000 };
  const busy = { ...metric, cpuUsage: 64, memoryUsage: 71, diskUsage: 93 };
  const html = renderToStaticMarkup(<ResourceRow vitals={deriveHostVitals(host, [busy])} />);
  assert.equal(html.match(/fx-host-spec-bar/g)?.length, 3);
  assert.match(html, /<span style="transform:scaleX\(0\.64\)"><\/span>/);
  assert.match(html, /data-tone="warn" style="transform:scaleX\(0\.71\)"/);
  assert.match(html, /data-tone="down" style="transform:scaleX\(0\.93\)"/);
});

test("规格格数字不知道（没上报过）就不画条", () => {
  const host = { id: 5, name: "new", isOnline: true, lastHeartbeat: now - 5000 };
  const html = renderToStaticMarkup(<ResourceRow vitals={deriveHostVitals(host, [])} />);
  assert.doesNotMatch(html, /fx-host-spec-bar/);
});
