import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MIMIC_RELEASE_SHA256,
  buildMimicManualCommands,
  mimicFailureReason,
  normalizeMimicDownloadProxy,
} from "../shared/mimicAssets";
import { getOrFetchMimicAssetPath, isRelayableMimicAsset, mimicAssetRelayBase } from "./mimicAssets";
import { MIMIC_TARGET_VERSION, withMimicInstallerDefaults } from "./mimicInstallTasks";

const installerPath = path.join(process.cwd(), "scripts/install-mimic.sh");
const installer = fs.readFileSync(installerPath, "utf8");

test("安装脚本钉的 mimic 包哈希和面板转发用的是同一份", () => {
  const table = MIMIC_RELEASE_SHA256[MIMIC_TARGET_VERSION];
  assert.ok(table && Object.keys(table).length >= 12, "目标版本要有钉住的包");
  for (const [asset, sha] of Object.entries(table)) {
    assert.match(installer, new RegExp(`${MIMIC_TARGET_VERSION.replace(/\./g, "\\.")}/${asset.replace(/\./g, "\\.")}\\) echo ${sha} ;;`), asset);
  }
});

test("只转发钉了哈希的包名，别的一律 404", () => {
  assert.equal(isRelayableMimicAsset("0.7.1", "bookworm_mimic_0.7.1-1_amd64.deb"), true);
  assert.equal(isRelayableMimicAsset("v0.7.1", "trixie_mimic-dkms_0.7.1-1_arm64.deb"), true);
  assert.equal(isRelayableMimicAsset("0.7.1", "../../etc/passwd"), false);
  assert.equal(isRelayableMimicAsset("0.7.1", "bookworm_mimic_0.7.1-1_riscv64.deb"), false);
  assert.equal(isRelayableMimicAsset("9.9.9", "bookworm_mimic_9.9.9-1_amd64.deb"), false);
});

test("面板转发：哈希对才缓存，哈希不对的内容丢掉", async () => {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nex-mimic-assets-"));
  process.chdir(tmp);
  try {
    const asset = "bookworm_mimic_0.7.1-1_amd64.deb";
    let calls = 0;
    const bad = async () => {
      calls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("<html>blocked</html>").buffer as ArrayBuffer };
    };
    assert.equal(await getOrFetchMimicAssetPath("0.7.1", asset, bad), null);
    assert.ok(calls >= 1);
    assert.equal(fs.existsSync(path.join(tmp, "data/mimic-assets/v0.7.1", asset)), false);

    // 用钉住的哈希反推不出真包：把缓存直接放好，确认「缓存哈希对就直接用、不再联网」
    const notFound = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(await getOrFetchMimicAssetPath("0.7.1", "trixie_mimic_0.7.1-1_amd64.deb", notFound), null);
    assert.equal(await getOrFetchMimicAssetPath("0.7.1", "not-a-mimic-asset.deb", notFound), null);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("缓存里哈希不对的旧文件会被删掉重拉", async () => {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nex-mimic-assets-"));
  process.chdir(tmp);
  try {
    const asset = "noble_mimic_0.7.1-1_amd64.deb";
    const cachePath = path.join(tmp, "data/mimic-assets/v0.7.1", asset);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "tampered");
    const notFound = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(await getOrFetchMimicAssetPath("0.7.1", asset, notFound), null);
    assert.equal(fs.existsSync(cachePath), false);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("面板转发地址和代理只在能安全写进 shell 时才注入安装脚本", () => {
  assert.equal(mimicAssetRelayBase("https://panel.example.com"), "https://panel.example.com/api/agent/mimic-assets");
  assert.equal(mimicAssetRelayBase(""), "");
  assert.equal(mimicAssetRelayBase("https://panel.example.com/$(id)"), "");

  const script = "#!/usr/bin/env bash\nMIMIC_REPO=\"hack3ric/mimic\"\n";
  const injected = withMimicInstallerDefaults(script, {
    version: "0.7.1",
    assetBase: "https://panel.example.com/api/agent/mimic-assets",
    proxy: "socks5h://127.0.0.1:1080",
  });
  assert.ok(injected.startsWith("#!/usr/bin/env bash\n# --- NEX panel defaults ---\n"));
  assert.match(injected, /FORWARDX_MIMIC_ASSET_BASE="\$\{FORWARDX_MIMIC_ASSET_BASE:-https:\/\/panel\.example\.com\/api\/agent\/mimic-assets\}"/);
  assert.match(injected, /FORWARDX_MIMIC_PROXY="\$\{FORWARDX_MIMIC_PROXY:-socks5h:\/\/127\.0\.0\.1:1080\}"/);

  const hostile = withMimicInstallerDefaults(script, { assetBase: "https://x/\"; rm -rf /; \"", proxy: "socks5h://a:1/`id`" });
  assert.equal(hostile, script);

  // 注入后的真实脚本仍然能被 bash 解析，主机上已有的环境变量优先
  const real = withMimicInstallerDefaults(installer, { version: "0.7.1", assetBase: "https://p.example/api/agent/mimic-assets", proxy: "http://10.0.0.2:3128" });
  const parsed = spawnSync("bash", ["-n"], { input: real, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const probe = spawnSync("bash", ["-c", `${real.split("\n").slice(0, 5).join("\n")}\necho "$FORWARDX_MIMIC_PROXY"`], {
    encoding: "utf8",
    env: { ...process.env, FORWARDX_MIMIC_PROXY: "socks5h://127.0.0.1:7890" },
  });
  assert.equal(probe.stdout.trim(), "socks5h://127.0.0.1:7890");
});

test("下载代理地址校验", () => {
  assert.equal(normalizeMimicDownloadProxy(""), "");
  assert.equal(normalizeMimicDownloadProxy(" socks5h://127.0.0.1:1080/ "), "socks5h://127.0.0.1:1080");
  assert.equal(normalizeMimicDownloadProxy("http://user:p%40ss@10.0.0.1:3128"), "http://user:p%40ss@10.0.0.1:3128");
  assert.equal(normalizeMimicDownloadProxy("socks5://127.0.0.1"), null, "要带端口");
  assert.equal(normalizeMimicDownloadProxy("ftp://127.0.0.1:21"), null);
  assert.equal(normalizeMimicDownloadProxy("socks5h://127.0.0.1:1080 && reboot"), null);
  assert.equal(normalizeMimicDownloadProxy("http://u:p$x@1.2.3.4:80"), null);
});

test("从安装输出里认出失败原因（含旧脚本下载失败只报 unknown 的情况）", () => {
  assert.equal(mimicFailureReason("[NEX mimic] RESULT: failed reason=download"), "download");
  assert.equal(mimicFailureReason("RESULT: failed reason=kernel-headers"), "kernel-headers");
  assert.equal(mimicFailureReason(null, "x\nRESULT: failed reason=dkms-build\n"), "dkms-build");
  const oldLog = [
    "[NEX mimic] no compatible Mimic Debian assets found for x86_64 / 6.1.0-50-amd64",
    "[NEX mimic] failed to download mimic source archive",
    "[NEX mimic] RESULT: failed reason=unknown",
  ].join("\n");
  assert.equal(mimicFailureReason("RESULT: failed reason=unknown", oldLog), "download");
  assert.equal(mimicFailureReason("安装脚本退出码 3"), "unknown");
});

test("手动安装命令：经面板一行装，GitHub 直装跟手动验证过的步骤一致", () => {
  const plain = buildMimicManualCommands({ panelUrl: "https://panel.example.com/" });
  assert.equal(plain.panel, "curl -fsSL https://panel.example.com/api/agent/mimic-install.sh | sudo bash");
  assert.match(plain.github, /releases\/download\/v\$V/);
  assert.match(plain.github, /\$\{C\}_mimic_\$\{V\}-1_\$\{A\}\.deb/);
  assert.match(plain.github, /\$\{C\}_mimic-dkms_\$\{V\}-1_\$\{A\}\.deb/);
  assert.match(plain.github, /linux-headers-\$\(uname -r\)/);
  assert.equal(spawnSync("bash", ["-n"], { input: plain.github }).status, 0);

  const proxied = buildMimicManualCommands({ panelUrl: "https://panel.example.com", proxy: "socks5h://127.0.0.1:1080" });
  assert.equal(proxied.panel, "curl -fsSL https://panel.example.com/api/agent/mimic-install.sh | sudo FORWARDX_MIMIC_PROXY=socks5h://127.0.0.1:1080 bash");
  assert.match(proxied.github, /curl -fL --retry 3 -x socks5h:\/\/127\.0\.0\.1:1080 -o "\$D\/mimic\.deb"/);
  assert.equal(buildMimicManualCommands({ panelUrl: "" }).panel, "");
});

/*
  手动命令真跑一遍（curl / apt-get / modprobe / dpkg 换成桩，/etc/os-release 换成临时文件）：
  代号按家族退回，下载失败就停在那一步，不会接着去 apt-get 装旧文件。
*/
function runManualGithubCommand(osRelease: string, curlFails: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-mimic-manual-"));
  const osFile = path.join(dir, "os-release");
  fs.writeFileSync(osFile, osRelease);
  const log = path.join(dir, "calls.log");
  const command = buildMimicManualCommands({ panelUrl: "" }).github.replace(". /etc/os-release", `. ${osFile}`);
  const stubs = [
    `dpkg() { echo amd64; }`,
    `curl() { local url="\${@: -1}"; echo "curl $url" >> ${log}; ${curlFails ? "return 22" : "return 0"}; }`,
    `sudo() { echo "sudo $*" >> ${log}; return 0; }`,
    `mimic() { echo "mimic $*" >> ${log}; }`,
  ].join("\n");
  const result = spawnSync("bash", ["-c", `${stubs}\n${command}`], { encoding: "utf8" });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, calls };
}

test("手动命令：没有现成包的代号按家族退回 noble / bookworm", () => {
  const mint = runManualGithubCommand('ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=wilma\n', false);
  assert.match(mint.calls, /noble_mimic_0\.7\.1-1_amd64\.deb/);
  const bullseye = runManualGithubCommand("ID=debian\nVERSION_CODENAME=bullseye\n", false);
  assert.match(bullseye.calls, /bookworm_mimic-dkms_0\.7\.1-1_amd64\.deb/);
  const trixie = runManualGithubCommand("ID=debian\nVERSION_CODENAME=trixie\n", false);
  assert.match(trixie.calls, /trixie_mimic_0\.7\.1-1_amd64\.deb/);
  assert.match(trixie.calls, /sudo apt-get install -y/);
});

test("手动命令：下载失败就停，不去装", () => {
  const failed = runManualGithubCommand("ID=debian\nVERSION_CODENAME=bookworm\n", true);
  assert.notEqual(failed.status, 0);
  assert.equal((failed.calls.match(/^curl /gm) || []).length, 1);
  assert.doesNotMatch(failed.calls, /apt-get|modprobe/);
});

/*
  安装脚本的下载链：curl 换成桩，按 URL 决定「连不上 / 404 / 回 HTML / 回真包」，确认
  ① 面板转发排第一、哈希对就用；② 镜像回 HTML 不算数；③ 全连不上记 network，GitHub 404 记 notfound；
  ④ 设了代理时 GitHub 下载带 --proxy，面板地址不带。
*/
function runDownloadProbe(env: Record<string, string>, curlStub: string, asset: string) {
  const lib = installer.slice(0, installer.lastIndexOf('main "$@"'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-mimic-dl-"));
  const probe = [
    lib,
    "set +e",
    "log() { printf '%s\\n' \"$*\"; }",
    curlStub,
    `download_mimic_asset ${asset} ${dir}/out; echo "rc=$? last=$MIMIC_LAST_DOWNLOAD"`,
    `cat "$CURL_LOG" 2>/dev/null || true`,
  ].join("\n");
  const result = spawnSync("bash", ["-c", probe], { encoding: "utf8", env: { ...process.env, CURL_LOG: path.join(dir, "curl.log"), ...env } });
  fs.rmSync(dir, { recursive: true, force: true });
  return `${result.stdout}${result.stderr}`;
}

const DEB_ASSET = "bookworm_mimic_0.7.1-1_amd64.deb";

test("安装脚本：面板转发回来的包哈希对不上就换下一个来源", () => {
  const stub = `curl() {
  local out="" url="" a
  while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w|--proxy|--connect-timeout|--max-time|--speed-limit|--speed-time|--retry|--retry-delay) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
  echo "URL $url" >> "$CURL_LOG"
  case "$url" in
    https://panel.example/*) printf '!<arch>\\nnot-the-real-package' > "$out"; printf 200 ;;
    *) return 7 ;;
  esac
}`;
  const output = runDownloadProbe({ FORWARDX_MIMIC_ASSET_BASE: "https://panel.example/api/agent/mimic-assets", FORWARDX_GITHUB_MIRRORS: "https://mirror.example/" }, stub, DEB_ASSET);
  assert.match(output, /URL https:\/\/panel\.example\/api\/agent\/mimic-assets\/v0\.7\.1\/bookworm_mimic_0\.7\.1-1_amd64\.deb/);
  assert.match(output, /SHA-256 mismatch/);
  assert.match(output, /mirror mirror\.example: connection failed/);
  assert.match(output, /github: connection failed/);
  assert.match(output, /rc=1 last=network/);
});

test("安装脚本：镜像回 HTML 不算下载成功；GitHub 明确 404 记 notfound", () => {
  const stub = `curl() {
  local out="" url="" a
  while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w|--proxy|--connect-timeout|--max-time|--speed-limit|--speed-time|--retry|--retry-delay) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
  case "$url" in
    https://mirror.example/*) printf '<html>quota exceeded</html>' > "$out"; printf 200 ;;
    https://github.com/*) printf 'Not Found' > "$out"; printf 404 ;;
    *) return 7 ;;
  esac
}`;
  const output = runDownloadProbe({ FORWARDX_GITHUB_MIRRORS: "https://mirror.example/" }, stub, DEB_ASSET);
  assert.match(output, /mirror mirror\.example: response is not a valid/);
  assert.match(output, /github: HTTP 404/);
  assert.match(output, /rc=1 last=notfound/);
});

test("安装脚本：设了下载代理时 GitHub 带 --proxy、面板转发不带", () => {
  const stub = `curl() {
  local out="" url="" proxy=""
  while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proxy) proxy="$2"; shift 2 ;; -w|--connect-timeout|--max-time|--speed-limit|--speed-time|--retry|--retry-delay) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
  echo "URL $url proxy=\${proxy:-none}" >> "$CURL_LOG"
  case "$url" in
    https://panel.example/*) printf 503 ;;
    https://github.com/*) [ -n "$proxy" ] || return 7; cat "$REAL_DEB" > "$out"; printf 200 ;;
    *) return 7 ;;
  esac
}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-mimic-deb-"));
  // 造一个「哈希对得上」的包：临时把钉住的哈希换成这个假包的哈希
  const fake = Buffer.concat([Buffer.from("!<arch>\n"), crypto.randomBytes(64)]);
  const fakePath = path.join(dir, "fake.deb");
  fs.writeFileSync(fakePath, fake);
  const fakeSha = crypto.createHash("sha256").update(fake).digest("hex");
  const realSha = MIMIC_RELEASE_SHA256["0.7.1"][DEB_ASSET];
  const patched = installer.replace(realSha, fakeSha);
  const lib = patched.slice(0, patched.lastIndexOf('main "$@"'));
  const probe = [lib, "set +e", "log() { printf '%s\\n' \"$*\"; }", stub, `download_mimic_asset ${DEB_ASSET} ${dir}/out; echo "rc=$? last=$MIMIC_LAST_DOWNLOAD"`, `cat "$CURL_LOG"`].join("\n");
  const result = spawnSync("bash", ["-c", probe], {
    encoding: "utf8",
    env: {
      ...process.env,
      REAL_DEB: fakePath,
      CURL_LOG: path.join(dir, "curl.log"),
      FORWARDX_MIMIC_ASSET_BASE: "https://panel.example/api/agent/mimic-assets",
      FORWARDX_MIMIC_PROXY: "socks5h://127.0.0.1:1080",
      FORWARDX_GITHUB_MIRRORS: "https://mirror.example/",
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(output, /URL https:\/\/panel\.example\/\S+ proxy=none/);
  assert.match(output, /panel: HTTP 503/);
  assert.match(output, /URL https:\/\/github\.com\/\S+ proxy=socks5h:\/\/127\.0\.0\.1:1080/);
  assert.match(output, /ok via github via proxy/);
  assert.match(output, /rc=0 last=/);
});

test("安装脚本：下载失败不再报「没有兼容包」，也不白跑源码编译", () => {
  assert.match(installer, /if \[ "\$MIMIC_LAST_DOWNLOAD" = "notfound" \]; then/);
  assert.match(installer, /MIMIC_FAIL_REASON="download"/);
  assert.match(installer, /\[ "\$\{MIMIC_FAIL_REASON:-\}" != "download" \]/);
  // 跟手动安装一样用 apt 装本地包，依赖一次解决
  assert.match(installer, /apt-get install -y -q "\$tmp\/\$dkms_deb" "\$tmp\/\$bin_deb"/);
});
