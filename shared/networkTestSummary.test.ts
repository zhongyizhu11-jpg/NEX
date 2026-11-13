import assert from "node:assert/strict";
import test from "node:test";

import {
  averageJitter,
  parseMtrReport,
  parsePingOutput,
  parseTracerouteOutput,
  pingSummaryNotes,
  routeSummaryNotes,
  summarizeNetworkTest,
} from "./networkTestSummary";

const IPUTILS_PING = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=10.2 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=12.4 ms
64 bytes from 1.1.1.1: icmp_seq=4 ttl=57 time=11.0 ms

--- 1.1.1.1 ping statistics ---
4 packets transmitted, 3 received, 25% packet loss, time 3004ms
rtt min/avg/max/mdev = 10.200/11.200/12.400/0.910 ms`;

test("iputils ping：发送、收到、丢包、最小 / 平均 / 最大、标准差和抖动", () => {
  const summary = parsePingOutput(IPUTILS_PING)!;
  assert.equal(summary.kind, "ping");
  assert.equal(summary.sent, 4);
  assert.equal(summary.received, 3);
  assert.equal(summary.lossPercent, 25);
  assert.equal(summary.minMs, 10.2);
  assert.equal(summary.avgMs, 11.2);
  assert.equal(summary.maxMs, 12.4);
  assert.equal(summary.stddevMs, 0.91);
  assert.deepEqual(summary.samples, [10.2, 12.4, 11.0]);
  // |12.4-10.2| = 2.2，|11.0-12.4| = 1.4，平均 1.8
  assert.equal(summary.jitterMs, 1.8);
  assert.equal(summary.complete, true);
});

test("BusyBox ping：统计行写法不同、没有 mdev，抖动照样按回包算", () => {
  const summary = parsePingOutput(`PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: seq=0 ttl=117 time=5.100 ms
64 bytes from 8.8.8.8: seq=1 ttl=117 time=5.300 ms

--- 8.8.8.8 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max = 5.100/5.200/5.300 ms`)!;
  assert.equal(summary.sent, 2);
  assert.equal(summary.received, 2);
  assert.equal(summary.lossPercent, 0);
  assert.equal(summary.stddevMs, null);
  assert.equal(summary.jitterMs, 0.2);
  assert.deepEqual(pingSummaryNotes(summary).map((note) => note.level), ["ok"]);
});

test("全丢：没有往返时间，结论说的是「不回 ICMP 不等于不通」", () => {
  const summary = parsePingOutput(`PING 9.9.9.9 (9.9.9.9) 56(84) bytes of data.

--- 9.9.9.9 ping statistics ---
4 packets transmitted, 0 received, +4 errors, 100% packet loss, time 3060ms`)!;
  assert.equal(summary.received, 0);
  assert.equal(summary.errors, 4);
  assert.equal(summary.lossPercent, 100);
  assert.equal(summary.avgMs, null);
  assert.equal(summary.jitterMs, null);
  const notes = pingSummaryNotes(summary);
  assert.equal(notes[0].level, "warn");
  assert.match(notes[0].text, /TCPing/);
});

test("命令被掐、没有统计行：按已收到的回包给不完整的摘要，发送数未知", () => {
  const summary = parsePingOutput(`PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=20 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=30 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=31 ms (DUP!)`)!;
  assert.equal(summary.complete, false);
  assert.equal(summary.sent, null);
  assert.equal(summary.lossPercent, null);
  assert.equal(summary.received, 2);
  assert.equal(summary.minMs, 20);
  assert.equal(summary.maxMs, 30);
  assert.equal(summary.avgMs, 25);
  assert.equal(pingSummaryNotes(summary)[0].level, "info");
});

test("不是 ping 的输出（缺工具的提示）不出摘要", () => {
  assert.equal(parsePingOutput("Agent 主机缺少 ping 工具，无法执行 Ping 测试。"), null);
  assert.equal(summarizeNetworkTest("tcp", "TCP 1.1.1.1:443 连接成功\n耗时: 3 ms"), null);
});

test("抖动少于两个样本是 null", () => {
  assert.equal(averageJitter([]), null);
  assert.equal(averageJitter([3]), null);
  assert.equal(averageJitter([1, 4, 2]), 2.5);
});

const TRACEROUTE = `traceroute to 1.1.1.1 (1.1.1.1), 20 hops max, 60 byte packets
 1  10.0.0.1  0.345 ms  0.300 ms  0.290 ms
 2  * * *
 3  100.64.0.1  1.123 ms 100.64.0.2  1.300 ms *
 4  203.0.113.9  80.5 ms  81.0 ms  80.0 ms
 5  1.1.1.1  81.2 ms  81.1 ms  81.3 ms`;

test("traceroute：逐跳地址、无回应比例、多路径地址、到没到目标", () => {
  const summary = parseTracerouteOutput(TRACEROUTE, "1.1.1.1")!;
  assert.equal(summary.tool, "traceroute");
  assert.equal(summary.hops.length, 5);
  assert.deepEqual(summary.hops[0].addresses, ["10.0.0.1"]);
  assert.equal(summary.hops[0].sent, 3);
  assert.equal(summary.hops[0].lossPercent, 0);
  assert.equal(summary.hops[0].bestMs, 0.29);
  assert.equal(summary.hops[1].timedOut, true);
  assert.deepEqual(summary.hops[1].addresses, []);
  assert.equal(summary.hops[1].lossPercent, 100);
  assert.deepEqual(summary.hops[2].addresses, ["100.64.0.1", "100.64.0.2"]);
  assert.equal(summary.hops[2].lossPercent, 33.3);
  assert.equal(summary.reachedTarget, true);
  const notes = routeSummaryNotes(summary).map((note) => note.text);
  assert.ok(notes.some((text) => text.includes("5 跳到达目标")));
  assert.ok(notes.some((text) => text.includes("第 4 跳") && text.includes("ms")), "3 → 4 跳延迟跳了 79 ms，应该点出来");
  assert.ok(notes.some((text) => text.includes("不影响业务")), "中间的 * 不能说成丢包");
});

test("traceroute 末尾全是 *：没到目标，结论建议用 TCPing 确认", () => {
  const summary = parseTracerouteOutput(`traceroute to 9.9.9.9 (9.9.9.9), 20 hops max, 60 byte packets
 1  10.0.0.1  0.3 ms  0.3 ms  0.3 ms
 2  * * *
 3  * * *`, "9.9.9.9")!;
  assert.equal(summary.reachedTarget, false);
  const note = routeSummaryNotes(summary).find((item) => item.level === "warn")!;
  assert.match(note.text, /最后 2 跳/);
});

test("traceroute 的 !H 记成注记", () => {
  const summary = parseTracerouteOutput(` 1  10.0.0.1  0.3 ms !H  0.4 ms !H  *`)!;
  assert.deepEqual(summary.hops[0].annotations, ["!H"]);
  assert.ok(routeSummaryNotes(summary).some((note) => note.text.includes("!H")));
});

test("traceroute6：IPv6 地址也认", () => {
  const summary = parseTracerouteOutput(`traceroute to 2606:4700:4700::1111 (2606:4700:4700::1111), 20 hops max, 80 byte packets
 1  2001:db8::1  0.5 ms  0.4 ms  0.6 ms
 2  2606:4700:4700::1111  5.0 ms  5.1 ms  5.2 ms`, "2606:4700:4700::1111")!;
  assert.deepEqual(summary.hops.map((hop) => hop.addresses[0]), ["2001:db8::1", "2606:4700:4700::1111"]);
  assert.equal(summary.reachedTarget, true);
});

const MTR = `Start: 2026-11-12T10:00:00+0800
HOST: vps                         Loss%   Snt   Last   Avg  Best  Wrst StDev
  1.|-- 10.0.0.1                   0.0%    10    0.3   0.4   0.3   0.6   0.1
  2.|-- ???                       100.0    10    0.0   0.0   0.0   0.0   0.0
  3.|-- 100.64.0.1                20.0%    10    1.0   1.1   1.0   1.3   0.1
    |  \`|-- 100.64.0.2
  4.|-- 203.0.113.9               10.0%    10   60.0  60.5  59.9  61.0   0.3
  5.|-- 1.1.1.1                   10.0%    10   61.0  61.2  60.8  61.9   0.4`;

test("mtr report：??? 那一跳丢包列不带 % 也认，多路径地址并到同一跳", () => {
  const summary = parseMtrReport(MTR, "1.1.1.1")!;
  assert.equal(summary.tool, "mtr");
  assert.equal(summary.hops.length, 5);
  assert.equal(summary.hops[1].timedOut, true);
  assert.equal(summary.hops[1].lossPercent, 100);
  assert.equal(summary.hops[1].avgMs, null, "无回应的跳不能显示 0 ms");
  assert.deepEqual(summary.hops[2].addresses, ["100.64.0.1", "100.64.0.2"]);
  assert.equal(summary.hops[3].sent, 10);
  assert.equal(summary.hops[3].avgMs, 60.5);
  assert.equal(summary.hops[3].worstMs, 61);
  assert.equal(summary.hops[3].stddevMs, 0.3);
  assert.equal(summary.reachedTarget, true);
});

test("mtr：终点丢包时指出从哪一跳开始一路丢", () => {
  const notes = routeSummaryNotes(parseMtrReport(MTR, "1.1.1.1")!).map((note) => note.text);
  assert.ok(notes.some((text) => text.includes("终点丢包 10%") && text.includes("第 3 跳")), notes.join("\n"));
});

test("mtr：中间跳丢包、终点不丢 —— 说明不影响业务，不报警", () => {
  const summary = parseMtrReport(`HOST: vps                         Loss%   Snt   Last   Avg  Best  Wrst StDev
  1.|-- 10.0.0.1                   0.0%    10    0.3   0.4   0.3   0.6   0.1
  2.|-- 100.64.0.1                60.0%    10    1.0   1.1   1.0   1.3   0.1
  3.|-- 1.1.1.1                    0.0%    10    2.0   2.1   2.0   2.3   0.1`, "1.1.1.1")!;
  const notes = routeSummaryNotes(summary);
  assert.ok(!notes.some((note) => note.level === "warn"), JSON.stringify(notes));
  assert.ok(notes.some((note) => note.text.includes("不影响业务")));
});

test("老版本 mtr（没有 |--）也认", () => {
  const summary = parseMtrReport(`HOST: vps                Loss%   Snt   Last   Avg  Best  Wrst StDev
  1. 10.0.0.1              0.0%    10    0.3   0.4   0.3   0.6   0.1
  2. 1.1.1.1               0.0%    10    2.0   2.1   2.0   2.3   0.1`, "1.1.1.1")!;
  assert.deepEqual(summary.hops.map((hop) => hop.addresses[0]), ["10.0.0.1", "1.1.1.1"]);
});

test("summarizeNetworkTest 按方法分派；缺 mtr 工具的提示不出摘要", () => {
  assert.equal(summarizeNetworkTest("ping6", IPUTILS_PING)?.kind, "ping");
  assert.equal((summarizeNetworkTest("mtr6", MTR) as any)?.tool, "mtr");
  assert.equal((summarizeNetworkTest("traceroute", TRACEROUTE) as any)?.tool, "traceroute");
  assert.equal(summarizeNetworkTest("mtr", "Agent 主机缺少 mtr 工具，无法执行 MTR 测试。"), null);
});
