import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDatabaseHealth, type DatabaseHealth } from "@shared/databaseHealth";
import { DatabaseUnavailableView } from "./DatabaseHealthGate";

const outage: DatabaseHealth = {
  state: "unavailable",
  databaseType: "postgresql",
  checkedAt: "2026-10-02T00:00:05Z",
  unavailableSince: "2026-10-02T00:00:00Z",
  reason: { code: "ECONNREFUSED", message: "数据库连接被拒绝", suggestion: "检查数据库服务是否启动" },
  restartRequired: false,
};

test("database diagnostic view shows safe reasons without exposing a setup or login form", () => {
  const html = renderToStaticMarkup(<DatabaseUnavailableView health={outage} checking={false} onRetry={() => {}} />);
  assert.match(html, /数据库暂时不可用/);
  assert.match(html, /PostgreSQL/);
  assert.match(html, /ECONNREFUSED/);
  assert.match(html, /数据库连接被拒绝/);
  assert.match(html, /检查数据库服务是否启动/);
  assert.match(html, /重新检查/);
  assert.match(html, /role="alert"/);
  assert.match(html, /不会清除你的登录状态/);
  assert.doesNotMatch(html, /<input|<form|创建管理员|href="\/setup"|href="\/login"/);
  // 只有初始化失败、存储错误这类才提示重启。
  assert.doesNotMatch(html, /重启面板/);
  const restart = renderToStaticMarkup(<DatabaseUnavailableView health={{ ...outage, restartRequired: true }} checking={true} onRetry={() => {}} />);
  assert.match(restart, /重启面板/);
  assert.match(restart, /检查中/);
  assert.match(restart, /disabled=""/);
});

test("health responses from older panels or garbage are ignored", () => {
  assert.equal(parseDatabaseHealth(null), null);
  assert.equal(parseDatabaseHealth({ state: "broken" }), null);
  assert.equal(parseDatabaseHealth("<html>"), null);
  assert.equal(parseDatabaseHealth(outage)?.state, "unavailable");
});
