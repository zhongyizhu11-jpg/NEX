import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/*
  端口转发（转发组模板）挂线路组：模板自己不下发，入口机上跑、调度、上报评分的是它展开出来的那条
  （forwardGroupRuleId = 模板）。线路详情 / 规则卡 / 线路板按模板查的话永远是「两条都待命」，
  「现在走哪条」还停在转成端口转发之前那条规则最后报的地址上。这里确认都改从展开的那条读。
*/
test("端口转发模板的线路状态从展开的规则读：评分、在走哪条、入口；列表里的「现在走哪条」也换成它的", () => {
  runInDatabase(String.raw`
    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')");
    for (const [id, name] of [[2, "Jinx(29.9y)"], [6, "po0(300M)"]]) {
      await exec('INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "agentVersion", "isOnline") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [id, name, "203.0.113." + id, "203.0.113." + id, "slave", "tok" + id, "2.2.249", true]);
    }
    const paths = JSON.stringify([
      { key: "a", name: "主线路", hops: [2], dest: null, weight: 50, probe: null, dial: null, tier: 0, lineKey: "a" },
      { key: "b", name: "备用 1", hops: [], dest: null, weight: 50, probe: null, dial: null, tier: 1, lineKey: "b" },
    ]);
    const insertRule = (id, fields) => {
      const base = {
        id, userId: 1, hostId: 6, name: "Po0(300)-Jinx/39.9y", forwardType: "gost", protocol: "tcp",
        sourcePort: 42004, targetIp: "172.81.104.158", targetPort: 45855, isEnabled: true,
        failoverEnabled: true, failoverStrategy: "fallback", routeMode: "smart", routePaths: paths,
        failoverTargets: JSON.stringify([{ targetIp: "172.81.104.158", targetPort: 45855 }]),
        ...fields,
      };
      const keys = Object.keys(base);
      return exec("INSERT INTO forward_rules (" + keys.map((key) => '"' + key + '"').join(", ") + ") VALUES (" + keys.map(() => "?").join(", ") + ")", keys.map((key) => base[key]));
    };
    // 模板：转成端口转发之前留下的「在走」还是旧地址
    await insertRule(1, { isForwardGroupTemplate: true, forwardGroupId: 1, failoverActiveTarget: "hkboil.ddos.top:24895", failoverActiveAt: 1793619039 });
    // 展开的那条：同一台入口、同一个端口，真正在跑
    // 展开时在中转机上开了端口，dial 才有；模板上的路径没有 dial
    const childPaths = JSON.stringify([
      { key: "a", name: "主线路", hops: [2], dest: null, weight: 50, probe: null, dial: { ip: "203.0.113.2", port: 43418 }, tier: 0, lineKey: "a" },
      { key: "b", name: "备用 1", hops: [], dest: null, weight: 50, probe: null, dial: null, tier: 1, lineKey: "b" },
    ]);
    await insertRule(31, { forwardGroupId: 1, forwardGroupRuleId: 1, isRunning: true, routePaths: childPaths, failoverActiveTarget: "172.81.104.158:45855", failoverActiveAt: 1793620000 });

    const stats = await import(url("server/routeGroupStats.ts"));
    stats.recordRouteAgentStats({
      hostId: 6,
      isAllowed: () => true,
      reports: [{ ruleId: 31, sourcePort: 42004, strategy: "fallback", activeIndex: 1, activeSince: Date.now() - 60_000, prewarmIndex: -1, targets: [
        { index: 0, score: 100, latencyMs: 2, healthy: true },
        { index: 1, score: 100, latencyMs: 1, healthy: true },
      ] }],
    });

    const db = await import(url("server/db.ts"));
    const view = await import(url("server/routeStatusView.ts"));
    const template = await db.getForwardRuleById(1);

    const subject = await view.routeStatusSubject(template);
    assert.equal(Number(subject.id), 31, "模板的状态应该从展开的规则 31 读");

    const status = await view.buildRouteStatus(template);
    assert.ok(status, "模板挂了线路组，应该有线路状态");
    assert.equal(status.ruleId, 1, "返回的还是模板的 id（界面上的操作对模板做）");
    assert.equal(status.activeIndex, 1, "在走哪条按展开规则的上报");
    assert.ok(status.agentReportedAt, "有 Agent 上报时间");
    assert.equal(status.agentStale, false);
    assert.equal(status.paths[0].score, 100);
    assert.equal(status.paths[1].active, true);
    assert.equal(status.entry.hostId, 6);
    assert.equal(status.entry.sourcePort, 42004);

    const listed = await view.withTemplateRouteActive([template, await db.getForwardRuleById(31)]);
    assert.equal(listed[0].failoverActiveTarget, "172.81.104.158:45855", "列表里模板的「现在走哪条」换成展开那条的");
    assert.equal(listed[1].failoverActiveTarget, "172.81.104.158:45855", "不是模板的原样");
    /*
      模板的路径带上展开那条的 dial：界面拿模板算「Agent 报的地址是哪条线路」，dial 为空时每条线路的
      地址都是空的，Agent 报的中转地址就被当成「不在线路清单里」，规则卡只能写「择优 · 2 条」。
    */
    const { routePathsOf, routePathDial } = await import(url("shared/routeGroup.ts"));
    const listedPaths = routePathsOf(listed[0]);
    assert.deepEqual(listedPaths[0].dial, { ip: "203.0.113.2", port: 43418 }, "主线路的拨号地址来自展开那条");
    assert.equal(listedPaths[1].dial, null, "直连那条本来就没有 dial");
    assert.equal(listedPaths[0].hops[0], 2, "路径本身（中转）不变");
    const { describeFailoverActiveLine } = await import(url("shared/failoverActiveLine.ts"));
    const active = describeFailoverActiveLine({ ...listed[0], failoverActiveTarget: "203.0.113.2:43418" });
    assert.equal(active.index, 0, "Agent 报的中转地址对上主线路");
    assert.equal(active.unknown, false);
    assert.ok(routePathDial(listedPaths[0], listed[0]));

    // 不是模板：就是它自己
    const plain = await db.getForwardRuleById(31);
    assert.equal(Number((await view.routeStatusSubject(plain)).id), 31);
  `, { name: "route-status-template", quiet: true });
});
