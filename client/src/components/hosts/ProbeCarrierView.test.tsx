import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CarrierCaveat } from "./ProbeCarrierView";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("三网视图：讲清楚固定目标不回不等于整网断了、丢包和 TCP 失败不是一回事", () => {
  const html = renderToStaticMarkup(<CarrierCaveat />);
  assert.match(html, /不代表这家运营商整体断了/);
  assert.match(html, /丢包/);
  assert.match(html, /TCP 失败/);
});

test("三网视图挂在服务页里、懒加载；图表单独一个模块，不把 recharts 带进主机页", () => {
  const manager = read("./HostProbeServiceManager.tsx");
  assert.match(manager, /lazy\(\(\) => import\("\.\/ProbeCarrierView"\)\)/);
  assert.match(manager, /三网视图/);
  const view = read("./ProbeCarrierView.tsx");
  assert.doesNotMatch(view, /from "recharts"/);
  assert.match(view, /lazy\(\(\) => import\("\.\/ProbeCarrierCharts"\)\)/);
  assert.match(view, /单机/);
  assert.match(view, /双机对比/);
  assert.match(view, /添加上海三网预设/);
});
