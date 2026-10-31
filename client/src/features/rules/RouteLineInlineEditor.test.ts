import assert from "node:assert/strict";
import test from "node:test";

import { newRouteGroupDraft } from "@shared/routeGroup";
import type { RouteGroupDraft } from "./RouteGroupFields";
import { withPin } from "./RouteLineInlineEditor";

/*
  线路详情里正改着线路（编辑稿没保存）时点状态胶囊手动切换：切换马上存进库里，编辑稿里的指定也得跟上 ——
  保存带的是编辑稿里那份，不跟上的话一保存就把刚切过去的切回来（2.3.498 的毛病）。
*/
function draft(paths: Array<{ key: string; lineKey?: string }>): RouteGroupDraft {
  const base = newRouteGroupDraft({ timezone: "Asia/Shanghai" });
  return { ...base, paths: paths.map((path, index) => ({ ...base.paths[0], ...path, name: `路径 ${index + 1}` })) };
}

test("胶囊上指定了一条：编辑稿里按线路对上它在编辑稿里的下标", () => {
  // 编辑稿里主线路多展开了一条，备用 1 从第 2 条挪到第 3 条
  const editing = draft([{ key: "main-a", lineKey: "main" }, { key: "main-b", lineKey: "main" }, { key: "b1", lineKey: "b1" }]);
  const next = withPin(editing, { key: "b1", lineKey: "b1" }, 1_800_000_000_000);
  assert.deepEqual(next?.policy.pin, { index: 2, untilMs: 1_800_000_000_000 });
  assert.deepEqual(withPin(editing, { key: "main", lineKey: "main" }, null)?.policy.pin, { index: 0, untilMs: null }, "路径变了按线路找第一条");
});

test("交回自动：编辑稿里的指定清掉；编辑稿里已经没有那条线路就不动", () => {
  const pinned = { ...draft([{ key: "main", lineKey: "main" }, { key: "b1", lineKey: "b1" }]) };
  pinned.policy = { ...pinned.policy, pin: { index: 1, untilMs: null } };
  assert.equal(withPin(pinned, null, null)?.policy.pin, null);
  assert.equal(withPin(pinned, { key: "b9", lineKey: "b9" }, null), pinned);
  assert.equal(withPin(null, null, null), null);
});
