import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";
import { FXP_HANDSHAKE_V3_MARKER } from "../shared/fxpRuntime";
import { FXP_MIN_WIRE_VERSION } from "../shared/versions";

/*
  用户那台：所有主机都报 Agent 2.2.20x，可有一台的 FXP 是升级时下载失败（2.3.391 的校验值
  问题）后留下的握手 v2 旧版本 —— 升级脚本只警告了一句就把 Agent 换成了新的。

  这里真跑生成出来的 bash：把下载函数换成桩，看各种「FXP 拿不到」的情况下最后留在磁盘上的
  是什么、退出码是什么。
*/

function shellFunction(script: string, name: string) {
  const start = script.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

const script = generateInstallScript("https://panel.example.com");

const prelude = [
  script.split("\n").find((line) => line.startsWith("FXP_MIN_WIRE_VERSION=")),
  script.split("\n").find((line) => line.startsWith("FXP_HANDSHAKE_V3_MARKER=")),
  ...[
    "download_release_binary_with_retry",
    "stage_release_binary",
    "promote_staged_binary",
    "version_at_least",
    "fxp_binary_version",
    "fxp_version_wire_compatible",
    "warn_fxp_unavailable",
    "upgrade_agent_and_fxp_binaries",
  ].map((name) => shellFunction(script, name)),
  "sleep() { :; }",
  // 桩：按 DOWNLOAD_<资产前缀> 决定成功与否，成功时写一个假的二进制；每次调用记一笔。
  `download_release_binary() {
  local ASSET="$1" DST="$2"
  echo "$ASSET" >> "$WORK/attempts"
  case "$ASSET" in
    forwardx-agent-*) [ "$DOWNLOAD_AGENT" = ok ] || return 1; printf 'new agent\\n' > "$DST" ;;
    forwardx-fxp-*) [ "$DOWNLOAD_FXP" = ok ] || return 1; printf '#!/bin/sh\\necho 9.9.9\\n' > "$DST" ;;
  esac
  DOWNLOADED_RELEASE_VERSION="$RELEASE_VERSION"
  return 0
}`,
].join("\n");

type Scenario = {
  agent: "ok" | "fail";
  fxp: "ok" | "fail";
  existingFxp: string | null;
};

function runUpgrade(scenario: Scenario) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fxp-upgrade-"));
  try {
    const agentBin = path.join(work, "forwardx-agent");
    const fxpBin = path.join(work, "forwardx-fxp");
    fs.writeFileSync(agentBin, "old agent\n", { mode: 0o755 });
    if (scenario.existingFxp !== null) fs.writeFileSync(fxpBin, scenario.existingFxp, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", `${prelude}\nupgrade_agent_and_fxp_binaries`], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: os.tmpdir(),
        WORK: work,
        GO_AGENT_BIN: agentBin,
        FXP_BIN: fxpBin,
        GO_ARCH: "amd64",
        RELEASE_VERSION: "9.9.9",
        DOWNLOAD_AGENT: scenario.agent,
        DOWNLOAD_FXP: scenario.fxp,
      },
    });
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      agent: read(agentBin),
      fxp: read(fxpBin),
      attempts: (read(path.join(work, "attempts")) || "").trim().split("\n").filter(Boolean),
      leftovers: fs.readdirSync(work).filter((name) => name.includes("forwardx-new")),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const currentFxp = "#!/bin/sh\necho 2.2.123\n";
// 2.2.121 ~ 2.2.123：不认识 -version（flag 包退出 2），但二进制里有握手 v3 的文案。
const legacyV3Fxp = `#!/bin/sh\n# ${FXP_HANDSHAKE_V3_MARKER}\necho "flag provided but not defined: -version" >&2\nexit 2\n`;
// 早于 2.2.121：不认识 -version，也没有握手 v3。
const legacyV2Fxp = "#!/bin/sh\necho \"flag provided but not defined: -version\" >&2\nexit 2\n";

test("两个都下到了：先换 FXP 再换 Agent，不留临时文件", () => {
  const result = runUpgrade({ agent: "ok", fxp: "ok", existingFxp: legacyV2Fxp });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.agent, "new agent\n");
  assert.match(result.fxp || "", /echo 9\.9\.9/);
  assert.deepEqual(result.leftovers, []);
  assert.match(result.output, /新 FXP 版本: 9\.9\.9/);
});

test("FXP 下不来、现有 FXP 握手 v2：升级失败，Agent 和 FXP 都不动", () => {
  const result = runUpgrade({ agent: "ok", fxp: "fail", existingFxp: legacyV2Fxp });
  assert.notEqual(result.status, 0, "新 Agent 配握手 v2 的 FXP 不能算升级成功");
  assert.equal(result.agent, "old agent\n", "Agent 不能换成新的");
  assert.equal(result.fxp, legacyV2Fxp);
  assert.deepEqual(result.leftovers, [], "下好的新 Agent 要清掉");
  assert.match(result.output, /现有 FXP（legacy-v2）太旧/);
  assert.match(result.output, /本次升级中止/);
  assert.equal(result.attempts.filter((asset) => asset.startsWith("forwardx-fxp-")).length, 3, "FXP 要重试 3 次");
});

test("FXP 下不来、现有 FXP 版本号低于最低握手版本：同样失败", () => {
  const result = runUpgrade({ agent: "ok", fxp: "fail", existingFxp: "#!/bin/sh\necho 2.2.120\n" });
  assert.notEqual(result.status, 0);
  assert.equal(result.agent, "old agent\n");
  assert.match(result.output, /现有 FXP（2\.2\.120）太旧/);
});

test("FXP 下不来、现有 FXP 还能握手：大声警告、保留旧 FXP，Agent 照常升级", () => {
  for (const existingFxp of [currentFxp, legacyV3Fxp]) {
    const result = runUpgrade({ agent: "ok", fxp: "fail", existingFxp });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.agent, "new agent\n");
    assert.equal(result.fxp, existingFxp);
    assert.match(result.output, /!!!!/);
    assert.match(result.output, /保留现有 FXP（(2\.2\.123|legacy)）/);
    assert.deepEqual(result.leftovers, []);
  }
});

test("FXP 本来就没装、这次也下不来：Agent 照常升级，打醒目警告", () => {
  const result = runUpgrade({ agent: "ok", fxp: "fail", existingFxp: null });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.agent, "new agent\n");
  assert.equal(result.fxp, null);
  assert.match(result.output, /NEX FXP 升级失败（已重试 3 次）/);
});

test("Agent 下不来：什么都不换，重试 3 次后退出非 0", () => {
  const result = runUpgrade({ agent: "fail", fxp: "ok", existingFxp: legacyV2Fxp });
  assert.notEqual(result.status, 0);
  assert.equal(result.agent, "old agent\n");
  assert.equal(result.fxp, legacyV2Fxp);
  assert.deepEqual(result.attempts, ["forwardx-agent-linux-amd64", "forwardx-agent-linux-amd64", "forwardx-agent-linux-amd64"]);
  assert.deepEqual(result.leftovers, []);
});

test("fxp_binary_version 的取值和 Agent 上报的一致", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fxp-version-"));
  try {
    const cases: Array<[string | null, string]> = [
      [currentFxp, "2.2.123"],
      ["#!/bin/sh\necho v2.2.124\n", "2.2.124"],
      [legacyV3Fxp, "legacy"],
      [legacyV2Fxp, "legacy-v2"],
      [null, "missing"],
    ];
    for (const [content, expected] of cases) {
      const bin = path.join(work, "forwardx-fxp");
      fs.rmSync(bin, { force: true });
      if (content !== null) fs.writeFileSync(bin, content, { mode: 0o755 });
      const result = spawnSync("bash", ["-c", `${prelude}\nfxp_binary_version "$BIN"`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH || "/usr/bin:/bin", BIN: bin },
      });
      assert.equal(result.stdout.trim(), expected, `${content} → ${result.stdout}${result.stderr}`);
    }
    const compatible = (version: string) => spawnSync("bash", ["-c", `${prelude}\nfxp_version_wire_compatible "$V"`], {
      env: { PATH: process.env.PATH || "/usr/bin:/bin", V: version },
    }).status === 0;
    assert.equal(compatible(FXP_MIN_WIRE_VERSION), true);
    assert.equal(compatible("2.2.120"), false);
    assert.equal(compatible("2.10.0"), true);
    assert.equal(compatible("legacy"), true);
    assert.equal(compatible("legacy-v2"), false);
    assert.equal(compatible("missing"), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("全新安装拿不到 FXP 时照旧继续，但警告要醒目", () => {
  const start = script.indexOf("install_go_agent() {");
  const install = script.slice(start, script.indexOf("\n}\n", start));
  assert.match(install, /stage_release_binary "forwardx-fxp-linux-\$\{GO_ARCH\}" "\$FXP_BIN" "NEX FXP" "0"/);
  assert.match(install, /warn_fxp_unavailable "安装"/);
  assert.match(install, /return 0/);
});

test("脚本里变量后面紧跟中文时要加花括号（bash 3.2 会把多字节字符吞进变量名）", () => {
  const offenders = script.split("\n").filter((line) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line));
  assert.deepEqual(offenders, []);
});
