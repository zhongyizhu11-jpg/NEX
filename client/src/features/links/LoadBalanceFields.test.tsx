import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BALANCE_TARGET_PROBE_CHOICES, DEFAULT_BALANCE_DETECT } from "@shared/loadBalance";
import { BalanceAdvanced, LoadBalanceFields, SecondsPicker } from "./LoadBalanceFields";

const noop = () => undefined;

test("秒数：值正好是某一格时那格亮着，框里一直是当前值", () => {
  const html = renderToStaticMarkup(<SecondsPicker label="多久探一次目标" value={10} choices={BALANCE_TARGET_PROBE_CHOICES} min={2} max={300} onChange={noop} />);
  const checked = [...html.matchAll(/aria-checked="true"[^>]*>([^<]*)/g)].map((match) => match[1]);
  assert.equal(checked.length, 1);
  assert.match(html, /<input[^>]*value="10"/);
  assert.match(html, /aria-label="多久探一次目标（秒，2–300）"/);
});

test("秒数：自定义的值（不在格子里）一格都不亮，框里照样显示", () => {
  const html = renderToStaticMarkup(<SecondsPicker label="多久探一次目标" value={45} choices={BALANCE_TARGET_PROBE_CHOICES} min={2} max={300} onChange={noop} />);
  assert.doesNotMatch(html, /aria-checked="true"/);
  assert.match(html, /<input[^>]*value="45"/);
  assert.match(html, /min="2"/);
  assert.match(html, /max="300"/);
});

test("只走最快的一台：只有延迟优先有这个开关，在「差多少算一样快」下面", () => {
  const latency = renderToStaticMarkup(<BalanceAdvanced value={{ ...DEFAULT_BALANCE_DETECT }} onChange={noop} strategy="latency" />);
  assert.match(latency, /aria-label="只走最快的一台"/);
  assert.ok(latency.indexOf("差多少算一样快") < latency.indexOf("只走最快的一台"));
  assert.match(latency, /比最快的慢不到这么多的一起分/);
  for (const strategy of ["auto", "fallback", "weighted"] as const) {
    const html = renderToStaticMarkup(<BalanceAdvanced value={{ ...DEFAULT_BALANCE_DETECT }} onChange={noop} strategy={strategy} />);
    assert.doesNotMatch(html, /只走最快的一台/, strategy);
  }
});

test("只走最快的一台：开着时开关是开的，实际效果、分配方式那一句、灵敏度那一行都说它", () => {
  const detect = { ...DEFAULT_BALANCE_DETECT, fastestOnly: true };
  const advanced = renderToStaticMarkup(<BalanceAdvanced value={detect} onChange={noop} strategy="latency" />);
  const toggle = advanced.match(/<button[^>]*aria-label="只走最快的一台"[^>]*>/)?.[0] ?? "";
  assert.match(toggle, /aria-checked="true"/);
  assert.match(advanced, /另一台要快出这么多（并且快两成）才换过去/);
  assert.match(advanced, /实际效果：[^<]*延迟优先：只走最快的一台/);
  const fields = renderToStaticMarkup(<LoadBalanceFields strategy="latency" onStrategyChange={noop} detect={detect} onDetectChange={noop} />);
  assert.match(fields, /只走整链延迟最快的一个/);
  assert.match(fields, /延迟优先：只走最快的一台/);
  // 不算灵敏度：还是「均衡」，不变成自定义
  assert.doesNotMatch(fields, />自定义</);
});
