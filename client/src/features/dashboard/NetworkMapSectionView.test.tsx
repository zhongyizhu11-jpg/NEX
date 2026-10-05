import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { NetworkOverviewSection, buildNetworkMapModel } from "./NetworkMapSection";

const now = 1_700_000_000_000;
const host = (id: number, name: string, geo?: [number, number], countryCode?: string) => ({
  id, name, isOnline: true, lastHeartbeat: now - 1000,
  ...(geo ? { geoLatitudeMicro: Math.round(geo[0] * 1e6), geoLongitudeMicro: Math.round(geo[1] * 1e6) } : {}),
  ...(countryCode ? { geoCountryCode: countryCode } : {}),
});

test("概览卡片：标题、状态胶囊、底下的图例（线路 / 转发 / 主机），图里有点阵、主机点和合成的线，没有地图引擎的壳", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, "HK", [22.32, 114.17], "HK"), host(2, "JP", [35.68, 139.65]), host(3, "无坐标")],
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
  assert.match(html, /线路 <b>2<\/b> · 转发 <b>2<\/b>/);
  assert.match(html, /data-tone="ok"[^>]*>.*?全部正常/, "没有断的、没有降级的，胶囊写全部正常");
  assert.doesNotMatch(html, /中断|降级/, "没有断的不写中断");
  assert.ok((html.match(/<image [^>]*href="\/globe\/earth-day.jpg"/g) || []).length === 2, "底下铺着地球图（本体一份、+360° 一份）");
  assert.match(html, /aria-label="概览：3 台主机，3 段连线"/);
  assert.match(html, /HK → JP · 隧道 live/);
  assert.match(html, /JP → 无坐标 · 2 条转发/);
  assert.match(html, /HK → 无坐标 · 隧道 paused · 停用/);
  assert.match(html, /未定位/);
  assert.match(html, /class="fx-overview-city">(🇭🇰|HK) /, "标签第一行是旗（画不出时是国家码）+ 城市");
  assert.doesNotMatch(html, /nm-mini|maplibre/);
});

test("概览卡片：有主机掉线时胶囊写几台离线，指向它的转发在图例里算降级", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, "HK", [22.32, 114.17]), { ...host(2, "JP", [35.68, 139.65]), isOnline: false, lastHeartbeat: now - 10 * 60_000 }],
    tunnels: [],
  });
  const html = renderToStaticMarkup(
    <NetworkOverviewSection model={model} forwardLinks={[{ fromHostId: 1, toHostId: 2, rules: 1, enabled: 1 }]} onOpen={() => {}} />,
  );
  assert.match(html, /data-tone="warn"[^>]*>.*?1 台离线/);
  assert.match(html, /降级 <b>1<\/b>/);
  assert.doesNotMatch(html, /中断/);
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
