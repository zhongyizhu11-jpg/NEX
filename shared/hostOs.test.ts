import assert from "node:assert/strict";
import test from "node:test";
import { hostOsShortTag, parseHostOs } from "./hostOs";

/**
 * osInfo 是 Agent 原样上报的 /etc/os-release PRETTY_NAME。卡片上只放得下
 * 「名字 + 大版本」，所以这里守着常见 VPS 系统认得对、版本号取得对。
 */
const cases: Array<[string, string, string]> = [
  ["Debian GNU/Linux 12 (bookworm)", "debian", "Debian 12"],
  ["Debian GNU/Linux 11 (bullseye)", "debian", "Debian 11"],
  ["Debian GNU/Linux trixie/sid", "debian", "Debian trixie/sid"],
  ["Ubuntu 22.04.4 LTS", "ubuntu", "Ubuntu 22.04"],
  ["Ubuntu 24.04 LTS", "ubuntu", "Ubuntu 24.04"],
  ["CentOS Linux 7 (Core)", "centos", "CentOS 7"],
  ["CentOS Stream 9", "centos", "CentOS Stream 9"],
  ["AlmaLinux 9.4 (Seafoam Ocelot)", "almalinux", "AlmaLinux 9.4"],
  ["Rocky Linux 9.3 (Blue Onyx)", "rocky", "Rocky Linux 9.3"],
  ["Red Hat Enterprise Linux 9.3 (Plow)", "rhel", "RHEL 9.3"],
  ["Fedora Linux 39 (Server Edition)", "fedora", "Fedora 39"],
  ["Alpine Linux v3.19", "alpine", "Alpine 3.19"],
  ["Arch Linux", "arch", "Arch Linux"],
  ["Manjaro Linux", "manjaro", "Manjaro"],
  ["openSUSE Leap 15.5", "opensuse", "openSUSE Leap 15.5"],
  ["openSUSE Tumbleweed", "opensuse", "openSUSE Tumbleweed"],
  ["SUSE Linux Enterprise Server 15 SP5", "opensuse", "SLES 15"],
  ["Kali GNU/Linux Rolling", "kali", "Kali Rolling"],
  ["Linux Mint 21.2", "mint", "Linux Mint 21.2"],
  ["OpenWrt 23.05.2", "openwrt", "OpenWrt 23.05"],
  ["Alibaba Cloud Linux 3.2104 U8 (OpenAnolis Edition)", "alinux", "Alinux 3"],
  ["Alibaba Cloud Linux (Aliyun Linux) 2.1903 LTS (Hunting Beagle)", "alinux", "Alinux 2"],
  ["Deepin 20.9", "deepin", "Deepin 20.9"],
  ["Oracle Linux Server 8.9", "linux", "Oracle Linux 8.9"],
  ["Amazon Linux 2023", "linux", "Amazon Linux 2023"],
  ["openEuler 22.03 (LTS-SP2)", "linux", "openEuler 22.03"],
  ["Kylin Linux Advanced Server V10 (Lance)", "linux", "Kylin V10"],
  ["Raspbian GNU/Linux 11 (bullseye)", "linux", "Raspbian 11"],
  ["Pop!_OS 22.04 LTS", "linux", "Pop!_OS 22.04"],
  ["linux/amd64", "linux", "Linux"],
];

for (const [raw, family, label] of cases) {
  test(`认得出 ${raw}`, () => {
    const os = parseHostOs(raw);
    assert.equal(os.family, family);
    assert.equal(os.label, label);
    assert.equal(os.full, raw);
  });
}

test("没上报：空标识，卡片上就不画", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.deepEqual(parseHostOs(value), { family: "unknown", name: "", version: "", label: "", full: "" });
  }
});

test("深空主机行的短标签", () => {
  const tag = (raw: string | null) => hostOsShortTag(parseHostOs(raw));
  assert.equal(tag("Ubuntu 24.04.1 LTS"), "UBU");
  assert.equal(tag("Debian GNU/Linux 12 (bookworm)"), "DEB");
  assert.equal(tag("AlmaLinux 9.4 (Seafoam Ocelot)"), "ALMA");
  assert.equal(tag("Rocky Linux 9.3 (Blue Onyx)"), "ROCKY");
  assert.equal(tag("CentOS Linux 7 (Core)"), "CENT");
  assert.equal(tag("windows/amd64"), "WIN");
  assert.equal(tag("linux/amd64"), "LNX");
  assert.equal(tag(null), "");
});

test("名字和版本分开给，详情里能单独用", () => {
  const os = parseHostOs("Rocky Linux 9.3 (Blue Onyx)");
  assert.equal(os.name, "Rocky Linux");
  assert.equal(os.version, "9.3");
});
