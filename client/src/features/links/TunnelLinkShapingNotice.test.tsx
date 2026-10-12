import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TunnelLinkShapingNotice, tunnelLinkShapingText } from "./TunnelLinkShapingNotice";

test("卡片上只显示真的在整形或出了状况的方向", () => {
  const tunnel = {
    linkShapingStatus: [
      { direction: "up", state: "watching", rateMbps: 0, learnedMbps: 0 },
      { direction: "down", state: "shaping", rateMbps: 1498, learnedMbps: 1520 },
    ],
  };
  assert.equal(tunnelLinkShapingText(tunnel), "链路整形：出口→入口 1520 Mbit/s");
  assert.match(renderToStaticMarkup(<TunnelLinkShapingNotice tunnel={tunnel} />), /data-link-shaping/);

  assert.equal(tunnelLinkShapingText({ linkShapingStatus: [{ direction: "up", state: "shaping", rateMbps: 900, learnedMbps: 0 }] }), "链路整形：入口→出口 正在找限速点（900 Mbit/s）");
  assert.equal(tunnelLinkShapingText({ linkShapingStatus: [{ direction: "up", state: "paused" }] }), "链路整形：入口→出口 暂停（不像限速器）");
  assert.equal(tunnelLinkShapingText({ linkShapingStatus: [{ direction: "up", state: "watching" }] }), "");
  assert.equal(renderToStaticMarkup(<TunnelLinkShapingNotice tunnel={{ linkShapingStatus: [] }} />), "");
  assert.equal(tunnelLinkShapingText(null), "");
});

test("面板标成过期的上报不显示：关掉整形、换了协议之后 FXP 不再报", () => {
  const tunnel = {
    linkShapingStatus: [
      { direction: "down", state: "shaping", rateMbps: 376, learnedMbps: 0, stale: true },
    ],
  };
  assert.equal(tunnelLinkShapingText(tunnel), "");
  assert.equal(renderToStaticMarkup(<TunnelLinkShapingNotice tunnel={tunnel} />), "");
  // 一个方向过期、另一个还在报：只显示还在报的那个
  assert.equal(
    tunnelLinkShapingText({
      linkShapingStatus: [
        { direction: "down", state: "shaping", rateMbps: 376, learnedMbps: 0, stale: true },
        { direction: "up", state: "shaping", rateMbps: 900, learnedMbps: 880 },
      ],
    }),
    "链路整形：入口→出口 880 Mbit/s",
  );
});
