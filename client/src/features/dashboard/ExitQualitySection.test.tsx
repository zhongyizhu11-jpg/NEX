import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ExitQualitySection, exitSiteHeadline, type ExitQualityView } from "./ExitQualitySection";

const targets = [
  { key: "baidu", label: "百度", host: "www.baidu.com" },
  { key: "google", label: "Google", host: "www.google.com" },
];

function site(key: string, patch: Partial<ExitQualityView["hosts"][number]["sites"][number]> = {}) {
  return { key, latestMs: 42, latestFail: null, latestAt: 1, medianMs: 40, lossPct: 0, samples: 30, tone: "ok" as const, values: [40, 42, 41], ...patch };
}

test("出口质量：没样本整块不出现；有样本每台一行、每站一格，没连上写原因、丢包写比例", () => {
  assert.equal(renderToStaticMarkup(<ExitQualitySection data={null} />), "");
  assert.equal(renderToStaticMarkup(<ExitQualitySection data={{ targets, hosts: [], unsupported: 3 }} />), "");
  const html = renderToStaticMarkup(
    <ExitQualitySection data={{
      targets,
      unsupported: 2,
      hosts: [{
        id: 1, name: "HK 01", online: false, countryCode: null,
        sites: [site("baidu", { latestMs: null, latestFail: "dns", tone: "down", lossPct: 12.5 }), site("google")],
        unlock: { checkedAt: 1, items: [{ service: "netflix", text: "NF 全解", status: "ok" }, { service: "chatgpt", text: "GPT ✗", status: "blocked" }] },
      }],
    }} />,
  );
  assert.equal((html.match(/data-testid="exit-quality-host"/g) || []).length, 1);
  assert.equal((html.match(/data-testid="exit-quality-site"/g) || []).length, 2);
  assert.match(html, /HK 01/);
  assert.match(html, /离线 · 显示的是掉线前的/);
  assert.match(html, /NF 全解/);
  assert.match(html, /没连上 12.5%/);
  assert.match(html, /42 ms/);
  assert.match(html, /还有 2 台在线主机的 Agent 早于 2.2.237/);
  assert.equal(exitSiteHeadline({ latestMs: null, latestFail: "dns", samples: 3 }), "解析失败");
  assert.equal(exitSiteHeadline({ latestMs: null, latestFail: null, samples: 0 }), "—");
});
