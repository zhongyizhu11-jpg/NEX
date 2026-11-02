import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { Tabs } from "@/components/ui/tabs";
import { LinkSectionTabsBar, splitLinkSections } from "./LinkSectionTabs";

type Section = "tunnels" | "ports" | "chains" | "groups" | "pools" | "routes";
const ITEMS = [
  { value: "tunnels", label: "隧道链路" },
  { value: "ports", label: "端口转发" },
  { value: "chains", label: "转发链" },
  { value: "groups", label: "转发组" },
  { value: "pools", label: "节点池" },
  { value: "routes", label: "线路概览" },
] as const;
const PRIMARY = ["tunnels", "ports", "routes"] as const;

function render(active: Section) {
  return renderToStaticMarkup(
    <Tabs value={active}>
      <LinkSectionTabsBar<Section> items={ITEMS} primary={PRIMARY} groups={[{ label: "转发", values: ["chains", "groups"] }]} activeValue={active} onValueChange={() => undefined} ariaLabel="链路管理" />
    </Tabs>,
  );
}

test("分类条：常用的摆在条上（先后照旧），其余收进「更多」", () => {
  const split = splitLinkSections(ITEMS, PRIMARY);
  assert.deepEqual(split.primary.map((item) => item.value), ["tunnels", "ports", "routes"]);
  assert.deepEqual(split.more.map((item) => item.value), ["chains", "groups", "pools"]);
  const html = render("tunnels");
  assert.match(html, /隧道链路/);
  assert.match(html, /端口转发/);
  assert.match(html, /线路概览/);
  assert.match(html, />更多</);
  // 收起来的页签平时不在条上
  assert.doesNotMatch(html, /节点池/);
  assert.match(html, /data-testid="link-section-more"[^>]*data-state="inactive"|data-state="inactive"[^>]*data-testid="link-section-more"/);
});

test("分类条：选中的是「更多」里的一页时，那一格写它的名字、是选中态", () => {
  const html = render("pools");
  assert.match(html, /节点池/);
  assert.doesNotMatch(html, />更多</);
  const more = html.match(/<button[^>]*data-testid="link-section-more"[^>]*>/)?.[0] || "";
  assert.match(more, /data-state="active"/);
});

test("链路管理：九个页签的值（?tab=）一个没少，条上只摆三个", () => {
  const source = readFileSync(new URL("../../pages/Tunnels.tsx", import.meta.url), "utf8");
  assert.match(source, /const TUNNEL_SECTIONS = \["tunnels", "lines", "ports", "chains", "pools", "groups", "aggregates", "entries", "exits", "routes"\]/);
  assert.match(source, /const TUNNEL_PRIMARY_SECTIONS = \["tunnels", "ports", "routes"\]/);
  assert.match(source, /<LinkSectionTabs/);
});
