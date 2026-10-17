import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";
import { hardenManagedServiceUnit } from "./agentActionCommands";

function scriptSection(script: string, start: string, end: string) {
  const startIndex = script.indexOf(start);
  const endIndex = script.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing script section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing script section end: ${end}`);
  return script.slice(startIndex, endIndex);
}

test("panel GitHub accelerator settings reach the Mimic installer", () => {
  const script = generateInstallScript("https://panel.example.com", {
    githubAcceleratorEnabled: true,
    githubAcceleratorUrl: "https://proxy.example.com/",
  });

  assert.match(script, /GITHUB_ACCELERATOR_DEFAULT_ENABLED="true"/);
  assert.match(script, /GITHUB_ACCELERATOR_DEFAULT_URL='https:\/\/proxy\.example\.com'/);
  assert.match(
    script,
    /GITHUB_ACCELERATOR_ENABLED="\$GITHUB_ACCELERATOR_ENABLED" GITHUB_ACCELERATOR_URL="\$GITHUB_ACCELERATOR_URL" FORWARDX_MIMIC_VERSION=/,
  );
});

test("GitHub entry script preserves panel defaults unless explicitly overridden", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-agent.sh"), "utf8");

  assert.match(script, /GITHUB_ACCELERATOR_URL="\$\{GITHUB_ACCELERATOR_URL:-\}"/);
  assert.match(script, /GITHUB_ACCELERATOR_ENABLED="\$\{GITHUB_ACCELERATOR_ENABLED:-\}"/);
  assert.doesNotMatch(script, /GITHUB_ACCELERATOR_ENABLED="\$\{GITHUB_ACCELERATOR_ENABLED:-false\}"/);
});

test("Mimic installer applies the configured accelerator to upstream downloads", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  // Accelerator URL is prepended to every GitHub asset download
  assert.match(script, /url="\$\{GITHUB_ACCELERATOR_URL\}\/\$\{raw_url\}"/);
  // Mirror list combines accelerator with default mirrors
  assert.match(script, /printf '%s\/,%s\\n' "\$GITHUB_ACCELERATOR_URL" "\$mirrors"/);
  // Downloads come directly from hack3ric/mimic releases (no wg-mimic-fabric wrapper)
  assert.match(script, /MIMIC_REPO="hack3ric\/mimic"/);
  assert.doesNotMatch(script, /wg-mimic-fabric/);
  assert.doesNotMatch(script, /WMF_REPO|WMF_REF|WMF_GITHUB_MIRRORS/);
});

test("Agent services avoid duplicate logs and disable core dumps", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.match(script, /LimitCORE=0/);
  assert.match(script, /StandardOutput=null/);
  assert.match(script, /LogRateLimitBurst=200/);
  assert.match(script, /output_log="\/dev\/null"/);
  assert.match(script, /error_log="\/var\/log\/forwardx-agent\/\$SERVICE_NAME-stderr\.log"/);
  assert.match(script, /ulimit -c 0 2>\/dev\/null \|\| true; ulimit -n 1048576 [^;]*; exec \$GO_AGENT_BIN/);
  assert.doesNotMatch(script, /output_log="\/var\/log\/forwardx-agent\/\$SERVICE_NAME\.log"/);
});

test("Agent restarts leave FXP tunnel processes running and raise fd limits", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.match(script, /KillMode=process/);
  assert.match(script, /LimitNOFILE=1048576/);
  assert.match(script, /TasksMax=infinity/);
});

test("Agent install and upgrade both apply forwarding network tuning", () => {
  const script = generateInstallScript("https://panel.example.com");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");

  assert.match(script, /apply_network_tuning\(\) \{/);
  assert.match(script, /FORWARDX_NETWORK_TUNING/);
  assert.match(script, /net\.ipv4\.tcp_fastopen = \$\(\(cur \| 3\)\)/);
  assert.match(script, /net\.ipv4\.tcp_congestion_control = bbr/);
  // 跨境长往返线路跑满千兆要 64MB 窗口上限；只抬上限（tuning_raise），不压低已有更大的值。
  for (const key of ["net.core.rmem_max", "net.core.wmem_max", "net.ipv4.tcp_rmem", "net.ipv4.tcp_wmem"]) {
    assert.match(script, new RegExp(`tuning_raise ${key.replace(/\./g, "\\.")} 67108864`));
  }
  assert.match(script, /tuning_raise net\.netfilter\.nf_conntrack_max 1048576/);
  // conntrack 哈希桶跟着表上限走：新内核走 sysctl，老内核这个键只读，退回 /sys 模块参数并写 modprobe.d。
  assert.match(script, /tuning_conntrack_buckets 262144/);
  assert.match(script, /want=\$\(\(max \/ 4\)\)/);
  assert.match(script, /sysctl -w "net\.netfilter\.nf_conntrack_buckets=\$want"/);
  assert.match(script, /\/sys\/module\/nf_conntrack\/parameters\/hashsize/);
  assert.match(script, /options nf_conntrack hashsize=\$want/);
  // 只在模块加载时生效的 be_liberal 和其余只抬不压的键
  assert.match(script, /tuning_raise net\.netfilter\.nf_conntrack_tcp_be_liberal 1/);
  assert.match(script, /tuning_raise net\.ipv4\.tcp_no_metrics_save 1/);
  for (const key of ["net.core.rmem_default", "net.core.wmem_default"]) {
    assert.match(script, new RegExp(`tuning_raise ${key.replace(/\./g, "\\.")} 1048576`));
  }
  for (const key of ["net.ipv4.udp_rmem_min", "net.ipv4.udp_wmem_min"]) {
    assert.match(script, new RegExp(`tuning_raise ${key.replace(/\./g, "\\.")} 16384`));
  }
  assert.match(upgrade, /\n\s*apply_network_tuning\n/);
  assert.ok(upgrade.indexOf("apply_network_tuning") < upgrade.indexOf("write_agent_service"));
});

test("Agent install and upgrade do not install or modify host time synchronization", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.doesNotMatch(script, /\btime-sync\.target\b/);
  assert.doesNotMatch(script, /\bsync_system_time\b/);
  assert.doesNotMatch(script, /\b(?:chrony|chronyd|chronyc|systemd-timesyncd|timedatectl|ntpd)\b/);
  assert.doesNotMatch(script, /\bdate\s+-s\b/);
});

test("Agent upgrade atomically normalizes config before replacing and restarting the service", () => {
  const script = generateInstallScript("https://panel.example.com");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");

  const runtimeIndex = upgrade.indexOf("if ! install_runtime; then");
  const configIndex = upgrade.indexOf("if ! normalize_upgrade_agent_config; then");
  const serviceIndex = upgrade.indexOf("    write_agent_service");
  const restartIndex = upgrade.indexOf("    start_agent_service");
  const registerIndex = upgrade.indexOf("    if ! register_agent_once; then");

  assert.ok(runtimeIndex >= 0, "upgrade must finish runtime dependencies before config normalization");
  assert.ok(configIndex > runtimeIndex, "config normalization must follow dependency installation");
  assert.ok(serviceIndex > configIndex, "service definition must be replaced after config normalization");
  assert.ok(restartIndex > serviceIndex, "service restart must follow service definition replacement");
  assert.ok(registerIndex > restartIndex, "upgrade must re-register after the new service is running");
  assert.doesNotMatch(upgrade, /\n\s*migrate_legacy_config\s*\n/);
});

test("Agent binary downloads fail when the downloaded file cannot be installed", () => {
  const script = generateInstallScript("https://panel.example.com");
  const downloader = scriptSection(script, "download_url_binary() {", "download_github_binary() {");

  assert.match(script, /elf_binary_healthy\(\)/);
  assert.match(script, /file -b "\$BIN"/);
  assert.match(script, /MAGIC="\$\(od -An -tx1 -N4/);
  assert.match(script, /MACHINE="\$\(od -An -tx1 -j18 -N2/);
  assert.match(downloader, /elf_binary_healthy "\$TMP_FILE"/);
  assert.match(downloader, /不是当前主机可执行的 ELF 二进制/);
  assert.match(downloader, /TMP_FILE=\"\" STATUS_FILE=\"\"/);
  assert.match(downloader, /mktemp "\$\{DST\}\.tmp\.XXXXXX"/);
  assert.match(downloader, /if ! chmod 0755 "\$TMP_FILE" \|\| ! mv -f "\$TMP_FILE" "\$DST"; then/);
  assert.doesNotMatch(downloader, /install -m 0755 "\$\{DST\}\.tmp" "\$DST"/);
  assert.match(downloader, /echo "\[警告\] \$LABEL 安装失败: \$DST"/);
  assert.match(downloader, /return 1/);
});

test("Agent upgrade config normalization preserves unknown fields and applies migration state", () => {
  const script = generateInstallScript("https://panel.example.com", {
    migrationFallbackPanelUrl: "https://old-panel.example.com",
    panelMigrationId: "migration-1",
    panelMigrationStartedAt: 123456,
  });
  const normalizer = scriptSection(script, "normalize_upgrade_agent_config() {", "migrate_legacy_config() {");

  assert.match(normalizer, /SOURCE="\$CONFIG_DIR\/config\.json"/);
  assert.match(normalizer, /SOURCE="\$LEGACY_CONFIG_DIR\/config\.json"/);
  assert.match(normalizer, /mktemp "\$CONFIG_DIR\/config\.json\.tmp\.XXXXXX"/);
  assert.match(normalizer, /if ! jq -e /);
  assert.match(normalizer, /if ! jq -n -e /);
  assert.match(normalizer, /\.panelUrl = \$panelUrl \| \.token = \$token \| \.interval = 30/);
  assert.match(normalizer, /\.migrationFallbackPanelUrl = \$fallback/);
  assert.match(normalizer, /del\(\.migrationFallbackPanelUrl, \.panelMigrationId, \.panelMigrationStartedAt\)/);
  assert.doesNotMatch(normalizer, /\{\s*panelUrl\s*:/);
  assert.match(normalizer, /if ! chmod 600 "\$TMP"; then/);
  assert.match(normalizer, /if ! mv -f "\$TMP" "\$CONFIG_DIR\/config\.json"; then/);
});

test("Agent upgrade stages Agent and FXP before replacing either", () => {
  const script = generateInstallScript("https://panel.example.com");
  const upgrade = scriptSection(script, "do_upgrade() {", "# ============ 入口 ============");
  const binaries = scriptSection(script, "upgrade_agent_and_fxp_binaries() {", "# ============ 卸载 ============");

  // 升级不再直接下载到正在用的路径：先下到 *.forwardx-new，都拿到了才替换（行为测试见
  // agentInstallFxpUpgrade.test.ts）。
  assert.match(upgrade, /if upgrade_agent_and_fxp_binaries; then/);
  assert.doesNotMatch(upgrade, /download_release_binary "forwardx-(agent|fxp)-linux-\$\{GO_ARCH\}" "\$(GO_AGENT_BIN|FXP_BIN)"/);
  assert.match(binaries, /stage_release_binary "forwardx-agent-linux-\$\{GO_ARCH\}" "\$GO_AGENT_BIN" "Go Agent" "0"/);
  assert.match(
    binaries,
    /RELEASE_VERSION="\$FXP_RELEASE_VERSION" stage_release_binary "forwardx-fxp-linux-\$\{GO_ARCH\}" "\$FXP_BIN" "NEX FXP" "0"/,
  );
  assert.ok(
    binaries.indexOf('promote_staged_binary "$FXP_BIN"') < binaries.indexOf('promote_staged_binary "$GO_AGENT_BIN"'),
    "FXP 先换、Agent 后换",
  );
  assert.match(binaries, /fxp_version_wire_compatible "\$CURRENT_FXP"/);
});

test("gost runtime upgrades validate a same-directory candidate before replacement", () => {
  const script = generateInstallScript("https://panel.example.com");
  const panel = scriptSection(script, "install_runtime_from_panel() {", "install_runtime_from_github() {");
  const github = scriptSection(script, "install_runtime_from_github() {", "install_runtime() {");
  const installer = scriptSection(script, "install_runtime() {", "install_go_agent() {");
  const commit = scriptSection(script, "commit_runtime_candidate() {", "nginx_self_check() {");

  assert.match(panel, /mktemp "\$\{RUNTIME_BIN\}\.candidate\.XXXXXX"/);
  assert.match(panel, /download_panel_binary "\$URL" "\$STAGED_RUNTIME" "gost runtime"/);
  assert.match(panel, /commit_runtime_candidate "\$STAGED_RUNTIME"/);
  assert.doesNotMatch(panel, /download_panel_binary "\$URL" "\$RUNTIME_BIN"/);

  assert.match(github, /install -m 0755 "\$GOST_BIN" "\$STAGED_RUNTIME"/);
  assert.match(github, /commit_runtime_candidate "\$STAGED_RUNTIME"/);
  assert.doesNotMatch(github, /install -m 0755 "\$GOST_BIN" "\$RUNTIME_BIN"/);

  assert.match(commit, /runtime_self_check "\$CANDIDATE"/);
  assert.match(commit, /mv -f "\$CANDIDATE" "\$RUNTIME_BIN"/);
  assert.doesNotMatch(installer, /rm -f "\$RUNTIME_BIN"/);
  assert.match(installer, /install -m 0755 "\$BIN" "\$STAGED_RUNTIME"/);
  assert.match(installer, /commit_runtime_candidate "\$STAGED_RUNTIME"/);
});

test("realm installer validates a staged candidate before replacing the existing binary", () => {
  const script = generateInstallScript("https://panel.example.com");
  const download = scriptSection(script, "install_realm_from_url() {", "is_github_accelerator_enabled() {");
  const commit = scriptSection(script, "commit_realm_candidate() {", "install_realm_from_url() {");
  const installer = scriptSection(script, "install_realm() {", "runtime_self_check() {");

  assert.match(download, /mktemp "\$\{REALM_PATH\}\.candidate\.XXXXXX"/);
  assert.match(download, /install -m 0755 "\$REALM_BIN" "\$STAGED_REALM"/);
  assert.match(download, /commit_realm_candidate "\$STAGED_REALM"/);
  assert.doesNotMatch(download, /install -m 0755 "\$REALM_BIN" "\$REALM_PATH"/);
  assert.doesNotMatch(download, /rm -f "\$REALM_PATH"/);
  assert.match(commit, /realm_binary_healthy "\$CANDIDATE"/);
  assert.match(commit, /mv -f "\$CANDIDATE" "\$REALM_PATH"/);
  assert.match(script, /realm health check:/);
  assert.doesNotMatch(installer, /rm -f "\$REALM_PATH"/);
});

test("realm installer pins the compatible default and preserves an explicit override", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.match(script, /FORWARDX_REALM_VERSION="\$\{FORWARDX_REALM_VERSION:-2\.9\.4\}"/);
  assert.match(script, /FORWARDX_REALM_VERSION_EXPLICIT=/);
  assert.match(script, /local VERSION="\$\{FORWARDX_REALM_VERSION:-2\.9\.4\}" LATEST_VERSION/);
  assert.match(script, /printf "%s\\n" "v\$\{VERSION#v\}"/);
  assert.match(script, /glibc2\.28 compatibility/);
  assert.match(script, /realm-\$\{REALM_ARCH\}-glibc2\.28\.tar\.gz/);
  assert.match(script, /default target applies to new installs/);
});

test("GitHub Agent entry script forwards the Realm version override", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-agent.sh"), "utf8");

  assert.match(script, /FORWARDX_REALM_VERSION="\$\{FORWARDX_REALM_VERSION:-2\.9\.4\}"/);
  assert.match(script, /FORWARDX_REALM_VERSION_EXPLICIT="false"/);
  assert.match(script, /FORWARDX_REALM_VERSION="\$FORWARDX_REALM_VERSION" \\\n\s+bash "\$tmp_script"/);
  assert.match(script, /FORWARDX_REALM_VERSION_EXPLICIT="\$FORWARDX_REALM_VERSION_EXPLICIT" \\\n\s+FORWARDX_REALM_VERSION=/);
});

test("nginx installer validates a staged candidate and preserves the existing runtime on failure", () => {
  const script = generateInstallScript("https://panel.example.com");
  const nginx = scriptSection(script, "install_nginx_runtime() {", "install_runtime_from_panel() {");
  const commit = scriptSection(script, "commit_nginx_candidate() {", "install_nginx_runtime() {");

  assert.match(nginx, /mktemp "\$\{NGINX_BIN\}\.candidate\.XXXXXX"/);
  assert.match(nginx, /install -m 0755 "\$BIN" "\$STAGED_NGINX"/);
  assert.match(nginx, /commit_nginx_candidate "\$STAGED_NGINX"/);
  assert.doesNotMatch(nginx, /install -m 0755 "\$BIN" "\$NGINX_BIN"/);
  assert.doesNotMatch(nginx, /rm -f "\$NGINX_BIN"/);
  assert.match(commit, /nginx_self_check "\$CANDIDATE"/);
  assert.match(commit, /mv -f "\$CANDIDATE" "\$NGINX_BIN"/);
});

test("Managed systemd units receive bounded logging defaults idempotently", () => {
  const unit = [
    "[Unit]",
    "Description=NEX runtime",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=/usr/local/bin/forwardx-runtime -C /etc/forwardx/runtime/gost.json",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");

  const hardened = hardenManagedServiceUnit(unit);
  assert.match(hardened, /LimitCORE=0/);
  assert.match(hardened, /LogRateLimitIntervalSec=30s/);
  assert.match(hardened, /LogRateLimitBurst=200/);
  assert.equal(hardenManagedServiceUnit(hardened), hardened);
});

test("Mimic installer provisions the NIC offload management dependency", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /ensure_ethtool\(\)/);
  assert.match(script, /apt-get install -y ethtool/);
  assert.match(script, /ensure_ethtool \|\| log/);
});

test("Mimic installer uses codename-prefixed release assets", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /detect_deb_codenames\(\)/);
  assert.match(script, /\$\{codename\}_mimic_\$\{TARGET_VERSION\}-1_\$\{arch\}\.deb/);
  assert.match(script, /\$\{codename\}_mimic-dkms_\$\{TARGET_VERSION\}-1_\$\{arch\}\.deb/);
  assert.match(script, /check_kernel_build_requirements/);
  assert.match(script, /bpftool_bin="\$\(type -P bpftool/);
  assert.match(script, /CHECKSUM_HACK=kprobe/);
  assert.doesNotMatch(script, /matching vmlinux BTF is unavailable[\s\S]*return 1/);
});

test("Mimic source fallback installs a privileged service with stale-hook cleanup", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /ExecStartPre=-\$\{modprobe_bin\} -r mimic/);
  assert.match(script, /ExecStartPre=-\$\{ip_bin\} link set dev %i xdp off/);
  assert.match(script, /ExecStartPre=-\$\{sh_bin\} -c 'idx=/);
  assert.match(script, /CapabilityBoundingSet=.*CAP_BPF/);
  assert.match(script, /forwardx-bpf\.conf/);
  assert.doesNotMatch(script, /User=mimic/);
  assert.doesNotMatch(script, /Group=mimic/);
});

test("Mimic installer run_logged reports the failing command's exit code", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");
  const runLogged = scriptSection(script, "run_logged() {", "\n}\n") + "\n}\n";
  const probe = `log(){ :; }\n${runLogged}\nrun_logged a false; echo "a=$?"\nrun_logged b bash -c 'exit 7'; echo "b=$?"\nrun_logged c true; echo "c=$?"\n`;
  const result = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // 以前 if cmd; then ...; fi 之后再取 $?，失败一律变成 0，dpkg -i 的补依赖 / 重试路径根本不走
  assert.match(result.stdout, /a=1\b/);
  assert.match(result.stdout, /b=7\b/);
  assert.match(result.stdout, /c=0\b/);
});

test("Mimic installer honours repair mode instead of exiting on a healthy host", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");
  // 面板「重新安装」发 FORWARDX_MIMIC_MODE=repair：「已经装好」的提前退出只在非 repair 时走
  assert.match(script, /\[ "\$\{current_version\}" = "\$\{TARGET_VERSION\}" \] && \[ "\$\{FORWARDX_MIMIC_MODE:-install\}" != "repair" \]/);
  assert.match(script, /reinstall requested, reinstalling packages/);
});

test("Agent release always builds the published FXP assets from Go", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/build-agent-release.sh"), "utf8");

  assert.match(script, /build_fxp amd64 forwardx-fxp-linux-amd64/);
  assert.match(script, /build_fxp arm64 forwardx-fxp-linux-arm64/);
  assert.match(script, /CGO_ENABLED=0 GOOS=linux GOARCH="\$goarch"/);
  assert.doesNotMatch(script, /FXP_IMPLEMENTATION|forwardx-fxp-rust|cargo|cross build/);
});

test("iperf3 is optional so a node without it still installs", () => {
  const script = generateInstallScript("https://panel.example.com", {});
  const deps = scriptSection(script, "install_deps() {", '  echo "[信息] 系统依赖就绪"');

  // 关键依赖里不再包含 iperf3：它只服务于 Looking Glass 测速，
  // Agent 侧本就用 LookPath 兜底，装不上不该阻断整个安装。
  assert.match(deps, /for B in curl jq iptables od; do/);
  assert.doesNotMatch(deps, /for B in curl jq iptables iperf3 od; do/);
  assert.match(deps, /if ! command -v iperf3 >\/dev\/null 2>&1; then/);
  assert.match(deps, /\[WARN\] 可选依赖未安装: iperf3/);

  // 仍然安装它，只是失败不致命。
  assert.match(deps, /apt-get install -y -qq .*iperf3/);
});

test("dependency install keeps package manager output for diagnosis", () => {
  const script = generateInstallScript("https://panel.example.com", {});
  const deps = scriptSection(script, "install_deps() {", '  echo "[信息] 系统依赖就绪"');

  // 以前所有包管理器输出都丢进 /dev/null，依赖缺失时只剩一句
  // 「未能安装依赖: X」，无法判断是源不可达还是包名不存在。
  assert.doesNotMatch(deps, /apt-get install[^\n]*>\/dev\/null 2>&1/);
  assert.match(deps, /FORWARDX_DEPS_LOG="\$\{TMPDIR:-\/tmp\}\/forwardx-agent-deps\.log"/);
  assert.match(deps, /apt-get install[^\n]*; \} >>"\$FORWARDX_DEPS_LOG" 2>&1 \|\| true/);
  assert.match(deps, /tail -n 20 "\$FORWARDX_DEPS_LOG"/);
  assert.match(deps, /dump_deps_log "\[错误\]"/);
});

test("已装官方 gost 时尝试从面板换成 NEX 自编版，换上后重启 runtime", () => {
  const script = generateInstallScript("https://panel.example.com");
  const installRuntime = script.slice(script.indexOf("install_runtime() {"));
  assert.match(script, /runtime_is_nex_build\(\) \{/);
  // 已经是自编版就不再下载。
  assert.match(installRuntime, /if runtime_is_nex_build "\$RUNTIME_BIN"; then[\s\S]*?return 0/);
  // 官方版能用时只接受面板上的自编版，换上以后重启正在跑的 runtime。
  assert.match(installRuntime, /NEX_RUNTIME_ONLY=1 install_runtime_from_panel; then\s+restart_runtime_services_if_running/);
  const fromPanel = script.slice(script.indexOf("install_runtime_from_panel() {"), script.indexOf("install_runtime_from_github() {"));
  assert.match(fromPanel, /NEX_RUNTIME_ONLY:-\}" \] && ! runtime_is_nex_build "\$STAGED_RUNTIME"/);
});

test("NEX gost runtime: build number parsing, upgrade with .prev backup + marker, rollback restores the old binary", () => {
  const script = generateInstallScript("https://panel.example.com");
  assert.match(script, /RUNTIME_MIN_NEX_BUILD="3"/);
  // 换运行时按面板这一版带的构建号（nex4），不是能力门槛（nex3）：nex3 的机器也要换上 nex4。
  assert.match(script, /RUNTIME_TARGET_NEX_BUILD="4"/);
  const functions = scriptSection(script, "runtime_self_check() {", "nginx_self_check() {");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "fwx-runtime-"));
  try {
    const fake = (name: string, version: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\nprintf 'gost ${version} (go1.25.4 linux/amd64)\\n'\nprintf 'Usage of gost:\\n  -C string\\n  -L value\\n  -F value\\n  -l\\n  -f\\n'\n`, { mode: 0o755 });
      return file;
    };
    const bin = path.join(dir, "forwardx-runtime");
    fs.copyFileSync(fake("nex2", "3.2.6-nex2"), bin);
    fs.chmodSync(bin, 0o755);
    const candidate = fake("candidate", "3.2.6-nex3");
    fake("upstream", "3.2.6");
    const probe = [
      `RUNTIME_BIN=${JSON.stringify(bin)}`,
      'RUNTIME_PREV_BIN="${RUNTIME_BIN}.prev"',
      `RUNTIME_UPGRADE_MARKER=${JSON.stringify(path.join(dir, "state/runtime-upgrade.json"))}`,
      `RUNTIME_ROLLBACK_STATE=${JSON.stringify(path.join(dir, "state/runtime-rollback.json"))}`,
      functions,
      `echo "build_nex2=$(runtime_nex_build "$RUNTIME_BIN") build_upstream=$(runtime_nex_build ${JSON.stringify(path.join(dir, "upstream"))}) version=$(runtime_version_string ${JSON.stringify(candidate)})"`,
      `commit_runtime_candidate ${JSON.stringify(candidate)} >/dev/null && echo "committed=$(runtime_version_string "$RUNTIME_BIN") prev=$(runtime_version_string "$RUNTIME_PREV_BIN")"`,
      'echo "marker=$(cat "$RUNTIME_UPGRADE_MARKER")"',
      'rollback_runtime_binary "restart of forwardx-runtime failed" >/dev/null && echo "rolledback=$(runtime_version_string "$RUNTIME_BIN") marker_left=$([ -e "$RUNTIME_UPGRADE_MARKER" ] && echo yes || echo no)"',
      'echo "rollback=$(cat "$RUNTIME_ROLLBACK_STATE")"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /build_nex2=2 build_upstream=0 version=3\.2\.6-nex3/);
    assert.match(result.stdout, /committed=3\.2\.6-nex3 prev=3\.2\.6-nex2/);
    const marker = JSON.parse(result.stdout.match(/^marker=(.*)$/m)![1]);
    assert.equal(marker.previousPath, `${bin}.prev`);
    assert.equal(marker.previousVersion, "3.2.6-nex2");
    assert.equal(marker.newVersion, "3.2.6-nex3");
    assert.ok(Number(marker.startedAt) > 1_600_000_000);
    assert.match(result.stdout, /rolledback=3\.2\.6-nex2 marker_left=no/);
    const rollback = JSON.parse(result.stdout.match(/^rollback=(.*)$/m)![1]);
    assert.equal(rollback.failedVersion, "3.2.6-nex3");
    assert.equal(rollback.restoredVersion, "3.2.6-nex2");
    assert.equal(rollback.restoredFingerprint.size, fs.statSync(bin).size);
    assert.equal(rollback.restoredFingerprint.inode, fs.statSync(bin).ino);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 已经是 NEX 自编版但构建号不够（nex2）：只从面板收更新的构建，换上后重启并检查，起不来就回滚。
  const installRuntime = scriptSection(script, "install_runtime() {", "install_go_agent() {");
  assert.match(installRuntime, /runtime_nex_build "\$RUNTIME_BIN"\)" -ge "\$RUNTIME_TARGET_NEX_BUILD"/);
  assert.match(installRuntime, /NEX_RUNTIME_ONLY=1 NEX_RUNTIME_MIN_BUILD="\$\(\( \$\(runtime_nex_build "\$RUNTIME_BIN"\) \+ 1 \)\)" install_runtime_from_panel; then\s+restart_runtime_services_if_running/);
  const fromPanel = scriptSection(script, "install_runtime_from_panel() {", "install_runtime_from_github() {");
  assert.match(fromPanel, /NEX_RUNTIME_MIN_BUILD:-\}" \] && \[ "\$\(runtime_nex_build "\$STAGED_RUNTIME"\)" -lt "\$NEX_RUNTIME_MIN_BUILD" \]/);
  const restart = scriptSection(script, "restart_runtime_services_if_running() {", "install_runtime() {");
  assert.match(restart, /rollback_runtime_binary "restart of \$SVC failed"/);
});
