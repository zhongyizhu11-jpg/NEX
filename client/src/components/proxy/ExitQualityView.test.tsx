import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ExitHostPanel, exitSiteHeadline, type ExitQualityHostView } from "./ExitQualityView";

const targets = [
  { key: "baidu", label: "百度", host: "www.baidu.com" },
  { key: "google", label: "Google", host: "www.google.com" },
];

function site(key: string, patch: Partial<ExitQualityHostView["sites"][number]> = {}) {
  return { key, latestMs: 42, latestFail: null, latestAt: 1, medianMs: 40, lossPct: 0, samples: 30, latestTries: 3, latestOk: 3, tone: "ok" as const, values: [40, 42, 41], ...patch };
}

function host(patch: Partial<ExitQualityHostView> = {}): ExitQualityHostView {
  return {
    id: 1, name: "HK 01", online: true, countryCode: null,
    sites: [site("baidu", { latestMs: null, latestFail: "dns", tone: "down", lossPct: 12.5 }), site("google")],
    unlock: { checkedAt: 1, items: [{ service: "netflix", text: "NF 全解", status: "ok" }] },
    unlockDetail: { checkedAt: 1, family: "auto", results: [{ service: "netflix", name: "Netflix", status: "ok", region: "HK" }, { service: "chatgpt", name: "ChatGPT", status: "blocked", region: null }] },
    unlockSupported: true,
    ...patch,
  };
}

test("出口检测：每站一格，没连上写原因、丢失写比例，解锁逐项列出", () => {
  const html = renderToStaticMarkup(<ExitHostPanel host={host({ online: false })} targets={targets} />);
  assert.equal((html.match(/data-testid="exit-quality-site"/g) || []).length, 2);
  assert.match(html, /离线 · 显示的是掉线前的/);
  assert.match(html, /没连上 12.5%/);
  assert.match(html, /42 ms/);
  assert.match(html, /Netflix/);
  assert.match(html, /可用 · HK/);
  assert.match(html, /不可用/);
});

test("出口检测：DNS 被污染写出来，不显示假的毫秒数；老 Agent 提示没校验证书", () => {
  const html = renderToStaticMarkup(<ExitHostPanel host={host({ unverified: true, sites: [site("google", { latestMs: null, latestFail: "poisoned", tone: "down" })] })} targets={targets} />);
  assert.match(html, /解析被污染/);
  assert.match(html, /data-testid="exit-unverified"/);
  assert.equal(exitSiteHeadline({ latestMs: null, latestFail: "blocked", samples: 3 }), "被阻断");
  assert.equal(exitSiteHeadline({ latestMs: null, latestFail: "dns", samples: 3 }), "解析失败");
  assert.equal(exitSiteHeadline({ latestMs: null, latestFail: null, samples: 0 }), "—");
});

test("出口检测：出不去的机器收成一句话，不铺四格红", () => {
  const down = site("baidu", { latestMs: null, medianMs: null, latestFail: "timeout", tone: "down", lossPct: 100 });
  const html = renderToStaticMarkup(<ExitHostPanel host={host({ noEgress: true, sites: [down, { ...down, key: "google" }] })} targets={targets} />);
  assert.match(html, /data-testid="exit-no-egress"/);
  assert.equal((html.match(/data-testid="exit-quality-site"/g) || []).length, 0);
});
