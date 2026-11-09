/*
  面板 + 真 Agent 联调（CI 的 e2e 任务，见 .github/workflows/ci.yml 和 e2e/run.sh）。

  面板直接跑在 runner 上（node dist/index.js，sqlite），三台 Agent 和一个「落地」跑在 docker compose
  的一个网段里（e2e/compose.yml）：

      客户端(runner) → 入口 10.77.0.11:18080 ─┬→ 中转 A 10.77.0.21 ─┐
                                              └→ 中转 B 10.77.0.22 ─┴→ 落地 10.77.0.31:9000

  落地是 socat：连上先把「谁连的我」（SOCAT_PEERADDR）写回来，然后原样回显 —— 所以客户端读第一行
  就知道这次真走的是哪台中转，不用信面板说的。接着照着用户会做的事走一遍，每一步都拿真流量核对：

    1. 主备：新连接走主线路（中转 A）
    2. 人工指定备用 1 → 新连接走中转 B；指定前开着的长连接不断（平滑切换 + 子规则原地热更新）
    3. 交回自动 → 回到中转 A
    4. 按时段（时段表命中备用 1）→ 走中转 B；撤掉时段表 → 回到 A
    5. 把中转 A 的容器停掉 → 自动切到 B，记下几秒切完；再起回来 → 自动切回 A
    6. 「重新下发」接口能用；全程期望 vs 实际对账（routeStatus.drift）都是空

  只用 Agent / 界面同一套 tRPC 接口（auth、setup、agentTokens、hosts、forwardGroups、rules、
  lineDiagnostics），不碰数据库。E2E_DRY_RUN=1 时不起容器：用 hosts.create 造三台假机器，只走一遍面板侧
  的建组 / 建线路，用来在没 docker 的地方核对接口形状。
*/
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_URL = (process.env.PANEL_URL || "http://127.0.0.1:9810").replace(/\/+$/, "");
const OUT_DIR = process.env.E2E_OUT || path.join(HERE, ".out");
const COMPOSE_FILE = process.env.E2E_COMPOSE_FILE || path.join(HERE, "compose.yml");
const COMPOSE_PROJECT = process.env.E2E_COMPOSE_PROJECT || "nex-e2e";
const DRY_RUN = process.env.E2E_DRY_RUN === "1";

const ADMIN_EMAIL = "e2e-admin@forwardx.local";
const ADMIN_PASSWORD = "forwardx-e2e-admin";
const ENTRY_PORT = 18080;
const TARGET_PORT = 9000;
const NET = {
  entry: "10.77.0.11",
  relayA: "10.77.0.21",
  relayB: "10.77.0.22",
  target: "10.77.0.31",
} as const;
/** 面板和机器各按自己的钟判「改完配置多久」：和 shared/routeSpecDrift 的 ROUTE_SPEC_DRIFT_GRACE_MS 一致，再多留 5 秒。 */
const DRIFT_GRACE_MS = 20_000 + 5_000;

type JsonValue = unknown;

class PanelClient {
  private cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  private cookieHeader() {
    return Array.from(this.cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorbCookies(response: Response) {
    const header = response.headers as Headers & { getSetCookie?: () => string[] };
    for (const raw of header.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0] || "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private async call(kind: "query" | "mutation", procedure: string, input?: JsonValue): Promise<JsonValue> {
    const url = kind === "query"
      ? `${this.base}/api/trpc/${procedure}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`}`
      : `${this.base}/api/trpc/${procedure}`;
    const response = await fetch(url, {
      method: kind === "query" ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie: this.cookieHeader() },
      body: kind === "mutation" ? JSON.stringify({ json: input ?? null }) : undefined,
    });
    this.absorbCookies(response);
    const text = await response.text();
    let body: { result?: { data?: { json?: JsonValue } }; error?: { json?: { message?: string } } } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`${procedure}: HTTP ${response.status}，不是 JSON：${text.slice(0, 200)}`);
    }
    if (!response.ok || body.error) {
      throw new Error(`${procedure}: ${body.error?.json?.message || `HTTP ${response.status}`}`);
    }
    return body.result?.data?.json;
  }

  query<T = JsonValue>(procedure: string, input?: JsonValue) {
    return this.call("query", procedure, input) as Promise<T>;
  }

  mutate<T = JsonValue>(procedure: string, input?: JsonValue) {
    return this.call("mutation", procedure, input) as Promise<T>;
  }
}

/* ---------- 面板接口返回里用到的几个字段（只写用到的） ---------- */

type HostRow = { id: number; name: string; ip?: string | null; isOnline?: boolean; agentVersion?: string | null };
type RouteHop = { hostId: number; running: boolean | null; ok: boolean | null; offline: boolean | null };
type RoutePathRow = { key: string; index: number; active: boolean; healthy: boolean | null; down: boolean; downReason: string; hops: RouteHop[]; dial: { ip: string; port: number } | null };
type RouteStatus = {
  ruleId: number;
  activeIndex: number;
  agentReportedAt: number | null;
  agentStale: boolean;
  drift: { fields: Array<{ key: string; label: string; expected: string; actual: string }>; reportedAt: number } | null;
  paths: RoutePathRow[];
  policy: { mode: string; pin: { index: number; untilMs: number | null } | null; schedule: unknown };
  entry: { hostId: number; online: boolean | null; sourcePort: number };
};
type RouteEvent = { id: number; kind: string; fromKey: string | null; toKey: string | null; reason: string | null; at: number };

/* ---------- 小工具 ---------- */

const startedAt = Date.now();
const report: { steps: Array<{ name: string; ms: number; ok: boolean; note?: string }>; measurements: Record<string, number> } = { steps: [], measurements: {} };

function log(message: string) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[${elapsed}s] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const begin = Date.now();
  log(`▶ ${name}`);
  try {
    const result = await run();
    report.steps.push({ name, ms: Date.now() - begin, ok: true });
    log(`✓ ${name}（${((Date.now() - begin) / 1000).toFixed(1)}s）`);
    return result;
  } catch (error) {
    report.steps.push({ name, ms: Date.now() - begin, ok: false, note: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询到 check 返回非 null / 非 false 为止；超时抛错并带上最后一次看到的样子。 */
async function until<T>(what: string, check: () => Promise<T | null | false | undefined>, timeoutMs: number, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = undefined;
  let lastError: unknown = undefined;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError ? `最后一次出错：${lastError instanceof Error ? lastError.message : String(lastError)}` : `最后一次看到：${JSON.stringify(last)}`;
      throw new Error(`等「${what}」超时（${Math.round(timeoutMs / 1000)} 秒）。${detail}`);
    }
    await sleep(intervalMs);
  }
}

function compose(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "-p", COMPOSE_PROJECT, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(" ")} 退出码 ${result.status}`);
}

/**
 * 连一次入口，读落地写回的第一行（它看到的对端地址 = 真走的那台中转），顺手留着这条连接给调用方
 * （测平滑切换要用）。
 */
function connectThrough(host: string, port: number, timeoutMs = 8_000): Promise<{ socket: net.Socket; peer: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, peer = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve({ socket, peer });
      }
    };
    const timer = setTimeout(() => finish(new Error(`连 ${host}:${port} 后 ${timeoutMs / 1000} 秒内没读到落地写回的对端地址`)), timeoutMs);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(null, buffer.slice(0, newline).trim());
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error(`连 ${host}:${port} 被关掉了，没读到对端地址`)));
  });
}

/** 新开一条连接看真走哪台中转，看完就关。 */
async function peerOfNewConnection() {
  const { socket, peer } = await connectThrough(NET.entry, ENTRY_PORT);
  socket.destroy();
  return peer;
}

/** 连着的那条还通不通：发一行，落地的 cat 该原样回。 */
function echoAlive(socket: net.Socket, text: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      resolve(ok);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(`${text}\n`)) done(true);
    };
    const onClose = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.write(`${text}\n`);
  });
}

/* ---------- 场景 ---------- */

const panel = new PanelClient(PANEL_URL);

async function setupPanel() {
  await step("面板初始化：建管理员、登录", async () => {
    const status = await panel.query<{ hasAdmin?: boolean; setupComplete?: boolean }>("setup.status");
    if (!status?.hasAdmin) {
      await panel.mutate("setup.createAdmin", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: "e2e" });
    }
    await panel.mutate("auth.login", { username: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const me = await panel.query<{ role?: string } | null>("auth.me");
    assert(me?.role === "admin", `登录后应是管理员，拿到 ${JSON.stringify(me)}`);
  });
}

type Hosts = { entry: number; relayA: number; relayB: number };

/** 用「注册 Token」这条路：建 Token → 容器里的 Agent 拿它注册 → 面板自动建主机（和界面上「添加机器」一样）。 */
async function bringUpAgents(): Promise<Hosts> {
  const tokens = await step("建三个注册 Token", async () => {
    const make = async (description: string) => (await panel.mutate<{ id: number; token: string }>("agentTokens.create", { description })).token;
    return { entry: await make("e2e-entry"), relayA: await make("e2e-relay-a"), relayB: await make("e2e-relay-b") };
  });

  await step("构建 Agent 镜像并起容器（入口 / 中转 A / 中转 B / 落地）", async () => {
    compose(["build"]);
    compose(["up", "-d", "--no-build"], { ENTRY_TOKEN: tokens.entry, RELAY_A_TOKEN: tokens.relayA, RELAY_B_TOKEN: tokens.relayB });
  });

  const hosts = await step("等三台 Agent 注册并上线", async () => {
    const found = await until("三台机器都在线", async () => {
      const rows = await panel.query<HostRow[]>("hosts.list");
      const byName = (name: string) => rows.find((row) => row.name === name && row.isOnline);
      const entry = byName("e2e-entry");
      const relayA = byName("e2e-relay-a");
      const relayB = byName("e2e-relay-b");
      if (!entry || !relayA || !relayB) return null;
      return { entry: Number(entry.id), relayA: Number(relayA.id), relayB: Number(relayB.id), versions: [entry.agentVersion, relayA.agentVersion, relayB.agentVersion] };
    }, 300_000, 3_000);
    log(`Agent 版本：${found.versions.join(" / ")}`);
    return { entry: found.entry, relayA: found.relayA, relayB: found.relayB };
  });

  await fixAddresses(hosts);
  return hosts;
}

/** 容器报的是 runner 的公网出口 IP：把三台的地址手动钉成网段里的地址（和界面上手改「Agent 检测 IP」一样）。 */
async function fixAddresses(hosts: Hosts) {
  await step("把三台机器的地址钉成网段内地址，中转开一段端口区间给中继用", async () => {
    await panel.mutate("hosts.update", { id: hosts.entry, detectedAddress: NET.entry });
    await panel.mutate("hosts.update", { id: hosts.relayA, detectedAddress: NET.relayA, portRangeStart: 20000, portRangeEnd: 20100 });
    await panel.mutate("hosts.update", { id: hosts.relayB, detectedAddress: NET.relayB, portRangeStart: 20000, portRangeEnd: 20100 });
    const rows = await panel.query<HostRow[]>("hosts.list");
    for (const [id, ip] of [[hosts.entry, NET.entry], [hosts.relayA, NET.relayA], [hosts.relayB, NET.relayB]] as const) {
      const row = rows.find((item) => Number(item.id) === id);
      assert(row && row.ip === ip, `主机 ${id} 的地址应是 ${ip}，现在是 ${row?.ip}`);
    }
  });
}

/** 没 docker 的干跑：三台假机器。 */
async function fakeHosts(): Promise<Hosts> {
  return step("干跑：用 hosts.create 造三台假机器", async () => {
    const make = async (name: string, ip: string, relay: boolean) => (await panel.mutate<{ id: number }>("hosts.create", {
      name, ip, hostType: "slave", ...(relay ? { portRangeStart: 20000, portRangeEnd: 20100 } : {}),
    })).id;
    return { entry: await make("e2e-entry", NET.entry, false), relayA: await make("e2e-relay-a", NET.relayA, true), relayB: await make("e2e-relay-b", NET.relayB, true) };
  });
}

type RouteGroupInput = {
  mode: string;
  delivery: string;
  switchMode: string;
  paths: Array<{ key: string; name: string; hops: number[]; dest: { ip: string; port: number }; weight: number }>;
  schedule: { timezone: string; windows: Array<{ days: number[]; from: string; to: string; targetIndex: number }> } | null;
  pin: { index: number; untilMs: number | null } | null;
  failureThreshold: number;
  failoverSeconds: number;
  recoverSeconds: number;
  minHoldSeconds: number;
  autoFailback: boolean;
  scoreMargin: number;
  scoreHoldSeconds: number;
  prewarmSeconds: number;
};

function baseRouteGroup(hosts: Hosts): RouteGroupInput {
  return {
    mode: "failover",
    delivery: "cold",
    switchMode: "smooth",
    paths: [
      { key: "a", name: "经中转 A", hops: [hosts.relayA], dest: { ip: NET.target, port: TARGET_PORT }, weight: 1 },
      { key: "b", name: "经中转 B", hops: [hosts.relayB], dest: { ip: NET.target, port: TARGET_PORT }, weight: 1 },
    ],
    schedule: null,
    pin: null,
    // 切得快一点，测试别等太久：探一次不通就算异常，2 秒切走；恢复观察 2 秒；不设最短驻留
    failureThreshold: 1,
    failoverSeconds: 2,
    recoverSeconds: 2,
    minHoldSeconds: 0,
    autoFailback: true,
    scoreMargin: 10,
    scoreHoldSeconds: 5,
    prewarmSeconds: 0,
  };
}

async function createLine(hosts: Hosts) {
  return step("建端口转发组（入口机是成员）+ 一条两路中转的线路", async () => {
    const group = await panel.mutate<{ id: number }>("forwardGroups.create", {
      name: "e2e 端口转发",
      groupMode: "port",
      groupType: "host",
      protocol: "tcp",
      forwardType: "gost",
      members: [{ memberType: "host", hostId: hosts.entry, priority: 0, isEnabled: true }],
    });
    const created = await panel.mutate<{ id: number; sourcePort: number }>("rules.create", {
      forwardGroupId: group.id,
      name: "e2e 线路",
      forwardType: "gost",
      protocol: "tcp",
      sourcePort: ENTRY_PORT,
      targetIp: NET.target,
      targetPort: TARGET_PORT,
      failoverEnabled: true,
      routeGroup: baseRouteGroup(hosts),
    });
    assert(Number(created?.id) > 0, `rules.create 没返回 id：${JSON.stringify(created)}`);
    const status = await panel.query<RouteStatus | null>("rules.routeStatus", { ruleId: created.id });
    assert(status, "刚建的线路 routeStatus 为空");
    assert(status.paths.length === 2, `应有 2 条路径，拿到 ${status.paths.length}`);
    assert(status.paths[0].key === "a" && status.paths[1].key === "b", `路径 key 应保留 a / b，拿到 ${status.paths.map((row) => row.key).join(",")}`);
    assert(status.paths[0].dial?.ip === NET.relayA && status.paths[1].dial?.ip === NET.relayB, `拨号地址应是两台中转：${JSON.stringify(status.paths.map((row) => row.dial))}`);
    return { groupId: group.id, ruleId: created.id };
  });
}

async function routeStatus(ruleId: number) {
  const status = await panel.query<RouteStatus | null>("rules.routeStatus", { ruleId });
  assert(status, `routeStatus(${ruleId}) 为空`);
  return status;
}

/** 等 Agent 报的「现在走哪条」变成 index（要求不是陈旧报告）；返回从 since 到切到为止用了多少毫秒。 */
async function waitActive(ruleId: number, index: number, what: string, timeoutMs: number, since = Date.now()) {
  await until(what, async () => {
    const status = await routeStatus(ruleId);
    return status.activeIndex === index && !status.agentStale && status.agentReportedAt ? status : null;
  }, timeoutMs, 1_500);
  return Date.now() - since;
}

/** 改完配置、留足宽限之后，面板该判「机器上跑的和面板一致」。 */
async function expectNoDrift(ruleId: number, changedAt: number) {
  await until("Agent 在宽限期之后再报一次", async () => {
    const status = await routeStatus(ruleId);
    return (status.agentReportedAt || 0) >= changedAt + DRIFT_GRACE_MS ? status : null;
  }, 90_000, 2_000);
  const status = await routeStatus(ruleId);
  assert(!status.drift, `期望 vs 实际应一致，面板却报了差异：${JSON.stringify(status.drift)}`);
}

async function updateRouteGroup(ruleId: number, routeGroup: RouteGroupInput) {
  await panel.mutate("rules.update", { id: ruleId, failoverEnabled: true, routeGroup });
  return Date.now();
}

async function runScenario(hosts: Hosts, ruleId: number) {
  const routeGroup = baseRouteGroup(hosts);

  await step("等入口机上的线路跑起来、两台中转的中继跑起来、Agent 报回评分", async () => {
    await until("线路在跑、主线路在用", async () => {
      const status = await routeStatus(ruleId);
      const relaysRunning = status.paths.every((row) => row.hops.every((hop) => hop.running === true));
      const healthy = status.paths.every((row) => row.healthy === true);
      return relaysRunning && healthy && status.activeIndex === 0 && status.agentReportedAt ? status : null;
    }, 240_000, 3_000);
  });

  await step("主备：新连接真走主线路（中转 A）", async () => {
    for (let i = 0; i < 3; i += 1) {
      const peer = await peerOfNewConnection();
      assert(peer === NET.relayA, `第 ${i + 1} 条连接应从中转 A 到落地，落地看到的是 ${peer}`);
    }
  });

  const longLived = await step("开一条长连接（走中转 A），一会儿切换时看它断不断", async () => {
    const conn = await connectThrough(NET.entry, ENTRY_PORT);
    assert(conn.peer === NET.relayA, `长连接应走中转 A，落地看到的是 ${conn.peer}`);
    assert(await echoAlive(conn.socket, "hello-before-pin"), "长连接建好后回显不通");
    return conn.socket;
  });

  await step("人工指定备用 1 → 新连接走中转 B，长连接不断，切换记录有这一笔", async () => {
    routeGroup.pin = { index: 1, untilMs: null };
    const changedAt = await updateRouteGroup(ruleId, routeGroup);
    report.measurements.pinSwitchMs = await waitActive(ruleId, 1, "机器上切到备用 1", 60_000);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayB, `指定备用 1 之后新连接应走中转 B，落地看到的是 ${peer}`);
    assert(await echoAlive(longLived, "hello-after-pin"), "指定之后，原来走中转 A 的长连接断了（平滑切换应留着旧连接）");
    const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId, limit: 50 });
    assert(events.some((event) => event.toKey === "b" && event.at >= changedAt - 5_000), `切换记录里应有一条切到 b 的：${JSON.stringify(events.slice(0, 5))}`);
    await expectNoDrift(ruleId, changedAt);
  });

  await step("交回自动 → 回到主线路（中转 A）", async () => {
    routeGroup.pin = null;
    const changedAt = await updateRouteGroup(ruleId, routeGroup);
    await waitActive(ruleId, 0, "交回自动之后回到主线路", 60_000);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayA, `交回自动之后新连接应走中转 A，落地看到的是 ${peer}`);
    await expectNoDrift(ruleId, changedAt);
  });

  await step("按时段：此刻命中的时段指向备用 1 → 走中转 B", async () => {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const hhmm = (value: number) => `${String(Math.floor(((value % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((value % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;
    routeGroup.mode = "scheduled";
    routeGroup.schedule = { timezone: "UTC", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: hhmm(minutes - 60), to: hhmm(minutes + 60), targetIndex: 1 }] };
    const changedAt = await updateRouteGroup(ruleId, routeGroup);
    await waitActive(ruleId, 1, "时段命中后切到备用 1", 60_000);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayB, `时段命中后新连接应走中转 B，落地看到的是 ${peer}`);
    await expectNoDrift(ruleId, changedAt);
  });

  await step("撤掉时段表、回到主备 → 回到中转 A", async () => {
    routeGroup.mode = "failover";
    routeGroup.schedule = null;
    const changedAt = await updateRouteGroup(ruleId, routeGroup);
    await waitActive(ruleId, 0, "撤掉时段表后回到主线路", 60_000);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayA, `撤掉时段表后新连接应走中转 A，落地看到的是 ${peer}`);
    await expectNoDrift(ruleId, changedAt);
  });

  await step("中转 A 挂了（停容器）→ 自动切到 B", async () => {
    const stoppedAt = Date.now();
    compose(["stop", "relay-a"]);
    report.measurements.failoverSwitchMs = await waitActive(ruleId, 1, "中转 A 停掉后切到备用 1", 120_000, stoppedAt);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayB, `中转 A 停掉后新连接应走中转 B，落地看到的是 ${peer}`);
    const status = await routeStatus(ruleId);
    assert(status.paths[0].down || status.paths[0].healthy === false, `主线路应标成异常：${JSON.stringify({ down: status.paths[0].down, healthy: status.paths[0].healthy, reason: status.paths[0].downReason })}`);
    const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId, limit: 50 });
    assert(events.some((event) => event.kind === "switch" && event.toKey === "b" && event.at >= stoppedAt - 5_000), `切换记录里应有一条因故障切到 b 的 switch：${JSON.stringify(events.slice(0, 5))}`);
  });

  await step("中转 A 回来（起容器）→ 自动切回 A", async () => {
    const startedBack = Date.now();
    compose(["start", "relay-a"]);
    report.measurements.failbackMs = await waitActive(ruleId, 0, "中转 A 回来后切回主线路", 240_000, startedBack);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayA, `中转 A 回来后新连接应走中转 A，落地看到的是 ${peer}`);
  });

  await step("「重新下发」能用，之后对账仍然一致", async () => {
    const result = await panel.mutate<{ ok: boolean }>("lineDiagnostics.lineResync", { ruleId });
    assert(result?.ok === true, `lineResync 应返回 ok：${JSON.stringify(result)}`);
    const changedAt = Date.now();
    await waitActive(ruleId, 0, "重新下发之后主线路仍在用", 60_000);
    await expectNoDrift(ruleId, changedAt);
    const peer = await peerOfNewConnection();
    assert(peer === NET.relayA, `重新下发之后新连接应走中转 A，落地看到的是 ${peer}`);
  });

  longLived.destroy();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await setupPanel();
  const hosts = DRY_RUN ? await fakeHosts() : await bringUpAgents();
  if (DRY_RUN) await fixAddresses(hosts);
  const { ruleId } = await createLine(hosts);
  if (DRY_RUN) {
    const status = await routeStatus(ruleId);
    log(`干跑结束：ruleId=${ruleId} paths=${JSON.stringify(status.paths.map((row) => ({ key: row.key, dial: row.dial, hops: row.hops.map((hop) => hop.hostId) })))}`);
    return;
  }
  await runScenario(hosts, ruleId);
}

main()
  .then(() => {
    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify({ ok: true, ...report }, null, 2));
    log(`全部通过。切换耗时：${JSON.stringify(report.measurements)}`);
  })
  .catch((error) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...report }, null, 2));
    console.error(`✗ ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
