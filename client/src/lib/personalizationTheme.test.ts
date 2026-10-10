import assert from "node:assert/strict";
import test from "node:test";
import { applyPersonalizationTheme, clearPersonalizationTheme } from "./personalizationTheme";

/**
 * 2.3.375 把主按钮、选中的分段项 / chip / 侧栏项、开关都换成了 --fx-primary-gradient，
 * 配色预设却只改强调色 —— 选了薰衣草，链接和图标变紫，按钮还是天蓝。这里守着：
 * 换预设时主色控件那组令牌跟着换，回到「面板默认」时全部撤掉、让令牌文件生效。
 */
function fakeRoot(dark = false) {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => { props.set(name, value); },
      removeProperty: (name: string) => { props.delete(name); },
    },
    classList: { contains: (name: string) => dark && name === "dark" },
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); },
  };
  return { root: root as unknown as HTMLElement, props, attrs };
}

const PRIMARY_CONTROL_VARS = [
  "--fx-primary-gradient",
  "--fx-primary-gradient-hover",
  "--fx-primary-fill",
  "--fx-primary-fill-hover",
  "--fx-primary-text",
  "--fx-primary-stroke",
  "--fx-primary-shadow",
];

test("选了薰衣草：按钮的渐变、字色、描边都换成薰衣草", () => {
  const { root, props, attrs } = fakeRoot();
  applyPersonalizationTheme("lavender", root);
  for (const name of PRIMARY_CONTROL_VARS) assert.ok(props.has(name), name);
  assert.equal(
    props.get("--fx-primary-gradient"),
    "linear-gradient(135deg, color-mix(in oklab, #6e56cf 65%, white) 0%, #6e56cf 100%)",
  );
  assert.equal(props.get("--fx-primary-fill"), "#6e56cf");
  assert.equal(props.get("--fx-primary-text"), "#ffffff");
  assert.match(props.get("--fx-primary-stroke") || "", /#6e56cf/);
  assert.equal(attrs.get("data-personalization-theme"), "lavender");
});

test("深色下用预设的深色主色和字色（松石深色是浅青底、深字）", () => {
  const { root, props } = fakeRoot(true);
  applyPersonalizationTheme("teal", root);
  assert.equal(
    props.get("--fx-primary-gradient"),
    "linear-gradient(135deg, oklch(0.72 0.14 180) 0%, color-mix(in oklab, oklch(0.72 0.14 180) 75%, black) 100%)",
  );
  assert.equal(props.get("--fx-primary-text"), "oklch(0.12 0.02 190)");
});

test("墨色：渐变从主色（正文色）推，按钮反黑", () => {
  const { root, props } = fakeRoot();
  applyPersonalizationTheme("mono", root);
  assert.equal(props.get("--fx-primary-fill"), "var(--fx-text)");
  assert.equal(props.get("--fx-primary-text"), "var(--fx-text-inverse)");
});

test("换回面板默认：主色控件的变量全部撤掉，令牌文件里的天蓝渐变生效", () => {
  const { root, props } = fakeRoot();
  applyPersonalizationTheme("sakura", root);
  assert.ok(props.size > 0);
  applyPersonalizationTheme("ink", root);
  for (const name of [...PRIMARY_CONTROL_VARS, "--fx-mesh-1", "--fx-accent", "--primary"]) {
    assert.equal(props.has(name), false, name);
  }
});

test("clearPersonalizationTheme 也撤掉主色控件的变量", () => {
  const { root, props, attrs } = fakeRoot();
  applyPersonalizationTheme("forest", root);
  clearPersonalizationTheme(root);
  assert.equal(props.size, 0);
  assert.equal(attrs.has("data-personalization-theme"), false);
});

test("页面底色只在浅色下写到 <html>，深色撤掉；卡片风格是一个属性", async () => {
  const { applyPersonalizationSurface, clearPersonalizationSurface } = await import("./personalizationTheme");
  const light = fakeRoot(false);
  applyPersonalizationSurface({ pageTint: "mist", cardStyle: "glow" }, light.root);
  assert.equal(light.props.get("--fx-l0-page"), "#edf3fb");
  assert.equal(light.props.get("--fx-l3-control-fill"), "#d9e5f2");
  assert.equal(light.attrs.get("data-page-tint"), "mist");
  assert.equal(light.attrs.get("data-card-style"), "glow");
  // 换回浅灰：变量撤掉、属性去掉
  applyPersonalizationSurface({ pageTint: "grey", cardStyle: "nope" }, light.root);
  assert.equal(light.props.has("--fx-l0-page"), false);
  assert.equal(light.attrs.has("data-page-tint"), false);
  assert.equal(light.attrs.get("data-card-style"), "edge");

  const dark = fakeRoot(true);
  applyPersonalizationSurface({ pageTint: "#eef3fb", cardStyle: "bar" }, dark.root);
  assert.equal(dark.props.has("--fx-l0-page"), false, "深色不写底色");
  assert.equal(dark.attrs.get("data-card-style"), "bar");

  clearPersonalizationSurface(light.root);
  assert.equal(light.attrs.has("data-card-style"), false);
});

test("界面主题：极光挂 data-ui-theme 并记进 localStorage，经典去掉属性和记录", async () => {
  const { applyPersonalizationSurface, clearPersonalizationSurface } = await import("./personalizationTheme");
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    const { root, attrs } = fakeRoot(false);
    assert.equal(applyPersonalizationSurface({ uiTheme: "aurora" }, root).uiTheme, "aurora");
    assert.equal(attrs.get("data-ui-theme"), "aurora");
    assert.equal(store.get("forwardx-ui-theme"), "aurora");
    // 不认识的值回到经典：属性去掉、本地记录也去掉（下次开机不会先挂上极光）
    assert.equal(applyPersonalizationSurface({ uiTheme: "neon" }, root).uiTheme, "classic");
    assert.equal(attrs.has("data-ui-theme"), false);
    assert.equal(store.has("forwardx-ui-theme"), false);
    applyPersonalizationSurface({ uiTheme: "aurora" }, root);
    clearPersonalizationSurface(root);
    assert.equal(attrs.has("data-ui-theme"), false);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
