import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpMessage, handleMcpPayload, JSON_RPC_INVALID_PARAMS, JSON_RPC_METHOD_NOT_FOUND, sanitizeForMcp, type McpSession } from "./mcp";
import { API_TOKEN_FORBIDDEN_MESSAGE, API_TOKEN_READ_ONLY_MESSAGE, apiTokenPolicyError } from "./apiTokenPolicy";
import { API_TOKEN_DISPLAY_PREFIX_LENGTH, generateApiToken, hashApiToken, isApiTokenFormat, readApiTokenFromHeader } from "./apiTokens";

function session(overrides: Partial<McpSession> = {}): McpSession & { calls: Array<{ path: string; input: unknown }> } {
  const calls: Array<{ path: string; input: unknown }> = [];
  return {
    scope: "read",
    isAdmin: true,
    pollIntervalMs: 0,
    pollTimeoutMs: 50,
    invoke: async (path: string, input?: unknown) => {
      calls.push({ path, input });
      if (path === "rules.getById") return { id: 3, name: "香港", agentToken: "secret", nested: { password: "x", ok: 1 } };
      if (path === "hosts.listPage") return { items: [{ id: 1, name: "HK", ip: "1.1.1.1", agentToken: "t", extra: "drop" }], total: 1, page: 1, pageSize: 20 };
      if (path === "rules.toggle") return { success: true };
      if (path === "ops.events.list") throw new Error('No procedure found on path "ops.events.list"');
      if (path === "rules.routeBoard") {
        return [{
          ruleId: 7,
          name: "港日",
          userId: 1,
          userName: "alice",
          status: {
            ruleId: 7,
            policy: { mode: "smart" },
            activeIndex: 0,
            agentStale: false,
            entry: { hostId: 1, name: "入口", online: true, sourcePort: 443 },
            paths: [{ key: "p1", letter: "A", name: "主线路", active: true, healthy: true, down: false, downReason: "", score: 92, latencyMs: 38, lossPct: 0, jitterMs: 2, hops: [{ hostId: 2, name: "港-1", rate: { inBps: 1 } }], dials: { ok: 3 } }],
          },
        }];
      }
      if (path === "rules.routeStatus") return { ruleId: 7, paths: [], activeIndex: 0 };
      if (path === "rules.routeEvents") return [{ id: 1, kind: "recovered", toLabel: "B 备用", at: 1 }];
      if (path === "lineDiagnostics.lineExport") {
        return { filename: "line-7.json", contentType: "application/json", body: JSON.stringify({ rule: { id: 7, name: "港日" }, events: [{ kind: "unhealthy" }], quality: [], agentToken: "leak" }) };
      }
      return null;
    },
    calls,
    ...overrides,
  } as any;
}

// ---------- 令牌 ----------

test("令牌是 nex_ + 40 位 base62，前缀取开头 8 个字符，哈希是 sha256 hex", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { token, prefix, hash } = generateApiToken();
    assert.match(token, /^nex_[0-9A-Za-z]{40}$/);
    assert.equal(prefix, token.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH));
    assert.equal(hash, hashApiToken(token));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(isApiTokenFormat(token));
    seen.add(token);
  }
  assert.equal(seen.size, 50);
  assert.equal(isApiTokenFormat("nex_short"), false);
  assert.equal(isApiTokenFormat(`nex_${"a".repeat(39)}!`), false);
});

test("只认 Bearer nex_ 令牌，App 的会话 JWT 不归这里管", () => {
  assert.equal(readApiTokenFromHeader("Bearer nex_abc"), "nex_abc");
  assert.equal(readApiTokenFromHeader("Bearer eyJhbGciOi..."), null);
  assert.equal(readApiTokenFromHeader(undefined), null);
  assert.equal(readApiTokenFromHeader("Basic nex_abc"), null);
});

test("只读令牌不能跑 mutation；任何令牌都不能动令牌、密码、2FA、通行密钥、登录设备", () => {
  assert.equal(apiTokenPolicyError("read", "rules.listPage", "query"), null);
  assert.equal(apiTokenPolicyError("read", "rules.toggle", "mutation"), API_TOKEN_READ_ONLY_MESSAGE);
  assert.equal(apiTokenPolicyError("full", "rules.toggle", "mutation"), null);
  for (const path of ["ops.apiTokens.create", "ops.apiTokens.list", "ops.passkeys.remove", "ops.sessions.revokeOthers", "auth.changePassword", "auth.enableTwoFactor", "auth.disableTwoFactor", "users.resetPassword"]) {
    assert.equal(apiTokenPolicyError("full", path, "mutation"), API_TOKEN_FORBIDDEN_MESSAGE, path);
  }
  // 名字只是以禁用过程开头的别的过程不受影响。
  assert.equal(apiTokenPolicyError("full", "auth.changePasswordHint", "query"), null);
  assert.equal(apiTokenPolicyError("read", "auth.me", "query"), null);
});

// ---------- MCP ----------

test("initialize 回显支持的协议版本，不支持的给默认版本；serverInfo.name 是 nex", async () => {
  const known = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, session()) as any;
  assert.equal(known.result.protocolVersion, "2025-03-26");
  assert.equal(known.result.serverInfo.name, "nex");
  assert.ok(known.result.capabilities.tools);
  const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, session()) as any;
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
});

test("通知回 202 无正文，ping 回空结果，未知方法 -32601", async () => {
  assert.deepEqual(await handleMcpPayload({ jsonrpc: "2.0", method: "notifications/initialized" }, session()), { status: 202 });
  const ping = await handleMcpPayload({ jsonrpc: "2.0", id: "p", method: "ping" }, session());
  assert.deepEqual(ping, { status: 200, body: { jsonrpc: "2.0", id: "p", result: {} } });
  const missing = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "resources/list" }, session()) as any;
  assert.equal(missing.error.code, JSON_RPC_METHOD_NOT_FOUND);
  const batch = await handleMcpPayload([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "ping" }], session());
  assert.equal(batch.status, 200);
  assert.equal((batch.body as any[]).length, 1);
});

test("tools/list 按令牌权限过滤：只读令牌看不到修改类工具，普通用户看不到管理员工具", async () => {
  const names = async (s: McpSession) => ((await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, s)) as any).result.tools.map((tool: any) => tool.name);
  const readAdmin = await names(session());
  assert.ok(readAdmin.includes("list_hosts"));
  assert.ok(readAdmin.includes("list_users"));
  assert.ok(!readAdmin.includes("set_rule_enabled"));
  const fullUser = await names(session({ scope: "full", isAdmin: false }));
  assert.ok(fullUser.includes("set_rule_enabled"));
  assert.ok(fullUser.includes("create_rule"));
  assert.ok(!fullUser.includes("list_users"));
  assert.ok(!fullUser.includes("reset_user_traffic"));
  // 线路组的四个工具都是只读的：只读令牌、普通用户都能用
  const readUser = await names(session({ isAdmin: false }));
  for (const name of ["list_lines", "get_line", "get_line_events", "export_line"]) {
    assert.ok(readAdmin.includes(name), name);
    assert.ok(readUser.includes(name), name);
  }
  const all = ((await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, session({ scope: "full" }))) as any).result.tools;
  assert.ok(all.length >= 12);
  for (const tool of all) {
    assert.equal(tool.inputSchema.type, "object");
    assert.match(tool.description, /[一-龥]/);
  }
});

test("只读令牌调修改类工具：isError，不会真去调过程", async () => {
  const s = session();
  const response = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_rule_enabled", arguments: { id: 3, enabled: false } } }, s) as any;
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /只读/);
  assert.equal(s.calls.length, 0);
});

test("工具调用走 tRPC 过程，结果去掉令牌 / 密码类字段，列表只留摘要字段", async () => {
  const s = session({ scope: "full" });
  const rule = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_rule", arguments: { id: 3 } } }, s) as any;
  const parsed = JSON.parse(rule.result.content[0].text);
  assert.deepEqual(parsed, { id: 3, name: "香港", nested: { ok: 1 } });
  const toggled = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_rule_enabled", arguments: { id: 3, enabled: false } } }, s) as any;
  assert.equal(toggled.result.isError, undefined);
  assert.deepEqual(s.calls.at(-1), { path: "rules.toggle", input: { id: 3, isEnabled: false } });
  const hosts = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_hosts", arguments: {} } }, s) as any;
  assert.deepEqual(JSON.parse(hosts.result.content[0].text).items, [{ id: 1, name: "HK", ip: "1.1.1.1" }]);
});

test("参数不对、未知工具、事件接口缺失都有清楚的回应", async () => {
  const s = session();
  const bad = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_rule", arguments: { id: "x" } } }, s) as any;
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /参数不对/);
  const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } }, s) as any;
  assert.equal(unknown.error.code, JSON_RPC_INVALID_PARAMS);
  const events = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_events", arguments: {} } }, s) as any;
  assert.equal(events.result.isError, undefined);
  assert.match(events.result.content[0].text, /还没有事件接口/);
});

test("sanitizeForMcp 去掉敏感字段、日期转字符串", () => {
  assert.deepEqual(sanitizeForMcp({ a: new Date(0), twoFactorSecret: "s", mobileToken: "t", list: [{ password: "p", b: 1 }] }), {
    a: "1970-01-01T00:00:00.000Z",
    list: [{ b: 1 }],
  });
});

test("线路组工具：list_lines 走 rules.routeBoard 并压成摘要，get_line / get_line_events / export_line 各调各的过程", async () => {
  const s = session();
  const call = async (name: string, args: unknown) => {
    const response = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, s) as any;
    assert.equal(response.result.isError, undefined, response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  };
  const lines = await call("list_lines", {});
  assert.deepEqual(s.calls.at(-1), { path: "rules.routeBoard", input: {} });
  assert.deepEqual(lines, [{
    ruleId: 7,
    name: "港日",
    userName: "alice",
    mode: "smart",
    activeIndex: 0,
    entry: { hostId: 1, name: "入口", online: true },
    agentStale: false,
    paths: [{ letter: "A", name: "主线路", active: true, healthy: true, down: false, downReason: null, score: 92, latencyMs: 38, lossPct: 0, jitterMs: 2, hops: "港-1" }],
  }]);
  await call("list_lines", { scope: "all" });
  assert.deepEqual(s.calls.at(-1), { path: "rules.routeBoard", input: { scope: "all" } });

  assert.deepEqual(await call("get_line", { ruleId: 7 }), { ruleId: 7, paths: [], activeIndex: 0 });
  assert.deepEqual(s.calls.at(-1), { path: "rules.routeStatus", input: { ruleId: 7 } });

  await call("get_line_events", { ruleId: 7 });
  assert.deepEqual(s.calls.at(-1), { path: "rules.routeEvents", input: { ruleId: 7, limit: 30 } });

  const exported = await call("export_line", { ruleId: 7, hours: 168 });
  assert.deepEqual(s.calls.at(-1), { path: "lineDiagnostics.lineExport", input: { ruleId: 7, format: "json", hours: 168 } });
  assert.deepEqual(exported, { rule: { id: 7, name: "港日" }, events: [{ kind: "unhealthy" }], quality: [] });

  const tooLong = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "export_line", arguments: { ruleId: 7, hours: 500 } } }, s) as any;
  assert.equal(tooLong.result.isError, true);
});
