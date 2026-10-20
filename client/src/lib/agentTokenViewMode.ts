import { readStoredViewMode, writeStoredViewMode } from "@/lib/viewModeStorage";

export type AgentTokenViewMode = "card" | "table";

const STORAGE_KEY = "forwardx.agentTokens.viewMode";

/**
 * Token 列表用卡片还是表格，记在本地。
 *
 * 主机管理页和 Token 管理组件原来各存一份读写实现**和同一个 storage key** ——
 * 两份读写同一把锁，改哪一份都只改了一半。
 */
export function getStoredAgentTokenViewMode(): AgentTokenViewMode {
  return readStoredViewMode<AgentTokenViewMode>(STORAGE_KEY, ["table", "card"], "card");
}

export function storeAgentTokenViewMode(viewMode: AgentTokenViewMode) {
  writeStoredViewMode(STORAGE_KEY, viewMode);
}
