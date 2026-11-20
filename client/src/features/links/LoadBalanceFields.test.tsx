import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BALANCE_TARGET_PROBE_CHOICES } from "@shared/loadBalance";
import { SecondsPicker } from "./LoadBalanceFields";

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
