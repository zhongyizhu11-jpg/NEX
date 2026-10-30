import assert from "node:assert/strict";
import test from "node:test";

import {
  LANDING_NOT_OWNED_REASON,
  describeIperf3Failure,
  iperf3EffectiveMbps,
  lineEventsToCsv,
  lineExportFilename,
  lineExportToCsv,
  parseIperf3Mbps,
  planLineSegments,
  slowestSegmentIndex,
} from "./lineDiagnostics";

const MULTI_STREAM = `Connecting to host 203.0.113.5, port 5201
[  5] local 198.51.100.2 port 50312 connected to 203.0.113.5 port 5201
[  7] local 198.51.100.2 port 50314 connected to 203.0.113.5 port 5201
[ ID] Interval           Transfer     Bitrate         Retr  Cwnd
[  5]   0.00-1.00   sec  27.5 MBytes   231 Mbits/sec    0   1.20 MBytes
[  7]   0.00-1.00   sec  27.1 MBytes   227 Mbits/sec    0   1.18 MBytes
[SUM]   0.00-1.00   sec  54.6 MBytes   458 Mbits/sec    0
- - - - - - - - - - - - - - - - - - - - - - - - -
[ ID] Interval           Transfer     Bitrate         Retr
[  5]   0.00-8.00   sec   220 MBytes   231 Mbits/sec  120             sender
[  5]   0.00-8.04   sec   218 MBytes   228 Mbits/sec                  receiver
[  7]   0.00-8.00   sec   216 MBytes   226 Mbits/sec   98             sender
[  7]   0.00-8.04   sec   214 MBytes   223 Mbits/sec                  receiver
[SUM]   0.00-8.00   sec   436 MBytes   457 Mbits/sec  218             sender
[SUM]   0.00-8.04   sec   432 MBytes   451 Mbits/sec                  receiver

iperf Done.
`;

const SINGLE_STREAM_OLD = `Connecting to host 192.0.2.10, port 5201
[  4] local 192.0.2.20 port 41234 connected to 192.0.2.10 port 5201
[ ID] Interval           Transfer     Bandwidth       Retr  Cwnd
[  4]   0.00-1.00   sec   112 MBytes   941 Mbits/sec    0    411 KBytes
- - - - - - - - - - - - - - - - - - - - - - - - -
[ ID] Interval           Transfer     Bandwidth       Retr
[  4]   0.00-10.00  sec  1.09 GBytes   938 Mbits/sec    3             sender
[  4]   0.00-10.00  sec  1.09 GBytes   936 Mbits/sec                  receiver

iperf Done.
`;

const REVERSE_GBITS = `Connecting to host 203.0.113.5, port 40123
Reverse mode, remote host 203.0.113.5 is sending
[  5] local 198.51.100.2 port 50400 connected to 203.0.113.5 port 40123
[ ID] Interval           Transfer     Bitrate
[SUM]   0.00-1.00   sec   230 MBytes  1.93 Gbits/sec
- - - - - - - - - - - - - - - - - - - - - - - - -
[ ID] Interval           Transfer     Bitrate         Retr
[SUM]   0.00-8.04   sec  1.82 GBytes  1.95 Gbits/sec  1024             sender
[SUM]   0.00-8.00   sec  1.80 GBytes  1.93 Gbits/sec                  receiver

iperf Done.
`;

test("parseIperf3Mbps：多流取 [SUM] 汇总行，不吃每秒的区间行", () => {
  assert.deepEqual(parseIperf3Mbps(MULTI_STREAM), { sendMbps: 457, recvMbps: 451 });
});

test("parseIperf3Mbps：单流老版本（Bandwidth 列）也认", () => {
  assert.deepEqual(parseIperf3Mbps(SINGLE_STREAM_OLD), { sendMbps: 938, recvMbps: 936 });
});

test("parseIperf3Mbps：-R 反向、Gbits/sec 换算成 Mbit/s", () => {
  assert.deepEqual(parseIperf3Mbps(REVERSE_GBITS), { sendMbps: 1950, recvMbps: 1930 });
  assert.equal(iperf3EffectiveMbps(parseIperf3Mbps(REVERSE_GBITS)), 1930);
});

test("parseIperf3Mbps：Kbits/sec、CRLF、多流无 [SUM] 时把各流加起来", () => {
  const output = [
    "[  5]   0.00-8.00   sec   800 KBytes   819 Kbits/sec    2             sender",
    "[  5]   0.00-8.10   sec   780 KBytes   789 Kbits/sec                  receiver",
    "[  7]   0.00-8.00   sec   800 KBytes   181 Kbits/sec    2             sender",
  ].join("\r\n");
  assert.deepEqual(parseIperf3Mbps(output), { sendMbps: 1, recvMbps: 0.79 });
});

test("parseIperf3Mbps：报错 / 空输出返回 null，有效值退回 sender", () => {
  assert.deepEqual(parseIperf3Mbps("iperf3: error - unable to connect to server: Connection refused"), { sendMbps: null, recvMbps: null });
  assert.deepEqual(parseIperf3Mbps(""), { sendMbps: null, recvMbps: null });
  assert.equal(iperf3EffectiveMbps({ sendMbps: 12, recvMbps: null }), 12);
});

test("describeIperf3Failure：没装 iperf3、连不上、忙，都说成人话", () => {
  assert.match(describeIperf3Failure("Agent 主机缺少 iperf3，无法启动 iperf3 服务端测试。"), /没装 iperf3/);
  assert.match(describeIperf3Failure("exec: \"iperf3\": executable file not found in $PATH"), /没装 iperf3/);
  assert.match(describeIperf3Failure("iperf3: error - unable to connect to server: Connection refused"), /防火墙/);
  assert.match(describeIperf3Failure("iperf3: error - the server is busy running a test. try again later"), /正忙/);
  assert.equal(describeIperf3Failure(""), "iperf3 没有输出测速结果");
});

test("planLineSegments：入口 → 中转 → 中转 → 落地，最后一段跳过", () => {
  const segments = planLineSegments({
    entry: { hostId: 1, name: "入口" },
    hops: [{ hostId: 2, name: "港-1" }, { hostId: 3, name: "日-1" }],
    landing: { name: "1.2.3.4:443" },
  });
  assert.deepEqual(segments.map((segment) => [segment.from.hostId, segment.to.hostId, segment.skipReason]), [
    [1, 2, null],
    [2, 3, null],
    [3, null, LANDING_NOT_OWNED_REASON],
  ]);
  assert.equal(segments[2].to.name, "1.2.3.4:443");
});

test("planLineSegments：直连路径只有一段落地，跳过；前后同一台机器也跳过", () => {
  assert.deepEqual(
    planLineSegments({ entry: { hostId: 1, name: "入口" }, hops: [], landing: { name: "" } }).map((s) => [s.to.name, s.skipReason]),
    [["落地", LANDING_NOT_OWNED_REASON]],
  );
  const same = planLineSegments({ entry: { hostId: 1, name: "a" }, hops: [{ hostId: 1, name: "a" }], landing: { name: "x" } });
  assert.match(String(same[0].skipReason), /同一台/);
});

test("slowestSegmentIndex：只看测完的段", () => {
  assert.equal(slowestSegmentIndex([
    { status: "done", mbps: 900 },
    { status: "done", mbps: 120.5 },
    { status: "error", mbps: null },
    { status: "skipped", mbps: null },
  ]), 1);
  assert.equal(slowestSegmentIndex([{ status: "skipped", mbps: null }]), null);
});

test("lineEventsToCsv：BOM、表头、转义、防公式注入", () => {
  const csv = lineEventsToCsv([
    { kind: "switch", fromLabel: "A 主线路", toLabel: "B 备用", reason: "unhealthy", reasonText: "探测不通, 已切换", score: 80, latencyMs: 35, at: Date.UTC(2026, 9, 30, 1, 2, 3) },
    { kind: "unhealthy", toLabel: "=HYPERLINK()", at: Date.UTC(2026, 9, 30, 1, 0, 0) },
  ]);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.replace(/^﻿/, "").trim().split("\n");
  assert.equal(lines[0], "time,kind,from,to,reason,reasonText,score,latencyMs");
  assert.equal(lines[1], '2026-10-30T01:02:03.000Z,switch,A 主线路,B 备用,unhealthy,"探测不通, 已切换",80,35');
  assert.equal(lines[2], "2026-10-30T01:00:00.000Z,unhealthy,,'=HYPERLINK(),,,,");
});

test("lineExportToCsv：三张表依次排，文件名只含 ASCII", () => {
  const csv = lineExportToCsv({
    ruleId: 7,
    ruleName: "港日",
    exportedAt: Date.UTC(2026, 9, 30),
    paths: [{ letter: "A", name: "主线路", key: "p1", active: true, healthy: true, score: 90, latencyMs: 40, hops: [{ name: "港-1" }, { name: "日-1" }] }],
    events: [{ kind: "recovered", toLabel: "A 主线路", at: Date.UTC(2026, 9, 30) }],
    quality: [{ letter: "A", name: "主线路", points: [{ at: Date.UTC(2026, 9, 29), latencyMs: 41.5, lossPct: 0, jitterMs: 2, availabilityPct: 100, score: 92, samples: 60 }] }],
  });
  const text = csv.replace(/^﻿/, "");
  assert.match(text, /^# rule\nruleId,ruleName,exportedAt\n7,港日,2026-10-30T00:00:00.000Z\n/);
  assert.match(text, /\n# paths\n.*\nA,主线路,p1,yes,yes,,,90,40,,,,港-1 > 日-1\n/);
  assert.match(text, /\n# events\ntime,kind/);
  assert.match(text, /\n# quality\npath,time.*\nA 主线路,2026-10-29T00:00:00.000Z,41.5,0,2,100,92,60\n$/);
  assert.equal(lineExportFilename(7, "csv", Date.UTC(2026, 9, 30, 8, 5, 9, 123)), "line-7-20261030T080509Z.csv");
});
