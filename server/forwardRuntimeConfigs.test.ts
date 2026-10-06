import assert from "node:assert/strict";
import test from "node:test";

import {
  REALM_CONFIG_DIR,
  buildRealmConfigToml,
  buildRealmServiceUnit,
  buildSocatServiceUnit,
  cleanEndpointHost,
  endpointHostPort,
  realmConfigPathForPort,
  realmServiceNameForPort,
  realmTomlString,
  socatDialEndpoint,
  socatServiceNameForPort,
} from "./forwardRuntimeConfigs";

/**
 * realm 的配置文件与服务单元。
 *
 * 这一层的错都是**不报错的错**：`use_udp` 写反、proxy protocol 版本填错、监听
 * 地址少个方括号 —— realm 要么起不来、要么起来了但流量走不通，而面板上只会看到
 * 一句「等待 Agent 上报」。原来这段拼接埋在六千行路由里，只能靠肉眼看。
 */

const base = {
  sourcePort: 20001,
  remote: "198.51.100.7:443",
  sendProxy: false,
  acceptProxy: false,
  proxyVersion: 1,
};

test("use_udp 跟着规则协议走，不是写死的", () => {
  assert.match(buildRealmConfigToml({ ...base, protocol: "tcp" }), /use_udp = false/);
  assert.match(buildRealmConfigToml({ ...base, protocol: "udp" }), /use_udp = true/);
  assert.match(
    buildRealmConfigToml({ ...base, protocol: "both" }),
    /use_udp = true/,
    "TCP+UDP 的规则要开 UDP，否则 UDP 那一半静默不通",
  );
});

test("PROXY protocol 的收发和版本各自独立", () => {
  const sendOnly = buildRealmConfigToml({ ...base, protocol: "tcp", sendProxy: true, proxyVersion: 2 });
  assert.match(sendOnly, /send_proxy = true/);
  assert.match(sendOnly, /send_proxy_version = 2/);
  assert.match(sendOnly, /accept_proxy = false/, "只开发送时不能顺手把接收也打开");

  const acceptOnly = buildRealmConfigToml({ ...base, protocol: "tcp", acceptProxy: true });
  assert.match(acceptOnly, /accept_proxy = true/);
  assert.match(acceptOnly, /send_proxy = false/, "只开接收时不能顺手把发送也打开");
});

test("监听地址是带方括号的 IPv6 通配，远端原样带进去", () => {
  const config = buildRealmConfigToml({ ...base, protocol: "tcp", remote: "[2001:db8::1]:443" });
  assert.match(config, /listen = "\[::0\]:20001"/, "少了方括号 realm 解析不出监听地址");
  assert.match(config, /remote = "\[2001:db8::1\]:443"/, "IPv6 远端的方括号要原样保留");
});

test("服务名和配置路径按协议分开，TCP 和 UDP 不会互相覆盖", () => {
  assert.equal(realmServiceNameForPort(20001, "tcp"), "forwardx-realm-tcp-20001");
  assert.equal(realmServiceNameForPort(20001, "udp"), "forwardx-realm-udp-20001");
  assert.notEqual(
    realmConfigPathForPort(20001, "tcp"),
    realmConfigPathForPort(20001, "udp"),
    "同一个端口的 TCP 和 UDP 配置写到同一个文件，后写的会把前一个顶掉",
  );
  assert.ok(realmConfigPathForPort(20001, "tcp").startsWith(REALM_CONFIG_DIR + "/"));
});

test("TOML 字符串会转义，不会被目标地址里的引号截断", () => {
  assert.equal(realmTomlString('a"b'), '"a\\"b"');
  assert.equal(realmTomlString(null), '""');
});

test("服务单元：绑网卡时才加 --interface", () => {
  const unitInput = { sourcePort: 20001, targetIp: "198.51.100.7", targetPort: 443, configPath: "/etc/forwardx/realm/x.toml" };
  assert.ok(!buildRealmServiceUnit(unitInput).includes("--interface"), "没指定网卡时不该凭空加参数");
  assert.match(buildRealmServiceUnit({ ...unitInput, networkInterface: "eth0" }), /--interface eth0/);
  assert.match(buildRealmServiceUnit(unitInput), /^\[Unit\]/, "单元文件要以 [Unit] 开头");
  assert.match(buildRealmServiceUnit(unitInput), /WantedBy=multi-user\.target/);
});

/* ---------------------------------------------------------------------------
 * socat / 端点地址
 * ------------------------------------------------------------------------- */

const socatBase = {
  sourcePort: 20002,
  targetIp: "198.51.100.7",
  targetPort: 443,
  dialHost: "198.51.100.7",
  dialPort: 443,
};

test("监听的协议族和拨号的协议族是两件事", () => {
  /*
    监听一律 `TCP6-LISTEN` + `ipv6only=0`（一个双栈套接字同时收 v4 和 v6），
    而拨号用哪个协议族得看目标地址长什么样。把两者当成一件事是这里最容易犯的错：
    统一成 v6 会让 IPv4 目标连不上，统一成 v4 会让 IPv6 目标连不上，
    两种都是「服务起来了但流量不通」。
  */
  const toIpv4 = buildSocatServiceUnit({ ...socatBase, descriptionProtocol: "tcp", dialProtocol: "TCP" });
  assert.match(toIpv4, /socat -b65536 TCP6-LISTEN:20002,fork,reuseaddr,ipv6only=0,nodelay /);
  assert.match(toIpv4, / TCP:198\.51\.100\.7:443,nodelay$/m);

  const toIpv6 = buildSocatServiceUnit({
    ...socatBase,
    descriptionProtocol: "tcp",
    dialProtocol: "TCP",
    dialHost: "2001:db8::1",
  });
  assert.match(toIpv6, /socat -b65536 TCP6-LISTEN:20002,fork,reuseaddr,ipv6only=0,nodelay /);
  // 目标是 IPv6：协议名带 6，地址带方括号，两样缺一不可。
  assert.match(toIpv6, / TCP6:\[2001:db8::1\]:443,nodelay$/m);
});

test("UDP 规则的监听和拨号都走 UDP", () => {
  const unit = buildSocatServiceUnit({ ...socatBase, descriptionProtocol: "udp", dialProtocol: "UDP" });
  assert.match(unit, /socat -b65536 UDP6-LISTEN:20002,/);
  assert.match(unit, / UDP:198\.51\.100\.7:443$/m);
  assert.doesNotMatch(unit, /TCP/);
  // nodelay 是 TCP 选项，写到 UDP 地址上 socat 会直接报错退出。
  assert.doesNotMatch(unit, /nodelay/);
});

test("拨号目标和展示目标分开：走故障转移时拨本机，说明里仍写真实落地", () => {
  /*
    故障转移会把 socat 指到本机的代理端口，但 Description 得留着真实的落地地址 ——
    否则运维在机器上 `systemctl status` 看到的是一句「转到 127.0.0.1」，
    完全看不出这条转发本来要去哪。
  */
  const unit = buildSocatServiceUnit({
    ...socatBase,
    descriptionProtocol: "tcp",
    dialProtocol: "TCP",
    dialHost: "127.0.0.1",
    dialPort: 51443,
  });
  assert.match(unit, /Description=NEX socat tcp forwarder 20002->198\.51\.100\.7:443$/m);
  assert.match(unit, / TCP:127\.0\.0\.1:51443,nodelay$/m);
});

test("服务名按协议分开，TCP 和 UDP 不会抢同一个 systemd 单元", () => {
  assert.equal(socatServiceNameForPort(20002, "tcp"), "forwardx-socat-tcp-20002");
  assert.equal(socatServiceNameForPort(20002, "udp"), "forwardx-socat-udp-20002");
  assert.notEqual(socatServiceNameForPort(20002, "tcp"), socatServiceNameForPort(20002, "udp"));
});

test("已经带方括号的 IPv6 不会被再包一层", () => {
  // 上游有几条路径传进来的地址本身就是 `[::1]` 形式，包两层的话 socat 直接解析不了。
  assert.equal(cleanEndpointHost("[2001:db8::1]"), "2001:db8::1");
  assert.equal(endpointHostPort("[2001:db8::1]", 443), "[2001:db8::1]:443");
  assert.equal(socatDialEndpoint("TCP", "[2001:db8::1]", 443), "TCP6:[2001:db8::1]:443");
  // 域名既不加方括号也不加 6 后缀。
  assert.equal(socatDialEndpoint("TCP", "exit.example.com", 443), "TCP:exit.example.com:443");
});
