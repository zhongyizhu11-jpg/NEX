/**
 * 设置 › 进阶 › 指标导出里那段可以直接抄进 prometheus.yml 的抓取配置。
 *
 * 地址从面板的对外地址拆：协议进 scheme，主机和端口进 targets（Prometheus 的 target 不带协议和路径）。
 * 面板地址拆不出来（没配、或者写错了）就留一个一眼看得出要改的占位，不猜。
 */
export const SCRAPE_TARGET_PLACEHOLDER = "面板地址:端口";

export function buildPrometheusScrapeConfig(input: { panelUrl: string; path: string; token: string }): string {
  let scheme = "https";
  let target = SCRAPE_TARGET_PLACEHOLDER;
  try {
    const url = new URL(input.panelUrl.trim());
    if (url.protocol === "http:" || url.protocol === "https:") {
      scheme = url.protocol.slice(0, -1);
      // URL.host：端口是协议默认的那个时不带端口，Prometheus 会按 scheme 补 80 / 443。
      if (url.host) target = url.host;
    }
  } catch {
    // 留占位
  }
  return [
    "scrape_configs:",
    "  - job_name: nex",
    `    scheme: ${scheme}`,
    `    metrics_path: ${input.path}`,
    "    scrape_interval: 30s",
    "    authorization:",
    "      type: Bearer",
    `      credentials: ${input.token}`,
    "    static_configs:",
    `      - targets: ["${target}"]`,
    "",
  ].join("\n");
}
