import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Badge } from "./badge";
import { Button } from "./button";

test("徽标 tone：软底深字，盖掉默认的主色底和高光", () => {
  const html = renderToStaticMarkup(<Badge tone="up">已安装</Badge>);
  assert.match(html, /data-tone="up"/);
  assert.match(html, /bg-\[var\(--fx-healthy-soft\)\]/);
  assert.match(html, /text-\[var\(--fx-healthy-text\)\]/);
  assert.match(html, /bg-none/);
  assert.doesNotMatch(html, /--fx-primary-fill|--fx-primary-sheen|--fx-primary-text/);
  assert.doesNotMatch(html, /text-white/);
});

test("徽标 tone 每一档都是令牌色", () => {
  for (const tone of ["neutral", "accent", "up", "warn", "down", "info"] as const) {
    const html = renderToStaticMarkup(<Badge tone={tone}>x</Badge>);
    assert.match(html, /bg-\[var\(--fx-[a-z-]+\)\]/, tone);
  }
});

test("徽标 size=sm：16px 高、11px 字；不给 size 和原来一样", () => {
  const small = renderToStaticMarkup(<Badge size="sm" variant="secondary">TCP</Badge>);
  assert.match(small, /h-4/);
  assert.match(small, /text-\[11px\]/);
  assert.doesNotMatch(small, /text-\[11\.5px\]/);
  const normal = renderToStaticMarkup(<Badge variant="secondary">TCP</Badge>);
  assert.match(normal, /text-\[11\.5px\]/);
  assert.doesNotMatch(normal, /data-tone/);
});

test("按钮 size=xs：28px 高", () => {
  const html = renderToStaticMarkup(<Button size="xs">展开</Button>);
  assert.match(html, /h-7/);
  assert.doesNotMatch(html, /h-9/);
});
