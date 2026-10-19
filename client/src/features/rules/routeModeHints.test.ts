import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROUTE_MODE_HINTS } from "./routeModeHints";

test("每种走法各有一句说明，说的是「适合什么」而不只是换个说法重复名字", () => {
  for (const [mode, hint] of Object.entries(ROUTE_MODE_HINTS)) {
    assert.ok(hint.length >= 12, `${mode} 的说明太短了：${hint}`);
    assert.doesNotMatch(hint, /^(端口转发|隧道转发|转发链|转发组)$/);
  }
});

test("编辑框里标签下面真的挂着这句话，跟着选中的走法变", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../pages/Rules.tsx"), "utf8");
  assert.match(source, /ROUTE_MODE_HINTS\[routeTab\]/);
});
