import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hostTrafficExcluded, hostTrafficFailoverThresholdBytes, normalizeHostTrafficFailoverPercent, shouldExcludeHostForTraffic } from "../shared/hostTrafficPolicy";
import { groupRuleTrafficBlocked, planTunnelTrafficParticipation } from "./hostTrafficRuntimePlan";
import { planHostTrafficPolicyRefresh } from "./hostTrafficPolicyRuntime";

// 上游 v2.3.281 的 server/hostTrafficPolicy.test.ts 移植：纯函数部分原样，SQLite 和真心跳那两段
// 按 NEX 的表结构 / 心跳输出改过。

test("host quota is opt-in and uses the configured direction and exact threshold", () => {
  const host = { trafficLimit: 1000, trafficFailoverEnabled: true, trafficFailoverThresholdPercent: 90 };
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficFailoverEnabled: false }, { bytesOut: 5000 }), false);
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficLimit: 0 }, { bytesOut: 5000 }), false);
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficMeasureMode: "outbound" }, { bytesIn: 1000, bytesOut: 899 }), false);
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficMeasureMode: "outbound" }, { bytesOut: 900 }), true);
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficMeasureMode: "both" }, { bytesIn: 450, bytesOut: 450 }), true);
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficMeasureMode: "max" }, { bytesIn: 899, bytesOut: 450 }), false);
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficMeasureMode: "max" }, { bytesIn: 900, bytesOut: 450 }), true);
  // 认不出的计量方式按双向（和主机卡片同一个口径，shared/hostTrafficQuota.ts）。
  assert.equal(shouldExcludeHostForTraffic({ ...host, trafficMeasureMode: "weird" }, { bytesIn: 450, bytesOut: 450 }), true);
  assert.equal(hostTrafficExcluded({ ...host, trafficFailoverExcluded: true }), true);
  assert.equal(hostTrafficExcluded({ ...host, trafficFailoverExcluded: 1 }), true);
  assert.equal(hostTrafficExcluded({ ...host, trafficFailoverEnabled: false, trafficFailoverExcluded: true }), false);
  assert.equal(hostTrafficExcluded({ ...host, trafficLimit: 0, trafficFailoverExcluded: true }), false);
  assert.equal(normalizeHostTrafficFailoverPercent(undefined), 100);
  assert.equal(normalizeHostTrafficFailoverPercent(0), 1);
  assert.equal(normalizeHostTrafficFailoverPercent(250), 100);
  assert.equal(normalizeHostTrafficFailoverPercent("80"), 80);
  assert.equal(hostTrafficFailoverThresholdBytes(host), 900);
  assert.equal(hostTrafficFailoverThresholdBytes({ ...host, trafficFailoverEnabled: false }), null);
});

for (const mode of ["forwardx", "tls", "nginx_stream"]) {
  test(`${mode} runtime excludes quota hosts and promotes an exit without mutating stored ports`, () => {
    const tunnel = { id: 1, mode, isEnabled: true, entryHostId: 1, entryGroupId: 10, exitHostId: 3, exitGroupId: 20, listenPort: 21001, loadBalanceEnabled: true };
    const exits = [{ id: 7, hostId: 4, seq: 1, listenPort: 22002, mimicPort: 22003, isEnabled: true, connectHost: "exit.example.test" },
      { id: 8, hostId: 5, seq: 2, listenPort: 23002, isEnabled: true }];
    const hops = [{ hostId: 1, seq: 0, listenPort: 1234 }, { hostId: 6, seq: 1, listenPort: 1235 }, { hostId: 3, seq: 2, listenPort: 21001 }];
    const saved = JSON.stringify({ tunnel, exits, hops });
    const plan = planTunnelTrafficParticipation(tunnel, hops, exits, [1, 2], new Set([1, 3, 5]));
    assert.deepEqual(plan.entryHostIds, [2]);
    assert.equal(plan.tunnel.entryHostId, 2);
    assert.equal(plan.tunnel.exitHostId, 4);
    assert.equal(plan.tunnel.listenPort, 22002);
    assert.equal(plan.tunnel.connectHost, "exit.example.test");
    assert.equal(plan.promotedExit.id, 7);
    assert.equal(plan.hops[2].hostId, 4);
    assert.equal(plan.hops[2].listenPort, 22002);
    assert.equal(plan.hops[2].seq, 2, "authentication sequence remains stable");
    assert.equal(plan.exits[0].isEnabled, false);
    assert.equal(JSON.stringify({ tunnel, exits, hops }), saved);
    const restored = planTunnelTrafficParticipation(tunnel, hops, exits, [1, 2], new Set());
    assert.equal(restored.tunnel.exitHostId, 3);
    assert.equal(restored.tunnel.listenPort, 21001);
    assert.deepEqual(restored.entryHostIds, [1, 2]);
    const allFull = planTunnelTrafficParticipation(tunnel, hops, exits, [1, 2], new Set([1, 2, 3, 4, 5]));
    assert.equal(allFull.tunnel.isEnabled, false);
    assert.deepEqual(allFull.entryHostIds, []);
    assert.equal(allFull.promotedExit, null);
  });
}

test("quota does not alter standalone rules, or silently bypass a chain transit", () => {
  assert.equal(groupRuleTrafficBlocked({ hostId: 1 }, new Set([1])), false);
  assert.equal(groupRuleTrafficBlocked({ hostId: 1, forwardGroupId: 10 }, new Set([1])), true);
  assert.equal(groupRuleTrafficBlocked({ hostId: 1, forwardGroupId: 10, isForwardGroupTemplate: 1 }, new Set([1])), false);
  assert.equal(groupRuleTrafficBlocked({ hostId: 2, forwardGroupId: 10 }, new Set([1]), [1, 2]), true);
  const single = planTunnelTrafficParticipation({ entryHostId: 1, exitHostId: 2, isEnabled: true }, [], [], [1], new Set([1, 2]));
  assert.equal(single.tunnel.isEnabled, true);
  const chain = planTunnelTrafficParticipation({ entryGroupId: 10, exitHostId: 3, isEnabled: true }, [{ hostId: 1 }, { hostId: 2 }, { hostId: 3 }], [], [1], new Set([2]));
  assert.equal(chain.tunnel.isEnabled, false);
});

test("relay failover removes only exhausted candidates and retains their authentication sequence", () => {
  const tunnel = { mode: "forwardx", isEnabled: true, relayMode: "failover", entryHostId: 1, exitHostId: 4 };
  const hops = [{ hostId: 1, seq: 0 }, { hostId: 2, seq: 1 }, { hostId: 3, seq: 2 }, { hostId: 4, seq: 3 }];
  const plan = planTunnelTrafficParticipation(tunnel, hops, [], [1], new Set([2]));
  assert.equal(plan.tunnel.isEnabled, true);
  assert.deepEqual(plan.hops.map((hop) => hop.hostId), [1, 3, 4]);
  assert.deepEqual(plan.hops.map((hop) => hop.seq), [0, 2, 3]);
  const allFull = planTunnelTrafficParticipation(tunnel, hops, [], [1], new Set([2, 3]));
  assert.equal(allFull.tunnel.isEnabled, false, "no direct bypass of all exhausted relays");
});

test("a policy transition refreshes exactly the groups, tunnels and Agents that depend on the host", () => {
  const groups = [
    { id: 10, members: [{ hostId: 1 }, { hostId: 2 }] },
    { id: 11, members: [{ hostId: 7 }] },
    { id: 12, entryGroupId: 10, members: [{ hostId: 8 }] },
    { id: 13, members: [{ tunnelId: 30, hostId: 0 }] },
  ];
  const topology = [
    { tunnel: { id: 30, entryHostId: 5, exitHostId: 1 }, hops: [], exits: [] },
    { tunnel: { id: 31, entryHostId: 6, exitHostId: 9, entryGroupId: 10 }, hops: [], exits: [{ hostId: 4 }] },
    { tunnel: { id: 32, entryHostId: 7, exitHostId: 7 }, hops: [], exits: [] },
  ];
  const plan = planHostTrafficPolicyRefresh(1, groups, topology);
  assert.deepEqual([...plan.affectedGroups].sort(), [10, 12, 13]);
  assert.deepEqual([...plan.affectedTunnels].sort(), [30, 31]);
  assert.deepEqual([...plan.affectedHosts].sort((a, b) => a - b), [1, 2, 4, 5, 6, 8, 9]);
});

test("SQLite quota state survives restart; resets/configuration/rollback retain membership", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-host-quota-"));
  const databasePath = path.join(directory, "quota.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    const schema = await mod("server/dbSchema.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const metrics = await mod("server/repositories/metricsRepository.ts");
    const hosts = await mod("server/repositories/hostRepository.ts");
    const policy = await mod("server/hostTrafficPolicy.ts");
    const groups = await mod("server/repositories/forwardGroupRepository.ts");
    const excluded = async () => { policy.invalidateHostTrafficPolicyCache(); return [...await policy.getTrafficExcludedHostIds()]; };
    const now = Math.floor(Date.now()/1000);
    await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'quota-admin', 'not-used', 'admin')");
    await runtime.executeRaw('INSERT INTO hosts (id,name,ip,ipv4,"hostType","userId","isOnline","lastHeartbeat","trafficLimit","trafficMeasureMode","trafficFailoverEnabled","trafficFailoverThresholdPercent") VALUES (1,?,?,?,?,?,?,?,?,?,?,?)', ["primary", "192.0.2.1", "192.0.2.1", "slave", 1, 1, now, 1000, "outbound", 1, 90]);
    await runtime.executeRaw('INSERT INTO hosts (id,name,ip,ipv4,"hostType","userId","isOnline","lastHeartbeat") VALUES (2,?,?,?,?,?,?,?)', ["backup", "192.0.2.2", "192.0.2.2", "slave", 1, 1, now]);
    policy.invalidateHostTrafficPolicyCache();
    await metrics.recordHostTrafficSample(1, {bytesIn: 10000, bytesOut: 10000});
    assert.deepEqual(await excluded(), []);
    await metrics.recordHostTrafficSample(1, {bytesIn: 20000, bytesOut: 10899});
    assert.deepEqual(await excluded(), []);
    await metrics.recordHostTrafficSample(1, {bytesIn: 20000, bytesOut: 10900});
    assert.deepEqual(await excluded(), [1]);
    // 只暂停组调度，主机本身照样在线。
    assert.equal(!!(await hosts.getHostById(1)).isOnline, true);
    await runtime.closeDatabase();
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    assert.deepEqual(await excluded(), [1], "survives a panel restart");
    await runtime.executeRaw('INSERT INTO forward_groups (id,name,"groupType","groupMode",domain,"targetIp","userId","isEnabled","activeMemberId","lastDdnsValue") VALUES (10,?,?,?,?,?,?,?,?,?)', ["failover","host","failover","group.example.test","0.0.0.0",1,1,101,"192.0.2.1"]);
    await runtime.executeRaw('INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled","healthStatus","lastCheckedAt") VALUES (101,10,?,1,0,1,?,?)', ["host","healthy",now]);
    await runtime.executeRaw('INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled","healthStatus","lastCheckedAt") VALUES (102,10,?,2,1,1,?,?)', ["host","healthy",now]);
    await groups.runForwardGroupFailover(10);
    assert.equal(Number((await groups.getForwardGroupById(10)).activeMemberId), 102, "quota overrides a healthy, online primary without the offline grace delay");
    await metrics.resetHostTraffic(1);
    assert.deepEqual(await excluded(), [], "a traffic reset restores participation");
    await metrics.recordHostTrafficSample(1, {bytesIn: 20020, bytesOut: 10920});
    assert.equal((await metrics.getHostTraffic(1)).bytesOut, 20, "reset preserves the system baseline");
    await metrics.correctHostTraffic(1, 1000, "outbound");
    assert.deepEqual(await excluded(), [1]);
    const router = (await mod("server/routers/hosts.ts")).hostsRouter;
    const userCaller = router.createCaller({user:{id:1,role:"user",accountEnabled:true},req:{headers:{}},res:{}});
    await userCaller.update({id:1,trafficFailoverEnabled:false,trafficFailoverThresholdPercent:100}).catch(() => {});
    assert.deepEqual(await excluded(), [1], "ordinary users cannot disable the admin traffic policy");
    const adminCaller = router.createCaller({user:{id:1,role:"admin",accountEnabled:true},req:{headers:{}},res:{}});
    await assert.rejects(adminCaller.update({id:1,trafficFailoverEnabled:true,trafficLimit:0}), /套餐流量/);
    await assert.rejects(adminCaller.update({id:1,trafficFailoverThresholdPercent:101}));
    await hosts.updateHost(1, {trafficFailoverEnabled:false});
    assert.deepEqual(await excluded(), [], "turning the switch off restores participation");
    await hosts.updateHost(1, {trafficFailoverEnabled:true,trafficLimit:2000});
    assert.deepEqual(await excluded(), [], "a bigger plan restores participation");
    await assert.rejects(runtime.withDatabaseTransaction(async () => {
      await metrics.correctHostTraffic(1,3000,"outbound");
      assert.deepEqual(await excluded(), [1]);
      throw new Error("rollback test");
    }));
    assert.deepEqual([...await policy.getTrafficExcludedHostIds()], [], "the cache never keeps a rolled-back state");
    assert.deepEqual(await excluded(), [], "a rolled-back correction leaves the state untouched");
    assert.equal((await metrics.getHostTraffic(1)).bytesOut, 1000);
    const members = await runtime.queryRaw('SELECT "isEnabled" FROM forward_group_members WHERE "groupId"=10 ORDER BY id');
    assert.deepEqual(members.map((m) => Number(m.isEnabled)), [1,1], "membership is never edited");
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("real Agent heartbeat routes grouped exits away from exhausted hosts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-quota-heartbeat-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import express from "express";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const policy = await mod("server/hostTrafficPolicy.ts");
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.values(data).map(()=>'?').join(',')+')',Object.values(data));
    const setExcluded = async (sql, params = []) => { await runtime.executeRaw(sql, params); policy.invalidateHostTrafficPolicyCache(); };
    const now = Math.floor(Date.now()/1000);
    await insert("users",{id:1,username:"quota-admin",password:"not-used",role:"admin"});
    for(let id=1;id<=5;id++) await insert("hosts",{id,name:"host-"+id,ip:"192.0.2."+id,ipv4:"192.0.2."+id,hostType:"slave",userId:1,agentToken:"quota-token-"+id,agentVersion:"2.2.199",isOnline:1,lastHeartbeat:now,
      trafficLimit:1000,trafficFailoverEnabled:1,trafficFailoverExcluded:[1,3,5].includes(id)?1:0});
    for(const [id,mode] of [[10,"entry"],[20,"exit"],[30,"port"]]) await insert("forward_groups",{id,name:mode,groupMode:mode,groupType:"host",targetIp:"192.0.2.99",userId:1});
    for(const [id,groupId,hostId,priority] of [[101,10,1,0],[102,10,2,1],[201,20,3,0],[202,20,4,1],[301,30,5,0]]) await insert("forward_group_members",{id,groupId,hostId,priority,memberType:"host"});
    await insert("tunnels",{id:40,name:"quota-tunnel",mode:"forwardx",entryHostId:1,exitHostId:3,entryGroupId:10,exitGroupId:20,listenPort:21001,userId:1,isEnabled:1,loadBalanceEnabled:1,loadBalanceStrategy:"round_robin"});
    await insert("tunnel_exit_nodes",{id:401,tunnelId:40,hostId:4,seq:1,listenPort:22001,isEnabled:1});
    await insert("forward_rules",{id:50,name:"tunnel-rule",hostId:1,tunnelId:40,forwardType:"gost",sourcePort:20001,targetIp:"192.0.2.99",targetPort:443,protocol:"tcp",tunnelExitPort:21001,userId:1,isEnabled:1});
    await insert("forward_rules",{id:51,name:"quota-port-child",hostId:5,forwardGroupId:30,forwardGroupMemberId:301,forwardGroupRuleId:52,forwardType:"realm",sourcePort:20005,targetIp:"192.0.2.99",targetPort:443,protocol:"tcp",userId:1,isEnabled:1,isRunning:1});
    await insert("forward_rules",{id:52,name:"quota-port-template",hostId:5,forwardGroupId:30,isForwardGroupTemplate:1,forwardType:"realm",sourcePort:20005,targetIp:"192.0.2.99",targetPort:443,protocol:"tcp",userId:1,isEnabled:1});
    policy.invalidateHostTrafficPolicyCache();
    const heartbeat = await mod("server/agentHeartbeatRoute.ts");
    const app=express();app.use(express.json());
    app.use((req,res,next)=>{req.agentToken=String(req.headers.authorization||"").replace(/^Bearer /,"");next();});
    heartbeat.registerAgentHeartbeatRoute(app);
    const server=http.createServer(app);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port;
    const beat=async(id)=>{
      const response=await fetch(base+"/api/agent/heartbeat",{method:"POST",headers:{authorization:"Bearer quota-token-"+id,"content-type":"application/json"},body:JSON.stringify({agentVersion:"2.2.199",uptime:1000,cpuUsage:1,memoryUsage:1,diskUsage:1,forceReconcile:true})});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
      body.actions=(body.desiredState&&body.desiredState.actions)||body.actions||[];
      return body;
    };
    const summary=(body)=>JSON.stringify(body.actions.map(a=>({ruleId:a.ruleId,tunnelId:a.tunnelId,op:a.op,type:a.forwardType,fxp:a.fxp&&{role:a.fxp.role,exitHost:a.fxp.exitHost,exitPort:a.fxp.exitPort}})));
    // 入口 1 被暂停：入口组里换成入口 2；主出口 3 被暂停：提上来备用出口 4（用它自己的端口 22001）。
    const entry=await beat(2);
    const entryAction=entry.actions.find(a=>a.ruleId===50&&a.op==="apply");
    assert.ok(entryAction,summary(entry));
    assert.equal(entryAction.fxp.exitHost,"192.0.2.4",JSON.stringify(entryAction.fxp));
    assert.equal(entryAction.fxp.exitPort,22001);
    assert.ok(![...(entryAction.fxp.exits||[]),...(entryAction.fxp.exitRoutes||[])].some(route=>route.host==="192.0.2.3"),JSON.stringify(entryAction.fxp.exits));
    // 被暂停的端口转发组成员：子规则不下发。
    const blockedPort=await beat(5);
    assert.ok(!blockedPort.actions.some(a=>a.ruleId===51&&a.op==="apply"),summary(blockedPort));
    // 被暂停的入口自己不再装这条隧道规则。
    const oldEntry=await beat(1);
    assert.ok(!oldEntry.actions.some(a=>a.ruleId===50&&a.op==="apply"),summary(oldEntry));
    const saved=(await runtime.queryRaw('SELECT "entryHostId","exitHostId","listenPort","isEnabled" FROM tunnels WHERE id=40'))[0];
    assert.deepEqual({...saved},{entryHostId:1,exitHostId:3,listenPort:21001,isEnabled:1},"stored tunnel is untouched");
    // 出口全被暂停：不退回到被暂停的主出口。
    await setExcluded('UPDATE hosts SET "trafficFailoverExcluded"=1 WHERE id=4');
    const allFull=await beat(2);
    assert.ok(!allFull.actions.some(a=>a.ruleId===50&&a.op==="apply"),"no fallback to an exhausted primary: "+summary(allFull));
    // 全部恢复：回到保存着的主出口和端口。
    await setExcluded('UPDATE hosts SET "trafficFailoverExcluded"=0');
    await runtime.executeRaw('UPDATE tunnels SET "isRunning"=0 WHERE id=40');
    await runtime.executeRaw('UPDATE forward_rules SET "isRunning"=0 WHERE id=50');
    const restored=await beat(1);
    const restoredEntry=restored.actions.find(a=>a.ruleId===50&&a.op==="apply");
    assert.ok(restoredEntry,summary(restored));
    assert.equal(restoredEntry.fxp.exitHost,"192.0.2.3");
    assert.equal(restoredEntry.fxp.exitPort,21001);
    await new Promise((resolve)=>server.close(resolve));process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "heartbeat.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
