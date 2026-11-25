import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 「订阅管理」页：在弹窗里打字不能重画节点列表。
 *
 * 这一页没有渲染测试（trpc、路由、弹窗都要 mock），所以守在源码上，把保证这件事的三个条件钉住：
 *   1. 三个表单弹窗（节点、新建链接、改名）的输入状态在各自的组件里，页面文件里没有那些 useState；
 *      键击只会 setState 到弹窗组件，页面组件根本不重渲染。
 *   2. ProxyInboundsSection（默认导出）和 ProxyNodeRow 都 memo 过：页面因为别的原因重画
 *      （开关弹窗、二维码）时，props 引用不变就整段跳过。
 *   3. 传给 ProxyInboundsSection 的回调都经过 useCallback / useMemo，不是内联箭头函数 ——
 *      否则 memo 等于没做。
 * 另外「订阅内容」弹窗必须是 lazy 的：五百多行只在点开时下载。
 */
const read = (relative: string) => fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");

test("弹窗的表单状态不在页面组件里", () => {
  const page = read("../../pages/ClientSubscriptions.tsx");
  for (const setter of ["setNodeName", "setNodeLink", "setNodeRemark", "setNodeTrafficLimitGb", "setTokenName", "setRenameValue", "setCollapsedGroups"]) {
    assert.doesNotMatch(page, new RegExp(`\\b${setter}\\b`), `页面里不该再有 ${setter}`);
  }
  // 反向对照：这些状态确实搬到了弹窗组件里
  assert.match(read("ProxyNodeEditDialog.tsx"), /useState\(\(\) => String\(node\?\.name \|\| ""\)\)/);
  assert.match(read("ProxySubTokenCreateDialog.tsx"), /const \[name, setName\] = useState\(""\)/);
  assert.match(read("ProxyPreviewRenameDialog.tsx"), /const \[value, setValue\] = useState\(target\.name\)/);
  assert.match(read("ProxySubscriptionPreviewDialog.tsx"), /useState<string\[\]>\(readStoredCollapsed\)/);
});

test("节点列表那一段和每一行都 memo 过", () => {
  assert.match(read("ProxyInboundsSection.tsx"), /^export default memo\(ProxyInboundsSection\);/m);
  assert.match(read("ProxyNodeRow.tsx"), /^export const ProxyNodeRow = memo\(function ProxyNodeRow\(/m);
});

test("传给 ProxyInboundsSection 的回调都是稳定引用，订阅内容弹窗懒加载", () => {
  const page = read("../../pages/ClientSubscriptions.tsx");
  const start = page.indexOf("<ProxyInboundsSection");
  const end = page.indexOf("/>", start);
  assert.ok(start > 0 && end > start, "找得到 <ProxyInboundsSection … />");
  const props = page.slice(start, end);
  assert.doesNotMatch(props, /=>/, `ProxyInboundsSection 的 props 里不该有内联箭头函数：\n${props}`);
  for (const name of ["openPreview", "openHosts", "changeGroupMode", "openCreateNode", "toggleQuota", "openEditNode", "confirmDeleteNode"]) {
    assert.match(page, new RegExp(`const ${name} = useCallback\\(`), `${name} 要 useCallback`);
  }
  assert.match(page, /const pastedRowSpecs = useMemo</);
  // loader 写成模块级常量，lazy() 和页面闲时预热（lib/lazyWarm）用的是同一个函数
  assert.match(page, /const loadProxySubscriptionPreviewDialog = \(\) => import\("@\/components\/proxy\/ProxySubscriptionPreviewDialog"\)/);
  assert.match(page, /lazy\(loadProxySubscriptionPreviewDialog\)/);
  assert.match(page, /\{previewOpen && \(\s*<Suspense fallback=\{<DialogLoadingFallback open=\{previewOpen\} \/>\}>/);
});

test("行上的开关是乐观的，失效只动自己影响到的查询", () => {
  const page = read("../../pages/ClientSubscriptions.tsx");
  const preview = read("ProxySubscriptionPreviewDialog.tsx");
  assert.doesNotMatch(page, /<Switch\b/, "页面里的开关全部换成 OptimisticSwitch");
  assert.doesNotMatch(preview, /<Switch\b/, "订阅内容弹窗里的开关全部换成 OptimisticSwitch");
  // 「一把全失效」的 refresh 不复存在；节点 / 令牌各走各的
  assert.doesNotMatch(page, /const refresh = /);
  assert.match(page, /const invalidateNodes = useCallback\(\(\) => Promise\.all\(\[\s*utils\.proxySubscriptions\.listNodes\.invalidate\(\),\s*utils\.proxySubscriptions\.preview\.invalidate\(\),/);
  assert.match(page, /const invalidateTokens = useCallback\(\(\) => utils\.proxySubscriptions\.listTokens\.invalidate\(\)/);
  // 行开关用的 updateNode 不弹「客户端节点已更新」、不关弹窗 —— 那两件事只属于弹窗自己的实例
  assert.doesNotMatch(page, /toast\.success\("客户端节点已更新"\)/);
  assert.match(read("ProxyNodeEditDialog.tsx"), /toast\.success\("客户端节点已更新"\)/);
});
