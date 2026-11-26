import assert from "node:assert/strict";
import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

import { tunnelExitPinUnsupportedReason } from "../shared/tunnelExitPin";

/*
  C1 手动指定出口（tunnels.balancePinHostId）：
    · 指定的那台掉线 / 回来：马上让入口重新拿配置（以前没人催，流量进黑洞最长约 5 分钟）；
    · 指定的那台被从出口里去掉、被停用、负载均衡关了：指定清掉（以前从不清）；
    · Nginx 隧道、带中转的 NEX 链路指定了也不生效：直接拒绝；
    · 和别的改链路的操作拿同一把 tunnel:<id> 锁。
*/
test("指定不了的链路：Nginx 隧道、带中转的 NEX 链路；GOST（含多跳）和直连的 NEX 可以", () => {
  assert.match(String(tunnelExitPinUnsupportedReason({ mode: "nginx_stream" }, 0)), /Nginx 隧道/);
  assert.match(String(tunnelExitPinUnsupportedReason({ mode: "forwardx" }, 3)), /带中转的 NEX/);
  assert.equal(tunnelExitPinUnsupportedReason({ mode: "forwardx" }, 0), null);
  assert.equal(tunnelExitPinUnsupportedReason({ mode: "forwardx" }, 2), null);
  assert.equal(tunnelExitPinUnsupportedReason({ mode: "tls" }, 4), null, "GOST 多跳是入口自己排整条链，出口也是它挑");
});

test("手动指定出口：掉线 / 回来催入口，出口没了清指定，指定不了的链路拒绝，拿链路锁", () => {
  runInDatabase(String.raw`
    console.info = () => {};
    console.warn = () => {};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const now = Math.floor(Date.now() / 1000);
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'x', 'admin')");
    for (const id of [1, 2, 3, 4, 5]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, 1, 1, ?)', [id, "host-" + id, "198.51.100." + id, "198.51.100." + id, "tok" + id, now]);
    }
    const addTunnel = async (id, mode, extra = {}) => {
      await exec(
        'INSERT INTO tunnels (id, name, "entryHostId", "exitHostId", mode, "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId", "isEnabled", "isRunning") VALUES (?, ?, 1, 2, ?, ?, ?, ?, 1, 1, 1)',
        [id, "t" + id, mode, 9000 + id * 100, extra.loadBalance === false ? 0 : 1, "round_robin"],
      );
      for (const [seq, hostId] of [[1, 3], [2, 4]]) {
        await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (?, ?, ?, ?, 1)', [id, seq, hostId, 9000 + id * 100 + seq]);
      }
    };
    await addTunnel(1, "forwardx");
    await addTunnel(2, "nginx_stream");
    await addTunnel(3, "forwardx");
    // 链路 3 带一台中转（5）：入口 1 → 中转 5 → 出口 2
    for (const [seq, hostId] of [[0, 1], [1, 5], [2, 2]]) {
      await exec('INSERT INTO tunnel_hops ("tunnelId", seq, "hostId", "listenPort") VALUES (3, ?, ?, ?)', [seq, hostId, 9400 + seq]);
    }
    await addTunnel(4, "tls");

    const { tunnelsRouter } = await import(url("server/routers/tunnels.ts"));
    const caller = tunnelsRouter.createCaller({ user: { id: 1, role: "admin", username: "admin", accountEnabled: true }, req: { headers: {}, socket: {} }, res: { setHeader: () => {} }, authSession: null, authFailureReason: null });
    const message = (promise) => promise.then(() => "ok", (error) => String(error.message));
    const pinOf = async (id) => Number((await query('SELECT "balancePinHostId" FROM tunnels WHERE id = ?', [id]))[0].balancePinHostId || 0);

    // --- 指定不了的链路直接拒绝
    assert.match(await message(caller.setExitPin({ tunnelId: 2, hostId: 3 })), /Nginx 隧道的出口由 nginx 自己挑/);
    assert.match(await message(caller.setExitPin({ tunnelId: 3, hostId: 3 })), /带中转的 NEX 链路由中转挑出口/);
    assert.equal(await pinOf(2), 0);
    assert.equal(await pinOf(3), 0);
    assert.equal(await message(caller.setExitPin({ tunnelId: 1, hostId: 3 })), "ok");
    assert.equal(await message(caller.setExitPin({ tunnelId: 4, hostId: 4 })), "ok", "GOST 隧道可以指定");
    assert.equal(await pinOf(1), 3);
    assert.match(await message(caller.setExitPin({ tunnelId: 1, hostId: 5 })), /不是这条链路的出口/);
    await exec('UPDATE tunnel_exit_nodes SET "isEnabled" = 0 WHERE "tunnelId" = 4 AND "hostId" = 3');
    assert.match(await message(caller.setExitPin({ tunnelId: 4, hostId: 3 })), /已停用/);
    // 交回自动在指定不了的链路上也可以（清掉以前留下的指定）
    assert.equal(await message(caller.setExitPin({ tunnelId: 2, hostId: null })), "ok");

    // --- 拿 tunnel:<id> 锁：锁被占着时等着
    const locks = await import(url("server/keyedTaskLock.ts"));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holding = locks.withKeyedTaskLock("tunnel:1", () => gate);
    const pending = caller.setExitPin({ tunnelId: 1, hostId: 4 });
    await sleep(300);
    assert.equal(await pinOf(1), 3, "链路锁被别的操作占着：还没改");
    release();
    await holding;
    await pending;
    assert.equal(await pinOf(1), 4);

    // --- 指定的那台掉线 / 回来：催入口
    const status = await import(url("server/tunnelRuntimeStatus.ts"));
    const pins = await import(url("server/tunnelExitPin.ts"));
    const notifier = await import(url("server/hostStatusNotifier.ts"));
    status.recordTunnelRuntimeHostStatus(1, 1, true);
    status.recordTunnelRuntimeHostStatus(1, 2, true);
    assert.deepEqual(await pins.refreshTunnelsPinnedToHost(3, "test"), [], "没有链路指定着 3（链路 1 已经改指定 4）");
    await exec('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ? WHERE id = 4', [now - 6 * 3600]);
    await notifier.sweepOfflineHostsAndNotify();
    assert.equal(Number((await query('SELECT "isOnline" FROM hosts WHERE id = 4'))[0].isOnline), 0);
    assert.equal(status.isTunnelRuntimeHostReady(1, 1), false, "指定的出口掉线：入口的就绪清掉，下一次心跳带着「不指定」的规格重新下发");
    assert.equal(status.isTunnelRuntimeHostReady(1, 2), true, "别的出口不动");
    status.recordTunnelRuntimeHostStatus(1, 1, true);
    await exec('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ? WHERE id = 4', [Math.floor(Date.now() / 1000)]);
    await notifier.notifyHostOnlineIfNeeded({ id: 4, name: "host-4", isOnline: true });
    assert.equal(status.isTunnelRuntimeHostReady(1, 1), false, "指定的出口回来了：入口再拿一次配置，重新只走它");
    assert.equal(await pinOf(1), 4, "掉线不清指定：回来接着用");

    // --- 出口没了 / 停用了 / 负载均衡关了：清指定
    const repo = await import(url("server/repositories/tunnelRepository.ts"));
    assert.equal(await repo.clearStaleTunnelExitPin(1), false, "指定的那台还是出口：不清");
    await exec('UPDATE tunnel_exit_nodes SET "isEnabled" = 0 WHERE "tunnelId" = 1 AND "hostId" = 4');
    assert.equal(await repo.clearStaleTunnelExitPin(1), true);
    assert.equal(await pinOf(1), 0, "指定的出口被停用：清");
    await exec('UPDATE tunnels SET "balancePinHostId" = 3 WHERE id = 1');
    await exec('DELETE FROM tunnel_exit_nodes WHERE "tunnelId" = 1 AND "hostId" = 3');
    await repo.clearStaleTunnelExitPin(1);
    assert.equal(await pinOf(1), 0, "指定的出口被去掉：清");
    await exec('UPDATE tunnels SET "balancePinHostId" = 2, "loadBalanceEnabled" = 0 WHERE id = 1');
    await repo.clearStaleTunnelExitPin(1);
    assert.equal(await pinOf(1), 0, "负载均衡关了：清");

    // --- 出口组去掉成员：链路上的指定跟着清
    const service = await import(url("server/services/forwardGroupService.ts"));
    const member = (hostId, priority, isEnabled = true) => ({ memberType: "host", hostId, connectHost: "198.51.100." + hostId, priority, isEnabled });
    const input = (members) => ({
      name: "exits", remark: null, groupMode: "exit", groupType: "host", protocol: "tcp", forwardType: "iptables",
      proxyProtocolReceive: false, proxyProtocolSend: false, proxyProtocolExitReceive: false, proxyProtocolExitSend: false, proxyProtocolVersion: 1,
      tcpFastOpen: false, zeroCopy: false, udpOverTcp: false, udpOverTcpPort: null,
      failoverEnabled: false, failoverStrategy: "fallback", failoverTargets: [], domain: null, recordType: "A",
      failoverSeconds: 60, recoverSeconds: 120, trafficMultiplier: 100,
      chinaHealthCheckEnabled: false, chinaHealthCheckTarget: null, telegramSwitchNotifyEnabled: false, ddnsAutoResolveEnabled: false,
      autoFailback: true, isEnabled: true, exitStrategy: "round_robin", members,
    });
    const groupId = await service.createForwardGroupFromInput(input([member(2, 0), member(3, 1), member(4, 2)]), 1);
    await exec('INSERT INTO tunnels (id, name, "exitGroupId", "entryHostId", "exitHostId", mode, "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId", "isEnabled", "isRunning", "balancePinHostId") VALUES (9, ?, ?, 1, 2, ?, 9900, 1, ?, 1, 1, 1, 4)', ["grouped", groupId, "forwardx", "round_robin"]);
    await exec('INSERT INTO tunnel_exit_nodes ("tunnelId", seq, "hostId", "listenPort", "isEnabled") VALUES (9, 1, 3, 9901, 1), (9, 2, 4, 9902, 1)');
    await service.updateForwardGroupFromInput(groupId, input([member(2, 0), member(3, 1), member(4, 2, false)]));
    assert.equal(await pinOf(9), 0, "出口组里停用了指定的那台：链路上的指定清掉");
  `, { name: "exit-pin", timeoutMs: 180_000 });
});

test("NEX 隧道手动指定：出口全部下发、指定的排第一（入口按主备挑），不再只留一台", async () => {
  const { orderEntryRoutesForPin } = await import("./tunnelExitPin");
  const routes = [{ hostId: 7, host: "a" }, { hostId: 12, host: "b" }, { hostId: 2, host: "c" }];
  const pinned = orderEntryRoutesForPin(routes, 2);
  assert.equal(pinned.pinned, true);
  assert.deepEqual(pinned.routes.map((route) => route.hostId), [2, 7, 12], "指定的排第一，别的照原顺序留着当后备");
  // 指定的不在这些出口里 / 没指定 / 只有一台：原样
  assert.deepEqual(orderEntryRoutesForPin(routes, 99), { routes, pinned: false });
  assert.deepEqual(orderEntryRoutesForPin(routes, 0), { routes, pinned: false });
  assert.deepEqual(orderEntryRoutesForPin([routes[0]], 7), { routes: [routes[0]], pinned: false });
  // 指定的就是第一台：顺序不变，但照样算指定（分法换主备）
  assert.deepEqual(orderEntryRoutesForPin(routes, 7), { routes, pinned: true });
});
