import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { scheduleHostDdnsUpdate } from "./hostDdns";
import { normalizeHostDdnsValueMode } from "../shared/hostDdnsPlan";
import {
  hostDetectedAddressesSignature,
  normalizeHostDetectedAddressReport,
  parseHostDetectedAddresses,
  serializeHostDetectedAddresses,
} from "../shared/hostPublicAddresses";

/*
  心跳里的 publicAddresses（Agent 2.2.255+，agent/public_addresses.go）落库。

  单独一个模块、单独一次写：心跳路由那边只多一行调用（那个文件别的功能也在改，改动越少越好），
  也不掺进 updateHostHeartbeat 那一大包 —— 地址列表十分钟才报一次，没变就一个字节都不写。

  列表变了不碰 ip / ipv4 / ipv6：那几栏由 mergeAgentReportedAddress（主 IP 选择也在那里）管。
  这里只多做一件事：主机 DDNS 选了「全部 IP」时列表就是记录值，变了要重发。
*/

/** 心跳路由手里的主机行：这里只读写这几栏。 */
type DetectedAddressHost = {
  id?: unknown;
  detectedAddresses?: unknown;
  ddnsEnabled?: unknown;
  ddnsValueMode?: unknown;
};
type HeartbeatBody = { publicAddresses?: unknown; [key: string]: unknown } | null | undefined;

/** 返回要写进 detectedAddresses 的新值；没带列表或者没变返回 null。 */
export function detectedAddressesUpdate(host: DetectedAddressHost | null | undefined, body: HeartbeatBody, nowMs = Date.now()): string | null {
  const report = normalizeHostDetectedAddressReport(body?.publicAddresses, nowMs);
  if (!report) return null;
  const previous = parseHostDetectedAddresses(host?.detectedAddresses);
  if (previous && hostDetectedAddressesSignature(previous) === hostDetectedAddressesSignature(report)) return null;
  return serializeHostDetectedAddresses(report);
}

export async function syncHostDetectedAddresses(host: DetectedAddressHost, body: HeartbeatBody) {
  const next = detectedAddressesUpdate(host, body);
  if (next === null) return false;
  const hostId = Number(host?.id || 0);
  if (!(hostId > 0)) return false;
  await db.updateHost(hostId, { detectedAddresses: next });
  host.detectedAddresses = next;
  if (host?.ddnsEnabled && normalizeHostDdnsValueMode(host?.ddnsValueMode) === "all") {
    scheduleHostDdnsUpdate(host, "agent-address-list-changed");
  }
  return true;
}

/** 心跳路由用：失败只记日志，绝不能让一次地址列表写库失败把整次心跳拖垮。 */
export async function syncHostDetectedAddressesSafely(host: DetectedAddressHost, body: HeartbeatBody) {
  try {
    return await syncHostDetectedAddresses(host, body);
  } catch (error) {
    appendPanelLog("warn", `[HostAddress] detected address list sync failed host=${Number(host?.id || 0)}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
