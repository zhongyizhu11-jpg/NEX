import assert from "node:assert/strict";
import test from "node:test";
import { buildPrometheusScrapeConfig, SCRAPE_TARGET_PLACEHOLDER } from "./scrapeConfig";

const base = { path: "/metrics", token: "nex_metrics_abc" };

test("抓取配置：https 面板地址拆成 scheme 和 target，默认端口不写", () => {
  const text = buildPrometheusScrapeConfig({ ...base, panelUrl: "https://panel.example.com/" });
  assert.equal(text, [
    "scrape_configs:",
    "  - job_name: nex",
    "    scheme: https",
    "    metrics_path: /metrics",
    "    scrape_interval: 30s",
    "    authorization:",
    "      type: Bearer",
    "      credentials: nex_metrics_abc",
    "    static_configs:",
    '      - targets: ["panel.example.com"]',
    "",
  ].join("\n"));
});

test("抓取配置：http://IP:端口 直接访问的面板带上端口；地址后面的路径不进 target", () => {
  const text = buildPrometheusScrapeConfig({ ...base, panelUrl: " http://203.0.113.7:9810/settings?tab=advanced " });
  assert.match(text, /scheme: http\n/);
  assert.match(text, /targets: \["203\.0\.113\.7:9810"\]/);
  const ipv6 = buildPrometheusScrapeConfig({ ...base, panelUrl: "https://[2001:db8::1]:8443" });
  assert.match(ipv6, /targets: \["\[2001:db8::1\]:8443"\]/);
});

test("抓取配置：面板地址拆不出来（空的、App 里的 capacitor 地址）时留占位，不猜", () => {
  for (const panelUrl of ["", "not a url", "capacitor://localhost"]) {
    const text = buildPrometheusScrapeConfig({ ...base, panelUrl });
    assert.ok(text.includes(`targets: ["${SCRAPE_TARGET_PLACEHOLDER}"]`), panelUrl);
    assert.match(text, /scheme: https\n/);
  }
});
