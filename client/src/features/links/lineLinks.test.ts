import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LINE_PARAM, lineDetailHref, readPositiveParam, searchWithParam } from "./lineLinks";

test("线路详情的深链只有一种写法：/rules?line=<规则 id>", () => {
  assert.equal(LINE_PARAM, "line");
  assert.equal(lineDetailHref(12), "/rules?line=12");
  assert.equal(lineDetailHref(12.7), "/rules?line=12");
});

test("查询串里取 / 换 / 去掉一个参数，别的参数原样留着", () => {
  assert.equal(readPositiveParam("?line=5&tab=routes", "line"), 5);
  assert.equal(readPositiveParam("/tunnels?line=5", "line"), 5);
  assert.equal(readPositiveParam("line=abc", "line"), null);
  assert.equal(readPositiveParam("?line=-1", "line"), null);
  assert.equal(readPositiveParam("", "line"), null);
  assert.equal(searchWithParam("?tab=routes", "line", 9), "?tab=routes&line=9");
  assert.equal(searchWithParam("?tab=routes&line=9", "line", null), "?tab=routes");
  assert.equal(searchWithParam("?line=9", "line", null), "");
});

test("看线路的几处都用同一个地址跳线路详情", () => {
  const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8");
  // 拓扑图的规则行（线路组）、我的线路的「详情」、订阅内容的「线路详情」
  assert.match(read("../../pages/Topology.tsx"), /rule\.kind === "route" \? lineDetailHref\(rule\.id\)/);
  assert.match(read("./MyLinesSection.tsx"), /setLocation\(lineDetailHref\(line\.id\)\)/);
  assert.match(read("../../components/proxy/PreviewRouteDetail.tsx"), /lineDetailHref\(ruleId\)/);
  // 转发规则页认 ?line=；线路概览自己也认（开着时地址栏带着，能分享）
  assert.match(read("../../pages/Rules.tsx"), /<LineDetailFromUrl \/>/);
  assert.match(read("./LineWorkspace.tsx"), /useSearchIdParam\(LINE_PARAM\)/);
  assert.match(read("../../pages/Tunnels.tsx"), /readPositiveParam\(linkLocation, LINE_PARAM\) && activeSection !== "routes"/);
});
