/*
  主机的「系统」标识：把 Agent 上报的 osInfo 认成「哪个发行版 + 哪个版本」。

  osInfo 是 Agent 读 /etc/os-release 的 PRETTY_NAME 原样上报的（读不到时退回
  `linux/amd64` 这种 GOOS/GOARCH），比如：

    Debian GNU/Linux 12 (bookworm)        → Debian 12
    Ubuntu 22.04.4 LTS                    → Ubuntu 22.04
    CentOS Linux 7 (Core)                 → CentOS 7
    Rocky Linux 9.3 (Blue Onyx)           → Rocky Linux 9.3
    Alpine Linux v3.19                    → Alpine 3.19
    Alibaba Cloud Linux 3.2104 U8 (…)     → Alinux 3

  卡片上放得下的只有「名字 + 大版本」，完整的 PRETTY_NAME 留给详情和悬停提示。
  认不出来的发行版不硬猜：名字照抄（去掉括号里的代号），图标用通用的服务器。
*/

export type HostOsFamily =
  | "debian"
  | "ubuntu"
  | "centos"
  | "almalinux"
  | "rocky"
  | "rhel"
  | "fedora"
  | "alpine"
  | "arch"
  | "manjaro"
  | "opensuse"
  | "kali"
  | "mint"
  | "openwrt"
  | "alinux"
  | "deepin"
  | "linux"
  | "unknown";

export type HostOsIdentity = {
  /** 用来挑图标和颜色；认不出的发行版是 linux，没上报是 unknown */
  family: HostOsFamily;
  /** 发行版的短名字：Debian、Rocky Linux、openSUSE Leap */
  name: string;
  /** 版本号，没有就是空串（Arch、Gentoo 这种滚动发行版） */
  version: string;
  /** 卡片上那枚标识的文字：名字 + 版本 */
  label: string;
  /** Agent 上报的原文，给详情和悬停提示 */
  full: string;
};

type FamilyRule = {
  family: HostOsFamily;
  test: RegExp;
  name: string | ((text: string) => string);
  /** 版本号怎么取；默认取名字后面第一个「数字(.数字)」 */
  version?: (text: string) => string;
};

const firstVersion = (text: string, parts = 2) => {
  const match = text.match(/\bv?(\d+(?:\.\d+)*)/i);
  if (!match) return "";
  return match[1].split(".").slice(0, parts).join(".");
};
const majorVersion = (text: string) => firstVersion(text, 1);
const rollingOr = (fallback: string) => (text: string) => (/rolling/i.test(text) ? "Rolling" : firstVersion(text) || fallback);

/*
  顺序有讲究：衍生版放在母版前面（Linux Mint、Kali、Manjaro 的 PRETTY_NAME 里
  不会出现 Ubuntu / Debian / Arch，但 Alibaba Cloud Linux 会带 Anolis、Rocky 的
  代号里可能出现别的词），先认得更具体的那个。
*/
const FAMILY_RULES: FamilyRule[] = [
  { family: "mint", test: /linux\s*mint|linuxmint/i, name: "Linux Mint" },
  { family: "kali", test: /\bkali\b/i, name: "Kali", version: rollingOr("") },
  { family: "ubuntu", test: /ubuntu/i, name: "Ubuntu" },
  { family: "debian", test: /debian/i, name: "Debian", version: (text) => firstVersion(text, 1) || debianCodename(text) },
  { family: "centos", test: /centos/i, name: (text) => (/stream/i.test(text) ? "CentOS Stream" : "CentOS"), version: majorVersion },
  { family: "almalinux", test: /alma\s*linux/i, name: "AlmaLinux" },
  { family: "rocky", test: /rocky/i, name: "Rocky Linux" },
  { family: "rhel", test: /red\s*hat|\brhel\b/i, name: "RHEL" },
  { family: "fedora", test: /fedora/i, name: "Fedora", version: majorVersion },
  { family: "alpine", test: /alpine/i, name: "Alpine" },
  { family: "manjaro", test: /manjaro/i, name: "Manjaro" },
  { family: "arch", test: /\barch\s*linux\b|\barchlinux\b|^arch\b/i, name: "Arch Linux", version: () => "" },
  {
    family: "opensuse",
    test: /opensuse|\bsuse\b|\bsles\b/i,
    name: (text) => {
      if (/tumbleweed/i.test(text)) return "openSUSE Tumbleweed";
      if (/leap/i.test(text)) return "openSUSE Leap";
      if (/opensuse/i.test(text)) return "openSUSE";
      return "SLES";
    },
    version: (text) => (/tumbleweed/i.test(text) ? "" : firstVersion(text)),
  },
  { family: "openwrt", test: /openwrt/i, name: "OpenWrt" },
  { family: "alinux", test: /alibaba\s*cloud\s*linux|\balinux\b|aliyun/i, name: "Alinux", version: majorVersion },
  { family: "deepin", test: /deepin/i, name: "Deepin" },
];

/** 没有图标、但名字值得认一下的发行版：只规整名字，family 记成 linux */
const NAMED_LINUX: Array<{ test: RegExp; name: string; version?: (text: string) => string }> = [
  { test: /oracle\s*linux/i, name: "Oracle Linux" },
  { test: /amazon\s*linux/i, name: "Amazon Linux", version: majorVersion },
  { test: /openeuler/i, name: "openEuler" },
  { test: /anolis/i, name: "Anolis OS" },
  { test: /tencentos/i, name: "TencentOS" },
  { test: /kylin/i, name: "Kylin", version: (text) => { const m = text.match(/\bV(\d+)\b/i); return m ? `V${m[1]}` : firstVersion(text); } },
  { test: /uniontech|\buos\b/i, name: "UOS", version: majorVersion },
  { test: /armbian/i, name: "Armbian" },
  { test: /raspbian/i, name: "Raspbian", version: majorVersion },
  { test: /gentoo/i, name: "Gentoo", version: () => "" },
  { test: /nixos/i, name: "NixOS" },
  { test: /void/i, name: "Void Linux", version: () => "" },
];

function debianCodename(text: string) {
  // Debian testing / sid 的 PRETTY_NAME 没有数字：「Debian GNU/Linux trixie/sid」
  const match = text.match(/debian\s+gnu\/linux\s+([a-z/]+)/i);
  return match ? match[1] : "";
}

function stripParentheses(text: string) {
  return text.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function versionAfterName(text: string) {
  return firstVersion(text);
}

function join(name: string, version: string) {
  return [name, version].filter(Boolean).join(" ");
}

export function parseHostOs(value: unknown): HostOsIdentity {
  const full = String(value ?? "").replace(/^["']|["']$/g, "").trim();
  if (!full) return { family: "unknown", name: "", version: "", label: "", full: "" };

  // os-release 读不到时 Agent 报的是 GOOS/GOARCH
  const goTarget = full.match(/^([a-z0-9]+)\/([a-z0-9_]+)$/i);
  if (goTarget) {
    const os = goTarget[1].toLowerCase();
    const name = os === "linux" ? "Linux" : os === "freebsd" ? "FreeBSD" : os === "darwin" ? "macOS" : os === "windows" ? "Windows" : goTarget[1];
    return { family: os === "linux" ? "linux" : "unknown", name, version: "", label: name, full };
  }

  for (const rule of FAMILY_RULES) {
    if (!rule.test.test(full)) continue;
    const name = typeof rule.name === "function" ? rule.name(full) : rule.name;
    const version = (rule.version ?? versionAfterName)(full);
    return { family: rule.family, name, version, label: join(name, version), full };
  }

  for (const rule of NAMED_LINUX) {
    if (!rule.test.test(full)) continue;
    const version = (rule.version ?? versionAfterName)(full);
    return { family: "linux", name: rule.name, version, label: join(rule.name, version), full };
  }

  // 认不出的发行版：名字取版本号前面那几个词（最多三个），「Pop!_OS 22.04 LTS」→「Pop!_OS 22.04」
  const compact = stripParentheses(full).replace(/\bGNU\/Linux\b/i, " ").replace(/\s+/g, " ").trim();
  const version = firstVersion(compact);
  const words = compact.split(" ");
  const firstNumeric = words.findIndex((word) => /\d/.test(word));
  const name = (firstNumeric === -1 ? words : words.slice(0, firstNumeric)).slice(0, 3).join(" ") || words[0] || full;
  return { family: "linux", name, version, label: join(name, version), full };
}

/*
  「深空」主题主机行里那一枚短标签：发行版缩成 3～5 个大写字母，一列竖着对齐好扫。
  认不出的 Linux 写 LNX；GOOS 兜底的 Windows / FreeBSD / macOS 取名字；没上报是空串（调用处画「—」）。
*/
const OS_SHORT_TAGS: Record<HostOsFamily, string> = {
  debian: "DEB",
  ubuntu: "UBU",
  centos: "CENT",
  almalinux: "ALMA",
  rocky: "ROCKY",
  rhel: "RHEL",
  fedora: "FED",
  alpine: "ALP",
  arch: "ARCH",
  manjaro: "MANJ",
  opensuse: "SUSE",
  kali: "KALI",
  mint: "MINT",
  openwrt: "WRT",
  alinux: "ALI",
  deepin: "DEEP",
  linux: "LNX",
  unknown: "",
};

export function hostOsShortTag(os: Pick<HostOsIdentity, "family" | "name">): string {
  if (os.family !== "unknown") return OS_SHORT_TAGS[os.family];
  if (/^windows/i.test(os.name)) return "WIN";
  if (/^macos/i.test(os.name)) return "MAC";
  if (/^freebsd/i.test(os.name)) return "BSD";
  return os.name ? os.name.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() : "";
}
