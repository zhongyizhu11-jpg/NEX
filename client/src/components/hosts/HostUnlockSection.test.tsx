import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import HostUnlockSection, { UnlockStatusBadge } from "./HostUnlockSection";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("状态徽标：四种结论各一种颜色", () => {
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="ok" />), /fx-healthy-soft[^>]*>可用</);
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="partial" />), /fx-warn-soft[^>]*>部分可用</);
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="blocked" />), /fx-down-soft[^>]*>不可用</);
  assert.match(renderToStaticMarkup(<UnlockStatusBadge status="unknown" />), /fx-stroke-base[^>]*>无法判断</);
});

test("详情里有这一节：默认折叠，展开是出口检测那副面板；旧 Agent 提示升级；只有 IPv4 / IPv6 手动检测且只给管理员；主机卡片上不显示解锁摘要", () => {
  const dialog = read("./HostDetailDialog.tsx");
  assert.match(dialog, /<HostUnlockSection hostId=\{Number\(host\.id\)\} \/>/);
  const section = read("./HostUnlockSection.tsx");
  assert.match(section, /需要升级 Agent/);
  assert.match(section, /<CollapsibleSection title="流媒体 \/ AI 解锁">/, "默认折叠");
  assert.match(section, /<ExitHostPanel host=\{quality\.data\.host\} targets=\{quality\.data\.targets\} \/>/, "展开后和订阅页「出口检测」同一副面板");
  assert.ok(section.includes("{data?.canManage ? ("), "检测按钮只给管理员");
  assert.match(section, /family: "ipv4", label: "检测 IPv4"/);
  assert.match(section, /family: "ipv6", label: "检测 IPv6"/);
  assert.doesNotMatch(section, /计划检测|unlockHistory|检测用的出口|最近检测/, "没有计划检测、历史、协议族选择、最近检测那几行");
  assert.doesNotMatch(read("./HostSummaryCard.tsx"), /unlock/i);
  assert.equal(renderToStaticMarkup(<HostUnlockSection hostId={0} />), "");
});
