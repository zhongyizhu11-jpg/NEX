/*
  从原版 ForwardX 迁过来以后，已接入的 Agent 换成 NEX 的 Agent。

  迁移命令（scripts/install-panel-*.sh migrate-forwardx → dist/migrate-forwardx.js）导完数据后在
  system_settings 里写 FORWARDX_AGENT_MIGRATION_SETTING。开着它时，每次完整心跳：
    - 认出这台机器跑的是原版 ForwardX 的 Agent（shared/agentDistribution.ts）、而且没在升级中 →
      给它排一次升级，目标版本 = 面板自带的 AGENT_VERSION，目标发行来源 = nex；
    - Agent 收到后去「面板」的 /api/agent/install.sh 取安装脚本（原版 Agent 不验签，见 agent/upgrade.go
      的上游实现），脚本里写死的下载地址是 NEX 的 GitHub Release / 面板转发 —— 换上的就是 NEX 发的 Agent；
    - 新 Agent 心跳报 agentDistribution=nex 以后升级才算完成（agentRouteUtils.isAgentUpgradeCompleted）。
  升级没成（下载失败、机器不支持）时面板 10 分钟后清掉这次请求（clearStaleHostAgentUpgradeRequests），
  这里同一台机器至少隔 FORWARDX_AGENT_MIGRATION_RETRY_MS 才再排一次，不会每次心跳都重跑安装脚本。

  NEX 自己的 Agent（报了 nex，或者是带 agentCapabilities 的老 NEX Agent）一律不碰。
*/
import { FORWARDX_AGENT_DISTRIBUTION, normalizeAgentDistribution } from "../shared/agentDistribution";
import * as db from "./db";

export const FORWARDX_AGENT_MIGRATION_SETTING = "forwardxAgentMigration";
export const FORWARDX_AGENT_MIGRATION_RETRY_MS = 30 * 60 * 1000;
const SETTING_TTL_MS = 30 * 1000;

let settingCache: { enabled: boolean; loadedAt: number } | null = null;
const lastQueuedAt = new Map<number, number>();

/** 设置值：JSON（{ enabled: true, ... }）或者 "true"。别的（空、false、解析失败）都当关。 */
export function parseForwardxAgentMigrationSetting(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/^(1|true|yes|on)$/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text);
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

export async function isForwardxAgentMigrationEnabled(now = Date.now()) {
  if (settingCache && now - settingCache.loadedAt < SETTING_TTL_MS) return settingCache.enabled;
  const enabled = parseForwardxAgentMigrationSetting(await db.getSetting(FORWARDX_AGENT_MIGRATION_SETTING).catch(() => null));
  settingCache = { enabled, loadedAt: now };
  return enabled;
}

export function resetForwardxAgentMigrationStateForTests() {
  settingCache = null;
  lastQueuedAt.clear();
}

/** 这次心跳要不要给这台机器排「换成 NEX Agent」的升级。纯判断，不写库。 */
export function shouldQueueForwardxAgentMigration(input: {
  enabled: boolean;
  hostId: number;
  agentDistribution: unknown;
  agentUpgradeRequested: unknown;
  now?: number;
}) {
  if (!input.enabled || !(input.hostId > 0)) return false;
  if (input.agentUpgradeRequested) return false;
  if (normalizeAgentDistribution(input.agentDistribution) !== FORWARDX_AGENT_DISTRIBUTION) return false;
  const now = input.now ?? Date.now();
  const previous = lastQueuedAt.get(input.hostId) || 0;
  return !previous || now - previous >= FORWARDX_AGENT_MIGRATION_RETRY_MS;
}

export function markForwardxAgentMigrationQueued(hostId: number, now = Date.now()) {
  lastQueuedAt.set(hostId, now);
  // 防止主机很多时这张表无限长：只留最近排过的
  if (lastQueuedAt.size > 10_000) {
    const oldest = [...lastQueuedAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, lastQueuedAt.size - 10_000);
    for (const [id] of oldest) lastQueuedAt.delete(id);
  }
}
