import crypto from "node:crypto";

/*
  内容安全策略（CSP）。

  以前 script-src 带 'unsafe-inline'：页面里任何一处 XSS 漏洞都能直接执行脚本，CSP 等于没有。现在每个请求生成一个
  随机 nonce，放进响应头的 script-src，再把它写到 index.html 里的 <script> 标签上（serveStatic 注入）和订阅页的
  内联脚本上（proxySubPage）：只有带着这个 nonce 的脚本能跑，注入进来的脚本没有 nonce，浏览器直接拒。

  仍然放开的：
    · style-src 'unsafe-inline'：React 的行内样式、主题包、开机底色都是内联样式，样式注入的危害远小于脚本。
    · script-src 里的 jsdelivr / cubism.live2d.com：Live2D 看板娘插件按需从这几个域加载运行时（client/src/components/
      plugins/Live2DWidgetHost.tsx）；插件没开时这些域不会被用到，但名单仍在，收紧要等插件改成面板自托管。
    · connect-src https: http: wss: ws:：面板会从浏览器直接探测主机 / 目标的延迟（链路诊断、落地探测），地址是用户填的。
    · img-src / media-src / frame-src 的 https: http:：公告、套餐描述、插件页面里的图片和内嵌页面。
*/

export type CspOptions = {
  nonce: string;
  /** 自定义侧栏的 iframe 允许同源嵌入；其余一律不许被嵌。 */
  frameAncestors: "'self'" | "'none'";
};

export function newCspNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  const nonce = `'nonce-${options.nonce}'`;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    `frame-ancestors ${options.frameAncestors}`,
    "object-src 'none'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://fastly.jsdelivr.net",
    `script-src 'self' ${nonce} https://fastly.jsdelivr.net https://cdn.jsdelivr.net https://cubism.live2d.com`,
    "connect-src 'self' https: http: wss: ws:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'self' data: https: http:",
    "media-src 'self' data: blob: https: http:",
  ].join("; ");
}

/**
 * 给 HTML 里所有还没有 nonce 的 <script ...> 标签加上 nonce 属性。index.html 里有开机那段内联脚本和 Vite 打出来的
 * 模块入口；外链脚本带 nonce 没有副作用。只匹配真正的 <script 开标签，不碰 <noscript> 和文本里的字样。
 */
export function injectScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi, (_match, attrs: string) => `<script nonce="${nonce}"${attrs}>`);
}
