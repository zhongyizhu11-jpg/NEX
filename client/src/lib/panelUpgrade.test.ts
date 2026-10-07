import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { getPanelUpgradeProgress } from "./panelUpgrade";

/*
  升级进度原来有两份实现（侧边栏一份、设置页一份），而且已经漂了。
  下面第一条就是当时能同时看见的那个分歧场景。
*/

const 升级中 = (...logs: string[]) => ({ status: "running", mode: "upgrade", logs });

test("Docker 构建打出 transferring context 时，只有一个答案", () => {
  // 这行是 docker build 必然会打的。原来侧边栏算 52%「下载或拉取资产」，
  // 设置页算 74%「安装并重启」—— 你在设置页升级时侧边栏就在旁边，两个数同时在屏幕上。
  const progress = getPanelUpgradeProgress(升级中("开始升级面板", "Docker image 构建", "=> transferring context: 2.1kB"));
  assert.equal(progress.percent, 74);
  assert.equal(progress.label, "安装并重启");
  assert.deepEqual(progress.steps.map((step) => step.done), [true, true, true, false]);
});

test("pnpm 安装的日志特征也认（原来只有设置页认）", () => {
  for (const line of ["Packages: +812", "写入 node_modules", "transferring context"]) {
    const progress = getPanelUpgradeProgress(升级中("开始升级", "panel bundle 已就绪", line));
    assert.equal(progress.steps[2].done, true, `${line} 应当算作「下载或拉取资产」完成`);
  }
});

test("各个状态给出的进度", () => {
  assert.deepEqual(
    getPanelUpgradeProgress({ status: "idle", mode: "upgrade", logs: [] }),
    { percent: 0, label: "等待升级", detail: null, steps: [
      { label: "准备升级", done: false, active: false },
      { label: "检查发布资产", done: false, active: false },
      { label: "下载或拉取资产", done: false, active: false },
      { label: "安装并重启", done: false, active: false },
    ] },
  );

  const success = getPanelUpgradeProgress({ status: "success", mode: "upgrade", logs: [] });
  assert.equal(success.percent, 100);
  assert.equal(success.label, "升级完成，正在等待面板恢复");
  assert.ok(success.steps.every((step) => step.done));

  const waiting = getPanelUpgradeProgress({ status: "waiting_assets", mode: "upgrade", logs: [] });
  assert.equal(waiting.percent, 34);
  assert.equal(waiting.label, "等待 GitHub Actions 构建发布资产");

  const failed = getPanelUpgradeProgress({ status: "error", mode: "upgrade", logs: ["开始升级"] });
  assert.equal(failed.label, "升级异常");
  assert.ok(failed.percent >= 10);
});

test("回退用的是回退的说法，不是升级", () => {
  assert.equal(getPanelUpgradeProgress({ status: "idle", mode: "rollback", logs: [] }).label, "等待回退");
  assert.equal(getPanelUpgradeProgress({ status: "success", mode: "rollback", logs: [] }).label, "回退完成，正在等待面板恢复");
  assert.equal(getPanelUpgradeProgress({ status: "error", mode: "rollback", logs: [] }).label, "回退异常");
});

test("job 为空也要有说法，不能炸", () => {
  assert.equal(getPanelUpgradeProgress(null).percent, 0);
  assert.equal(getPanelUpgradeProgress(undefined).label, "等待升级");
  // logs 不是数组（服务端字段缺失时会这样）也不能炸
  assert.equal(getPanelUpgradeProgress({ status: "running", logs: "不是数组" as never }).percent, 12);
});

test("升级进度只有一处实现", () => {
  /*
    这条是防复发的。两份实现漂了多久没人知道 —— 因为两边各自看都「对」，
    只有并排摆出来才看得出分歧。步骤文案在源码里出现超过一次，就说明又抄了一份。
  */
  const root = path.resolve(import.meta.dirname, "..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(item.name) && !/\.test\.tsx?$/.test(item.name)) {
        if (fs.readFileSync(full, "utf8").includes("下载或拉取资产")) hits.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, ["lib/panelUpgrade.ts"], `升级进度的步骤文案出现在多个文件里，说明逻辑又被抄了一份：\n  ${hits.join("\n  ")}`);
});

/*
  2.3.398 起脚本自己报步骤。用户在手机上看到的「74% 卡好几分钟」就是老办法的毛病：
  「Downloading panel bundle」一行同时判完两步，下载、解压、装依赖整段停在同一个数。
*/

const 新脚本升级中 = (...logs: string[]) => ({
  status: "running",
  mode: "upgrade",
  startedAt: "2026-09-30T08:00:00.000Z",
  logs: ["[NEX] Current version v2.3.397", "[NEX] Starting panel 升级 to 2.3.398", ...logs],
});
const 时刻 = (seconds: number) => ({ now: Date.parse("2026-09-30T08:00:00.000Z") + seconds * 1000 });

test("按脚本报的 step N/M 算：五步均匀铺开 10 / 28 / 46 / 64 / 82", () => {
  const first = getPanelUpgradeProgress(新脚本升级中("[NEX] step 1/5 检查发布资产"), 时刻(3));
  assert.equal(first.percent, 10);
  assert.equal(first.label, "检查发布资产");
  assert.equal(first.detail, "已用 3 秒");
  assert.deepEqual(first.steps.map((step) => step.label), ["检查发布资产", "下载面板包", "解压文件", "安装依赖", "重启面板"]);
  assert.deepEqual(first.steps.map((step) => step.active), [true, false, false, false, false]);

  const percents = [1, 2, 3, 4, 5].map((n) =>
    getPanelUpgradeProgress(新脚本升级中(...Array.from({ length: n }, (_, i) => `[NEX] step ${i + 1}/5 x`)), 时刻(0)).percent,
  );
  assert.deepEqual(percents, [10, 28, 46, 64, 82]);

  const docker = getPanelUpgradeProgress(新脚本升级中("[NEX] step 1/4 检查镜像", "[NEX] step 2/4 拉取镜像"), 时刻(0));
  assert.equal(docker.label, "拉取镜像");
  assert.deepEqual(docker.steps.map((step) => step.done), [true, false, false, false]);
  assert.equal(docker.steps.length, 4);
});

test("2.3.414 之前的脚本打的是 [ForwardX] 前缀：升级到这版时跑的还是旧脚本，照样按标记算", () => {
  const legacy = getPanelUpgradeProgress(
    新脚本升级中("[ForwardX] step 1/5 检查发布资产", "[ForwardX] step 2/5 下载面板包", "[ForwardX] progress download 12845056/51380224 25%"),
    时刻(80),
  );
  assert.equal(legacy.percent, 33);
  assert.equal(legacy.label, "下载面板包");
  assert.equal(legacy.detail, "12.25 MB / 49 MB · 已用 1 分 20 秒");
  assert.deepEqual(legacy.steps.map((step) => step.done), [true, false, false, false, false]);
});

test("下载那一步的条真的随字节数走，小字写着「已下载 / 总量」", () => {
  const at = (line: string) => getPanelUpgradeProgress(
    新脚本升级中("[NEX] step 1/5 检查发布资产", "[NEX] step 2/5 下载面板包", "[INFO] Downloading panel bundle: https://…", line),
    时刻(80),
  );
  const quarter = at("[NEX] progress download 12845056/51380224 25%");
  assert.equal(quarter.percent, 33); // 28 + 18 * 0.25 = 32.5
  assert.equal(quarter.label, "下载面板包");
  assert.equal(quarter.detail, "12.25 MB / 49 MB · 已用 1 分 20 秒");
  const done = at("[NEX] progress download 51380224/51380224 100%");
  assert.equal(done.percent, 46);
  // 总长度不知道：百分比不动（不能瞎猜），只说已下载多少
  const unknown = at("[NEX] progress download 4194304/- -%");
  assert.equal(unknown.percent, 28);
  assert.equal(unknown.detail, "已下载 4 MB · 已用 1 分 20 秒");
  // 进入下一步后，上一步留下的进度行不再影响条
  const extracting = getPanelUpgradeProgress(
    新脚本升级中("[NEX] step 2/5 下载面板包", "[NEX] progress download 1/2 50%", "[NEX] step 3/5 解压文件"),
    时刻(0),
  );
  assert.equal(extracting.percent, 46);
  assert.equal(extracting.detail, "已用 0 秒");
});

test("「依赖未变化，跳过安装」那一步立刻完成，条推到重启那一步", () => {
  const progress = getPanelUpgradeProgress(
    新脚本升级中("[NEX] step 3/5 解压文件", "[NEX] step 4/5 依赖未变化，跳过安装"),
    时刻(40),
  );
  assert.equal(progress.percent, 82);
  assert.equal(progress.label, "依赖未变化，跳过安装");
  assert.deepEqual(progress.steps.map((step) => step.done), [true, true, true, true, false]);
  assert.deepEqual(progress.steps.map((step) => step.active), [false, false, false, false, true]);
  assert.equal(progress.steps[3].label, "依赖未变化，跳过安装");
});

test("轮询失败（面板在重启）：文案换成等待恢复，最后一步转圈，百分比不掉", () => {
  const job = 新脚本升级中("[NEX] step 5/5 重启面板", "[NEX] restarting panel service (elapsed 95s)");
  const connected = getPanelUpgradeProgress(job, 时刻(100));
  assert.equal(connected.percent, 82);
  assert.equal(connected.label, "重启面板");
  const lost = getPanelUpgradeProgress(job, { ...时刻(130), disconnected: true });
  assert.equal(lost.percent, 82);
  assert.equal(lost.label, "面板正在重启，等待恢复…");
  assert.equal(lost.detail, "已用 2 分 10 秒");
  assert.deepEqual(lost.steps.map((step) => step.active), [false, false, false, false, true]);

  // 断线时才走到第 2 步（脚本被杀的那种）：也把最后一步点亮，条不后退
  const early = getPanelUpgradeProgress(新脚本升级中("[NEX] step 2/5 下载面板包"), { ...时刻(10), disconnected: true });
  assert.equal(early.percent, 82);
  assert.equal(early.steps[4].active, true);

  // 老脚本的日志同样处理
  const legacy = getPanelUpgradeProgress(升级中("开始升级", "Downloading panel bundle"), { disconnected: true });
  assert.equal(legacy.label, "面板正在重启，等待恢复…");
  assert.equal(legacy.percent, 74);
  assert.equal(legacy.steps[3].active, true);

  // 不在跑的任务谈不上断线
  assert.equal(getPanelUpgradeProgress({ status: "error", logs: [] }, { disconnected: true }).label, "升级异常");
});

test("面板带着新版本回来：100%，标签写用时；服务端给的用时优先", () => {
  const restarted = getPanelUpgradeProgress(
    { ...新脚本升级中("[NEX] step 5/5 重启面板"), status: "success", restarted: true, restartedAt: "2026-09-30T08:01:42.000Z" },
  );
  assert.equal(restarted.percent, 100);
  assert.equal(restarted.label, "升级完成，用时 1 分 42 秒");
  assert.equal(restarted.detail, null);
  assert.ok(restarted.steps.every((step) => step.done));

  const serverElapsed = getPanelUpgradeProgress({ status: "success", mode: "rollback", restarted: true, logs: [] }, { elapsedMs: 59_000 });
  assert.equal(serverElapsed.label, "回退完成，用时 59 秒");

  // 脚本报了成功但面板还没重启：还是「等待面板恢复」，用时放小字
  const pending = getPanelUpgradeProgress({ status: "success", startedAt: "2026-09-30T08:00:00.000Z", finishedAt: "2026-09-30T08:00:30.000Z", logs: [] });
  assert.equal(pending.label, "升级完成，正在等待面板恢复");
  assert.equal(pending.detail, "用时 30 秒");
});

test("老脚本的日志（这版升级时跑的还是上一版装好的脚本）照旧按里程碑猜，多了已用时间", () => {
  const legacy = getPanelUpgradeProgress(
    { ...升级中("[NEX] Starting panel 升级", "[INFO] Downloading panel bundle: https://…"), startedAt: "2026-09-30T08:00:00.000Z" },
    时刻(200),
  );
  assert.equal(legacy.percent, 74);
  assert.equal(legacy.label, "安装并重启");
  assert.equal(legacy.detail, "已用 3 分 20 秒");
  // 没有 startedAt 也不炸，小字留空
  assert.equal(getPanelUpgradeProgress(升级中("开始升级")).detail, null);
});

test("坏掉的标记不认：越界的 step、没有 step 的 progress 行", () => {
  const bad = getPanelUpgradeProgress(新脚本升级中("[NEX] step 9/5 x", "[NEX] progress download 1/2 50%"), 时刻(0));
  assert.equal(bad.label, "检查发布资产"); // 退回老办法（Starting panel 判完第 1 步）
  assert.equal(bad.steps.length, 4);
});
