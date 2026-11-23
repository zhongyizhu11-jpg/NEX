import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 设置页宽屏是「左边分区、右边内容」。右边那一栏的宽度不跟着窗口走：窗口 1280 时它只有
 * 700 来像素，而 lg:/xl: 看的是窗口 —— 在这一栏里写 xl:grid-cols-2，两张表单卡会被并排
 * 挤成两条 340px 的窄条。所以这一页里的分栏一律按容器宽度写（@[42rem]: / @[58rem]:）。
 *
 * 这条守在源码上：以后有人照别的页面的习惯写一个 lg:grid-cols-2，这里会报出来。
 */
// 设置页的六个分区抽成了懒加载模块（client/src/components/settings/*Section.tsx 等），分栏写法在那里，一起看。
const settingsSections = ["SystemInfoSection", "PersonalizationSettingsSection", "BackupRestoreSection", "DeepSeekSettingsCard", "TelegramBotSettingsCard", "PanelLogsSection"];
const source = [
  path.resolve(import.meta.dirname, "Settings.tsx"),
  ...settingsSections.map((name) => path.resolve(import.meta.dirname, "../components/settings", `${name}.tsx`)),
].map((file) => fs.readFileSync(file, "utf8")).join("\n");
const emailSource = fs.readFileSync(path.resolve(import.meta.dirname, "EmailSettings.tsx"), "utf8");

test("设置页里的分栏按容器宽度切，不按窗口宽度切", () => {
  const viewportColumns = source.match(/(?<![\w@\-[/])(?:lg|xl|2xl):(?:grid-cols-|col-span-)[^\s"'`]*/g) ?? [];
  assert.deepEqual(viewportColumns, []);
  // 反向对照：容器写法确实在用，上面那条不是因为整页没有分栏才通过的
  assert.ok((source.match(/@\[(?:42|58)rem\]:grid-cols-/g) ?? []).length >= 20);
});

test("右边那一栏是容器；宽屏与否看这一页自己的宽度（侧栏收起时 1024 的窗口也够两栏）", () => {
  assert.match(source, /className="@container\/settings"/);
  assert.match(source, /<div className="@container min-w-0 space-y-4">/);
  assert.match(source, /<nav aria-label="设置分区" className="hidden @min-\[56rem\]\/settings:sticky/);
});

test("邮箱设置嵌在分区里，不再自己带一个页头（一屏两个 h1）", () => {
  assert.doesNotMatch(emailSource, /WorkspaceHeader/);
  // 反向对照：系统设置页自己的页头还在
  assert.match(source, /<WorkspaceHeader title="系统设置"/);
});
