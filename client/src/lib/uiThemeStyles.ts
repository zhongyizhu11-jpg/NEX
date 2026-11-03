import type { PersonalizationUiThemeId } from "@shared/personalization";

/*
  界面主题的样式按需加载。

  七套主题的 CSS 原来全打在主样式表里（主样式表 470KB，其中两百多 KB 是主题），可一个人同时只看得到一套。
  现在每套是一个单独的样式包（client/src/styles/ui-themes/ui-theme-*.css，Vite 按动态 import 拆成独立的
  CSS 文件），用到哪套才下哪套；经典没有主题文件，一直在主样式表里。

  不闪的规矩：<html data-ui-theme> 只在那一套的样式**已经下完**之后才挂上。
    · 开机：index.html 顶部的内联脚本先按 localStorage 挂上上次那套（只铺页面底色，#root 里只有那条
      细进度条），main.tsx 等这里把样式下完才 createRoot，第一帧就是对的。
    · 切换：applyPersonalizationSurface（personalizationTheme.ts）先来这里要样式，下完再改属性；
      没下完之前屏幕上还是原来那一套。
  下过的不卸：别的主题的规则都挂在自己的 data-ui-theme 下，留着不影响别人，切回来也不用再下。

  为什么每个包后面再接一份 compact.css：原来 index.css 里的顺序是「主题 → compact.css」，compact 的规则
  （html:root …，特异性 0,1,1 起）和主题的规则（html[data-ui-theme] …，也是 0,1,1 起）一样高的地方
  不少（珍珠的总览数字字号、卡片的边线和留白……），谁写在后面谁赢，一直是 compact 赢。主题包是后来插进
  <head> 的，排在整张主样式表后面，不接这一份就成了主题赢，紧凑外壳的尺寸会被主题盖掉。接一份一模
  一样的在后面，层叠结果和原来逐条相同（compact 和它后面 index.css 里那些不分层的规则之间没有同特异性
  抢同一属性的地方，主题和那些规则之间只有液态玻璃和背景图都把 .fx-mesh 设成 display: none，结果一样）。
  代价是每个主题包多 20KB（gzip 后 3KB 多），一个人只下一套。

  主题文件里有几块不挂在 data-ui-theme 下、却只在那套主题下才渲染的元素（液态玻璃的 .fx-lg-backdrop、
  珍珠的 .fx-pearl-nav-marker）：组件按 useUiTheme() 判断，属性挂上时样式已经在了，留在包里没问题。
  哪套主题下都要画的（预览小屏、保存栏、品牌预览卡）在 client/src/styles/ui-theme-shared.css，跟主样式表走。
*/

type ThemedId = Exclude<PersonalizationUiThemeId, "classic">;

/*
  写成 Record：shared/personalization.ts 里加了一套主题、这里没加，类型检查就会报出来，
  不会出现「选了新主题却永远等不到样式」。
*/
const LOADERS: Record<ThemedId, () => Promise<unknown>> = {
  aurora: () => import("../styles/ui-themes/ui-theme-aurora.css"),
  gilt: () => import("../styles/ui-themes/ui-theme-gilt.css"),
  rose: () => import("../styles/ui-themes/ui-theme-rose.css"),
  cinnabar: () => import("../styles/ui-themes/ui-theme-cinnabar.css"),
  "liquid-glass": () => import("../styles/ui-themes/ui-theme-liquid-glass.css"),
  indigo: () => import("../styles/ui-themes/ui-theme-indigo.css"),
  pearl: () => import("../styles/ui-themes/ui-theme-pearl.css"),
};

/* 已经有结果的（下完了，或者下失败了）。失败的也算：见 loadUiThemeStyles 的说明。 */
const settled = new Set<string>();
const inflight = new Map<string, Promise<void>>();

function loaderFor(id: string | null | undefined) {
  if (!id || !Object.prototype.hasOwnProperty.call(LOADERS, id)) return null;
  return LOADERS[id as ThemedId];
}

/** 这一套现在能不能直接挂上：经典、不认识的值（会被当成经典）、样式已经有结果的，都是能。 */
export function isUiThemeStyleReady(id: string | null | undefined) {
  return !loaderFor(id) || settled.has(id as string);
}

/**
 * 把这一套的样式下下来。总是 resolve（不 reject）：下载失败也照样往下走 —— 宁可这一次主题没画全，
 * 也不能让开机一直卡在启动底色、或者切换一直不生效。失败的也记成「有结果了」，之后切到它直接挂：
 * Vite 的预加载对同一个文件只发一次请求，这一页里再要也不会重下，再等也等不来；刷新之后才会再试
 * （一般是刚发版、旧文件已经不在了，刷新拿到的是新的文件名）。
 */
export function loadUiThemeStyles(id: string | null | undefined): Promise<void> {
  const loader = loaderFor(id);
  if (!loader || settled.has(id as string)) return Promise.resolve();
  const key = id as string;
  const running = inflight.get(key);
  if (running) return running;
  const task = loader()
    .then(
      () => undefined,
      (error: unknown) => { console.warn(`[ui-theme] 「${key}」的样式没下下来`, error); },
    )
    .finally(() => {
      settled.add(key);
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}
