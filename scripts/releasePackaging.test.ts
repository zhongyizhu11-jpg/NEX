import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

/*
  2.3.550 起面板包和镜像不带 gost 运行时与 mita（面板按需下，server/agentAssets.ts）；
  发布流程要同时出默认包和 -full 完整包，镜像构建要跳过这两样。这几条是结构性约束，改坏了发布就缺文件。
*/
test("发布流程：默认包排除运行时和 mita，另出 -full 完整包，两份都上传", () => {
  const workflow = read(".github/workflows/release-panel.yml");
  assert.match(workflow, /--exclude='dist\/agent\/forwardx-runtime-linux-\*'/);
  assert.match(workflow, /--exclude='dist\/agent\/forwardx-mita-linux-\*'/);
  assert.match(workflow, /FULL_BUNDLE="forwardx-panel-v\$\{VERSION_NO_V\}-full\.tar\.gz"/);
  assert.match(workflow, /files=\(dist\/panel\/\*\.tar\.gz\)/, "上传 dist/panel 下所有包");
});

test("面板镜像的 Agent 资产阶段跳过运行时和 mita；Agent 发布流程不跳", () => {
  assert.match(read("Dockerfile"), /RUN NEX_SKIP_RUNTIME=1 NEX_SKIP_MITA=1 bash scripts\/build-agent-release\.sh/);
  const agentRelease = read(".github/workflows/release-agent.yml");
  assert.doesNotMatch(agentRelease, /NEX_SKIP_RUNTIME|NEX_SKIP_MITA/, "发布页上必须有运行时和 mita，面板按需下靠它们");
  const build = read("scripts/build-agent-release.sh");
  assert.match(build, /NEX_SKIP_RUNTIME:-0/);
});

test("本地装机脚本：FORWARDX_PANEL_BUNDLE_SUFFIX=-full 能换到完整包", () => {
  const script = read("scripts/install-panel-local.sh");
  assert.match(script, /PANEL_BUNDLE_SUFFIX="\$\{FORWARDX_PANEL_BUNDLE_SUFFIX:-\}"/);
  assert.match(script, /\$\{PANEL_BUNDLE_PREFIX\}\$\{version\}\$\{PANEL_BUNDLE_SUFFIX\}\.tar\.gz/);
});
