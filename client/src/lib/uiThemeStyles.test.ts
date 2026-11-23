import assert from "node:assert/strict";
import test from "node:test";

/*
  内置样式包一次没下到不能就此卡死（用户面板 2026-11-23：手机上液态玻璃的样式包没下到，这一页从此挂着
  data-ui-theme 却没有主题样式，照片层当成普通内容排在页面顶上，「玻璃主题怎么一点都不像玻璃了」）。
  Vite 的预加载对同一个文件只发一次请求，所以失败后按它报的地址自己挂 <link> 在后台再试。
*/
function fakeDom() {
  const links: any[] = [];
  const events: string[] = [];
  let failNext = true;
  const makeLink = () => {
    const handlers: Record<string, () => void> = {};
    const link: any = {
      rel: "", href: "", attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) { link.attributes[name] = value; },
      addEventListener(type: string, handler: () => void) { handlers[type] = handler; },
      remove() { const index = links.indexOf(link); if (index >= 0) links.splice(index, 1); },
      fire(type: string) { handlers[type]?.(); },
    };
    return link;
  };
  const g = globalThis as any;
  g.document = {
    documentElement: { getAttribute: () => null },
    createElement: () => makeLink(),
    querySelector: (selector: string) => {
      const match = /link\[href="([^"]+)"\]/.exec(selector);
      return links.find((link) => match && link.href === match[1]) || null;
    },
    head: {
      appendChild(link: any) {
        links.push(link);
        const fail = failNext;
        failNext = false;
        queueMicrotask(() => link.fire(fail ? "error" : "load"));
      },
    },
  };
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event: { type: string }) { events.push(event.type); return true; },
  };
  g.Event = class { type: string; constructor(type: string) { this.type = type; } };
  return { links, events, setFailNext: (value: boolean) => { failNext = value; } };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("内置样式包：第一次没下到 → 记成有结果、不算下到；摘掉 Vite 留下的坏 <link>，按退避自己挂 <link> 再试，下到了发事件", async () => {
  const dom = fakeDom();
  const { __uiThemeStylesForTest, isUiThemeStyleLoaded, isUiThemeStyleReady, loadUiThemeStyles, UI_THEME_STYLE_LOADED_EVENT } = await import("./uiThemeStyles");
  const hooks = __uiThemeStylesForTest();
  hooks.reset();
  hooks.setRetryDelays([1, 30]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    // Vite 的预加载：挂了一条 <link>，报错时留着它
    let calls = 0;
    hooks.setBundledLoader("liquid-glass", async () => {
      calls += 1;
      const link = document.createElement("link") as any;
      link.rel = "stylesheet";
      link.href = "/assets/ui-theme-liquid-glass-DHpvFM4a.css";
      document.head.appendChild(link);
      throw new Error("Unable to preload CSS for /assets/ui-theme-liquid-glass-DHpvFM4a.css");
    });
    await loadUiThemeStyles("liquid-glass");
    assert.equal(calls, 1);
    assert.equal(isUiThemeStyleReady("liquid-glass"), true, "失败也算有结果：切换不能一直不生效");
    assert.equal(isUiThemeStyleLoaded("liquid-glass"), false, "但不算下到：照片层先别画");
    assert.equal(dom.links.length, 0, "Vite 留下的坏 <link> 摘掉了");
    await loadUiThemeStyles("liquid-glass");
    assert.equal(calls, 1, "有结果了就不再 import（Vite 也不会再发请求）");

    // 第一次重试（1ms 后）：自己挂的 <link> 也失败 → 摘掉、再排一次
    dom.setFailNext(true);
    await tick();
    assert.equal(isUiThemeStyleLoaded("liquid-glass"), false);
    assert.equal(dom.links.length, 0);
    // 第二次重试（30ms 后）：下到了
    dom.setFailNext(false);
    await tick(45);
    assert.equal(isUiThemeStyleLoaded("liquid-glass"), true);
    assert.deepEqual(dom.links.map((link) => [link.href, link.attributes["data-fx-ui-theme-bundled"]]), [["/assets/ui-theme-liquid-glass-DHpvFM4a.css", "liquid-glass"]]);
    assert.ok(dom.events.includes(UI_THEME_STYLE_LOADED_EVENT), "等它的组件据此再挂");
  } finally {
    console.warn = warn;
    hooks.reset();
    const g = globalThis as any;
    delete g.document; delete g.window; delete g.Event;
  }
});

test("内置样式包：错误里没有地址（不是 Vite 预加载那种）就无从再试，照旧记成有结果", async () => {
  const dom = fakeDom();
  const { __uiThemeStylesForTest, isUiThemeStyleLoaded, isUiThemeStyleReady, loadUiThemeStyles, failedPreloadHref } = await import("./uiThemeStyles");
  const hooks = __uiThemeStylesForTest();
  hooks.reset();
  hooks.setRetryDelays([1]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    hooks.setBundledLoader("pearl", async () => { throw new Error("boom"); });
    await loadUiThemeStyles("pearl");
    assert.equal(isUiThemeStyleReady("pearl"), true);
    await tick();
    assert.equal(isUiThemeStyleLoaded("pearl"), false);
    assert.equal(dom.links.length, 0, "没地址就没法自己挂");
    assert.equal(failedPreloadHref(new Error("Unable to preload CSS for /a.css")), "/a.css");
    assert.equal(failedPreloadHref(new Error("boom")), null);
    // 下成功的：直接算下到
    hooks.setBundledLoader("liquid-glass", async () => undefined);
    await loadUiThemeStyles("liquid-glass");
    assert.equal(isUiThemeStyleLoaded("liquid-glass"), true);
    assert.equal(isUiThemeStyleLoaded("classic"), true, "经典没有主题文件");
  } finally {
    console.warn = warn;
    hooks.reset();
    const g = globalThis as any;
    delete g.document; delete g.window; delete g.Event;
  }
});
