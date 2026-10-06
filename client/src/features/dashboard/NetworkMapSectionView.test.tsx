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

test("概览卡片：标题、状态胶囊、底下的图例（线的画法 + 主机数，不再自己数线路），图里有陆地和国界底图、主机点和合成的线，没有地图引擎的壳", () => {
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
  assert.match(html, /data-tone="ok"><\/span>正常/);
  assert.doesNotMatch(html, /线路 <b>/, "图例不再自己数线路 / 转发：总数在页头，三处各数各的会对不上");
  assert.match(html, /data-tone="ok"[^>]*>.*?全部正常/, "没有断的、没有降级的，胶囊写全部正常");
  assert.doesNotMatch(html, /中断|降级/, "没有断的不写中断");
  assert.match(html, /class="fx-overview-land"/, "底下铺着陆地");
  assert.match(html, /class="fx-overview-borders"/, "和陆地国界");
  assert.equal((html.match(/<path [^>]*vector-effect="non-scaling-stroke"/g) || []).length, 6, "浅滩、陆地、国界各画两份（本体一份、+360° 一份）");
  assert.match(html, /class="fx-overview-shore"/, "陆地外一圈浅滩");
  assert.match(html, /class="fx-overview-graticule"/, "海面一层经纬网");
  assert.match(html, /3 台主机 · 3 个地点/, "标题旁写主机数和地点数");
  assert.match(html, /aria-label="概览：3 台主机，3 个地点，3 段连线"/);
  assert.match(html, /HK → JP · 隧道 live/);
  assert.match(html, /JP → 无坐标 · 2 条转发/);
  assert.match(html, /HK → 无坐标 · 隧道 paused · 停用/);
  assert.match(html, /未定位/);
  assert.match(html, /class="fx-overview-city">(🇭🇰|HK) /, "标签第一行是旗（画不出时是国家码）+ 城市");
  assert.doesNotMatch(html, /nm-mini|maplibre/);
});

test("概览卡片：有主机掉线时胶囊写几台离线，指向它的转发画成降级、图例列出降级", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, "HK", [22.32, 114.17]), { ...host(2, "JP", [35.68, 139.65]), isOnline: false, lastHeartbeat: now - 10 * 60_000 }],
    tunnels: [],
  });
  const html = renderToStaticMarkup(
    <NetworkOverviewSection model={model} forwardLinks={[{ fromHostId: 1, toHostId: 2, rules: 1, enabled: 1 }]} onOpen={() => {}} />,
  );
  assert.match(html, /data-tone="warn"[^>]*>.*?1 台离线/);
  assert.match(html, /data-tone="warn"><\/span>降级/, "指向掉线主机的转发画成降级，图例列出降级");
  assert.doesNotMatch(html, /中断/);
});

test("概览卡片：两头都在同一个点里的线不画，图例也不列它的样式，点的提示里说点内连线中断", () => {
  const model = buildNetworkMapModel({
    now,
    hosts: [host(1, "GZ-1", [23.13, 113.26]), host(2, "GZ-2", [23.13, 113.26])],
    tunnels: [{ id: 1, name: "local", mode: "forwardx", isEnabled: true, entryHostId: 1, exitHostId: 2, availability: { status: "unavailable", available: false, source: "hosts", message: "x" } }],
  });
  const html = renderToStaticMarkup(<NetworkOverviewSection model={model} forwardLinks={[]} onOpen={() => {}} />);
  assert.match(html, /1 条中断/, "胶囊照旧数隧道");
  assert.doesNotMatch(html, /data-tone="down"><\/span>中断/, "线没画出来，图例别说有中断的线");
  assert.match(html, /aria-label="概览：2 台主机，1 个地点，0 段连线"/);
  assert.match(html, /正常 · 点内连线中断/, "两台都在线，提示里要说点内那条隧道断了");
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
