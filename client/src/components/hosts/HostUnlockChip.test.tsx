import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { unlockChipItems } from "@shared/unlockCheck";
import HostUnlockChip, { hostUnlockChipTitle } from "./HostUnlockChip";
import { UnlockStatusBadge } from "./HostUnlockSection";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("主机卡摘要：测过才画，颜色跟结论走", () => {
  assert.equal(renderToStaticMarkup(<HostUnlockChip summary={null} />), "");
  assert.equal(renderToStaticMarkup(<HostUnlockChip summary={{ family: "auto", checkedAt: 0, items: [] }} />), "");
  const items = unlockChipItems([
    { service: "netflix", status: "ok" },
    { service: "chatgpt", status: "partial" },
    { service: "claude", status: "blocked" },
    { service: "gemini", status: "unknown" },
  ]);
  const summary = { family: "ipv6" as const, checkedAt: 1_800_000_000, items };
  const html = renderToStaticMarkup(<HostUnlockChip summary={summary} />);
  assert.match(html, /NF 全解/);
  assert.match(html, /fx-healthy-text[^>]*>NF 全解/);
  assert.match(html, /fx-warn-text[^>]*>GPT 半/);
  assert.match(html, /fx-down-text[^>]*>Claude ✗/);
  assert.match(html, /text-muted-foreground">Gemini \?/);
  assert.match(hostUnlockChipTitle(summary), /^流媒体 \/ AI 解锁（IPv6 · /);
  assert.match(hostUnlockChipTitle(summary), /Claude：不可用/);
});

test("状态徽标：四种结论各一种颜色", () => {
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="ok" />), /fx-healthy-soft[^>]*>可用</);
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="partial" />), /fx-warn-soft[^>]*>部分可用</);
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="blocked" />), /fx-down-soft[^>]*>不可用</);
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="unknown" />), /fx-stroke-base[^>]*>无法判断</);
});

test("详情里有这一节；旧 Agent 提示升级；按钮和计划检测只给管理员", () => {
  const dialog = read("./HostDetailDialog.tsx");
  assert.match(dialog, /<HostUnlockSection hostId=\{Number\(host\.id\)\} \/>/);
  const section = read("./HostUnlockSection.tsx");
  assert.match(section, /需要升级 Agent/);
  assert.match(section, /检测解锁/);
  assert.ok(section.includes("{data.canManage ? ("), "「检测解锁」按钮只给管理员");
  assert.match(section, /data\.canManage && data\.schedule \?/);
  assert.match(section, /trpc\.hosts\.unlockHistory/);
  assert.match(read("./HostSummaryCard.tsx"), /<HostUnlockChip summary=\{host\?\.unlockSummary\} \/>/);
});
