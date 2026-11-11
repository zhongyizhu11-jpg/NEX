import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  API_TOKEN_ALWAYS_ALLOWED_PREFIXES,
  API_TOKEN_MODULE_PREFIXES,
  API_TOKEN_MODULES,
  apiTokenModuleOfPath,
  apiTokenModulesAllowPath,
  apiTokenModulesLabel,
  normalizeApiTokenModules,
  serializeApiTokenModules,
} from "./apiTokenModules";

const ROOT = path.resolve(import.meta.dirname, "..");

function routerKeys(file: string, marker: string) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${file} 里找不到 ${marker}`);
  const body = source.slice(start, source.indexOf("});", start));
  return [...body.matchAll(/^\s+([A-Za-z]+):\s*[A-Za-z]+Router,?$/gm)].map((m) => m[1]);
}

/*
  勾了模块的令牌碰不到的路由：安装向导、第三方登录、令牌 / 通行密钥 / 会话、离站备份、指标导出的口令。
  这些本来就在 TOKEN_FORBIDDEN_PATHS 里或者只给网页用，故意不归任何模块。
  新加了一个路由却没归类，这个测试会红：要么归进一个模块，要么加到这里并写明为什么。
*/
const DELIBERATELY_UNMAPPED_TOP = new Set(["setup", "googleAuth", "discordAuth"]);
const DELIBERATELY_UNMAPPED_OPS = new Set(["apiTokens", "passkeys", "sessions", "offsiteBackup", "audit", "profiling", "metricsExport", "eventWebhooks"]);

test("appRouter 的每个顶层路由都有归属（模块、永远放行，或写明了不给）", () => {
  const top = routerKeys("server/routers.ts", "export const appRouter = router({");
  assert.ok(top.length > 20, `只读到 ${top.length} 个路由`);
  for (const key of top) {
    if (key === "ops") continue;
    const covered = apiTokenModuleOfPath(`${key}.x`) !== null
      || API_TOKEN_ALWAYS_ALLOWED_PREFIXES.includes(`${key}.`)
      || DELIBERATELY_UNMAPPED_TOP.has(key);
    assert.ok(covered, `${key} 没有归到任何模块`);
  }
});

test("ops 下的每个子路由都有归属", () => {
  const ops = routerKeys("server/routers/ops/index.ts", "router({");
  assert.ok(ops.length > 10, `只读到 ${ops.length} 个 ops 子路由`);
  for (const key of ops) {
    const covered = apiTokenModuleOfPath(`ops.${key}.x`) !== null || DELIBERATELY_UNMAPPED_OPS.has(key);
    assert.ok(covered, `ops.${key} 没有归到任何模块`);
  }
});

test("一个前缀只归一个模块；按最长前缀归属", () => {
  const seen = new Map<string, string>();
  for (const module of API_TOKEN_MODULES) {
    for (const prefix of API_TOKEN_MODULE_PREFIXES[module]) {
      assert.ok(prefix.endsWith("."), prefix);
      assert.equal(seen.has(prefix), false, `${prefix} 同时在 ${seen.get(prefix)} 和 ${module}`);
      seen.set(prefix, module);
    }
  }
  assert.equal(apiTokenModuleOfPath("ops.events.list"), "monitoring");
  assert.equal(apiTokenModuleOfPath("ops.webhooks.list"), "system");
  assert.equal(apiTokenModuleOfPath("ops.hostOps.importItems"), "hosts");
  assert.equal(apiTokenModuleOfPath("ops.apiRateLimit.get"), "system");
  assert.equal(apiTokenModuleOfPath("rules.listPage"), "rules");
  assert.equal(apiTokenModuleOfPath("tunnels.listPage"), "lines");
  assert.equal(apiTokenModuleOfPath("setup.status"), null);
  // 前缀要带点：rulesExtra. 不算 rules
  assert.equal(apiTokenModuleOfPath("rulesExtra.list"), null);
});

test("不限模块的令牌哪里都能去；勾了模块只能去那几块，auth. 永远放行", () => {
  assert.equal(apiTokenModulesAllowPath(null, "users.listPage"), true);
  assert.equal(apiTokenModulesAllowPath([], "users.listPage"), true);
  assert.equal(apiTokenModulesAllowPath(["rules"], "rules.toggle"), true);
  assert.equal(apiTokenModulesAllowPath(["rules"], "lineDiagnostics.lineExport"), true);
  assert.equal(apiTokenModulesAllowPath(["rules"], "hosts.listPage"), false);
  assert.equal(apiTokenModulesAllowPath(["rules"], "auth.me"), true);
  assert.equal(apiTokenModulesAllowPath(["rules", "hosts"], "setup.status"), false);
});

test("模块列表规范化：去重、去掉认不出的、按固定顺序；空 = null；逗号和 JSON 两种存法都认", () => {
  assert.deepEqual(normalizeApiTokenModules(["hosts", "rules", "hosts", "nope"]), ["rules", "hosts"]);
  assert.equal(normalizeApiTokenModules([]), null);
  assert.equal(normalizeApiTokenModules(["nope"]), null);
  assert.equal(normalizeApiTokenModules(null), null);
  assert.equal(normalizeApiTokenModules(""), null);
  assert.deepEqual(normalizeApiTokenModules("monitoring,rules"), ["rules", "monitoring"]);
  assert.deepEqual(normalizeApiTokenModules('["users"]'), ["users"]);
  assert.equal(serializeApiTokenModules(["monitoring", "rules"]), "rules,monitoring");
  assert.equal(serializeApiTokenModules(null), null);
  assert.equal(apiTokenModulesLabel(null), "全部模块");
  assert.equal(apiTokenModulesLabel(["rules", "hosts"]), "转发规则、主机");
});
