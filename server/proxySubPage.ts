/**
 * 订阅落地页：浏览器打开订阅地址时看到的那一页（Marzban / Remnawave 都有）。
 *
 * 原来浏览器打开 /api/sub/<token> 是一坨 base64。这一页给用户：套餐、用量、到期、
 * 设备数、公告，和每个客户端的一键导入按钮 + 二维码。不列节点明细 —— 这页不要登录，
 * 节点里带凭据，不能摆在一个只靠地址保护的页面上。
 *
 * 纯服务端拼字符串，不依赖前端包：订阅域名可能是单独一台机器，静态资源不一定在。
 */

import { encodeBase64Utf8 } from "../shared/proxyNode";
import { PROXY_CLIENT_TARGETS, proxyClientImportFor, buildProxySubscriptionUrl, proxyClientPlatformsLabel } from "../shared/proxyClientImport";
import { formatBytes } from "../shared/formatBytes";

export type ProxySubPageInput = {
  appName: string;
  username: string;
  tokenName: string;
  planNames: string[];
  trafficUsed: number;
  trafficLimit: number;
  /** 毫秒，0 = 长期。 */
  expiresAt: number;
  /** 毫秒，0 = 没有。 */
  nextResetAt: number;
  deviceCount: number;
  deviceLimit: number;
  nodeCount: number;
  announce: string;
  supportUrl: string;
  /** 这条订阅的全部地址（主 + 备用）。 */
  origins: string[];
  token: string;
  alias: string;
  /** 主地址的二维码 data URL，可空。 */
  qrDataUrl: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dateText(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function renderProxySubPage(input: ProxySubPageInput): string {
  const origin = input.origins[0] || "";
  const mainUrl = buildProxySubscriptionUrl({ origin, token: input.token, format: "base64", kind: "nodes" });
  const usedPercent = input.trafficLimit > 0 ? Math.min(100, Math.round((input.trafficUsed / input.trafficLimit) * 100)) : 0;
  const daysLeft = input.expiresAt > 0 ? Math.max(0, Math.ceil((input.expiresAt - Date.now()) / 86_400_000)) : -1;

  const clientButtons = PROXY_CLIENT_TARGETS.map((target) => {
    const url = buildProxySubscriptionUrl({ origin, token: input.token, format: target.format, kind: "nodes", pinFormat: target.format !== "base64" });
    const importer = proxyClientImportFor(target, "nodes");
    const link = importer.buildImportUrl ? importer.buildImportUrl(url, input.tokenName) : "";
    const platforms = escapeHtml(proxyClientPlatformsLabel(target));
    if (link) {
      return `<a class="client" href="${escapeHtml(link)}"><span class="client-name">${escapeHtml(target.label)}</span><span class="client-meta">${platforms}</span></a>`;
    }
    return `<button class="client" type="button" data-copy="${escapeHtml(url)}" title="${escapeHtml(importer.manualHint || "复制地址后在客户端里粘贴")}"><span class="client-name">${escapeHtml(target.label)}</span><span class="client-meta">${platforms} · 复制地址</span></button>`;
  }).join("");

  const altUrls = input.origins.slice(1).map((alt) => buildProxySubscriptionUrl({ origin: alt, token: input.token, format: "base64", kind: "nodes" }));
  const aliasUrl = input.alias ? `${origin.replace(/\/+$/, "")}/s/${input.alias}` : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.appName)} · 订阅</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; --bar: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a21; --fg: #e5e7eb; --muted: #9ca3af; --line: #2a2f3a; --accent: #60a5fa; --bar: #2a2f3a; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; color: var(--muted); font-weight: 600; letter-spacing: .02em; }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .stat b { display: block; font-size: 18px; }
  .stat span { color: var(--muted); font-size: 13px; }
  .bar { height: 8px; border-radius: 999px; background: var(--bar); overflow: hidden; margin-top: 10px; }
  .bar i { display: block; height: 100%; background: var(--accent); width: ${usedPercent}%; }
  .clients { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .client { display: flex; flex-direction: column; gap: 2px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--fg); text-decoration: none; text-align: left; cursor: pointer; font: inherit; }
  .client:hover { border-color: var(--accent); }
  .client-name { font-weight: 600; }
  .client-meta { color: var(--muted); font-size: 12px; }
  .url { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .url input { flex: 1; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .url button, .btn { padding: 10px 14px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
  .qr { display: flex; justify-content: center; margin-top: 12px; }
  .qr img { width: 180px; height: 180px; border-radius: 10px; background: #fff; padding: 6px; }
  .announce { white-space: pre-wrap; }
  .muted { color: var(--muted); font-size: 13px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 24px; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 8px 14px; border-radius: 999px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(input.appName)}</h1>
  <p class="sub">${escapeHtml(input.username)}${input.planNames.length ? " · " + escapeHtml(input.planNames.join("、")) : ""} · ${escapeHtml(input.tokenName)}</p>

  <section class="card">
    <h2>用量</h2>
    <div class="stats">
      <div class="stat"><b>${escapeHtml(formatBytes(input.trafficUsed))}</b><span>已用${input.trafficLimit > 0 ? " / " + escapeHtml(formatBytes(input.trafficLimit)) : "（不限量）"}</span></div>
      <div class="stat"><b>${input.expiresAt > 0 ? escapeHtml(dateText(input.expiresAt)) : "长期"}</b><span>${input.expiresAt > 0 ? `到期（剩 ${daysLeft} 天）` : "有效期"}</span></div>
      <div class="stat"><b>${input.nodeCount}</b><span>节点</span></div>
      <div class="stat"><b>${input.deviceCount}${input.deviceLimit > 0 ? " / " + input.deviceLimit : ""}</b><span>设备</span></div>
    </div>
    ${input.trafficLimit > 0 ? `<div class="bar"><i></i></div>` : ""}
    ${input.nextResetAt > 0 ? `<p class="muted">流量将于 ${escapeHtml(dateText(input.nextResetAt))} 重置</p>` : ""}
  </section>

  ${input.announce ? `<section class="card"><h2>公告</h2><div class="announce">${escapeHtml(input.announce)}</div></section>` : ""}

  <section class="card">
    <h2>一键导入</h2>
    <div class="clients">${clientButtons}</div>
    <p class="muted">没装的客户端点了没反应；灰字「复制地址」的在客户端里手动粘贴。</p>
  </section>

  <section class="card">
    <h2>订阅地址</h2>
    <div class="url"><input readonly value="${escapeHtml(mainUrl)}"><button type="button" data-copy="${escapeHtml(mainUrl)}">复制</button></div>
    ${aliasUrl ? `<div class="url"><input readonly value="${escapeHtml(aliasUrl)}"><button type="button" data-copy="${escapeHtml(aliasUrl)}">复制短链</button></div>` : ""}
    ${altUrls.map((alt) => `<div class="url"><input readonly value="${escapeHtml(alt)}"><button type="button" data-copy="${escapeHtml(alt)}">复制备用</button></div>`).join("")}
    ${input.qrDataUrl ? `<div class="qr"><img alt="订阅二维码" src="${escapeHtml(input.qrDataUrl)}"></div>` : ""}
  </section>

  ${input.supportUrl ? `<p class="muted" style="text-align:center"><a href="${escapeHtml(input.supportUrl)}" rel="noopener">需要帮助？</a></p>` : ""}
  <footer>${escapeHtml(input.appName)}</footer>
</main>
<div class="toast" id="toast">已复制</div>
<script>
(function(){
  var toast=document.getElementById('toast');var timer;
  function show(text){toast.textContent=text;toast.classList.add('show');clearTimeout(timer);timer=setTimeout(function(){toast.classList.remove('show')},1500);}
  document.querySelectorAll('[data-copy]').forEach(function(el){el.addEventListener('click',function(){
    var value=el.getAttribute('data-copy');
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(value).then(function(){show('已复制')},function(){window.prompt('复制这条地址',value)});}
    else{window.prompt('复制这条地址',value);}
  });});
})();
</script>
</body>
</html>
`;
}

/** 响应头里的公告：base64，客户端（Happ、v2RayTun）读 announce 头显示。 */
export function announceHeaderValue(text: string): string {
  const clean = String(text || "").trim();
  return clean ? `base64:${encodeBase64Utf8(clean)}` : "";
}
