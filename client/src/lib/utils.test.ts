import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cn } from "./utils";

test("自定义字号和文字颜色放在一起时，两个都留着", () => {
  assert.equal(cn("text-meta leading-5", "text-muted-foreground"), "text-meta leading-5 text-muted-foreground");
  assert.equal(cn("text-secondary-type", "text-[var(--fx-warn-text)]"), "text-secondary-type text-[var(--fx-warn-text)]");
  assert.equal(cn("text-primary-type", "text-primary"), "text-primary-type text-primary", "text-primary 是颜色，text-primary-type 是字号");
});

test("和别的字号冲突时后写的胜出：按钮变体里的 text-[14px] 让位给 className 里的 text-meta", () => {
  assert.equal(cn("rounded-md text-[14px] font-medium", "text-meta"), "rounded-md font-medium text-meta");
  assert.equal(cn("text-meta", "text-sm"), "text-sm");
});

test("注册的字号和 index.css 里 @theme 定义的一一对应", () => {
  /*
    哪天在 @theme 里新加了一个字号而忘了告诉 tailwind-merge，它又会被当成颜色删掉 ——
    这里把两边对一遍。
  */
  const css = fs.readFileSync(path.resolve(import.meta.dirname, "../index.css"), "utf8");
  const themeSizes = [...css.matchAll(/^\s*--text-([a-z-]+):\s*var\(--fx-size-/gm)].map((match) => match[1]).sort();
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "utils.ts"), "utf8");
  const registered = (source.match(/text: \[([^\]]+)\]/)?.[1] || "").split(",").map((item) => item.trim().replace(/"/g, "")).filter(Boolean).sort();
  assert.ok(themeSizes.length >= 6, `index.css 里只认出 ${themeSizes.length} 个字号，正则大概失效了`);
  assert.deepEqual(registered, themeSizes);
});

test("自定义圆角 rounded-inner 和别的圆角冲突时后写的胜出", () => {
  assert.equal(cn("rounded-inner px-2", "rounded-full"), "px-2 rounded-full");
  assert.equal(cn("rounded-[6px]", "rounded-inner"), "rounded-inner");
});
