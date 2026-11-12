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
  const classes = new Set<string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => { props.set(name, value); },
      removeProperty: (name: string) => { props.delete(name); },
    },
    classList: {
      contains: (name: string) => (dark && name === "dark") || classes.has(name),
      add: (name: string) => { classes.add(name); },
      remove: (name: string) => { classes.delete(name); },
    },
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); },
  };
  return { root: root as unknown as HTMLElement, props, attrs, classes };
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

test("选了薰衣草：按钮的底色（两端同色）、字色、描边都换成薰衣草", () => {
  const { root, props, attrs } = fakeRoot();
  applyPersonalizationTheme("lavender", root);
  for (const name of PRIMARY_CONTROL_VARS) assert.ok(props.has(name), name);
  assert.equal(
    props.get("--fx-primary-gradient"),
    "linear-gradient(135deg, #6e56cf 0%, #6e56cf 100%)",
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
    "linear-gradient(135deg, oklch(0.72 0.14 180) 0%, oklch(0.72 0.14 180) 100%)",
  );
  assert.equal(props.get("--fx-primary-text"), "oklch(0.12 0.02 190)");
});

test("墨色：渐变从主色（正文色）推，按钮反黑", () => {
  const { root, props } = fakeRoot();
  applyPersonalizationTheme("mono", root);
  assert.equal(props.get("--fx-primary-fill"), "var(--fx-text)");
  assert.equal(props.get("--fx-primary-text"), "var(--fx-text-inverse)");
});

test("换回面板默认：主色控件的变量全部撤掉，令牌文件里的实色深蓝生效", () => {
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

/** 这个面板上「装着」的主题包（名单平时来自 publicInfo）。revision 只要是 sha256 那种写法就行。 */
const pkg = (id: string, revision = "a".repeat(64)) => ({ id, name: id, description: "", version: "1.0.0", revision, preview: {} });

test("界面主题：内置的直接认，主题包要装着才认；挂 data-ui-theme 并记进 localStorage，经典去掉属性和记录", async () => {
  const { applyPersonalizationSurface, clearPersonalizationSurface } = await import("./personalizationTheme");
  const { setInstalledUiThemes } = await import("./installedUiThemes");
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    const { root, attrs } = fakeRoot(false);
    setInstalledUiThemes([]);
    assert.equal(applyPersonalizationSurface({ uiTheme: "pearl" }, root).uiTheme, "pearl");
    assert.equal(attrs.get("data-ui-theme"), "pearl");
    assert.equal(store.get("forwardx-ui-theme"), "pearl");
    // 不认识的值回到经典：属性去掉、本地记录也去掉（下次开机不会先挂上旧主题）
    assert.equal(applyPersonalizationSurface({ uiTheme: "neon" }, root).uiTheme, "classic");
    assert.equal(attrs.has("data-ui-theme"), false);
    assert.equal(store.has("forwardx-ui-theme"), false);
    // 墨金现在是主题包：没装时和不认识的值一样回经典
    assert.equal(applyPersonalizationSurface({ uiTheme: "gilt" }, root).uiTheme, "classic");
    assert.equal(attrs.has("data-ui-theme"), false);
    // 装上以后就认；名单也记进 localStorage，下次开机在 publicInfo 回来之前就能用
    assert.equal(setInstalledUiThemes([pkg("gilt"), pkg("my-theme")]), true);
    assert.equal(setInstalledUiThemes([pkg("gilt"), pkg("my-theme")]), false, "名单没变不算变");
    assert.deepEqual(JSON.parse(store.get("forwardx-ui-themes") || "[]").map((theme: any) => theme.id), ["gilt", "my-theme"]);
    assert.equal(applyPersonalizationSurface({ uiTheme: "gilt" }, root).uiTheme, "gilt");
    assert.equal(attrs.get("data-ui-theme"), "gilt");
    assert.equal(store.get("forwardx-ui-theme"), "gilt");
    assert.equal(applyPersonalizationSurface({ uiTheme: "my-theme" }, root).uiTheme, "my-theme");
    // 卸载之后：同一个值回到经典
    setInstalledUiThemes([pkg("gilt")]);
    assert.equal(applyPersonalizationSurface({ uiTheme: "my-theme" }, root).uiTheme, "classic");
    assert.equal(attrs.has("data-ui-theme"), false);
    applyPersonalizationSurface({ uiTheme: "pearl" }, root);
    clearPersonalizationSurface(root);
    assert.equal(attrs.has("data-ui-theme"), false);
    // 名单里混进来的坏数据（id 不合规矩、和内置重名、revision 不是摘要）一条都不收
    setInstalledUiThemes([pkg("classic"), pkg("Bad Id"), pkg("ok-theme", "not-a-digest"), { id: "x" }, null]);
    assert.equal(applyPersonalizationSurface({ uiTheme: "ok-theme" }, root).uiTheme, "classic");
  } finally {
    setInstalledUiThemes([]);
    delete (globalThis as any).localStorage;
  }
});

test("界面主题：顶栏给自己选的那套盖过站点默认，设置页试看时绕过它；换主题那一下淡过去；选的主题包被卸了就跟回站点默认", async () => {
  const { applyPersonalizationSurface, setUiThemeOverride, readUiThemeOverride } = await import("./personalizationTheme");
  const { setInstalledUiThemes } = await import("./installedUiThemes");
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    const { root, attrs, classes } = fakeRoot(false);
    setInstalledUiThemes([pkg("rose"), pkg("gilt")]);
    assert.equal(applyPersonalizationSurface({ uiTheme: "rose" }, root).uiTheme, "rose");
    assert.equal(attrs.get("data-ui-theme"), "rose");
    assert.equal(classes.has("fx-theme-fading"), false, "第一次挂上不淡");

    setUiThemeOverride("gilt");
    assert.equal(readUiThemeOverride(), "gilt");
    assert.equal(applyPersonalizationSurface({ uiTheme: "rose" }, root).uiTheme, "gilt", "自己选的盖过站点默认");
    assert.equal(store.get("forwardx-ui-theme"), "gilt", "开机预载记的是实际生效的那套");
    assert.equal(classes.has("fx-theme-fading"), true, "换了主题：淡过去");
    assert.equal(applyPersonalizationSurface({ uiTheme: "rose", ignoreOverride: true }, root).uiTheme, "rose", "设置页试看看的是站点默认");

    // 管理员把墨金卸了：这台设备选的那套不作数了，跟回站点默认；装回来又生效（记录没删）
    setInstalledUiThemes([pkg("rose")]);
    assert.equal(readUiThemeOverride(), null);
    assert.equal(applyPersonalizationSurface({ uiTheme: "rose" }, root).uiTheme, "rose");
    setInstalledUiThemes([pkg("rose"), pkg("gilt")]);
    assert.equal(readUiThemeOverride(), "gilt");

    setUiThemeOverride(null);
    assert.equal(readUiThemeOverride(), null);
    store.set("forwardx-ui-theme-override", "neon");
    assert.equal(readUiThemeOverride(), null, "不认识的值当没选");
  } finally {
    setInstalledUiThemes([]);
    delete (globalThis as any).localStorage;
  }
});

test("界面主题按需加载：页面上的 <html> 等那一套样式有了结果才换属性；等的时候被清掉又挂上，先顶着原来那套", async () => {
  const { applyPersonalizationSurface, clearPersonalizationSurface } = await import("./personalizationTheme");
  const { isUiThemeStyleReady, isUiThemeStyleUsable, loadUiThemeStyles, uiThemePackageHref } = await import("./uiThemeStyles");
  const { setInstalledUiThemes } = await import("./installedUiThemes");
  const g = globalThis as { document?: unknown };
  const { root, attrs, classes } = fakeRoot(false);
  const warn = console.warn;
  /*
    一个够用的假 <head>：主题包的样式是往里挂 <link>，挂上去之后下一个微任务「下完」。
    地址里带 broken 的那条报错（主题被卸载后样式地址 404 就是这样）。
    内置的珍珠 / 液态玻璃在 node 里 import 不了 .css：下载会「失败」，正好走一遍失败也照样往下走的那条路；
    主题包后面那条 compact.css 也 import 不了，同样照常往下走。
  */
  const links: any[] = [];
  const makeLink = () => {
    const handlers: Record<string, () => void> = {};
    const link: any = {
      rel: "", href: "", disabled: false, attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) { link.attributes[name] = value; },
      addEventListener(type: string, handler: () => void) { handlers[type] = handler; },
      remove() { const index = links.indexOf(link); if (index >= 0) links.splice(index, 1); },
      fire(type: string) { handlers[type]?.(); },
    };
    return link;
  };
  g.document = {
    documentElement: root,
    createElement: () => makeLink(),
    head: {
      appendChild(link: any) {
        links.push(link);
        queueMicrotask(() => link.fire(String(link.href).includes("broken") ? "error" : "load"));
      },
    },
  };
  console.warn = () => {};
  setInstalledUiThemes([pkg("rose"), pkg("gilt"), pkg("indigo"), pkg("broken-theme")]);
  const settle = async (id: string) => {
    await loadUiThemeStyles(id);
    await Promise.resolve();
  };
  try {
    assert.equal(isUiThemeStyleReady("classic"), true, "经典没有主题文件");
    assert.equal(isUiThemeStyleReady("neon"), true, "不认识的值会被当成经典，不用等");
    assert.equal(isUiThemeStyleReady("rose"), false);
    assert.equal(isUiThemeStyleReady("pearl"), false);

    applyPersonalizationSurface({ uiTheme: "rose" }, root);
    assert.equal(attrs.has("data-ui-theme"), false, "样式没到，属性先不动");
    await settle("rose");
    assert.equal(attrs.get("data-ui-theme"), "rose", "样式有了结果才挂上");
    assert.equal(isUiThemeStyleReady("rose"), true);
    assert.deepEqual(links.map((link) => link.href), [uiThemePackageHref("rose", "a".repeat(64))], "主题包的样式从面板取，地址带着 revision");
    assert.equal(links[0].attributes["data-fx-ui-theme-package"], "rose");

    // 连着换两套：中间那套不管先到后到都作废，只挂最后要的那套（两边谁先下完不一定，所以记下每一次挂了什么）
    const shown: string[] = [];
    const setAttribute = root.setAttribute.bind(root);
    root.setAttribute = (name: string, value: string) => {
      if (name === "data-ui-theme") shown.push(value);
      setAttribute(name, value);
    };
    applyPersonalizationSurface({ uiTheme: "gilt" }, root);
    applyPersonalizationSurface({ uiTheme: "pearl" }, root);
    assert.equal(attrs.get("data-ui-theme"), "rose", "两套都没到，屏幕上还是玫瑰");
    await Promise.all([settle("gilt"), settle("pearl")]);
    await Promise.resolve();
    assert.equal(attrs.get("data-ui-theme"), "pearl");
    assert.deepEqual(shown, ["pearl"], "墨金一次都没挂上");
    root.setAttribute = setAttribute;
    assert.equal(classes.has("fx-theme-fading"), true, "切换照旧淡过去");
    // 主题包的 <link> 只让当前这一套开着：现在是珍珠（内置），两条主题包的都关着
    assert.deepEqual(links.map((link) => [link.attributes["data-fx-ui-theme-package"], link.disabled]), [["rose", true], ["gilt", true]]);

    // PersonalizationLayer 依赖一变：先清掉、同一轮里接着挂一套还没下的 —— 中间不能空着（不然先闪一下经典）
    clearPersonalizationSurface(root);
    applyPersonalizationSurface({ uiTheme: "indigo" }, root);
    assert.equal(attrs.get("data-ui-theme"), "pearl", "刚撤掉的那套先放回去顶着");
    await settle("indigo");
    assert.equal(attrs.get("data-ui-theme"), "indigo");
    assert.deepEqual(links.filter((link) => !link.disabled).map((link) => link.attributes["data-fx-ui-theme-package"]), ["indigo"]);

    // 主题包的样式取不下来（刚被卸载、面板连不上）：不挂它的 id，退回经典，那条 <link> 也摘掉
    applyPersonalizationSurface({ uiTheme: "broken-theme" }, root);
    await settle("broken-theme");
    assert.equal(isUiThemeStyleUsable("broken-theme"), false);
    assert.equal(attrs.has("data-ui-theme"), false, "没有样式的主题不挂，按经典画");
    assert.equal(links.some((link) => link.attributes["data-fx-ui-theme-package"] === "broken-theme"), false);
    // 主题更新了（revision 变了）：换成新地址，旧的那条摘掉
    setInstalledUiThemes([pkg("rose", "b".repeat(64)), pkg("gilt"), pkg("indigo")]);
    assert.equal(isUiThemeStyleReady("rose"), false, "地址变了要重新取");
    applyPersonalizationSurface({ uiTheme: "rose" }, root);
    await settle("rose");
    assert.equal(attrs.get("data-ui-theme"), "rose");
    assert.deepEqual(links.filter((link) => link.attributes["data-fx-ui-theme-package"] === "rose").map((link) => link.href), [uiThemePackageHref("rose", "b".repeat(64))]);
    // 卸载了的主题包：下一次换主题时它的 <link> 被摘掉
    setInstalledUiThemes([pkg("rose", "b".repeat(64))]);
    applyPersonalizationSurface({ uiTheme: "pearl" }, root);
    assert.deepEqual(links.map((link) => link.attributes["data-fx-ui-theme-package"]), ["rose"]);

    // 真卸载：清掉之后没人接着挂，过一个微任务就忘掉，之后不会把旧的放回来
    clearPersonalizationSurface(root);
    await Promise.resolve();
    applyPersonalizationSurface({ uiTheme: "liquid-glass" }, root);
    assert.equal(attrs.has("data-ui-theme"), false);
    await settle("liquid-glass");
    assert.equal(attrs.get("data-ui-theme"), "liquid-glass");

    // 等的时候切回一套现成的：现成的立刻挂上，等的那套回来也不再改
    setInstalledUiThemes([pkg("rose", "b".repeat(64)), pkg("cinnabar")]);
    applyPersonalizationSurface({ uiTheme: "cinnabar" }, root);
    applyPersonalizationSurface({ uiTheme: "rose" }, root);
    assert.equal(attrs.get("data-ui-theme"), "rose");
    await settle("cinnabar");
    assert.equal(attrs.get("data-ui-theme"), "rose");
  } finally {
    console.warn = warn;
    setInstalledUiThemes([]);
    delete g.document;
  }
});

test("主题安全模式：?themeSafe=1 之后这个标签页只认内置的三套，?themeSafe=0 退出", async () => {
  const { resolveUiTheme, isUiThemeSafeMode } = await import("./personalizationTheme");
  const { setInstalledUiThemes } = await import("./installedUiThemes");
  const session = new Map<string, string>();
  const g = globalThis as any;
  g.sessionStorage = {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => { session.set(key, value); },
    removeItem: (key: string) => { session.delete(key); },
  };
  g.window = { location: { search: "" } };
  try {
    setInstalledUiThemes([pkg("gilt")]);
    assert.equal(isUiThemeSafeMode(), false);
    assert.equal(resolveUiTheme("gilt"), "gilt");
    g.window.location.search = "?themeSafe=1";
    assert.equal(resolveUiTheme("gilt"), "classic", "安全模式不挂主题包");
    assert.equal(resolveUiTheme("liquid-glass"), "liquid-glass", "内置的照常");
    g.window.location.search = "?tab=personalization";
    assert.equal(isUiThemeSafeMode(), true, "换了页面还在安全模式里（记在这个标签页）");
    g.window.location.search = "?themeSafe=0";
    assert.equal(isUiThemeSafeMode(), false);
    assert.equal(resolveUiTheme("gilt"), "gilt");
  } finally {
    setInstalledUiThemes([]);
    delete g.window;
    delete g.sessionStorage;
  }
});
