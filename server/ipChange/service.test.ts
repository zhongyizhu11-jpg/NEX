import assert from "node:assert/strict";
import test from "node:test";

import { ipChangeProbeServiceId } from "../../shared/ipChange";
import { createMemoryIpChangeStore } from "./memoryStore";
import { IpChangeProviderError, type IpChangeProvider, type IpChangeResult } from "./providers";
import { createCredentialCipher } from "./secrets";
import { IP_CHANGE_PLUGIN_INACTIVE_MESSAGE, IpChangeService, type IpChangeHost, type IpChangeNotice } from "./service";

/*
  换 IP 流程用内存仓库 + 假云厂商跑：探测状态机、冷却和每日上限、手动和自动的区别、单机串行、
  重启后标「结果不确定」、主 IP / 入口 IP 两种结果的地址联动（入口地址字段 + DDNS）、插件没开时什么都不做。
*/

type FakeProviderOptions = {
  changeIp?: (call: number) => Promise<IpChangeResult>;
};

function fakeProvider(options: FakeProviderOptions = {}) {
  let calls = 0;
  const provider: IpChangeProvider & { calls: () => number } = {
    id: "webhook",
    label: "假云厂商",
    docsHint: "测试用",
    credentialFields: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "account", label: "账号", type: "text" },
    ],
    targetFields: [{ key: "instanceId", label: "实例 ID", type: "text", required: true }],
    requiresDowntime: false,
    async testCredentials() {
      return { currentIp: "203.0.113.10" };
    },
    async getCurrentIp() {
      return "203.0.113.10";
    },
    async changeIp() {
      calls += 1;
      if (options.changeIp) return options.changeIp(calls);
      return { oldIp: "203.0.113.10", newIp: `198.51.100.${calls}`, ipRole: "primary", releasedOldIp: true, notes: [] };
    },
    calls: () => calls,
  };
  return provider;
}

function harness(input: { provider?: IpChangeProvider; host?: Partial<IpChangeHost>; active?: boolean } = {}) {
  let nowMs = Date.parse("2026-10-16T00:00:00Z");
  const clock = () => new Date(nowMs);
  const advance = (ms: number) => { nowMs += ms; };
  const store = createMemoryIpChangeStore(clock);
  const provider = input.provider || fakeProvider();
  const cipher = createCredentialCipher("unit-test-secret".repeat(4));
  const hosts = new Map<number, IpChangeHost>([[1, {
    id: 1, name: "港-1", ip: "203.0.113.10", ipv4: "203.0.113.10", ipv6: null, entryIp: null,
    addressManual: false, ddnsEnabled: true, ddnsDomain: "hk1.example.com", isOnline: true, lastHeartbeat: new Date(),
    ...input.host,
  }]]);
  const online = new Map<number, boolean>([[1, true]]);
  const calls = {
    hostUpdates: [] as Array<{ id: number; patch: Record<string, unknown> }>,
    addressChanged: [] as Array<{ hostId: number; current: IpChangeHost; previous: IpChangeHost }>,
    runtimeRefreshed: [] as number[],
    ddns: [] as Array<{ hostId: number; value: unknown; force?: boolean }>,
    notices: [] as IpChangeNotice[],
    agentRefreshes: [] as number[],
  };
  const state = { active: input.active ?? true };
  const service = new IpChangeService({
    store,
    resolveProvider: (id) => (id === provider.id ? provider : undefined),
    listProviders: () => [provider],
    cipher: () => cipher,
    isActive: async () => state.active,
    hosts: {
      get: async (id) => (hosts.has(id) ? { ...hosts.get(id)! } : null),
      update: async (id, patch) => {
        calls.hostUpdates.push({ id, patch });
        hosts.set(id, { ...hosts.get(id)!, ...patch });
      },
      list: async () => [...hosts.values()],
    },
    isHostOnline: (host) => online.get(Number(host.id)) === true,
    address: {
      handleHostAddressChanged: async (hostId, current, previous) => { calls.addressChanged.push({ hostId, current, previous }); },
      refreshHostAddressRuntime: async (hostId) => { calls.runtimeRefreshed.push(hostId); },
      scheduleHostDdnsUpdate: (host, _reason, options) => { calls.ddns.push({ hostId: Number(host.id), value: host.ipv4, force: options.force }); return true; },
    },
    pushAgentRefresh: (hostId) => { calls.agentRefreshes.push(hostId); },
    notify: (notice) => { calls.notices.push(notice); },
    log: () => undefined,
    fetch: (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch,
    now: clock,
    sleep: async (ms) => { advance(ms); },
    followUp: { timeoutMs: 30_000, pollMs: 10_000 },
    probeCacheTtlMs: 0,
  });
  const setup = async (overrides: Record<string, unknown> = {}) => {
    const accountId = await service.createAccount({ name: "测试账号", provider: provider.id, credentials: { apiKey: "secret-api-key-123456", account: "me" } });
    await service.saveHostConfig({
      hostId: 1,
      enabled: true,
      autoEnabled: true,
      cloudAccountId: accountId,
      target: { instanceId: "i-123" },
      checkTargets: "a.cn:80\nb.cn:80\nc.cn:80",
      checkMethod: "tcp",
      failureThreshold: 3,
      checkIntervalSeconds: 60,
      cooldownMinutes: 30,
      maxChangesPerDay: 3,
      releaseOldIp: true,
      ...overrides,
    } as any);
    return accountId;
  };
  const report = (fails: boolean[] | "all-fail" | "ok") => {
    const values = fails === "all-fail" ? [true, true, true] : fails === "ok" ? [false, false, false] : fails;
    return values.map((failed, index) => ({
      serviceId: ipChangeProbeServiceId(index),
      targetIp: ["a.cn", "b.cn", "c.cn"][index],
      targetPort: 80,
      isTimeout: failed,
      probeSuccesses: failed ? 0 : 1,
    }));
  };
  return { service, store, provider, hosts, online, calls, advance, clock, setup, report, state };
}

async function failRounds(h: ReturnType<typeof harness>, rounds: number) {
  for (let i = 0; i < rounds; i += 1) {
    h.advance(60_000);
    await h.service.ingestProbeReports(1, h.report("all-fail"));
  }
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("探测任务借主机探测服务的通道下发：保留段 serviceId、目标和间隔来自配置", async () => {
  const h = harness();
  await h.setup();
  const tasks = await h.service.getProbeTasksForHost(1);
  assert.deepEqual(tasks.map((task) => [task.serviceId, task.method, task.targetIp, task.targetPort, task.intervalSeconds]), [
    [ipChangeProbeServiceId(0), "tcping", "a.cn", 80, 60],
    [ipChangeProbeServiceId(1), "tcping", "b.cn", 80, 60],
    [ipChangeProbeServiceId(2), "tcping", "c.cn", 80, 60],
  ]);
  assert.deepEqual(h.calls.agentRefreshes, [1], "保存配置后推一次刷新，Agent 马上拿到新任务");
  assert.deepEqual(await h.service.getProbeTasksForHost(2), []);
});

test("阈值：所有目标连续 N 轮都失败才自动更换；任何一次成功清零", async () => {
  const h = harness();
  await h.setup({ autoEnabled: false });
  await failRounds(h, 2);
  assert.equal((await h.store.getConfig(1))!.consecutiveFailures, 2);
  assert.equal((await h.store.getConfig(1))!.state, "failing");
  // 只有部分目标失败：这一轮不算，也不清零
  h.advance(60_000);
  await h.service.ingestProbeReports(1, h.report([true, false, true]));
  assert.equal((await h.store.getConfig(1))!.consecutiveFailures, 0, "有一个目标通就是成功，清零");
  assert.equal((await h.store.getConfig(1))!.state, "healthy");
  await failRounds(h, 3);
  assert.equal((await h.store.getConfig(1))!.consecutiveFailures, 3);
  await settle();
  assert.equal((h.provider as any).calls(), 0, "没开自动更换不会换");
  assert.equal(h.calls.notices.filter((notice) => notice.kind === "suspected").length, 1, "到阈值提醒一次");
  await failRounds(h, 2);
  assert.equal(h.calls.notices.filter((notice) => notice.kind === "suspected").length, 1, "同一件事不反复提醒");
});

test("主机对面板离线时探测结果一律不算", async () => {
  const h = harness();
  await h.setup();
  h.online.set(1, false);
  await failRounds(h, 5);
  assert.equal((await h.store.getConfig(1))!.consecutiveFailures, 0);
  await h.service.tick();
  await settle();
  assert.equal((h.provider as any).calls(), 0);
});

test("对不上号的结果（目标改了、Agent 还拿着旧任务）不算", async () => {
  const h = harness();
  await h.setup();
  h.advance(60_000);
  await h.service.ingestProbeReports(1, h.report("all-fail").map((item) => ({ ...item, targetIp: "old.cn" })));
  assert.equal((await h.store.getConfig(1))!.consecutiveFailures, 0);
});

test("自动更换（主 IP）：先落库再调云厂商；成功后进冷却、等 Agent 报新 IP 再强制刷 DDNS", async () => {
  let observedStateDuringCall: string | undefined;
  let h!: ReturnType<typeof harness>;
  const provider = fakeProvider({
    changeIp: async () => {
      observedStateDuringCall = (await h.store.getConfig(1))!.state;
      assert.equal(h.store.events.at(-1)?.status, "running", "调用云厂商之前已经插了 running 记录");
      // Agent 很快就会自己报上新 IP（这里直接改主机行，不经过面板的 hosts.update）
      h.hosts.set(1, { ...h.hosts.get(1)!, ip: "198.51.100.7", ipv4: "198.51.100.7" });
      return { oldIp: "203.0.113.10", newIp: "198.51.100.7", ipRole: "primary", releasedOldIp: true, notes: ["旧 EIP 已释放"] };
    },
  });
  h = harness({ provider });
  await h.setup();
  await failRounds(h, 3);
  await settle();
  const config = await h.store.getConfig(1);
  assert.equal(observedStateDuringCall, "changing");
  assert.equal(config!.state, "cooldown");
  assert.equal(config!.consecutiveFailures, 0);
  assert.equal(config!.generation, 1);
  assert.ok(config!.lastChangeAt);
  const event = h.store.events.find((item) => item.trigger === "auto")!;
  assert.equal(event.status, "succeeded");
  assert.equal(event.newIp, "198.51.100.7");
  assert.equal(event.ipRole, "primary");
  // 自动检测地址的主机：面板不抢写 ip（Agent 下一次心跳可能还带着旧 IP，抢写会来回跳），等 Agent 上报
  assert.equal(h.calls.hostUpdates.length, 0);
  assert.equal(h.calls.addressChanged.length, 0, "地址变更联动由 Agent 上报那条路径触发");
  assert.deepEqual(h.calls.ddns, [{ hostId: 1, value: "198.51.100.7", force: true }], "Agent 报上新 IP 后强制刷一次 DDNS");
  assert.equal(h.calls.notices.filter((notice) => notice.kind === "changed").length, 1);
});

test("主 IP + 锁定了检测 IP 的主机：面板直接改 ip/ipv4，走地址变更联动并强制 DDNS；手填入口是旧 IP 的一起改", async () => {
  const h = harness({ host: { addressManual: true, entryIp: "203.0.113.10" } });
  await h.setup();
  const { done } = await h.service.beginChange(1, "manual");
  const outcome = await done;
  assert.equal(outcome.status, "succeeded");
  assert.equal(h.hosts.get(1)!.ipv4, "198.51.100.1");
  assert.equal(h.hosts.get(1)!.ip, "198.51.100.1");
  assert.equal(h.hosts.get(1)!.entryIp, "198.51.100.1");
  assert.equal(h.calls.addressChanged.length, 1);
  assert.equal(h.calls.addressChanged[0].previous.ipv4, "203.0.113.10");
  assert.deepEqual(h.calls.runtimeRefreshed, [1], "原来手填了入口，地址变更联动不会重算运行时，这里补上");
  assert.deepEqual(h.calls.ddns, [{ hostId: 1, value: "198.51.100.1", force: true }]);
});

test("入口 IP：主机自己的 IP 不动，入口地址改成新 IP；入口是自定义域名的不动只提醒", async () => {
  const entryProvider = () => fakeProvider({
    changeIp: async () => ({ oldIp: null, newIp: "192.0.2.55", ipRole: "entry", releasedOldIp: false, notes: [] }),
  });
  const h = harness({ provider: entryProvider() });
  await h.setup();
  const outcome = await (await h.service.beginChange(1, "manual")).done;
  assert.equal(outcome.status, "succeeded");
  assert.equal(h.hosts.get(1)!.entryIp, "192.0.2.55");
  assert.equal(h.hosts.get(1)!.ipv4, "203.0.113.10", "主机自己的 IP 不变");
  assert.equal(h.calls.addressChanged.length, 1);
  assert.deepEqual(h.calls.runtimeRefreshed, [], "原来没手填入口，handleHostAddressChanged 自己会重算运行时");
  assert.equal(h.calls.ddns.length, 0, "主机 DDNS 跟的是 ipv4，入口型更换不强刷");
  assert.ok((outcome as any).notes.some((note: string) => /DDNS/.test(note)), "提醒 DDNS 不会跟着变");

  const h2 = harness({ provider: entryProvider(), host: { entryIp: "edge.example.com" } });
  await h2.setup();
  const outcome2 = await (await h2.service.beginChange(1, "manual")).done;
  assert.equal(h2.hosts.get(1)!.entryIp, "edge.example.com");
  assert.ok((outcome2 as any).notes.some((note: string) => /自定义域名/.test(note)));
});

test("同一台主机同时只有一次更换：第二个请求直接拒绝", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = fakeProvider({
    changeIp: async () => {
      await gate;
      return { oldIp: null, newIp: "198.51.100.9", ipRole: "primary", releasedOldIp: true, notes: [] };
    },
  });
  const h = harness({ provider });
  await h.setup();
  const first = await h.service.beginChange(1, "manual");
  await assert.rejects(h.service.beginChange(1, "manual"), /正在更换/);
  await assert.rejects(h.service.resetState(1), /正在更换/);
  const auto = await h.service.maybeAutoChange(1);
  assert.equal(auto.started, false);
  release();
  await first.done;
  assert.equal((provider as any).calls(), 1);
});

test("冷却和每日上限只约束自动更换；手动更换不看冷却", async () => {
  const h = harness();
  await h.setup({ cooldownMinutes: 30, maxChangesPerDay: 2 });
  await failRounds(h, 3);
  await settle();
  assert.equal((h.provider as any).calls(), 1);
  // 冷却中又被墙：不自动换
  await failRounds(h, 3);
  await settle();
  assert.equal((h.provider as any).calls(), 1);
  assert.equal((await h.service.maybeAutoChange(1) as any).code, "cooldown");
  // 手动可以
  await (await h.service.beginChange(1, "manual")).done;
  assert.equal((h.provider as any).calls(), 2);
  // 冷却过了，但 24 小时内已经两次 → 每日上限挡住自动
  h.advance(31 * 60_000);
  await h.service.tick();
  assert.equal((await h.store.getConfig(1))!.state, "healthy", "冷却结束；换成功时计数已经清零");
  await failRounds(h, 3);
  await settle();
  assert.equal((h.provider as any).calls(), 2);
  assert.equal((await h.service.maybeAutoChange(1) as any).code, "daily-cap");
  assert.ok(h.calls.notices.some((notice) => notice.kind === "suspected" && /每日上限/.test(notice.reason)));
  // 一天以后又可以了
  h.advance(24 * 60 * 60_000);
  await h.service.tick();
  await settle();
  assert.equal((h.provider as any).calls(), 3);
});

test("云厂商说「可能已经生效」：结果不确定，自动和手动都停下，直到重置", async () => {
  const provider = fakeProvider({
    changeIp: async (call) => {
      if (call === 1) throw new IpChangeProviderError("请求超时，可能已提交 secret-api-key-123456", { retryable: true, ambiguous: true });
      return { oldIp: null, newIp: "198.51.100.20", ipRole: "primary", releasedOldIp: true, notes: [] };
    },
  });
  const h = harness({ provider });
  await h.setup();
  await failRounds(h, 3);
  await settle();
  assert.equal((provider as any).calls(), 1);
  const config = await h.store.getConfig(1);
  assert.equal(config!.state, "uncertain");
  assert.doesNotMatch(config!.lastError || "", /secret-api-key-123456/, "报错里的凭据原文被抹掉");
  assert.equal(h.store.events[0].status, "uncertain");
  await assert.rejects(h.service.beginChange(1, "manual"), /结果不确定/);
  h.advance(2 * 60 * 60_000);
  await failRounds(h, 3);
  await h.service.tick();
  await settle();
  assert.equal((provider as any).calls(), 1);
  await h.service.resetState(1);
  assert.equal((await h.store.getConfig(1))!.state, "idle");
  await (await h.service.beginChange(1, "manual")).done;
  assert.equal((provider as any).calls(), 2);
});

test("明确可重试的失败进冷却、冷却后自动再试；不可重试的进 error 等管理员", async () => {
  const retryable = fakeProvider({ changeIp: async (call) => {
    if (call === 1) throw new IpChangeProviderError("配额不足", { retryable: true });
    return { oldIp: null, newIp: "198.51.100.30", ipRole: "primary", releasedOldIp: true, notes: [] };
  } });
  const h = harness({ provider: retryable });
  await h.setup();
  await failRounds(h, 3);
  await settle();
  assert.equal((await h.store.getConfig(1))!.state, "cooldown");
  assert.equal(h.store.events[0].status, "failed");
  h.advance(31 * 60_000);
  await h.service.tick();
  await settle();
  assert.equal((retryable as any).calls(), 2);
  assert.equal(h.store.events.at(-1)!.status, "succeeded");

  const fatal = fakeProvider({ changeIp: async () => { throw new IpChangeProviderError("凭据无效", { retryable: false }); } });
  const h2 = harness({ provider: fatal });
  await h2.setup();
  await failRounds(h2, 3);
  await settle();
  assert.equal((await h2.store.getConfig(1))!.state, "error");
  h2.advance(2 * 60 * 60_000);
  await h2.service.tick();
  await settle();
  assert.equal((fatal as any).calls(), 1, "error 状态不自动重试");
  assert.ok(h2.calls.notices.some((notice) => notice.kind === "failed"));
});

test("面板在更换中途重启：启动时标成结果不确定，绝不自动重发", async () => {
  const h = harness();
  await h.setup();
  // 模拟上一个进程：已经落库（changing + running），然后进程没了
  await h.store.updateConfig(1, { state: "changing", consecutiveFailures: 5 });
  await h.store.insertEvent({ hostId: 1, trigger: "auto", provider: "webhook", oldIp: "203.0.113.10", newIp: null, ipRole: null, status: "running", error: null, notes: [], startedAt: h.clock(), finishedAt: null });
  const recovered = await h.service.recoverInterrupted();
  assert.deepEqual(recovered, [1]);
  assert.equal((await h.store.getConfig(1))!.state, "uncertain");
  assert.equal(h.store.events[0].status, "uncertain");
  h.advance(2 * 60 * 60_000);
  await h.service.tick();
  await settle();
  assert.equal((h.provider as any).calls(), 0);
});

test("插件没开：不下发探测、不收结果、定时任务不动、接口报错", async () => {
  const h = harness();
  await h.setup();
  h.state.active = false;
  assert.deepEqual(await h.service.getProbeTasksForHost(1), []);
  await failRounds(h, 5);
  assert.equal((await h.store.getConfig(1))!.consecutiveFailures, 0);
  await h.store.updateConfig(1, { consecutiveFailures: 10, state: "failing" });
  assert.deepEqual(await h.service.tick(), { checked: 0, started: 0 });
  await settle();
  assert.equal((h.provider as any).calls(), 0);
  await assert.rejects(h.service.beginChange(1, "manual"), new RegExp(IP_CHANGE_PLUGIN_INACTIVE_MESSAGE.slice(0, 6)));
  await assert.rejects(h.service.saveHostConfig({ hostId: 1 } as any), /插件/);
  assert.equal(await h.service.hostStatus(1), null);
});

test("插件启停后快照变了：心跳快路径要被打断，定时任务推一次刷新", async () => {
  const h = harness();
  await h.setup();
  await h.service.getProbeTasksForHost(1);
  assert.equal(h.service.hasPendingProbeDelivery(1), false);
  h.state.active = false;
  h.calls.agentRefreshes.length = 0;
  assert.equal(await h.service.refreshProbeDelivery(), 1);
  assert.deepEqual(h.calls.agentRefreshes, [1]);
  assert.equal(h.service.hasPendingProbeDelivery(1), true, "该撤掉的任务还没送到");
  assert.deepEqual(await h.service.getProbeTasksForHost(1), []);
  assert.equal(h.service.hasPendingProbeDelivery(1), false);
});

test("云账号接口只回打码后的凭据；原样提交打码值保留原值", async () => {
  const h = harness();
  const accountId = await h.setup();
  const [account] = await h.service.listAccounts();
  assert.deepEqual(account.credentials, { apiKey: "sec******456", account: "me" });
  assert.doesNotMatch(JSON.stringify(await h.service.listAccounts()), /secret-api-key-123456/);
  assert.doesNotMatch(h.store.accounts.get(accountId)!.credentialsJson || "", /secret-api-key-123456/, "落库的是密文");
  await h.service.updateAccount({ id: accountId, credentials: { ...account.credentials, account: "you" } });
  const changed = await h.service.listAccounts();
  assert.deepEqual(changed[0].credentials, { apiKey: "sec******456", account: "you" });
  await assert.rejects(h.service.deleteAccount(accountId), /在用/);
  assert.deepEqual(await h.service.testAccount({ accountId, target: { instanceId: "i-1" } }), { currentIp: "203.0.113.10" });
});
