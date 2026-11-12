/*
  面板 + 真 Agent 联调（CI 的 e2e 任务，见 .github/workflows/ci.yml 和 e2e/run.sh）。

  面板直接跑在 runner 上（node dist/index.js，sqlite），三台 Agent 和一个「落地」跑在 docker compose
  的一个网段里（e2e/compose.yml）：

      客户端(runner) → 入口 10.77.0.11:18080 ─┬→ 中转 A 10.77.0.21 ─┐
                                              └→ 中转 B 10.77.0.22 ─┴→ 落地 10.77.0.31:9000

  落地是 socat：连上先把「谁连的我」（SOCAT_PEERADDR）写回来，然后原样回显 —— 所以客户端读第一行
  就知道这次真走的是哪台中转，不用信面板说的。接着照着用户会做的事走一遍，每一步都拿真流量核对（三条线路分家，
  见下面 Lines 的说明）：

    1. 主备：新连接走主线路（中转 A）
    2. 人工指定备用 1 → 新连接走中转 B；指定前开着的长连接不断（平滑切换 + 子规则原地热更新）
    3. 交回自动 → 回到中转 A
    4. 按时段（时段表命中备用 1）→ 走中转 B；撤掉时段表 → 回到 A；「重新下发」接口能用
    5. 切换演练：把主线路当成挂了 20 秒 → 切到 B，到点切回 A，报告里有几秒切完、几秒切回
    6. 把中转 A 的容器停掉 → 自动切到 B，记下几秒切完；再起回来 → 自动切回 A
    7. 全程期望 vs 实际对账（routeStatus.drift）都是空

  只用 Agent / 界面同一套 tRPC 接口（auth、setup、agentTokens、hosts、forwardGroups、rules、
  lineDiagnostics），不碰数据库。E2E_DRY_RUN=1 时不起容器：用 hosts.create 造三台假机器，只走一遍面板侧
  的建组 / 建线路，用来在没 docker 的地方核对接口形状。
*/
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_VERSION } from "../shared/versions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_URL = (process.env.PANEL_URL || "http://127.0.0.1:9810").replace(/\/+$/, "");
const OUT_DIR = process.env.E2E_OUT || path.join(HERE, "out");
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
  drill: { active: { phase: string; switchMs: number | null; switchedToLabel: string | null } | null; reports: Array<{ switched: boolean; switchMs: number | null; restored: boolean | null; restoreMs: number | null; connectionsBefore: number | null; connectionsAfter: number | null; reason: string }> } | null;
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

/** 起容器时定下来的 Token 变量：之后每次 compose 都带着（stop / start 也会插值 compose 文件）。 */
let composeEnv: Record<string, string> = {};

function compose(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "-p", COMPOSE_PROJECT, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...composeEnv, ...env },
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
async function peerOfNewConnection(port: number = ENTRY_PORT) {
  const { socket, peer } = await connectThrough(NET.entry, port);
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
    // 装机脚本默认先去 GitHub 拿发布版的 Agent；这里要测的是面板这次构建出来的那份（dist/agent），让它优先从面板装。
    await panel.mutate("system.updateSettings", { agentPreferPanelInstall: true });
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
    composeEnv = { ENTRY_TOKEN: tokens.entry, RELAY_A_TOKEN: tokens.relayA, RELAY_B_TOKEN: tokens.relayB };
    compose(["build"]);
    compose(["up", "-d", "--no-build"]);
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
    log(`Agent 版本：${found.versions.join(" / ")}（面板这次构建的是 ${AGENT_VERSION}）`);
    // 装机脚本默认先去 GitHub 拿发布版；测的必须是这次构建的 Agent，不然新加的协议（比如规格回报）根本不在里面。
    for (const version of found.versions) {
      assert(String(version || "").trim() === AGENT_VERSION, `容器里装的 Agent 是 ${version}，不是面板这次构建的 ${AGENT_VERSION}：装机没有走面板资产`);
    }
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

/*
  三条线路分家。Agent 有抖动抑制（agent/failover_selection.go）：同一条规则一小时内自动切 3 次以上，之后的切换要等
  5–60 分钟（人工指定不算，当前线路挂了的逃生也不受限）。场景里交回、时段、撤时段、故障切换、演练加起来远不止
  3 次 —— 第一版把这些都压在一条规则上，中转 A 回来后的切回就被它按规矩压住了 10 分钟。所以分三条规则各演各的：
    manual   人工指定 / 交回 / 按时段 / 撤时段 / 重新下发（3 次自动切换，之后不再指望它切）
    drill    切换演练（切走 + 切回 2 次）
    failure  停掉中转 A 再起回来（切走 + 切回 2 次）
  每条规则在入口机上一个端口，落地写回的对端地址就是它真走的中转。
*/
type Lines = { manual: number; drill: number; failure: number };
const LINE_PORTS = { manual: ENTRY_PORT, drill: ENTRY_PORT + 1, failure: ENTRY_PORT + 2 } as const;

async function createLines(hosts: Hosts): Promise<Lines> {
  return step("建端口转发组（入口机是成员）+ 三条两路中转的线路", async () => {
    const group = await panel.mutate<{ id: number }>("forwardGroups.create", {
      name: "e2e 端口转发",
      groupMode: "port",
      groupType: "host",
      protocol: "tcp",
      forwardType: "gost",
      members: [{ memberType: "host", hostId: hosts.entry, priority: 0, isEnabled: true }],
    });
    const make = async (name: string, sourcePort: number) => {
      const created = await panel.mutate<{ id: number; sourcePort: number }>("rules.create", {
        forwardGroupId: group.id,
        name,
        forwardType: "gost",
        protocol: "tcp",
        sourcePort,
        targetIp: NET.target,
        targetPort: TARGET_PORT,
        failoverEnabled: true,
        routeGroup: baseRouteGroup(hosts),
      });
      assert(Number(created?.id) > 0, `rules.create(${name}) 没返回 id：${JSON.stringify(created)}`);
      const status = await panel.query<RouteStatus | null>("rules.routeStatus", { ruleId: created.id });
      assert(status, `刚建的线路 ${name} routeStatus 为空`);
      assert(status.paths.length === 2, `${name} 应有 2 条路径，拿到 ${status.paths.length}`);
      assert(status.paths[0].key === "a" && status.paths[1].key === "b", `${name} 路径 key 应保留 a / b，拿到 ${status.paths.map((row) => row.key).join(",")}`);
      assert(status.paths[0].dial?.ip === NET.relayA && status.paths[1].dial?.ip === NET.relayB, `${name} 拨号地址应是两台中转：${JSON.stringify(status.paths.map((row) => row.dial))}`);
      return created.id;
    };
    return {
      manual: await make("e2e 指定 / 时段", LINE_PORTS.manual),
      drill: await make("e2e 演练", LINE_PORTS.drill),
      failure: await make("e2e 故障切换", LINE_PORTS.failure),
    };
  });
}

async function routeStatus(ruleId: number) {
  const status = await panel.query<RouteStatus | null>("rules.routeStatus", { ruleId });
  assert(status, `routeStatus(${ruleId}) 为空`);
  return status;
}

/** 出错时把这条线路此刻的样子和最近几条切换记录带上，CI 日志里一眼看出卡在哪。 */
async function describeLine(ruleId: number) {
  const status = await routeStatus(ruleId).catch(() => null);
  const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId, limit: 8 }).catch(() => [] as RouteEvent[]);
  const paths = status?.paths.map((row) => ({ key: row.key, active: row.active, healthy: row.healthy, down: row.down, reason: row.downReason, hops: row.hops.map((hop) => ({ running: hop.running, offline: hop.offline, ok: hop.ok })) }));
  const recent = events.map((event) => ({ kind: event.kind, from: event.fromKey, to: event.toKey, reason: event.reason, at: new Date(event.at).toISOString() }));
  return `\n  线路状态：${JSON.stringify({ activeIndex: status?.activeIndex, agentReportedAt: status?.agentReportedAt, drill: status?.drill, paths })}\n  最近事件：${JSON.stringify(recent)}`;
}

/** 等 Agent 报的「现在走哪条」变成 index（要求不是陈旧报告）；返回从 since 到切到为止用了多少毫秒。 */
async function waitActive(ruleId: number, index: number, what: string, timeoutMs: number, since = Date.now()) {
  try {
    await until(what, async () => {
      const status = await routeStatus(ruleId);
      return status.activeIndex === index && !status.agentStale && status.agentReportedAt ? status : null;
    }, timeoutMs, 1_500);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${await describeLine(ruleId)}`);
  }
  return Date.now() - since;
}

/** 线路在入口机上跑起来、两台中转的中继跑起来、主线路在用、Agent 报回了评分。 */
async function waitLineUp(ruleId: number) {
  try {
    await until(`线路 ${ruleId} 在跑、主线路在用`, async () => {
      const status = await routeStatus(ruleId);
      const relaysRunning = status.paths.every((row) => row.hops.every((hop) => hop.running === true));
      const healthy = status.paths.every((row) => row.healthy === true);
      return relaysRunning && healthy && status.activeIndex === 0 && status.agentReportedAt ? status : null;
    }, 240_000, 3_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${await describeLine(ruleId)}`);
  }
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

async function runScenario(hosts: Hosts, lines: Lines) {
  const routeGroup = baseRouteGroup(hosts);

  await step("等三条线路在入口机上跑起来、中继跑起来、Agent 报回评分", async () => {
    for (const ruleId of Object.values(lines)) await waitLineUp(ruleId);
  });

  await step("主备：三条线路的新连接都真走主线路（中转 A）", async () => {
    for (const [name, port] of Object.entries(LINE_PORTS)) {
      const peer = await peerOfNewConnection(port);
      assert(peer === NET.relayA, `${name} 的新连接应从中转 A 到落地，落地看到的是 ${peer}`);
    }
  });

  const longLived = await step("开一条长连接（走中转 A），一会儿切换时看它断不断", async () => {
    const conn = await connectThrough(NET.entry, LINE_PORTS.manual);
    assert(conn.peer === NET.relayA, `长连接应走中转 A，落地看到的是 ${conn.peer}`);
    assert(await echoAlive(conn.socket, "hello-before-pin"), "长连接建好后回显不通");
    return conn.socket;
  });

  await step("人工指定备用 1 → 新连接走中转 B，长连接不断，切换记录有这一笔", async () => {
    routeGroup.pin = { index: 1, untilMs: null };
    const changedAt = await updateRouteGroup(lines.manual, routeGroup);
    report.measurements.pinSwitchMs = await waitActive(lines.manual, 1, "机器上切到备用 1", 60_000);
    const peer = await peerOfNewConnection(LINE_PORTS.manual);
    assert(peer === NET.relayB, `指定备用 1 之后新连接应走中转 B，落地看到的是 ${peer}`);
    assert(await echoAlive(longLived, "hello-after-pin"), "指定之后，原来走中转 A 的长连接断了（平滑切换应留着旧连接）");
    const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId: lines.manual, limit: 50 });
    assert(events.some((event) => event.toKey === "b" && event.at >= changedAt - 5_000), `切换记录里应有一条切到 b 的：${JSON.stringify(events.slice(0, 5))}`);
    await expectNoDrift(lines.manual, changedAt);
  });

  await step("交回自动 → 回到主线路（中转 A）", async () => {
    routeGroup.pin = null;
    const changedAt = await updateRouteGroup(lines.manual, routeGroup);
    await waitActive(lines.manual, 0, "交回自动之后回到主线路", 60_000);
    const peer = await peerOfNewConnection(LINE_PORTS.manual);
    assert(peer === NET.relayA, `交回自动之后新连接应走中转 A，落地看到的是 ${peer}`);
    await expectNoDrift(lines.manual, changedAt);
  });

  await step("按时段：此刻命中的时段指向备用 1 → 走中转 B", async () => {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const hhmm = (value: number) => `${String(Math.floor(((value % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((value % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;
    routeGroup.mode = "scheduled";
    routeGroup.schedule = { timezone: "UTC", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: hhmm(minutes - 60), to: hhmm(minutes + 60), targetIndex: 1 }] };
    const changedAt = await updateRouteGroup(lines.manual, routeGroup);
    await waitActive(lines.manual, 1, "时段命中后切到备用 1", 60_000);
    const peer = await peerOfNewConnection(LINE_PORTS.manual);
    assert(peer === NET.relayB, `时段命中后新连接应走中转 B，落地看到的是 ${peer}`);
    await expectNoDrift(lines.manual, changedAt);
  });

  await step("撤掉时段表、回到主备 → 回到中转 A", async () => {
    routeGroup.mode = "failover";
    routeGroup.schedule = null;
    const changedAt = await updateRouteGroup(lines.manual, routeGroup);
    await waitActive(lines.manual, 0, "撤掉时段表后回到主线路", 60_000);
    const peer = await peerOfNewConnection(LINE_PORTS.manual);
    assert(peer === NET.relayA, `撤掉时段表后新连接应走中转 A，落地看到的是 ${peer}`);
    await expectNoDrift(lines.manual, changedAt);
  });

  await step("「重新下发」能用，之后对账仍然一致", async () => {
    const result = await panel.mutate<{ ok: boolean }>("lineDiagnostics.lineResync", { ruleId: lines.manual });
    assert(result?.ok === true, `lineResync 应返回 ok：${JSON.stringify(result)}`);
    const changedAt = Date.now();
    await waitActive(lines.manual, 0, "重新下发之后主线路仍在用", 60_000);
    await expectNoDrift(lines.manual, changedAt);
    const peer = await peerOfNewConnection(LINE_PORTS.manual);
    assert(peer === NET.relayA, `重新下发之后新连接应走中转 A，落地看到的是 ${peer}`);
  });

  longLived.destroy();

  await step("切换演练：把主线路当成挂了 20 秒 → 切到 B，到点切回 A，出报告", async () => {
    const started = Date.now();
    const result = await panel.mutate<{ ok: boolean; started: number; seconds: number }>("lineDiagnostics.lineDrillStart", { ruleId: lines.drill, lineKey: "a", seconds: 20 });
    assert(result?.ok === true && result.started === 1, `lineDrillStart 应登记 1 份：${JSON.stringify(result)}`);
    report.measurements.drillSwitchMs = await waitActive(lines.drill, 1, "演练：机器切到备用 1", 40_000, started);
    const during = await routeStatus(lines.drill);
    assert(during.drill?.active?.phase === "down", `演练应在进行中：${JSON.stringify(during.drill)}`);
    assert(during.paths[0].down && /演练/.test(during.paths[0].downReason), `主线路应标成演练中：${JSON.stringify({ down: during.paths[0].down, reason: during.paths[0].downReason })}`);
    const peer = await peerOfNewConnection(LINE_PORTS.drill);
    assert(peer === NET.relayB, `演练中新连接应走中转 B，落地看到的是 ${peer}`);
    const done = await until("演练结束出报告", async () => {
      const status = await routeStatus(lines.drill);
      return !status.drill?.active && status.drill?.reports[0] ? status.drill.reports[0] : null;
    }, 150_000, 2_000);
    assert(done.switched && done.switchMs !== null && done.switchMs <= 20_000, `报告应写几秒切完：${JSON.stringify(done)}${await describeLine(lines.drill)}`);
    assert(done.restored === true && done.restoreMs !== null, `报告应写恢复后切回了：${JSON.stringify(done)}${await describeLine(lines.drill)}`);
    report.measurements.drillRestoreMs = done.restoreMs;
    await waitActive(lines.drill, 0, "演练结束后机器回到主线路", 30_000);
    const after = await peerOfNewConnection(LINE_PORTS.drill);
    assert(after === NET.relayA, `演练结束后新连接应回到中转 A，落地看到的是 ${after}`);
    const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId: lines.drill, limit: 50 });
    assert(events.filter((event) => event.kind === "drill").length >= 2, `切换记录里应有演练开始、结束两笔：${JSON.stringify(events.slice(0, 6))}`);
  });

  await step("中转 A 挂了（停容器）→ 自动切到 B", async () => {
    const stoppedAt = Date.now();
    compose(["stop", "relay-a"]);
    report.measurements.failoverSwitchMs = await waitActive(lines.failure, 1, "中转 A 停掉后切到备用 1", 120_000, stoppedAt);
    const peer = await peerOfNewConnection(LINE_PORTS.failure);
    assert(peer === NET.relayB, `中转 A 停掉后新连接应走中转 B，落地看到的是 ${peer}`);
    const status = await routeStatus(lines.failure);
    assert(status.paths[0].down || status.paths[0].healthy === false, `主线路应标成异常：${JSON.stringify({ down: status.paths[0].down, healthy: status.paths[0].healthy, reason: status.paths[0].downReason })}`);
    const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId: lines.failure, limit: 50 });
    assert(events.some((event) => event.kind === "switch" && event.toKey === "b" && event.at >= stoppedAt - 5_000), `切换记录里应有一条因故障切到 b 的 switch：${JSON.stringify(events.slice(0, 5))}`);
  });

  await step("中转 A 回来（起容器）→ 自动切回 A", async () => {
    const startedBack = Date.now();
    compose(["start", "relay-a"]);
    // 另两条线路也跟着切过去了，但它们这一小时里已经自动切过几次，切回会被抖动抑制压住，这里只看这一条。
    // 线路刚建好时中继还没起全，偶尔会有一次「主线路不健康 → 切走 → 马上切回」的开机抖动。算上它，这条规则一小时里
    // 的自动切换就到了 3 次，切回会被抖动抑制按规矩压 5 分钟（事件里有 flap_hold，带着压到几点）。这是 Agent 该有的行为，
    // 不是故障：看到 flap_hold 就等到它写的时间再加一分钟余量，而不是在 240 秒上判失败（2026-11 main 上偶发红过一次）。
    report.measurements.failbackMs = await waitActive(lines.failure, 0, "中转 A 回来后切回主线路", 240_000, startedBack).catch(async (error) => {
      const events = await panel.query<RouteEvent[]>("rules.routeEvents", { ruleId: lines.failure, limit: 20 });
      const holdUntil = events
        .filter((event) => event.kind === "flap_hold" && event.at >= startedBack - 60_000)
        .map((event) => Date.parse(/until (\S+)/.exec(event.reason || "")?.[1] || ""))
        .filter((at) => Number.isFinite(at))
        .sort((a, b) => b - a)[0];
      if (!holdUntil) throw error;
      report.steps.push({ name: "切回被抖动抑制压住，等它到点", ms: 0, ok: true, note: `hold until ${new Date(holdUntil).toISOString()}` });
      return waitActive(lines.failure, 0, "抖动抑制到点后切回主线路", Math.max(holdUntil - Date.now(), 0) + 90_000, startedBack);
    });
    const peer = await peerOfNewConnection(LINE_PORTS.failure);
    assert(peer === NET.relayA, `中转 A 回来后新连接应走中转 A，落地看到的是 ${peer}`);
  });

  await step("收尾：三条线路的期望 vs 实际对账都没有差异", async () => {
    for (const [name, ruleId] of Object.entries(lines)) {
      const status = await routeStatus(ruleId);
      assert(!status.drift, `${name} 的面板配置和机器上跑的应一致：${JSON.stringify(status.drift)}`);
    }
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await setupPanel();
  const hosts = DRY_RUN ? await fakeHosts() : await bringUpAgents();
  if (DRY_RUN) await fixAddresses(hosts);
  const lines = await createLines(hosts);
  if (DRY_RUN) {
    for (const [name, ruleId] of Object.entries(lines)) {
      const status = await routeStatus(ruleId);
      log(`干跑：${name} ruleId=${ruleId} paths=${JSON.stringify(status.paths.map((row) => ({ key: row.key, dial: row.dial, hops: row.hops.map((hop) => hop.hostId) })))}`);
    }
    return;
  }
  await runScenario(hosts, lines);
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
