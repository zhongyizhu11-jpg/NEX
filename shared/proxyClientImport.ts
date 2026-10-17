/**
 * 各客户端的一键导入链接。
 *
 * 每个 scheme 都核对过官方来源（Loon 与 Quantumult X 是官方仓库文档，sing-box
 * 是官方手册，其余是各自客户端长期通行的写法），没有凭印象写：点了没反应的按钮
 * 比没有按钮更糟，用户会以为是订阅坏了。
 */

import {
  PROXY_SUBSCRIPTION_FORMAT_LABELS,
  proxySubscriptionFormatHasProfile,
  type ProxySubscriptionFormat,
} from "./proxySubscription";
import { encodeBase64Utf8 } from "./proxyNode";

/**
 * 一键导入走的是 deep link，只有装了该客户端的设备点得动 —— 在 Windows 上点
 * loon:// 是个什么都不会发生的死按钮。所以平台不是展示信息，而是筛选依据。
 * 跨设备导入靠二维码，不靠这些图标。
 */
export const PROXY_CLIENT_PLATFORMS = ["ios", "android", "windows", "macos", "linux"] as const;

export type ProxyClientPlatform = (typeof PROXY_CLIENT_PLATFORMS)[number];

export const PROXY_CLIENT_PLATFORM_LABELS: Record<ProxyClientPlatform, string> = {
  ios: "iOS",
  android: "Android",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export type ProxyClientTarget = {
  id: string;
  /** 客户端显示名 */
  label: string;
  /** 窄屏用的短名：三列网格放不下"Quantumult X"这种长名 */
  shortLabel: string;
  /** 支持该客户端的平台，用于按当前设备筛选 */
  platforms: readonly ProxyClientPlatform[];
  /**
   * 同一个 scheme 还覆盖哪些客户端。
   *
   * 一格 clash:// 管着整个 Clash 家族，界面上只写"Clash"会让用 Clash Verge 的人
   * 以为没有自己那个，所以把名字列出来。
   */
  covers?: string;
  /** 该客户端要拉的订阅格式 */
  format: ProxySubscriptionFormat;
  /**
   * 由订阅地址和名称拼出可点击的 scheme。
   *
   * 只有官方确实有导入 scheme 的客户端才给 —— 编一个出来的结果是一格点了
   * 没反应的按钮，比没有这一格更糟。没有的填 manualHint 走手动。
   */
  buildImportUrl?: (subscriptionUrl: string, name: string) => string;
  /**
   * 没有 scheme 时，告诉用户在这个客户端里把地址粘到哪儿。
   *
   * 订阅地址本身对任何客户端都有效，deep link 只是省一次粘贴 —— 所以没有
   * scheme 不等于不支持，只是少一步自动化。
   */
  manualHint?: string;
  /**
   * 规则订阅（完整配置）走的导入方式，和节点订阅不同时才写。
   *
   * Loon / QX 的 scheme 导入的是节点资源，拿去导完整配置会被当成节点列表；
   * 没有核实过的配置导入 scheme 就走手动，不编。
   */
  profileImport?: Pick<ProxyClientTarget, "buildImportUrl" | "manualHint">;
};

const ALL_PLATFORMS = PROXY_CLIENT_PLATFORMS;

/** base64url，去掉补位的等号：Shadowrocket 的 sub:// 用的是这种。 */
function base64UrlOfText(value: string): string {
  return encodeBase64Utf8(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 订阅地址里带 ?format=...&rules=... 这种查询串，塞进另一个 URL 的参数时
 * 必须整体百分号编码，否则 & 会被外层当成参数分隔符而截断。
 */
function q(value: string): string {
  return encodeURIComponent(value);
}

export const PROXY_CLIENT_TARGETS: readonly ProxyClientTarget[] = [
  {
    id: "clash",
    label: "Clash / mihomo",
    shortLabel: "Clash",
    platforms: ALL_PLATFORMS,
    // 这些都注册 clash:// install-config，一格全覆盖。
    covers: "Clash Verge Rev、ClashX、ClashX Meta、FlClash、Clash for Android、Clash Meta",
    format: "clash",
    buildImportUrl: (url, name) => `clash://install-config?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "stash",
    label: "Stash",
    shortLabel: "Stash",
    platforms: ["ios", "macos"],
    format: "clash",
    buildImportUrl: (url, name) => `stash://install-config?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "singbox",
    label: "sing-box",
    shortLabel: "sing-box",
    platforms: ALL_PLATFORMS,
    format: "singbox",
    // 名称走 fragment，不是查询参数。
    buildImportUrl: (url, name) => `sing-box://import-remote-profile?url=${q(url)}#${q(name)}`,
  },
  {
    id: "loon",
    label: "Loon",
    shortLabel: "Loon",
    platforms: ["ios"],
    format: "loon",
    buildImportUrl: (url, name) => `loon://import?sub=${q(url)}&name=${q(name)}`,
    profileImport: { manualHint: "配置 → 添加配置文件 → 从 URL 下载 → 粘贴这条地址，之后在配置里切到它" },
  },
  {
    id: "surge",
    label: "Surge",
    shortLabel: "Surge",
    // surge:///install-config 是 Surge 的 iOS/macOS 专属。安卓上的 Surfboard 虽然
    // 读同一套配置格式（订阅按 UA 给它 Surge 格式），但只有自己的导入界面、
    // 不认这个 scheme —— 列进 android 就是在安卓上摆一个点了没反应的按钮。
    platforms: ["ios", "macos"],
    covers: "Surfboard（安卓，需手动粘贴地址）",
    format: "surge",
    // surge 后面是三条斜杠，少一条不会被识别。
    buildImportUrl: (url) => `surge:///install-config?url=${q(url)}`,
    // install-config 装的本来就是完整配置，规则订阅同样走它；配置自带 MANAGED-CONFIG，会自己更新。
    profileImport: { buildImportUrl: (url) => `surge:///install-config?url=${q(url)}` },
  },
  {
    id: "quantumultx",
    label: "Quantumult X",
    shortLabel: "QuantumultX",
    platforms: ["ios"],
    format: "quantumultx",
    // add-resource 会保留已有资源，update-configuration 则会覆盖，这里取前者。
    buildImportUrl: (url, name) => {
      const payload = JSON.stringify({ server_remote: [`${url}, tag=${name}`] });
      return `quantumult-x:///add-resource?remote-resource=${q(payload)}`;
    },
    profileImport: { manualHint: "设置 → 配置文件 → 下载 → 粘贴这条地址（会替换当前配置）" },
  },
  {
    id: "hiddify",
    label: "Hiddify",
    shortLabel: "Hiddify",
    platforms: ALL_PLATFORMS,
    // Hiddify 明确支持 v2ray sublink（也就是通用 base64），走这条最稳。
    format: "base64",
    // 官方 wiki 的当前写法是 hiddify://import/<sublink>#name，订阅地址放在路径里
    // 而不是查询参数；install-config?url= 那套已被标记为不推荐。
    buildImportUrl: (url, name) => `hiddify://import/${url}#${q(name)}`,
  },
  {
    id: "shadowrocket",
    label: "Shadowrocket",
    shortLabel: "Shadowrocket",
    platforms: ["ios"],
    // 节点订阅按 base64 给；单列格式是为了规则订阅能给它一份完整配置。
    format: "shadowrocket",
    // sub:// 后面直接跟订阅地址的 base64，不是查询参数。
    buildImportUrl: (url, name) => `sub://${base64UrlOfText(url)}#${q(name)}`,
    profileImport: {
      manualHint: "先在「节点订阅」里点 Shadowrocket 导入节点；再到 配置 → 右上角 ＋ → 粘贴这条地址 → 下载，点这份配置选「使用配置」",
    },
  },
  {
    id: "v2rayng",
    label: "v2rayNG",
    shortLabel: "v2rayNG",
    platforms: ["android"],
    format: "base64",
    // install-sub 是订阅（会保留自动更新），install-config 是单条配置，这里要前者。
    // name 参数在部分版本上不生效（2dust/v2rayNG#3470），但地址照样导入成功，
    // 顶多是分组名要自己改一次 —— 不影响能不能用。
    buildImportUrl: (url, name) => `v2rayng://install-sub?url=${q(url)}&name=${q(name)}`,
  },
  {
    id: "surfboard",
    label: "Surfboard",
    shortLabel: "Surfboard",
    platforms: ["android"],
    // Surfboard 严格照 Surge 的配置格式来，订阅按 UA 本来就会给它 Surge 格式。
    format: "surge",
    // surge:///install-config 是 Surge 的 iOS/macOS 专属，Surfboard 不认。
    manualHint: "配置标签页 → 右下角「添加订阅」→ 从 URL 导入 → 粘贴这条地址",
    profileImport: { manualHint: "配置标签页 → 右下角「添加订阅」→ 从 URL 导入 → 粘贴这条地址" },
  },
  {
    id: "nekobox",
    label: "NekoBox",
    shortLabel: "NekoBox",
    platforms: ["android"],
    format: "base64",
    // 一键导入在官方那边还只是个未实现的功能请求（MatsuriDayo/NekoBoxForAndroid#323）。
    manualHint: "左上角菜单 → 分组 → 右上角新建 → 类型选「订阅」→ 粘贴这条地址",
  },
  {
    id: "nekoray",
    label: "NekoRay",
    shortLabel: "NekoRay",
    platforms: ["windows", "linux"],
    format: "base64",
    manualHint: "程序 → 分组 → 新建分组 → 类型选「订阅」→ 粘贴这条地址",
  },
  {
    id: "v2rayn",
    label: "v2rayN",
    shortLabel: "v2rayN",
    platforms: ["windows"],
    format: "base64",
    manualHint: "订阅 → 订阅分组设置 → 添加 → 粘贴这条地址 → 再点「更新订阅」",
  },
];

/** 这个客户端导入这一种订阅，是一键 scheme 还是手动粘贴。 */
export function proxyClientImportFor(
  target: ProxyClientTarget,
  kind: ProxySubscriptionKind,
): Pick<ProxyClientTarget, "buildImportUrl" | "manualHint"> {
  if (kind === "rules" && target.profileImport) return target.profileImport;
  return { buildImportUrl: target.buildImportUrl, manualHint: target.manualHint };
}

export function proxyClientTargetsForFormat(format: ProxySubscriptionFormat): ProxyClientTarget[] {
  return PROXY_CLIENT_TARGETS.filter((target) => target.format === format);
}

/** 图标下方那行小字。全平台就写"全平台"，否则逐个列出来。 */
export function proxyClientPlatformsLabel(target: ProxyClientTarget): string {
  if (target.platforms.length >= PROXY_CLIENT_PLATFORMS.length) return "全平台";
  return target.platforms.map((item) => PROXY_CLIENT_PLATFORM_LABELS[item]).join(" / ");
}

export function proxyClientTargetsForPlatform(platform: ProxyClientPlatform): ProxyClientTarget[] {
  return PROXY_CLIENT_TARGETS.filter((target) => target.platforms.includes(platform));
}

/**
 * 从 UA 认出当前设备。
 *
 * iPadOS 13 起 Safari 的 UA 伪装成 "Macintosh; Intel Mac OS X"，跟桌面 Mac 一模一样，
 * 只能靠触摸点数区分 —— 认错的代价是 iPad 上少了 Loon、Shadowrocket 这些只有 iOS 才有的，
 * 所以宁可让调用方把触摸信息传进来。
 */
export function detectProxyClientPlatform(
  userAgent: string,
  options?: { maxTouchPoints?: number },
): ProxyClientPlatform | null {
  const ua = String(userAgent || "");
  if (!ua) return null;

  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh|Mac OS X/i.test(ua)) {
    // 伪装成 Mac 的 iPad：桌面 Mac 的触摸点数是 0。
    return (options?.maxTouchPoints ?? 0) > 1 ? "ios" : "macos";
  }
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return null;
}

// ==================== 订阅种类 ====================

export const PROXY_SUBSCRIPTION_KINDS = ["nodes", "rules"] as const;

export type ProxySubscriptionKind = (typeof PROXY_SUBSCRIPTION_KINDS)[number];

export const PROXY_SUBSCRIPTION_KIND_LABELS: Record<ProxySubscriptionKind, string> = {
  nodes: "节点订阅",
  rules: "规则订阅",
};

export const PROXY_SUBSCRIPTION_KIND_HINTS: Record<ProxySubscriptionKind, string> = {
  nodes: "只有节点，分流规则由你在客户端里自己配。所有客户端都适用。",
  rules: "一份完整配置：节点、策略组（自动选路、带宽叠加）和分流规则一起给，导入后不用再设置。Clash、sing-box、Surge、Loon、Quantumult X、Shadowrocket 都有；Shadowrocket 的节点仍来自节点订阅。",
};

/**
 * 订阅导进客户端后显示的名字：新建订阅链接时填的名字（「用途」，比如「我的手机」），没填才用
 * 用户名；规则订阅后面加「规则」两个字，两份导进同一个客户端也分得清。以前是「用途 · 节点订阅」，
 * 太长，导进去每次都得重命名；后来改成用户名，几条链接导进去又都叫一个名字。
 *
 * 一键导入链接的 name 参数和订阅响应头（Content-Disposition / Profile-Title，给 Surge、
 * 手动添加的那些客户端）用的都是它。
 */
export function proxySubscriptionProfileName(linkName: string, kind: ProxySubscriptionKind, username = ""): string {
  const clean = (value: string) => Array.from(String(value ?? "").replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim()).slice(0, 32).join("");
  // 用户新建订阅链接时填的名字（「用途」）优先，没有才退回用户名。
  const base = clean(linkName) || clean(username) || "订阅";
  return kind === "rules" ? `${base} 规则` : base;
}

/** 订阅响应头里的名字：RFC 5987 的 filename*（Clash 系、v2rayN 读这个）和 base64 的 Profile-Title（Hiddify、sing-box 系）。 */
export function proxySubscriptionProfileHeaders(name: string): Record<string, string> {
  return {
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Profile-Title": `base64:${encodeBase64Utf8(name)}`,
  };
}

/**
 * 拼订阅地址。
 *
 * 节点订阅不带 rules 参数，规则订阅带上 —— 这样同一个令牌就能同时提供两种，
 * 不必为了换一种而重新签发地址。
 */
export function buildProxySubscriptionUrl(options: {
  origin: string;
  token: string;
  format: ProxySubscriptionFormat;
  kind: ProxySubscriptionKind;
  /**
   * 强制带上 format 参数。
   *
   * 服务端定格式的顺序是 ?format= → UA → 令牌默认格式。通用 base64 平时不带
   * format，好让同一条地址粘到哪个客户端都能协商出对的格式；但从某个客户端
   * 图标点进去时我们已经知道是哪个客户端了，不钉死的话，UA 认不出来就会掉到
   * 令牌默认格式上 —— 默认设成 Clash 的话，Shadowrocket 会收到一份 Clash YAML。
   */
  pinFormat?: boolean;
}): string {
  const params = new URLSearchParams();
  if (options.format !== "base64" || options.pinFormat) params.set("format", options.format);
  // rules=1 表示按订阅链接上配置的预设来，具体档位不暴露在地址里。
  if (options.kind === "rules") params.set("rules", "1");
  const query = params.toString();
  return `${options.origin.replace(/\/+$/, "")}/api/sub/${options.token}${query ? `?${query}` : ""}`;
}

/** 该格式是否真的能表达分流规则；不能的话没必要展示规则订阅地址。 */
export function proxySubscriptionKindSupported(
  format: ProxySubscriptionFormat,
  kind: ProxySubscriptionKind,
): boolean {
  if (kind === "nodes") return true;
  return format === "clash" || format === "singbox" || proxySubscriptionFormatHasProfile(format);
}

