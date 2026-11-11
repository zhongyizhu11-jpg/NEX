import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  API_TOKEN_FORBIDDEN_MESSAGE,
  API_TOKEN_READ_ONLY_MESSAGE,
  apiTokenForbiddenPaths,
  apiTokenPolicyError,
  apiTokenProfileUpdateError,
} from "./apiTokenPolicy";

test("令牌碰不到夺号、整库带走、装插件这几类过程，读写令牌都一样", () => {
  const paths = [
    "setup.resetExistingData",
    "setup.updateAdmin",
    "setup.saveDatabase",
    "setup.status",
    "telegram.createBindCode",
    "telegram.unbind",
    "telegram.login",
    "telegram.startMobileLogin",
    "googleAuth.setInitialPassword",
    "googleAuth.unlink",
    "discordAuth.setInitialPassword",
    "discordAuth.unlink",
    "system.exportPanelBackup",
    "system.importPanelBackup",
    "system.getMigrationCode",
    "system.createMigrationCode",
    "system.startPanelMigration",
    "system.startDatabaseSwitch",
    "system.revealPanelSslKey",
    "plugins.installFromUpload",
    "plugins.installFromGithub",
    "plugins.installFromStore",
    "plugins.updateFromGithub",
    "plugins.setTrusted",
    "plugins.runAction",
    "ops.offsiteBackup.get",
    "ops.offsiteBackup.save",
    "ops.offsiteBackup.restore",
    "ops.audit.list",
    "ops.audit.setRetention",
    "ops.profiling.status",
    "ops.profiling.setEnabled",
    "ops.profiling.captureCpu",
    "ops.profiling.captureHeap",
    "ops.profiling.remove",
    "ops.metricsExport.get",
    "ops.metricsExport.update",
    "ops.metricsExport.revealToken",
    "ops.metricsExport.resetToken",
  ];
  for (const procedure of paths) {
    for (const scope of ["read", "full"] as const) {
      for (const type of ["query", "mutation"]) {
        assert.equal(apiTokenPolicyError(scope, procedure, type), API_TOKEN_FORBIDDEN_MESSAGE, `${scope} ${procedure}`);
      }
    }
  }
  // 普通业务过程不受影响。
  assert.equal(apiTokenPolicyError("full", "plugins.list", "query"), null);
  assert.equal(apiTokenPolicyError("full", "system.getSettings", "query"), null);
  assert.equal(apiTokenPolicyError("full", "telegram.status", "query"), null);
  assert.equal(apiTokenPolicyError("read", "system.backupSummary", "query"), null);
  assert.equal(apiTokenPolicyError("read", "plugins.runAction", "mutation"), API_TOKEN_FORBIDDEN_MESSAGE);
  assert.equal(apiTokenPolicyError("read", "rules.toggle", "mutation"), API_TOKEN_READ_ONLY_MESSAGE);
  // 前缀相同的别的过程不会被误伤。
  assert.equal(apiTokenPolicyError("full", "telegram.loginStatus", "query"), null);
  assert.equal(apiTokenPolicyError("full", "setupWizardHint", "query"), null);
});

test("令牌改资料：改昵称照常，换邮箱被拒；网页会话不受影响", () => {
  const token = { scope: "full" as const };
  assert.equal(apiTokenProfileUpdateError(token, { email: undefined }, "a@example.com"), null);
  assert.equal(apiTokenProfileUpdateError(token, { email: "A@Example.com " }, "a@example.com"), null);
  assert.equal(apiTokenProfileUpdateError(token, { email: "b@example.com" }, "a@example.com"), API_TOKEN_FORBIDDEN_MESSAGE);
  assert.equal(apiTokenProfileUpdateError(token, { email: "b@example.com" }, null), API_TOKEN_FORBIDDEN_MESSAGE);
  assert.equal(apiTokenProfileUpdateError(null, { email: "b@example.com" }, "a@example.com"), null);
});

test("MCP 工具调用的过程都不在禁止名单里", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server/ops/mcp.ts"), "utf8");
  const invoked = [...source.matchAll(/s\.invoke\("([^"]+)"/g)].map((match) => match[1]);
  assert.ok(invoked.length > 10);
  for (const procedure of invoked) {
    assert.equal(apiTokenPolicyError("full", procedure, "mutation"), null, procedure);
  }
});

test("禁止名单里的每个过程都真实存在（防止改名后名单悄悄失效）", () => {
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { appRouter } = await import(pathToFileURL(path.join(process.cwd(), "server/routers.ts")).href);
    process.stdout.write("\n@@" + JSON.stringify(Object.keys(appRouter._def.procedures)) + "\n");
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", JWT_SECRET: "api-token-policy-test-secret" },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((item) => item.startsWith("@@"));
  assert.ok(line, result.stdout);
  const procedures: string[] = JSON.parse(line.slice(2));
  for (const rule of apiTokenForbiddenPaths()) {
    if (rule.endsWith(".")) {
      assert.ok(procedures.some((procedure) => procedure.startsWith(rule)), `没有以 ${rule} 开头的过程`);
    } else {
      assert.ok(procedures.includes(rule), `过程不存在：${rule}`);
    }
  }
});

test("勾了模块的令牌：范围内照常（只读仍不能改），范围外一律拒，禁止名单永远最先", () => {
  // 范围内
  assert.equal(apiTokenPolicyError("full", "rules.toggle", "mutation", ["rules"]), null);
  assert.equal(apiTokenPolicyError("read", "rules.listPage", "query", ["rules"]), null);
  // 范围内但只读令牌改东西
  assert.equal(apiTokenPolicyError("read", "rules.toggle", "mutation", ["rules"]), API_TOKEN_READ_ONLY_MESSAGE);
  // 范围外：查询也拒，说明里写清能去哪、这个过程归哪
  const denied = apiTokenPolicyError("full", "hosts.listPage", "query", ["rules"]);
  assert.match(String(denied), /只能访问：转发规则/);
  assert.match(String(denied), /hosts\.listPage 属于「主机」/);
  // 没归类的路由勾了模块也不给
  assert.match(String(apiTokenPolicyError("full", "googleAuth.status", "query", ["rules", "hosts"])), /未开放给令牌的部分/);
  // setup. 本来就在禁止名单里：禁止的说明优先
  assert.equal(apiTokenPolicyError("full", "setup.status", "query", ["rules", "hosts"]), API_TOKEN_FORBIDDEN_MESSAGE);
  // auth.me 永远能调
  assert.equal(apiTokenPolicyError("read", "auth.me", "query", ["rules"]), null);
  // 禁止名单优先：就算勾了「系统设置」，导出备份照样拒
  assert.equal(apiTokenPolicyError("full", "system.exportPanelBackup", "mutation", ["system"]), API_TOKEN_FORBIDDEN_MESSAGE);
  // 不传 / 空 = 不限，和老令牌一样
  assert.equal(apiTokenPolicyError("full", "users.listPage", "query"), null);
  assert.equal(apiTokenPolicyError("full", "users.listPage", "query", []), null);
  assert.equal(apiTokenPolicyError("full", "users.listPage", "query", null), null);
});

test("令牌不能改接口限流（不能给自己解除限流），能查看", () => {
  assert.equal(apiTokenPolicyError("full", "ops.apiRateLimit.update", "mutation"), API_TOKEN_FORBIDDEN_MESSAGE);
  assert.equal(apiTokenPolicyError("full", "ops.apiRateLimit.get", "query"), null);
});
