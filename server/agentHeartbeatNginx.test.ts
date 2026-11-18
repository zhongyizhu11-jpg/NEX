import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNginxStreamServerBlock,
  nginxFallbackBackupWeights,
  nginxFallbackIsStrictlyOrdered,
  nginxUpstreamBlock,
  nginxUpstreamServerCount,
} from "./agentHeartbeatNginx";

/*
  nginx stream 多出口 upstream 的生成规则。下面这些配置拿真的 nginx 1.24.0（worker_processes auto / 4）跑过：

  · 每种策略（none / auto / latency / fallback / round_robin / random / ip_hash / weighted / least_load / 老的 least_conn）
    2 台、4 台、32 台出口，以及域名 / IPv6 地址的 server，`nginx -t` 都通过。
  · 主备 4 台（S1 主；S2 / S3 / S4 备用，权重 10000 / 100 / 1）：
      都在            500 条 → S1 500
      S1 挂           3000 条 → S2 2970、S3 30
      S1 S2 挂        3000 条 → S3 2941、S4 59
      S1 S2 S3 挂     500 条 → S4 500
      S2 S3 回来      头 3000 条 → S2 2665、S3 330、S4 5；之后 3000 条 → S2 2931、S3 68、S4 1
      S1 回来         500 条 → S1 500
  · zone（4 个 worker、轮流 3 台、300 条顺序连接）：有 zone 是 S1 S2 S3 S1 S2 S3 …（100 / 100 / 100）；
    没有 zone 开头是 S1 S1 S1 S1 S2 S3 …（每个 worker 各从头数）。
    两台里一台拒绝连接：有 zone 撞 2 次就摘掉，没有 zone 撞了 8 次（4 个 worker 各 2 次）。
  · 两台里第一台被黑洞（丢包不回）：每条连接 3.01 秒后换到第二台（以前是 10 秒）。
*/

const endpoints = (count: number, weights?: number[]) => Array.from({ length: count }, (_, index) => ({
  addr: `203.0.113.${index + 1}:2300${index}`,
  primary: index === 0,
  ...(weights ? { weight: weights[index] } : {}),
}));
const serverLines = (block: string) => block.split("\n").filter((line) => line.trim().startsWith("server "));

test("单出口的 upstream 和以前一个字节不差：没有 zone", () => {
  assert.equal(
    nginxUpstreamBlock("fwx_rule_1_tcp", endpoints(1), "fallback"),
    "  upstream fwx_rule_1_tcp {\n    server 203.0.113.1:23000 max_fails=2 fail_timeout=10s;\n  }",
  );
  assert.equal(nginxUpstreamBlock("fwx_rule_1_tcp", [{ addr: "" }]), "");
});

test("多出口的 upstream 都带 zone，名字就是 upstream 的名字", () => {
  for (const strategy of ["none", "auto", "latency", "fallback", "round_robin", "random", "ip_hash", "weighted", "least_load", "least_conn"]) {
    const block = nginxUpstreamBlock("fwx_tentry_7_tcp", endpoints(3, [5, 3, 2]), strategy);
    const lines = block.split("\n");
    assert.equal(lines[0], "  upstream fwx_tentry_7_tcp {", strategy);
    assert.equal(lines[1], "    zone fwx_tentry_7_tcp 64k;", strategy);
    assert.equal(serverLines(block).length, 3, strategy);
  }
  // tcp / udp 两个 upstream 的 zone 各用各的名字
  assert.match(nginxUpstreamBlock("fwx_tentry_7_udp", endpoints(2), "round_robin"), /zone fwx_tentry_7_udp 64k;/);
});

test("主备：两台是一主一备；三台以上备用按 100 倍递减的权重排先后", () => {
  assert.deepEqual(serverLines(nginxUpstreamBlock("u", endpoints(2), "fallback")), [
    "    server 203.0.113.1:23000 max_fails=2 fail_timeout=10s;",
    "    server 203.0.113.2:23001 max_fails=2 fail_timeout=10s backup;",
  ]);
  assert.deepEqual(serverLines(nginxUpstreamBlock("u", endpoints(3), "fallback")), [
    "    server 203.0.113.1:23000 max_fails=2 fail_timeout=10s;",
    "    server 203.0.113.2:23001 weight=100 max_fails=2 fail_timeout=10s backup;",
    "    server 203.0.113.3:23002 max_fails=2 fail_timeout=10s backup;",
  ]);
  assert.deepEqual(serverLines(nginxUpstreamBlock("u", endpoints(4), "fallback")), [
    "    server 203.0.113.1:23000 max_fails=2 fail_timeout=10s;",
    "    server 203.0.113.2:23001 weight=10000 max_fails=2 fail_timeout=10s backup;",
    "    server 203.0.113.3:23002 weight=100 max_fails=2 fail_timeout=10s backup;",
    "    server 203.0.113.4:23003 max_fails=2 fail_timeout=10s backup;",
  ]);
  // 主备不看带宽权重：就算带了也不写到主服务器上
  assert.doesNotMatch(serverLines(nginxUpstreamBlock("u", endpoints(3, [5, 3, 2]), "fallback"))[0], /weight=/);

  assert.deepEqual(nginxFallbackBackupWeights(0), []);
  assert.deepEqual(nginxFallbackBackupWeights(1), [1]);
  assert.deepEqual(nginxFallbackBackupWeights(2), [100, 1]);
  assert.deepEqual(nginxFallbackBackupWeights(3), [10000, 100, 1]);
  // 最多三档，再往后的备用之间轮流
  assert.deepEqual(nginxFallbackBackupWeights(5), [10000, 100, 1, 1, 1]);
  assert.equal(nginxFallbackIsStrictlyOrdered(2), true);
  assert.equal(nginxFallbackIsStrictlyOrdered(3), false);
});

test("老的 least_conn 和「按负载」一样：least_conn + 权重", () => {
  const legacy = nginxUpstreamBlock("u", endpoints(2, [5, 3]), "least_conn");
  assert.equal(legacy, nginxUpstreamBlock("u", endpoints(2, [5, 3]), "least_load"));
  assert.match(legacy, /^ {4}least_conn;$/m);
  assert.match(legacy, /server 203\.0\.113\.1:23000 weight=5 /);
  assert.match(legacy, /server 203\.0\.113\.2:23001 weight=3 /);
  assert.equal(nginxUpstreamBlock("u", endpoints(2, [5, 3]), "LEAST_CONN"), legacy);
});

test("其余策略的指令和权重不变", () => {
  assert.match(nginxUpstreamBlock("u", endpoints(2), "random"), /^ {4}random;$/m);
  assert.match(nginxUpstreamBlock("u", endpoints(2), "ip_hash"), /^ {4}hash \$remote_addr consistent;$/m);
  const weighted = nginxUpstreamBlock("u", endpoints(2, [5, 3]), "weighted");
  assert.doesNotMatch(weighted, /least_conn|random|hash/);
  assert.match(weighted, /server 203\.0\.113\.1:23000 weight=5 /);
  // 轮流 / 随机 / 按访客固定不写权重；权重 1 不写
  assert.doesNotMatch(nginxUpstreamBlock("u", endpoints(2, [5, 3]), "round_robin"), /weight=/);
  assert.doesNotMatch(nginxUpstreamBlock("u", endpoints(2, [1, 1]), "weighted"), /weight=/);
  // 认不出的策略当轮流
  assert.doesNotMatch(nginxUpstreamBlock("u", endpoints(2), "whatever"), /least_conn|random|hash|backup|weight=/);
});

test("多出口的 TCP：3 秒连接超时、连不上换下一台；单出口和 UDP 不变", () => {
  const base = { name: "tunnel entry 7 rule 9 tcp", listenPort: 20009, proto: "tcp" as const, upstream: "fwx_tentry_9_tcp" };
  const single = buildNginxStreamServerBlock(base);
  assert.match(single, /^ {4}proxy_connect_timeout 10s;$/m);
  assert.doesNotMatch(single, /proxy_next_upstream/);
  assert.equal(buildNginxStreamServerBlock({ ...base, upstreamServers: 1 }), single);
  assert.equal(buildNginxStreamServerBlock({ ...base, upstreamServers: 0 }), single);

  const multi = buildNginxStreamServerBlock({ ...base, upstreamServers: 3 });
  assert.match(multi, /^ {4}proxy_connect_timeout 3s;$/m);
  assert.doesNotMatch(multi, /proxy_connect_timeout 10s/);
  assert.match(multi, /^ {4}proxy_next_upstream on;$/m);
  assert.match(multi, /^ {4}proxy_next_upstream_tries 3;$/m);
  assert.match(multi, /^ {4}proxy_next_upstream_timeout 10s;$/m);
  // 其余行不动
  assert.equal(
    multi.split("\n").filter((line) => !/proxy_next_upstream|proxy_connect_timeout/.test(line)).join("\n"),
    single.split("\n").filter((line) => !/proxy_connect_timeout/.test(line)).join("\n"),
  );

  const udp = { ...base, proto: "udp" as const, upstream: "fwx_tentry_9_udp" };
  assert.equal(buildNginxStreamServerBlock({ ...udp, upstreamServers: 3 }), buildNginxStreamServerBlock(udp));
  assert.doesNotMatch(buildNginxStreamServerBlock({ ...udp, upstreamServers: 3 }), /proxy_responses|proxy_next_upstream/);

  assert.equal(nginxUpstreamServerCount([{ addr: "a:1" }, { addr: "" }, { addr: "b:2" }]), 2);
});
