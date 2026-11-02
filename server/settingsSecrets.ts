/*
  设置页里两样不该原样回给前端的东西（P1-1）：面板 HTTPS 私钥、DDNS Webhook 的请求头。

  system.getSettings 只读令牌也能调，以前私钥和 Authorization 头原样返回 —— 只读令牌一泄露，
  别人就能拿私钥做中间人、拿请求头去改你的 DNS。现在设置接口只说「已配置」，私钥要看得走单独的
  管理员接口（system.revealPanelSslKey，令牌调不了），请求头只回打码后的样子。

  保存时前端不再带回这两样：没带就保持原值，见 resolvePanelSslKeyPem。
*/

function maskHeaderValue(value: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.length <= 8) return `${v.slice(0, 1)}${"*".repeat(6)}`;
  return `${v.slice(0, 4)}${"*".repeat(6)}${v.slice(-2)}`;
}

/** 请求头打码：只留头名和值的头尾几个字符。支持 JSON 和每行一个两种写法（和 ddns.ts 的解析一致）。 */
export function maskWebhookHeaders(raw: string | null | undefined) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const entries: Array<[string, string]> = [];
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, item] of Object.entries(parsed)) {
        if (key && item != null) entries.push([key, String(item)]);
      }
    }
  } catch {
    for (const line of value.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      entries.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
    }
  }
  if (!entries.length) return "（已保存）";
  return entries.map(([key, item]) => `${key.slice(0, 64)}: ${maskHeaderValue(item)}`).join("\n");
}

/**
 * 保存面板 SSL 时私钥 PEM 取哪个值。
 * 前端拿不到已保存的私钥，所以私钥框留空 = 保持原来的；证书也清空了才算整个 PEM 一起删掉。
 */
export function resolvePanelSslKeyPem(input: { certPem: string; keyPem: string }, currentKeyPem: string) {
  const keyPem = String(input.keyPem || "").trim();
  if (keyPem) return keyPem;
  if (!String(input.certPem || "").trim()) return "";
  return String(currentKeyPem || "").trim();
}
