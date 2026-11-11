import assert from "node:assert/strict";
import test from "node:test";
import { getFormatLocale, getLanguage, installDictionary, setLanguagePreference, t, translateServerText, translateText } from "./index";
import { PATTERNS } from "./patterns";
import { createTranslator, hasCjk, interpolate, keepOuterWhitespace, normalizeSource } from "./translate";

const DICTIONARY = {
  "转发规则": "Forwarding Rules",
  "保存": "Save",
  "在线": "Online",
  "状态": "Status",
  "已选 {n} 条": "{n} selected",
  "共 {0} 条": "{0} total",
  "主机「{0}」已离线": "Host \"{0}\" is offline",
  "删除 {0} 条规则？": "Delete {0} rules?",
  "用户不存在": "User not found",
};

test("基础工具：汉字判断、空白归一、首尾空白保留、插值", () => {
  assert.equal(hasCjk("保存"), true);
  assert.equal(hasCjk("Save："), false);
  assert.equal(hasCjk("："), false);
  assert.equal(normalizeSource("  共\n   12  条 "), "共 12 条");
  assert.equal(keepOuterWhitespace("  保存 ", "Save"), "  Save ");
  assert.equal(keepOuterWhitespace("   ", "x"), "   x");
  assert.equal(interpolate("已选 {n} 条", { n: 3 }), "已选 3 条");
  assert.equal(interpolate("{0}/{1}", ["a", 2]), "a/2");
  // 值里自带的占位不会被再展开一次
  assert.equal(interpolate("{0}{1}", ["{1}", "x"]), "{1}x");
  assert.equal(interpolate("{missing}", { other: 1 }), "{missing}");
});

test("精确匹配、模板、正则依次尝试；整段对不上就返回 null（不做子串替换）", () => {
  const translator = createTranslator(DICTIONARY, PATTERNS);
  assert.equal(translator.translate("转发规则"), "Forwarding Rules");
  assert.equal(translator.translate("  转发规则 "), "  Forwarding Rules ");
  assert.equal(translator.translate("已选 12 条"), "12 selected");
  assert.equal(translator.translate("主机「香港 01」已离线"), "Host \"香港 01\" is offline");
  // 模板抓到的那段本身是词典里的中文：一起换
  assert.equal(translator.translate("状态：在线"), "Status: Online");
  assert.equal(translator.translate("3 分钟前"), "3 minutes ago");
  assert.equal(translator.translate("1 天前"), "1 day ago");
  assert.equal(translator.translate("2天3小时"), "2d3h");
  assert.equal(translator.translate("每 60 秒"), "every 60 seconds");
  assert.equal(translator.translate("每1小时"), "every 1 hour");
  assert.equal(translator.translate("转发规则 · 每 30 秒"), "Forwarding Rules · every 30 seconds");
  assert.equal(translator.translate("转发规则很多"), null);
  assert.equal(translator.translate("Save"), null);
  assert.equal(translator.translate("__proto__"), null);
  assert.equal(translator.translate("constructor"), null);
  assert.equal(translator.exact("已选 12 条"), null, "exact 不套模板");
  assert.equal(translator.exact("用户不存在"), "User not found");
});

test("拼接文字：分隔符逐段翻、顿号列表全翻才换、括号、国旗、多行、首尾标点", () => {
  const translator = createTranslator({
    ...DICTIONARY,
    "搜索{0}": "Search {0}",
    "离线{0}": "Offline{0}",
    "查看 {0} 详情": "View {0} details",
    "停用隧道 {0}": "Disable tunnel {0}",
    "{0} 台主机": "{0} hosts",
    "{0} 条隧道": "{0} tunnels",
    "浅色白雾": "Light haze",
    "推荐": "recommended",
    "香港": "Hong Kong",
    "运营商": "ISP",
    "额度已用尽": "Quota used up",
    "延迟 {0} ms": "Latency {0} ms",
    "额度 {0} GB{1}": "Quota {0} GB{1}",
  }, PATTERNS);
  // 开口模板吞了半个词（汉字贴汉字）就不用：宁可整段留中文
  assert.equal(translator.translate("搜索主机 / IP"), null);
  assert.equal(translator.translate("离线前 ↓ 8 MB/s"), null);
  // 夹在字面中间、或隔着空格的占位是填空：名字原样
  assert.equal(translator.translate("查看 东京落地 详情"), "View 东京落地 details");
  assert.equal(translator.translate("停用隧道 华南-香港"), "Disable tunnel 华南-香港");
  assert.equal(translator.translate("我的规则 · 转发规则 · GOST TLS"), "我的规则 · Forwarding Rules · GOST TLS");
  assert.equal(translator.translate("转发规则 · 我的规则"), null, "后面的段没翻完就整段不动");
  assert.equal(translator.translate("HK 01 → JP 02；延迟 46 ms"), "HK 01 → JP 02; Latency 46 ms");
  assert.equal(translator.translate("3 台主机、1 条隧道"), "3 hosts, 1 tunnels");
  assert.equal(translator.translate("东京落地、SG 落地"), null, "列表里有翻不了的就整段不动");
  assert.equal(translator.translate("浅色白雾（%）"), "Light haze (%)");
  assert.equal(translator.translate("保存（推荐）"), "Save (recommended)");
  assert.equal(translator.translate("🇭🇰 香港"), "🇭🇰 Hong Kong");
  assert.equal(translator.translate("Hong Kong / Central\n运营商：HGC\n东京落地"), "Hong Kong / Central\nISP: HGC\n东京落地");
  // 抓到的段首尾带中文标点：去掉标点翻，标点换成英文的
  assert.equal(translator.translate("额度 20 GB。额度已用尽"), "Quota 20 GB. Quota used up");
  // 「标签：值」里值是一整句没翻的说明：不只翻出个标签
  assert.equal(translator.translate("状态：用到套餐的百分之百以后暂停"), null);
});

test("主机账本：「预计 …」几段可有可无的尾巴、样本数提示没有原因时", () => {
  const translator = createTranslator(DICTIONARY, PATTERNS);
  assert.equal(translator.translate("预计 120 GB"), "Projected 120 GB");
  assert.equal(translator.translate("预计 120 GB（粗估）"), "Projected 120 GB (rough)");
  assert.equal(translator.translate("预计 1.2 TB 会超"), "Projected 1.2 TB will exceed");
  assert.equal(translator.translate("预计 1.2 TB 会超，约 2026-11-20 用完（粗估）"), "Projected 1.2 TB will exceed, runs out around 2026-11-20 (rough)");
  assert.equal(translator.translate("预计 3 天"), null, "数值里还有中文就不是这一格");
  assert.equal(translator.translate("本周期 288 个 5 分钟样本（应有 288 个）"), "288 5-minute samples this cycle (expected 288)");
});

test("t() 与运行时语言：中文原样插值，英文先找整句键再插值", async () => {
  installDictionary(DICTIONARY);
  assert.equal(getLanguage(), "zh-CN");
  assert.equal(t("已选 {n} 条", { n: 2 }), "已选 2 条");
  assert.equal(translateText("保存"), "保存");
  await setLanguagePreference("en");
  try {
    assert.equal(getLanguage(), "en");
    assert.equal(getFormatLocale(), "en-US");
    assert.equal(t("已选 {n} 条", { n: 2 }), "2 selected");
    assert.equal(t("删除 {0} 条规则？", [5]), "Delete 5 rules?");
    assert.equal(t("保存"), "Save");
    // 没有整句键但插值后能套上模板
    assert.equal(t("共 {total} 条", { total: 9 }), "9 total");
    assert.equal(t("没有翻译的句子 {0}", ["x"]), "没有翻译的句子 x");
    assert.equal(translateText("已选 7 条"), "7 selected");
    // 服务端原话只认整句
    assert.equal(translateServerText("用户不存在"), "User not found");
    assert.equal(translateServerText("已选 7 条"), "已选 7 条");
    assert.equal(translateServerText("Agent stderr: 用户不存在"), "Agent stderr: 用户不存在");
  } finally {
    await setLanguagePreference("zh-CN");
  }
  assert.equal(getLanguage(), "zh-CN");
  assert.equal(t("保存"), "保存");
  assert.equal(getFormatLocale(), "zh-CN");
});
