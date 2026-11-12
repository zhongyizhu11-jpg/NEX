import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PANEL_DEFAULT_PRIMARY_GRADIENT,
  PERSONALIZATION_THEME_PRESETS,
  personalizationSwatchGradient,
  primaryGradientStops,
} from "./personalization";

/**
 * 「面板默认」的色块抄的是令牌里那道渐变。令牌改了、这里没跟，设置页上的色块就又会
 * 和真实的按钮对不上 —— 用户拿着截图来问「这个有生效吗」，就是因为色块画的是实心蓝、
 * 按钮却是渐变。
 */
test("面板默认的渐变两端和 design-tokens.css 一致（浅色、深色各一组）", () => {
  const css = fs.readFileSync(new URL("./design-tokens.css", import.meta.url), "utf8");
  const found = [...css.matchAll(/--fx-primary-gradient:\s*linear-gradient\(135deg,\s*(#[0-9a-f]{6}) 0%,\s*(#[0-9a-f]{6}) 100%\)/gi)]
    .map((match) => [match[1].toLowerCase(), match[2].toLowerCase()]);
  assert.deepEqual(found, [
    [...PANEL_DEFAULT_PRIMARY_GRADIENT.light],
    [...PANEL_DEFAULT_PRIMARY_GRADIENT.dark],
  ]);
});

test("色卡第一枚：面板默认用令牌的两端，其余预设用主色本身（两端同色）", () => {
  assert.equal(personalizationSwatchGradient("ink"), "linear-gradient(135deg, #155ec4 0%, #155ec4 100%)");
  assert.equal(personalizationSwatchGradient("lavender"), "linear-gradient(135deg, #6e56cf 0%, #6e56cf 100%)");
  for (const preset of PERSONALIZATION_THEME_PRESETS) {
    assert.match(personalizationSwatchGradient(preset.id), /^linear-gradient\(135deg, /, preset.id);
  }
});

test("主色控件不再兑白 / 兑黑：深浅色两端都是主色本身，字色对比不被冲淡", () => {
  assert.deepEqual(primaryGradientStops("#6e56cf", "light"), ["#6e56cf", "#6e56cf"]);
  assert.deepEqual(primaryGradientStops("#6e56cf", "dark"), ["#6e56cf", "#6e56cf"]);
});

test("页面底色：预设 id 或 #rrggbb，别的回到浅灰；浅灰不写变量，自定义色的控件槽从底色兑 5% 黑", async () => {
  const { normalizePersonalizationPageTint, personalizationPageTintVars } = await import("./personalization");
  assert.equal(normalizePersonalizationPageTint("mist"), "mist");
  assert.equal(normalizePersonalizationPageTint("#EEF3FB"), "#eef3fb");
  assert.equal(normalizePersonalizationPageTint("#fff"), "grey");
  assert.equal(normalizePersonalizationPageTint("nope"), "grey");
  assert.equal(normalizePersonalizationPageTint(undefined), "grey");
  assert.equal(personalizationPageTintVars("grey"), null);
  assert.deepEqual(personalizationPageTintVars("mist"), { page: "#edf3fb", control: "#d9e5f2" });
  assert.deepEqual(personalizationPageTintVars("#eef3fb"), { page: "#eef3fb", control: "color-mix(in srgb, #eef3fb 95%, black)" });
  assert.match(personalizationPageTintVars("accent")!.page, /var\(--fx-primary-fill\)/);
});

test("卡片风格：四选一，默认彩色描边", async () => {
  const { normalizePersonalizationCardStyle, PERSONALIZATION_CARD_STYLES } = await import("./personalization");
  assert.deepEqual(PERSONALIZATION_CARD_STYLES.map((style) => style.id), ["edge", "glow", "bar", "plain"]);
  assert.equal(normalizePersonalizationCardStyle("glow"), "glow");
  assert.equal(normalizePersonalizationCardStyle("zebra"), "edge");
  assert.equal(normalizePersonalizationCardStyle(""), "edge");
});

test("界面主题：内置经典 / 珍珠 / 液态玻璃三套，其余要装了主题包才认，默认经典", async () => {
  const { normalizePersonalizationUiTheme, PERSONALIZATION_UI_THEMES } = await import("./personalization");
  const { BUILTIN_UI_THEME_IDS } = await import("./uiThemePackage");
  assert.deepEqual(PERSONALIZATION_UI_THEMES.map((theme) => theme.id), ["classic", "pearl", "liquid-glass"]);
  assert.deepEqual(PERSONALIZATION_UI_THEMES.map((theme) => theme.id), [...BUILTIN_UI_THEME_IDS], "两处的内置名单要一致");
  assert.equal(normalizePersonalizationUiTheme("pearl"), "pearl");
  assert.equal(normalizePersonalizationUiTheme("liquid-glass"), "liquid-glass");
  assert.equal(normalizePersonalizationUiTheme("classic"), "classic");
  // 原来内置、现在是官方主题库里的主题包：没装就回经典，装了才认
  assert.equal(normalizePersonalizationUiTheme("gilt"), "classic");
  assert.equal(normalizePersonalizationUiTheme("deepspace"), "classic");
  assert.equal(normalizePersonalizationUiTheme("gilt", ["gilt", "my-theme"]), "gilt");
  assert.equal(normalizePersonalizationUiTheme("my-theme", new Set(["gilt", "my-theme"])), "my-theme");
  assert.equal(normalizePersonalizationUiTheme("rose", ["gilt"]), "classic");
  assert.equal(normalizePersonalizationUiTheme("aurora"), "classic"); // 极光已下线：存着旧值的回落到经典
  assert.equal(normalizePersonalizationUiTheme("neon"), "classic");
  assert.equal(normalizePersonalizationUiTheme(undefined), "classic");
});

test("液态玻璃参数：越界的数字夹回范围，坏值回到出厂", async () => {
  const { normalizeLiquidGlassConfig, DEFAULT_LIQUID_GLASS } = await import("./personalization");
  assert.deepEqual(normalizeLiquidGlassConfig(undefined), DEFAULT_LIQUID_GLASS);
  assert.deepEqual(normalizeLiquidGlassConfig("not json"), DEFAULT_LIQUID_GLASS);
  assert.deepEqual(
    normalizeLiquidGlassConfig({ photoSource: "builtin", wash: 95, darkOpacity: "55", blur: -3, sheen: false, layout: "full" }),
    { photoSource: "builtin", wash: 80, darkOpacity: 55, blur: 0, sheen: false, layout: "full" },
  );
  assert.deepEqual(normalizeLiquidGlassConfig(JSON.stringify({ photoSource: "moon", blur: 12.4, layout: "grid" })), { ...DEFAULT_LIQUID_GLASS, blur: 12 });
  // 2.3.433 存下来的配置没有 layout：读出来是 auto
  assert.equal(normalizeLiquidGlassConfig({ photoSource: "wallpaper" }).layout, "auto");
});
