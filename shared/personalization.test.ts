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

test("色卡第一枚画的是渐变：面板默认用令牌的两端，其余预设从主色推", () => {
  assert.equal(personalizationSwatchGradient("ink"), "linear-gradient(135deg, #8ccfff 0%, #56aaf2 100%)");
  const lavender = personalizationSwatchGradient("lavender");
  assert.match(lavender, /^linear-gradient\(135deg, color-mix\(in oklab, #6e56cf 65%, white\) 0%, #6e56cf 100%\)$/);
  for (const preset of PERSONALIZATION_THEME_PRESETS) {
    assert.match(personalizationSwatchGradient(preset.id), /^linear-gradient\(135deg, /, preset.id);
  }
});

test("浅色是「主色兑白 → 主色」，深色是「主色 → 主色兑黑」", () => {
  assert.deepEqual(primaryGradientStops("#6e56cf", "light"), ["color-mix(in oklab, #6e56cf 65%, white)", "#6e56cf"]);
  assert.deepEqual(primaryGradientStops("#6e56cf", "dark"), ["#6e56cf", "color-mix(in oklab, #6e56cf 75%, black)"]);
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

test("界面主题：经典 / 极光二选一，默认经典", async () => {
  const { normalizePersonalizationUiTheme, PERSONALIZATION_UI_THEMES } = await import("./personalization");
  assert.deepEqual(PERSONALIZATION_UI_THEMES.map((theme) => theme.id), ["classic", "aurora"]);
  assert.equal(normalizePersonalizationUiTheme("aurora"), "aurora");
  assert.equal(normalizePersonalizationUiTheme("classic"), "classic");
  assert.equal(normalizePersonalizationUiTheme("neon"), "classic");
  assert.equal(normalizePersonalizationUiTheme(undefined), "classic");
});
