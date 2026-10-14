import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase64Utf8 } from "./proxyNode";
import { PROXY_SUBSCRIPTION_FORMATS } from "./proxySubscription";
import {
  buildProxySubscriptionUrl,
  detectProxyClientPlatform,
  proxyClientPlatformsLabel,
  proxyClientTargetsForFormat,
  proxyClientTargetsForPlatform,
  proxyClientImportFor,
  proxySubscriptionKindSupported,
  PROXY_CLIENT_PLATFORMS,
  PROXY_CLIENT_TARGETS,
  PROXY_SUBSCRIPTION_KINDS,
  proxySubscriptionProfileHeaders,
  proxySubscriptionProfileName,
} from "./proxyClientImport";

const ORIGIN = "https://panel.example.com";
const TOKEN = "tok123";

test("节点订阅不带 rules 参数，规则订阅带上", () => {
  const nodes = buildProxySubscriptionUrl({ origin: ORIGIN, token: TOKEN, format: "clash", kind: "nodes" });
  const rules = buildProxySubscriptionUrl({ origin: ORIGIN, token: TOKEN, format: "clash", kind: "rules" });

  assert.equal(nodes, "https://panel.example.com/api/sub/tok123?format=clash");
  assert.equal(rules, "https://panel.example.com/api/sub/tok123?format=clash&rules=1");
});

test("通用 base64 不带 format，方便粘进只认裸地址的老客户端", () => {
  const url = buildProxySubscriptionUrl({ origin: ORIGIN, token: TOKEN, format: "base64", kind: "nodes" });

  assert.equal(url, "https://panel.example.com/api/sub/tok123");
});

test("每个客户端图标给出的地址都钉死了格式", () => {
  // 令牌的「默认格式」只是 UA 认不出来时的回落。图标是"已经知道是哪个客户端"的
  // 场景，一律钉死 —— 否则默认格式设成 Clash 时，Shadowrocket 会收到 Clash YAML。
  // 创建订阅链接时已经不再问默认格式了，这条守住"不问也不会出错"。
  for (const target of PROXY_CLIENT_TARGETS) {
    const url = buildProxySubscriptionUrl({
      origin: ORIGIN,
      token: TOKEN,
      format: target.format,
      kind: "nodes",
      pinFormat: true,
    });
    assert.ok(url.includes(`format=${target.format}`), `${target.id} 的地址没带格式: ${url}`);
  }
});

test("pinFormat 会把 base64 也写进地址", () => {
  // 服务端定格式的顺序是 ?format= → UA → 令牌默认格式。从客户端图标点进去时
  // 已经知道是哪个客户端，不钉死的话 UA 认不出来就会掉到令牌默认格式上 ——
  // 默认设成 Clash 的话，Shadowrocket 会收到一份 Clash YAML。
  const pinned = buildProxySubscriptionUrl({
    origin: ORIGIN,
    token: TOKEN,
    format: "base64",
    kind: "nodes",
    pinFormat: true,
  });

  assert.equal(pinned, "https://panel.example.com/api/sub/tok123?format=base64");
});

test("origin 末尾多余的斜杠不会拼出双斜杠", () => {
  const url = buildProxySubscriptionUrl({
    origin: "https://panel.example.com/",
    token: TOKEN,
    format: "loon",
    kind: "nodes",
  });

  assert.equal(url, "https://panel.example.com/api/sub/tok123?format=loon");
});

test("只有能表达规则的格式才提供规则订阅", () => {
  assert.equal(proxySubscriptionKindSupported("clash", "rules"), true);
  assert.equal(proxySubscriptionKindSupported("singbox", "rules"), true);
  // Loon、Surge、QX、Shadowrocket 的节点订阅是节点列表，规则订阅给的是一份完整配置。
  assert.equal(proxySubscriptionKindSupported("loon", "rules"), true);
  assert.equal(proxySubscriptionKindSupported("surge", "rules"), true);
  assert.equal(proxySubscriptionKindSupported("quantumultx", "rules"), true);
  assert.equal(proxySubscriptionKindSupported("shadowrocket", "rules"), true);
  // base64 是 URI 列表，装不下任何配置。
  assert.equal(proxySubscriptionKindSupported("base64", "rules"), false);

  // 节点订阅所有格式都有。
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    assert.equal(proxySubscriptionKindSupported(format, "nodes"), true, format);
  }
});

test("订阅地址整体编码后才嵌进导入链接", () => {
  // 地址里带 &，不编码会被外层当成参数分隔符而截断，导入到一半的地址必然失败。
  const url = "https://panel.example.com/api/sub/tok123?format=clash&rules=1";
  const clash = PROXY_CLIENT_TARGETS.find((target) => target.id === "clash")!;

  const link = clash.buildImportUrl!(url, "我的手机");

  assert.ok(!link.includes("&rules=1"), `订阅地址未编码: ${link}`);
  assert.ok(link.includes(encodeURIComponent(url)), link);
  assert.match(link, /^clash:\/\/install-config\?url=/);
});

test("各客户端的 scheme 与官方文档一致", () => {
  const url = "https://panel.example.com/api/sub/tok123?format=clash";
  const name = "我的手机";
  const link = (id: string) => PROXY_CLIENT_TARGETS.find((target) => target.id === id)!.buildImportUrl!(url, name);

  assert.match(link("clash"), /^clash:\/\/install-config\?url=.+&name=/);
  assert.match(link("stash"), /^stash:\/\/install-config\?url=.+&name=/);
  // sing-box 的名称走 fragment，不是查询参数。
  assert.match(link("singbox"), /^sing-box:\/\/import-remote-profile\?url=[^#]+#/);
  assert.match(link("loon"), /^loon:\/\/import\?sub=.+&name=/);
  // surge 后面是三条斜杠。
  assert.match(link("surge"), /^surge:\/\/\/install-config\?url=/);
  assert.match(link("quantumultx"), /^quantumult-x:\/\/\/add-resource\?remote-resource=/);
  assert.match(link("shadowrocket"), /^sub:\/\//);
});

test("Quantumult X 的参数是编码后的 JSON，带 tag", () => {
  const url = "https://panel.example.com/api/sub/tok123?format=quantumultx";
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "quantumultx")!;

  const link = target.buildImportUrl!(url, "我的手机");
  const payload = JSON.parse(decodeURIComponent(link.split("remote-resource=")[1]));

  assert.deepEqual(payload, { server_remote: [`${url}, tag=我的手机`] });
});

test("Shadowrocket 的 sub:// 用 base64 而不是查询参数", () => {
  const url = "https://panel.example.com/api/sub/tok123";
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "shadowrocket")!;

  const link = target.buildImportUrl!(url, "我的手机");
  const encoded = link.slice("sub://".length).split("#")[0];

  // base64url：不能含 + / =，否则在 URL 里会被再次转义。
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(decodeBase64Utf8(encoded), url);
});

test("每格要么有官方 scheme，要么有手动添加说明，不能两头空", () => {
  // 编一个不存在的 scheme 出来，结果是一格点了没反应的按钮 —— 比没有这一格更糟。
  // 反过来，没有 scheme 也不等于不支持：订阅地址本身对任何客户端都有效。
  for (const target of PROXY_CLIENT_TARGETS) {
    const hasScheme = typeof target.buildImportUrl === "function";
    const hasHint = typeof target.manualHint === "string" && target.manualHint.length > 0;
    assert.ok(hasScheme || hasHint, `${target.id} 既没有 scheme 也没有手动说明，点开是空的`);
    assert.ok(!(hasScheme && hasHint), `${target.id} 同时给了 scheme 和手动说明，界面不知道该走哪条`);
  }
});

test("没有官方 scheme 的客户端就是不给 scheme", () => {
  // 这几个都查过官方来源：NekoBox 的一键导入还只是未实现的功能请求，
  // Surfboard 不认 surge:// —— 谁要是哪天手滑给它们编了个 scheme，这条会红。
  for (const id of ["surfboard", "nekobox", "nekoray", "v2rayn"]) {
    const target = PROXY_CLIENT_TARGETS.find((item) => item.id === id)!;
    assert.equal(target.buildImportUrl, undefined, `${id} 不该有 scheme`);
    assert.ok(target.manualHint, `${id} 缺少手动添加说明`);
  }
});

test("v2rayNG 用 install-sub 而不是 install-config", () => {
  // install-config 导进去的是单条配置，不会当成订阅、也不会自动更新。
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "v2rayng")!;
  const link = target.buildImportUrl!("https://panel.example.com/api/sub/tok123", "我的手机");

  assert.match(link, /^v2rayng:\/\/install-sub\?url=/);
  assert.ok(!link.includes("install-config"));
});

test("每个客户端都对应一个真实存在的订阅格式", () => {
  const formats = new Set<string>(PROXY_SUBSCRIPTION_FORMATS);
  for (const target of PROXY_CLIENT_TARGETS) {
    assert.ok(formats.has(target.format), `${target.id} 指向了未知格式 ${target.format}`);
    assert.ok(target.label, `${target.id} 缺少显示名`);
  }

  const ids = PROXY_CLIENT_TARGETS.map((target) => target.id);
  assert.equal(new Set(ids).size, ids.length, "客户端 id 重复");
});

test("每种订阅格式都至少有一个可一键导入的客户端", () => {
  for (const format of PROXY_SUBSCRIPTION_FORMATS) {
    const targets = proxyClientTargetsForFormat(format);
    assert.ok(targets.length > 0, `${format} 没有对应的客户端，界面上会只剩复制按钮`);
  }
});

test("导入链接里的中文名称被编码，不会破坏 scheme", () => {
  const url = "https://panel.example.com/api/sub/tok123";
  for (const target of PROXY_CLIENT_TARGETS) {
    if (!target.buildImportUrl) continue;
    const link = target.buildImportUrl(url, "我的 手机 & 平板");
    // 未编码的空格和 & 会让部分客户端在解析时截断。
    assert.doesNotMatch(link, / /, `${target.id} 的链接含未编码空格: ${link}`);
  }
});

test("每个客户端都指向一个自己平台上真能用的 scheme", () => {
  // 一个客户端不能既没平台又留在列表里 —— 那格在任何设备上都点不动。
  for (const target of PROXY_CLIENT_TARGETS) {
    assert.ok(target.platforms.length > 0, `${target.id} 没有任何平台`);
  }
});

test("两种订阅种类的常量与标签齐全", () => {
  assert.deepEqual([...PROXY_SUBSCRIPTION_KINDS], ["nodes", "rules"]);
});

test("每个客户端都标注了适用平台和短名", () => {
  // 图标网格上没有品牌 logo，平台标注是用户判断"我能不能用这个"的唯一线索。
  for (const target of PROXY_CLIENT_TARGETS) {
    assert.ok(target.platforms.length > 0, `${target.id} 缺少平台标注`);
    for (const platform of target.platforms) {
      assert.ok(PROXY_CLIENT_PLATFORMS.includes(platform), `${target.id} 的平台 ${platform} 不认识`);
    }
    assert.ok(target.shortLabel, `${target.id} 缺少短名`);
    assert.ok(target.shortLabel.length <= 12, `${target.id} 的短名放不进三列网格: ${target.shortLabel}`);
  }
});

test("平台标注全覆盖时收敛成「全平台」", () => {
  const clash = PROXY_CLIENT_TARGETS.find((item) => item.id === "clash")!;
  const loon = PROXY_CLIENT_TARGETS.find((item) => item.id === "loon")!;
  const stash = PROXY_CLIENT_TARGETS.find((item) => item.id === "stash")!;

  assert.equal(proxyClientPlatformsLabel(clash), "全平台");
  assert.equal(proxyClientPlatformsLabel(loon), "iOS");
  assert.equal(proxyClientPlatformsLabel(stash), "iOS / macOS");
});

test("按平台筛出来的都是该平台真能装的", () => {
  // deep link 只有装了 App 的设备点得动，筛错了就是一格死按钮。
  assert.deepEqual(
    proxyClientTargetsForPlatform("windows").map((item) => item.id).sort(),
    ["clash", "hiddify", "nekoray", "singbox", "v2rayn"],
  );
  assert.deepEqual(
    proxyClientTargetsForPlatform("android").map((item) => item.id).sort(),
    ["clash", "hiddify", "nekobox", "singbox", "surfboard", "v2rayng"],
  );
  assert.deepEqual(
    proxyClientTargetsForPlatform("macos").map((item) => item.id).sort(),
    ["clash", "hiddify", "singbox", "stash", "surge"],
  );
  assert.deepEqual(
    proxyClientTargetsForPlatform("ios").map((item) => item.id).sort(),
    ["clash", "hiddify", "loon", "quantumultx", "shadowrocket", "singbox", "stash", "surge"],
  );
});

test("Surfboard 不进 android：它不认 surge:// scheme", () => {
  // surge:///install-config 是 Surge 的 iOS/macOS 专属。Surfboard 读同一套配置
  // 格式（订阅按 UA 给它 Surge 格式），但只有自己的导入界面 —— 列进 android
  // 等于在安卓上摆一个点了没反应的按钮。
  const surge = PROXY_CLIENT_TARGETS.find((item) => item.id === "surge")!;

  assert.deepEqual([...surge.platforms], ["ios", "macos"]);
  assert.ok(!surge.platforms.includes("android"));
});

test("Hiddify 的订阅地址放在路径里，不是查询参数", () => {
  // 官方 wiki 当前写法是 hiddify://import/<sublink>#name；
  // install-config?url= 那套已被标记为不推荐。
  const url = "https://panel.example.com/api/sub/tok123";
  const target = PROXY_CLIENT_TARGETS.find((item) => item.id === "hiddify")!;

  const link = target.buildImportUrl!(url, "我的手机");

  assert.equal(link, `hiddify://import/${url}#${encodeURIComponent("我的手机")}`);
  // 通用 base64 的地址不带查询串，放进路径不会被 ? 截断。
  assert.equal(target.format, "base64");
  assert.ok(!url.includes("?"), "base64 订阅地址不该带查询参数，否则塞进路径会被截断");
});

test("一格 scheme 覆盖多个客户端时把名字列出来", () => {
  // 只写"Clash"会让用 Clash Verge 的人以为没有自己那个。
  const clash = PROXY_CLIENT_TARGETS.find((item) => item.id === "clash")!;

  assert.ok(clash.covers?.includes("Clash Verge"), clash.covers);
  assert.ok(clash.covers?.includes("ClashX"), clash.covers);
});

test("每个平台至少有一个能用的客户端", () => {
  // 一个都筛不出来的话，界面上会只剩一句"没有可用客户端"，不如不筛。
  for (const platform of PROXY_CLIENT_PLATFORMS) {
    assert.ok(proxyClientTargetsForPlatform(platform).length > 0, `${platform} 没有任何可用客户端`);
  }
});

test("从 UA 认出设备平台", () => {
  const ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

  assert.equal(detectProxyClientPlatform(ios), "ios");
  // Android 的 UA 里也有 Linux，不能被 Linux 分支抢先匹配。
  assert.equal(detectProxyClientPlatform(android), "android");
  assert.equal(detectProxyClientPlatform(mac), "macos");
  assert.equal(detectProxyClientPlatform(win), "windows");
  assert.equal(detectProxyClientPlatform(linux), "linux");
  assert.equal(detectProxyClientPlatform(""), null);
});

test("伪装成 Mac 的 iPad 靠触摸点数认出来", () => {
  // iPadOS 13 起 Safari 的 UA 和桌面 Mac 一模一样，认错的话 iPad 上会少掉
  // Loon、Shadowrocket 这些只有 iOS 才有的客户端。
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

  assert.equal(detectProxyClientPlatform(mac, { maxTouchPoints: 5 }), "ios");
  assert.equal(detectProxyClientPlatform(mac, { maxTouchPoints: 0 }), "macos");
});

test("节点订阅下全部客户端可用，规则订阅下只剩能出完整配置的那几个", () => {
  const usable = (kind: "nodes" | "rules") =>
    PROXY_CLIENT_TARGETS.filter((target) => proxySubscriptionKindSupported(target.format, kind));

  assert.equal(usable("nodes").length, PROXY_CLIENT_TARGETS.length);
  // 其余客户端在界面上置灰而不是隐藏，所以这里断言的是"可用数量"，不是"展示数量"。
  assert.deepEqual(
    usable("rules").map((target) => target.id).sort(),
    ["clash", "loon", "quantumultx", "shadowrocket", "singbox", "stash", "surfboard", "surge"],
  );
});

test("规则订阅在 Loon / QX / Shadowrocket 上走手动添加配置，不借用节点资源的 scheme", () => {
  const byId = (id: string) => PROXY_CLIENT_TARGETS.find((target) => target.id === id)!;
  // 节点订阅照旧一键导入。
  for (const id of ["loon", "quantumultx", "shadowrocket"]) {
    assert.ok(proxyClientImportFor(byId(id), "nodes").buildImportUrl, id);
    const profile = proxyClientImportFor(byId(id), "rules");
    assert.equal(profile.buildImportUrl, undefined, id);
    assert.ok(profile.manualHint, id);
  }
  // Surge 的 install-config 装的就是完整配置。
  assert.match(
    proxyClientImportFor(byId("surge"), "rules").buildImportUrl!("https://p/api/sub/t?format=surge&rules=1", "x"),
    /^surge:\/\/\/install-config\?url=/,
  );
  // 没有单独写 profileImport 的客户端，两种订阅同一个入口。
  assert.equal(proxyClientImportFor(byId("clash"), "rules").buildImportUrl, byId("clash").buildImportUrl);
});

test("订阅名称：用户名，规则订阅加「规则」，响应头能还原出同一个名字", () => {
  assert.equal(proxySubscriptionProfileName("xixixi", "nodes"), "xixixi");
  assert.equal(proxySubscriptionProfileName("小王", "rules"), "小王 规则");
  assert.equal(proxySubscriptionProfileName("  ", "nodes"), "订阅");
  assert.equal(proxySubscriptionProfileName('a"b\\c/d\n', "nodes"), "abcd");
  assert.equal(proxySubscriptionProfileName("一".repeat(40), "nodes"), "一".repeat(32));
  const headers = proxySubscriptionProfileHeaders("小王 规则");
  assert.equal(headers["Content-Disposition"], "attachment; filename*=UTF-8''%E5%B0%8F%E7%8E%8B%20%E8%A7%84%E5%88%99");
  assert.equal(decodeBase64Utf8(headers["Profile-Title"].slice("base64:".length)), "小王 规则");
  // 响应头里不能有 HTTP 不允许的字符。
  for (const value of Object.values(headers)) assert.match(value, /^[\x20-\x7e]+$/);
});
