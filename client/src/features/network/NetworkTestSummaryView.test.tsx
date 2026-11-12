import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { parseMtrReport, parsePingOutput, parseTracerouteOutput } from "@shared/networkTestSummary";
import { PingSummaryStrip, RouteHopTable } from "./NetworkTestSummaryView";

test("Ping 摘要：七个格子都有，丢包时标警告色，带 mdev 时多一行标准差", () => {
  const summary = parsePingOutput(`64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=10.0 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=57 time=12.0 ms
--- 1.1.1.1 ping statistics ---
4 packets transmitted, 2 received, 50% packet loss, time 3004ms
rtt min/avg/max/mdev = 10.000/11.000/12.000/1.000 ms`)!;
  const html = renderToStaticMarkup(<PingSummaryStrip summary={summary} />);
  for (const label of ["发送", "收到", "丢包率", "最小", "平均", "最大", "抖动"]) assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>`));
  assert.match(html, /50%<\/dd>/);
  assert.match(html, /fx-warn-text[^>]*>50%/);
  assert.match(html, /2\.00 ms/, "抖动 |12-10| = 2");
  assert.match(html, /标准差（mdev）/);
});

test("逐跳表：MTR 有发送数和标准差列，无回应的跳不显示 0 ms，终点丢包标红", () => {
  const summary = parseMtrReport(`HOST: vps                Loss%   Snt   Last   Avg  Best  Wrst StDev
  1.|-- 10.0.0.1              0.0%    10    0.3   0.4   0.3   0.6   0.1
  2.|-- ???                  100.0    10    0.0   0.0   0.0   0.0   0.0
  3.|-- 1.1.1.1              20.0%    10    2.0   2.1   2.0   2.3   0.1`, "1.1.1.1")!;
  const html = renderToStaticMarkup(<RouteHopTable summary={summary} />);
  assert.match(html, />发送</);
  assert.match(html, />标准差</);
  assert.match(html, /无回应/);
  assert.doesNotMatch(html, /0\.0 ms/, "??? 那一跳的延迟列应该是 -");
  assert.match(html, /fx-down-text[^>]*>20%/);
  assert.match(html, /终点丢包 20%/);
});

test("逐跳表：Traceroute 列的是「无回应」比例，没有发送 / 标准差列", () => {
  const summary = parseTracerouteOutput(` 1  10.0.0.1  0.3 ms  0.3 ms  0.3 ms
 2  * * *
 3  1.1.1.1  2.0 ms  2.1 ms  2.2 ms`, "1.1.1.1")!;
  const html = renderToStaticMarkup(<RouteHopTable summary={summary} />);
  assert.match(html, /<th[^>]*>无回应<\/th>/);
  assert.doesNotMatch(html, />标准差</);
  assert.match(html, /3 跳到达目标/);
});
