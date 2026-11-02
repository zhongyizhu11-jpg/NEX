import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * recharts（gzip 后一百来 KB）只在真的要画图时才下载。
 *
 * 以前隧道页、组页直接 import recharts，主机页、规则页又经由几个弹窗静态引入它，
 * 打开这几页就要先下完整个图表库。现在图表都在单独的模块里、由页面 lazy 引入。
 * 这里守在源码上：页面文件里再出现 `from "recharts"` 或者静态 import 这些图表模块，就报出来。
 */
const src = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(src, file), "utf8");

const PAGES = [
  "pages/Tunnels.tsx",
  "pages/ForwardGroups.tsx",
  "pages/Hosts.tsx",
  "pages/Rules.tsx",
  "features/rules/RouteGroupSheet.tsx",
  "components/hosts/HostSpeedTestSection.tsx",
];

const CHART_MODULES = [
  "components/charts/LatencyLineCharts",
  "components/hosts/HostProbeServiceLatencyDialog",
  "components/proxy/SpeedTestDialog",
  "./RouteQualityHistory",
  "components/rules/TcpingDetailDialog",
];

test("页面不直接 import recharts，也不静态 import 带图表的模块", () => {
  for (const file of PAGES) {
    const source = read(file);
    assert.doesNotMatch(source, /from "recharts"/, `${file} 直接引了 recharts`);
    for (const mod of CHART_MODULES) {
      const staticImport = new RegExp(`^import [^;]*from "(@/)?${mod.replace(/[./]/g, (c) => `\\${c}`)}";`, "m");
      assert.doesNotMatch(source, staticImport, `${file} 静态引了 ${mod}`);
    }
  }
});

test("懒加载的曲线外面有占位，容器高度固定", () => {
  assert.match(read("pages/Tunnels.tsx"), /<Suspense fallback={<Skeleton className="h-full w-full" \/>}>\s*<TunnelLatencyLineChart/);
  assert.match(read("pages/ForwardGroups.tsx"), /<Suspense fallback={[^\n]*正在加载延迟数据[^\n]*}>\s*<GroupLatencyAreaChart/);
  assert.match(read("features/rules/RouteGroupSheet.tsx"), /<Suspense fallback={<RouteQualityHistoryPlaceholder \/>}>/);
});
