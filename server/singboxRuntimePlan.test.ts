import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createEmptyProxyInbound, type ProxyInbound } from "../shared/proxyInbound";
import {
  buildSingboxRetirementPlan,
  buildSingboxRuntimePlan,
  buildSingboxServiceUnit,
  ensureSingboxBinaryCmd,
  singboxAssetUrl,
  singboxValidateCommand,
  SINGBOX_BIN,
  SINGBOX_CONFIG_PATH,
  SINGBOX_SERVICE_NAME,
  SINGBOX_VERSION,
} from "./singboxRuntimePlan";

function inbound(overrides: Partial<ProxyInbound>): ProxyInbound {
  return { ...createEmptyProxyInbound(), ...overrides };
}

const VLESS_REALITY = inbound({
  protocol: "vless",
  name: "HK 落地",
  port: 443,
  security: "reality",
  uuid: "8f1c-uuid",
  serverName: "dl.google.com",
  realityPrivateKey: "PRIV",
  realityPublicKey: "PUB",
  realityShortId: "ab12",
});

/** 生成的 shell 拿 `sh -n` 过一遍语法。 */
function assertShellParses(script: string, label: string) {
  try {
    execFileSync("sh", ["-n"], { input: script, stdio: ["pipe", "ignore", "pipe"] });
  } catch (error: any) {
    assert.fail(`${label} 不是合法的 shell：${String(error?.stderr || error?.message || error)}`);
  }
}

test("下发计划里的每一条命令都是合法 shell", () => {
  /**
   * 这些命令是拼出来的字符串，语法错误不会在编译期暴露，只会在每一台落地机上
   * 各失败一次 —— 而且报的是 shell 的错，跟入站配置毫无字面关联。
   */
  const plan = buildSingboxRuntimePlan({ inbounds: [{ inbound: VLESS_REALITY, tag: "in-1" }] });
  plan.commands.forEach((command, index) => assertShellParses(command, `commands[${index}]`));
  buildSingboxRetirementPlan().commands.forEach((command, index) => {
    assertShellParses(command, `retirement commands[${index}]`);
  });
});

test("装二进制的命令在开加速和不开加速两种情况下都合法", () => {
  assertShellParses(ensureSingboxBinaryCmd(), "无加速");
  assertShellParses(
    ensureSingboxBinaryCmd({ accelerator: { enabled: true, url: "https://gh.example.com" } }),
    "有加速",
  );
});

test("加速地址排在原地址前面，两者都在候选里", () => {
  const accelerated = ensureSingboxBinaryCmd({ accelerator: { enabled: true, url: "https://gh.example.com" } });
  const direct = singboxAssetUrl(SINGBOX_VERSION, "amd64");

  assert.ok(accelerated.includes(`https://gh.example.com/${direct}`));
  // 加速站挂了还得能回原地址，所以原地址不能被替换掉。
  assert.ok(accelerated.includes(direct));
  assert.ok(accelerated.indexOf(`https://gh.example.com/${direct}`) < accelerated.lastIndexOf(direct));

  // 没配加速时不该凭空多出一个前缀。
  assert.ok(!ensureSingboxBinaryCmd().includes("gh.example.com"));
});

test("两种架构都有下载地址，认不出的架构直接失败", () => {
  const cmd = ensureSingboxBinaryCmd();
  assert.ok(cmd.includes(singboxAssetUrl(SINGBOX_VERSION, "amd64")));
  assert.ok(cmd.includes(singboxAssetUrl(SINGBOX_VERSION, "arm64")));
  for (const uname of ["x86_64", "amd64", "aarch64", "arm64"]) {
    assert.ok(cmd.includes(uname), uname);
  }
  // 认不出架构时宁可报错，也不要装一个跑不起来的二进制。
  assert.match(cmd, /unsupported arch/);
});

test("版本对不上就重装，而不是将就用", () => {
  const cmd = ensureSingboxBinaryCmd({ version: "1.14.0" });
  // 入站配置是按某个版本的字段写的，旧版会整份拒绝加载。
  assert.ok(cmd.includes("sing-box version 1.14.0"));
  // 前缀 v 要吃掉，否则拼出来的资源名是 sing-box-v1.14.0-...
  assert.ok(ensureSingboxBinaryCmd({ version: "v1.14.0" }).includes("sing-box version 1.14.0"));
  assert.equal(singboxAssetUrl("v1.14.0", "amd64"), singboxAssetUrl("1.14.0", "amd64"));
});

test("下载失败时不动原来那个二进制", () => {
  const cmd = ensureSingboxBinaryCmd();
  // 先装到候选文件、跑通 version 再改名 —— 落地机上跑着流量，不能为升级先删旧的。
  assert.match(cmd, /SB_NEW='\/usr\/local\/bin\/forwardx-singbox\.candidate\.'\$\$/);
  assert.match(cmd, /if "\$SB_NEW" version >\/dev\/null 2>&1 && mv -f "\$SB_NEW"/);
  // 候选跑不起来就删候选，绝不动 BIN 本身。
  assert.match(cmd, /rm -f "\$SB_NEW"/);
});

test("装完要查版本，不能只查文件在不在", () => {
  /**
   * 真跑过一遍才发现的：只查 `[ -x BIN ]` 的话，「要 1.15、装着 1.14、下载又失败」
   * 会以退出码 0 收场，然后面板把按新版字段写的配置推下去，sing-box 拒绝加载 ——
   * 报出来是「服务起不来」，跟版本毫无字面关联。
   */
  const cmd = ensureSingboxBinaryCmd({ version: "9.9.9" });
  assert.match(cmd, /if ! .*grep -qF 'sing-box version 9\.9\.9'/);
  assert.match(cmd, /需要 9\.9\.9，实际是/);
  assert.match(cmd, /exit 1/);
});

test("配置下发前先让 sing-box 自己校验", () => {
  const plan = buildSingboxRuntimePlan({ inbounds: [{ inbound: VLESS_REALITY, tag: "in-1" }] });
  const config = plan.managedConfigs[0];

  /**
   * 最值钱的一道闸：一份配置里只要有一个入站不合法，sing-box 就拒绝加载整份配置，
   * 同一台落地机上其他入站会跟着一起停。校验命令让坏配置在落地前就被挡住。
   */
  assert.equal(config.validateCommand, singboxValidateCommand());
  assert.ok(config.validateCommand.includes("check -c"));
  // {{path}} 是 Agent 侧替换成暂存文件路径的占位符，写死路径就变成校验旧配置了。
  assert.ok(config.validateCommand.includes("{{path}}"));
});

test("下发的配置就是入站生成的那一份", () => {
  const plan = buildSingboxRuntimePlan({ inbounds: [{ inbound: VLESS_REALITY, tag: "in-1" }] });
  const config = plan.managedConfigs[0];

  assert.equal(plan.active, true);
  assert.equal(config.path, SINGBOX_CONFIG_PATH);
  assert.equal(config.format, "json");
  assert.equal(config.serviceName, SINGBOX_SERVICE_NAME);

  const decoded = JSON.parse(Buffer.from(config.contentBase64, "base64").toString("utf-8"));
  assert.equal(decoded.inbounds.length, 1);
  assert.equal(decoded.inbounds[0].tag, "in-1");
  assert.equal(decoded.inbounds[0].listen_port, 443);
});

test("多个入站合成一份配置", () => {
  const plan = buildSingboxRuntimePlan({
    inbounds: [
      { inbound: VLESS_REALITY, tag: "in-1" },
      { inbound: inbound({ protocol: "shadowsocks", port: 8388, security: "none", method: "aes-256-gcm", password: "pw" }), tag: "in-2" },
    ],
  });
  const decoded = JSON.parse(Buffer.from(plan.managedConfigs[0].contentBase64, "base64").toString("utf-8"));
  assert.deepEqual(decoded.inbounds.map((item: any) => item.tag), ["in-1", "in-2"]);
});

test("一个入站都不剩时停服务、删配置，但留着二进制", () => {
  const plan = buildSingboxRuntimePlan({ inbounds: [] });
  assert.equal(plan.active, false);
  assert.deepEqual(plan.managedConfigs, []);

  const joined = plan.commands.join(" ");
  assert.ok(joined.includes(SINGBOX_CONFIG_PATH));
  // 二进制留着：用户很可能马上又建一个，重下 30MB 不值当。
  assert.ok(!joined.includes(`rm -f '${SINGBOX_BIN}'`));
});

test("服务单元指向下发的配置，并且会自己拉起来", () => {
  const unit = buildSingboxServiceUnit();
  assert.ok(unit.includes(`ExecStart=${SINGBOX_BIN} run -c ${SINGBOX_CONFIG_PATH}`));
  assert.ok(unit.includes("Restart=always"));
  assert.ok(unit.includes("[Install]"));
});

test("枚举字段不合法的入站被单独剔掉，不拖累同机其他入站", () => {
  const plan = buildSingboxRuntimePlan({
    inbounds: [
      { inbound: VLESS_REALITY, tag: "in-1" },
      { inbound: { ...VLESS_REALITY, port: 444, flow: "evil-flow" }, tag: "in-bad-flow" },
      { inbound: inbound({ protocol: "tuic", port: 9443, congestionControl: "cubic2" }), tag: "in-bad-cc" },
      { inbound: inbound({ protocol: "snell", port: 8000, password: "psk", snellVersion: 6, snellMode: "x" }), tag: "in-bad-snell" },
    ],
  });
  const decoded = JSON.parse(Buffer.from(plan.managedConfigs[0].contentBase64, "base64").toString("utf-8"));
  assert.deepEqual(decoded.inbounds.map((item: any) => item.tag), ["in-1"]);
});

test("装 sing-box 要排在配置校验之前：新机器上校验时程序得已经在", () => {
  // Agent 的顺序：preCommands → managedConfigs（跑 validateCommand 校验）→ commands。
  // 装二进制原来在 commands 里：从没装过 sing-box 的机器上 `forwardx-singbox check` 找不到程序，
  // 校验失败、动作中止，安装永远轮不到 —— 新机器上建的落地节点永远起不来。
  const plan = buildSingboxRuntimePlan({ inbounds: [{ inbound: VLESS_REALITY, tag: "inbound-1" }] });
  const install = ensureSingboxBinaryCmd();
  assert.deepEqual(plan.preCommands, [install]);
  assert.ok(!plan.commands.includes(install), "commands 里不能再装二进制（那时校验已经跑完了）");
  assert.match(plan.managedConfigs[0].validateCommand, new RegExp(`^${SINGBOX_BIN.replace(/[/.]/g, "\\$&")} check `));
  assert.deepEqual(buildSingboxRetirementPlan().preCommands, []);
});

test("GitHub 和加速都下不到时最后从面板下 sing-box", () => {
  const command = ensureSingboxBinaryCmd({
    accelerator: { enabled: true, url: "https://gh.example.com" },
    panelRelayBase: "http://panel.example.com:9810/api/agent/singbox-assets",
  });
  assertShellParses(command, "带面板转发的安装命令");
  const amd64 = command.split("\n").find((line) => line.includes("x86_64|amd64)")) || "";
  const github = amd64.indexOf(singboxAssetUrl(SINGBOX_VERSION, "amd64"));
  const relay = amd64.indexOf(`http://panel.example.com:9810/api/agent/singbox-assets/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-amd64.tar.gz`);
  assert.ok(github > 0 && relay > github, "面板那一个要排在 GitHub 原地址后面");
  assert.ok(!ensureSingboxBinaryCmd().includes("singbox-assets"), "没给面板地址就不加");
});
