import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { NetworkOverviewSection, buildNetworkMapModel } from "./NetworkMapSection";

const now = 1_700_000_000_000;
const host = (id: number, name: string, geo?: [number, number]) => ({
  id, name, isOnline: true, lastHeartbeat: now - 1000,
  ...(geo ? { geoLatitudeMicro: Math.round(geo[0] * 1e6), geoLongitudeMicro: Math.round(geo[1] * 1e6) } : {}),
});

test("概览卡片：标题、图例（主机 / 隧道 / 转发），图里有主机点、隧道线和转发线，没有地图引擎的壳", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, "HK", [22.32, 114.17]), host(2, "JP", [35.68, 139.65]), host(3, "无坐标")],
    tunnels: [
      { id: 1, name: "live", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2 },
      { id: 2, name: "paused", mode: "forwardx", isEnabled: false, entryHostId: 1, exitHostId: 3 },
    ],
  });
  const html = renderToStaticMarkup(
    <NetworkOverviewSection model={model} forwardLinks={[{ fromHostId: 2, toHostId: 3, rules: 2, enabled: 2 }]} onOpen={() => {}} />,
  );
  assert.match(html, /aria-label="概览"/);
  assert.match(html, />概览</);
  assert.match(html, /3 台主机/);
  assert.match(html, /隧道 <span[^>]*>2<\/span>/);
  assert.match(html, /转发 <span[^>]*>2<\/span>/);
  assert.doesNotMatch(html, /中断/, "没有断的不写中断");
  assert.match(html, /aria-label="概览：3 台主机，3 段连线"/);
  assert.match(html, /HK → JP · 隧道 live/);
  assert.match(html, /JP → 无坐标 · 2 条转发/);
  assert.match(html, /未定位/);
  assert.doesNotMatch(html, /nm-mini|maplibre/);
});

test("概览卡片：一条线也没有时写一句怎么连，经过看不到的主机的隧道说明没画出来", () => {
  const empty = buildNetworkMapModel({ now, hosts: [host(1, "a")], tunnels: [] });
  assert.match(renderToStaticMarkup(<NetworkOverviewSection model={empty} forwardLinks={[]} onOpen={() => {}} />), /还没有连线/);
  const hidden = buildNetworkMapModel({
    now,
    hosts: [host(1, "a")],
    tunnels: [{ id: 5, name: "shared", mode: "tls", isEnabled: true, entryHostId: 1, exitHostId: null, hopHostIds: [1], availability: { status: "available", available: true, source: "hosts", message: "ok" } }],
  });
  assert.match(renderToStaticMarkup(<NetworkOverviewSection model={hidden} forwardLinks={[]} onOpen={() => {}} />), /1 条隧道经过你看不到的主机，没有画出来/);
});
