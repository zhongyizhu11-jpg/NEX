import { findInstalledUiTheme } from "./installedUiThemes";

/*
  界面主题的样式按需加载。

  一个人同时只看得到一套主题，所以主题的 CSS 都不在主样式表里，用到哪套才下哪套。两种来源：

  · 内置的珍珠、深空：各是一个单独的样式包（client/src/styles/ui-themes/ui-theme-*.css，Vite 按动态
    import 拆成独立的 CSS 文件）。经典没有主题文件，一直在主样式表里。
  · 装上去的主题包（shared/uiThemePackage.ts）：样式存在面板的库里，从 /api/ui-themes/<id>.css 取，
    这里往 <head> 里挂一条 <link>。

  不闪的规矩：<html data-ui-theme> 只在那一套的样式**已经下完**之后才挂上。
    · 开机：index.html 顶部的内联脚本先按 localStorage 挂上上次那套（只铺页面底色，#root 里只有那条
      细进度条），main.tsx 等这里把样式下完才 createRoot，第一帧就是对的。
    · 切换：applyPersonalizationSurface（personalizationTheme.ts）先来这里要样式，下完再改属性；
      没下完之前屏幕上还是原来那一套。
  内置的下过就不卸：规则都挂在自己的 data-ui-theme 下，留着不影响别人，切回来也不用再下。
  主题包的那条 <link> 只在它是当前主题时开着（syncUiThemePackageSheets）：包是别人写的，不能指望
  每条规则都老老实实写在自己的 data-ui-theme 下面，关掉才是真的不影响别的主题。

  为什么主题后面要再接一份 compact.css：原来 index.css 里的顺序是「主题 → compact.css」，compact 的规则
  （html:root …，特异性 0,1,1 起）和主题的规则（html[data-ui-theme] …，也是 0,1,1 起）一样高的地方
  不少（珍珠的总览数字字号、卡片的边线和留白……），谁写在后面谁赢，一直是 compact 赢。主题是后来插进
  <head> 的，排在整张主样式表后面，不接这一份就成了主题赢，紧凑外壳的尺寸会被主题盖掉。
    · 内置的两套：样式包里自己接着一份（ui-theme-*.css 的第二个 @import），每个包多 20KB（gzip 后 3KB 多）。
    · 主题包：所有主题包后面共用一条 compact.css 的 <link>（COMPACT_TAIL），主题包的 <link> 永远插在它前面。

  主题文件里有几块不挂在 data-ui-theme 下、却只在那套主题下才渲染的元素（液态玻璃的 .fx-lg-backdrop、
  珍珠的 .fx-pearl-nav-marker）：组件按 useUiTheme() 判断，属性挂上时样式已经在了，留在包里没问题。
  哪套主题下都要画的（预览小屏、保存栏、品牌预览卡）在 client/src/styles/ui-theme-shared.css，跟主样式表走。
*/

/*
  写成对象字面量 + satisfies 之外的 id 一律当主题包处理：shared/personalization.ts 里加了一套内置主题、
  这里没加，client/src/styles/uiThemeChunks.test.ts 会报出来，不会出现「选了新主题却永远等不到样式」。
*/
const BUNDLED_LOADERS: Record<string, () => Promise<unknown>> = {
  pearl: () => import("../styles/ui-themes/ui-theme-pearl.css"),
  deepspace: () => import("../styles/ui-themes/ui-theme-deepspace.css"),
};

/* 已经有结果的内置样式包（下完了，或者下失败了）。失败的也算：见 loadUiThemeStyles 的说明。 */
const settled = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/*
  主题包的样式：按「id + revision」记。loaded 是那条已经下完的 <link>；failed 是上次没下下来的地址
  （主题刚被卸载、网断了），同一个地址不再重试，名单更新（revision 变了、或者这个 id 不在了）之后自然换地址。
*/
type PackageSheet = { href: string; link: HTMLLinkElement };
const packageSheets = new Map<string, PackageSheet>();
const failedPackageHrefs = new Set<string>();
let compactTail: HTMLLinkElement | null = null;
let assetBase = "";

/**
 * App 里页面跑在 capacitor://localhost，样式要到登录时填的面板地址去取；网页上是同源，留空。
 * main.tsx 开机时设一次，PersonalizationLayer 在面板地址变了之后再设。
 */
export function setUiThemeAssetBase(base: string) {
  assetBase = String(base || "").replace(/\/+$/, "");
}

export function uiThemePackageHref(id: string, revision: string) {
  return `${assetBase}/api/ui-themes/${encodeURIComponent(id)}.css?v=${encodeURIComponent(revision)}`;
}

function bundledLoader(id: string | null | undefined) {
  if (!id || !Object.prototype.hasOwnProperty.call(BUNDLED_LOADERS, id)) return null;
  return BUNDLED_LOADERS[id];
}

function packageTarget(id: string | null | undefined) {
  const theme = findInstalledUiTheme(id);
  return theme ? { id: theme.id, href: uiThemePackageHref(theme.id, theme.revision) } : null;
}

/** 这一套现在能不能直接挂上：经典、不认识的值（会被当成经典）、样式已经有结果的，都是能。 */
export function isUiThemeStyleReady(id: string | null | undefined) {
  if (bundledLoader(id)) return settled.has(id as string);
  const target = packageTarget(id);
  if (!target) return true;
  return packageSheets.get(target.id)?.href === target.href || failedPackageHrefs.has(target.href);
}

/**
 * 这一套挂上去有没有样式可看。只有主题包会答「没有」：它的样式没取下来（刚被卸载、面板连不上）。
 * 这时候挂上它的 id 只会得到一个没有主题样式、又不是经典的四不像，调用的人应该退回经典。
 */
export function isUiThemeStyleUsable(id: string | null | undefined) {
  if (bundledLoader(id)) return true;
  const target = packageTarget(id);
  if (!target) return true;
  return !failedPackageHrefs.has(target.href);
}

function waitForSheet(link: HTMLLinkElement): Promise<boolean> {
  return new Promise((resolve) => {
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => resolve(false), { once: true });
  });
}

async function ensureCompactTail() {
  if (compactTail || typeof document === "undefined") return;
  // ?url：拿到这份样式构建后的地址，自己挂 <link>，这样它在 <head> 里的位置由这里说了算
  const { default: href } = await import("../styles/compact.css?url");
  if (compactTail) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute("data-fx-ui-theme-tail", "compact");
  compactTail = link;
  const done = waitForSheet(link);
  document.head.appendChild(link);
  await done;
}

async function loadPackageSheet(target: { id: string; href: string }) {
  if (typeof document === "undefined") return;
  await ensureCompactTail().catch(() => undefined);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = target.href;
  link.setAttribute("data-fx-ui-theme-package", target.id);
  const done = waitForSheet(link);
  // 永远插在 compact 那条前面：后来装的主题也不能排到它后面去
  if (compactTail?.parentNode) compactTail.parentNode.insertBefore(link, compactTail);
  else document.head.appendChild(link);
  if (!(await done)) {
    link.remove();
    failedPackageHrefs.add(target.href);
    console.warn(`[ui-theme] 主题包「${target.id}」的样式没取下来`);
    return;
  }
  // 同一套主题更新了（revision 变了）：新样式到位之后再摘旧的，中间不会有一帧没样式
  const previous = packageSheets.get(target.id);
  packageSheets.set(target.id, { href: target.href, link });
  if (previous && previous.link !== link) previous.link.remove();
}

/**
 * 把这一套的样式下下来。总是 resolve（不 reject）：下载失败也照样往下走 —— 宁可这一次主题没画全，
 * 也不能让开机一直卡在启动底色、或者切换一直不生效。
 * 内置的样式包失败了也记成「有结果了」，之后切到它直接挂：Vite 的预加载对同一个文件只发一次请求，
 * 这一页里再要也不会重下，再等也等不来；刷新之后才会再试（一般是刚发版、旧文件已经不在了）。
 * 主题包失败了记的是那个地址，isUiThemeStyleUsable 会答「不能用」，调用的人退回经典。
 */
export function loadUiThemeStyles(id: string | null | undefined): Promise<void> {
  const loader = bundledLoader(id);
  const target = loader ? null : packageTarget(id);
  if (!loader && !target) return Promise.resolve();
  if (isUiThemeStyleReady(id)) return Promise.resolve();
  const key = loader ? (id as string) : target!.href;
  const running = inflight.get(key);
  if (running) return running;
  const work = loader
    ? loader().then(
      () => undefined,
      (error: unknown) => { console.warn(`[ui-theme] 「${key}」的样式没下下来`, error); },
    ).finally(() => { settled.add(key); })
    : loadPackageSheet(target!).catch(() => { failedPackageHrefs.add(target!.href); });
  const task = work.finally(() => { inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

/**
 * 主题包的 <link> 只让当前这一套开着。activeId 是现在 <html data-ui-theme> 上那个值（经典传 "classic"）。
 * 名单里已经没有的主题（刚卸载）顺手把它的 <link> 摘掉。
 */
export function syncUiThemePackageSheets(activeId: string | null | undefined) {
  for (const [id, sheet] of packageSheets) {
    if (!findInstalledUiTheme(id)) {
      sheet.link.remove();
      packageSheets.delete(id);
      continue;
    }
    sheet.link.disabled = id !== activeId;
  }
}
