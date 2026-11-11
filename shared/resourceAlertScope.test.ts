import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RESOURCE_ALERT_CONFIG,
  isHostInResourceAlertScope,
  normalizeHostResourceAlertOverride,
  normalizeResourceAlertConfig,
  resolveHostResourceAlertConfig,
  type ResourceAlertConfig,
} from "./resourceAlert";

const global: ResourceAlertConfig = { ...DEFAULT_RESOURCE_ALERT_CONFIG, enabled: true, cpuPercent: 90, memoryPercent: 85, diskPercent: 95 };

test("没有覆盖、范围是全部主机：原样用全局设置（和以前完全一样）", () => {
  assert.equal(resolveHostResourceAlertConfig(global, 1, null), global);
  // 全局总开关关着：本机「始终监控」也不报
  assert.equal(resolveHostResourceAlertConfig({ ...global, enabled: false }, 1, { mode: "on", cpuPercent: 60, memoryPercent: null, diskPercent: null }).enabled, false);
});

test("范围：指定主机 / 排除主机", () => {
  const include: ResourceAlertConfig = { ...global, scope: "include", scopeHostIds: [2, 3] };
  assert.equal(isHostInResourceAlertScope(include, 2, null), true);
  assert.equal(isHostInResourceAlertScope(include, 1, null), false);
  assert.equal(resolveHostResourceAlertConfig(include, 1, null).enabled, false);
  const exclude: ResourceAlertConfig = { ...global, scope: "exclude", scopeHostIds: [2] };
  assert.equal(isHostInResourceAlertScope(exclude, 2, null), false);
  assert.equal(isHostInResourceAlertScope(exclude, 1, null), true);
});

test("本机开 / 关压过范围；阈值逐项覆盖，留空用全局", () => {
  const include: ResourceAlertConfig = { ...global, scope: "include", scopeHostIds: [2] };
  const forced = resolveHostResourceAlertConfig(include, 1, { mode: "on", cpuPercent: 70, memoryPercent: null, diskPercent: 0 });
  assert.equal(forced.enabled, true);
  assert.equal(forced.cpuPercent, 70);
  assert.equal(forced.memoryPercent, 85);
  assert.equal(forced.diskPercent, 0);
  assert.equal(resolveHostResourceAlertConfig(global, 2, { mode: "off", cpuPercent: null, memoryPercent: null, diskPercent: null }).enabled, false);
  const inherit = resolveHostResourceAlertConfig(global, 2, { mode: "inherit", cpuPercent: null, memoryPercent: 99, diskPercent: null });
  assert.equal(inherit.enabled, true);
  assert.equal(inherit.memoryPercent, 99);
  assert.equal(inherit.cpuPercent, 90);
});

test("覆盖规整：全跟随等于没有；阈值和全局同一范围", () => {
  assert.equal(normalizeHostResourceAlertOverride(null), null);
  assert.equal(normalizeHostResourceAlertOverride(""), null);
  assert.equal(normalizeHostResourceAlertOverride("{bad"), null);
  assert.equal(normalizeHostResourceAlertOverride({ mode: "inherit" }), null);
  assert.deepEqual(normalizeHostResourceAlertOverride(JSON.stringify({ mode: "on", cpuPercent: "30", memoryPercent: 120, diskPercent: "" })), {
    mode: "on",
    cpuPercent: 50,
    memoryPercent: 100,
    diskPercent: null,
  });
  assert.equal(normalizeHostResourceAlertOverride({ mode: "weird", cpuPercent: 0 })?.mode, "inherit");
});

test("全局设置的新字段：默认全部主机、不通知所属用户；主机列表从 JSON 字符串读回", () => {
  const normalized = normalizeResourceAlertConfig({ enabled: true });
  assert.equal(normalized.scope, "all");
  assert.deepEqual(normalized.scopeHostIds, []);
  assert.equal(normalized.notifyOwner, false);
  const stored = normalizeResourceAlertConfig({ scope: "exclude", scopeHostIds: "[3,1,3,-1,\"x\"]", notifyOwner: "true" });
  assert.equal(stored.scope, "exclude");
  assert.deepEqual(stored.scopeHostIds, [1, 3]);
  assert.equal(stored.notifyOwner, true);
  assert.equal(normalizeResourceAlertConfig({ scope: "nope" }).scope, "all");
});
