import { normalizePanelUrl, resolveAgentAdvertisedPanelUrl } from "./agentPanelUrl";
import { getMigratedToPanelUrl, getPanelMigrationAgentDirective } from "./panelMigrationAgentState";
import { isAgentVersionAtLeast } from "../shared/version";
import { hostPolicyBool } from "../shared/hostTrafficPolicy";
import { HOST_AGENT_PANEL_URL_AGENT_VERSION } from "../shared/hostAgentPanelUrl";

export { HOST_AGENT_PANEL_URL_AGENT_VERSION };

/*
  主机独立的 Agent 面板连接地址（上游 2.3.295 的行为）。

  默认所有 Agent 都连「面板公开地址」。有的机器走不通那个地址（国内线路、出站端口受限，或者要经另一层
  反代），管理员可以给这台主机单独填一个指向同一面板的地址：
  - 这台主机的安装 / 升级命令用它；
  - 心跳回包里的 panelUrl 换成它，在线的 Agent 不用重装就会切过去。

  切过去之前 Agent 先用自己的 Token 对新地址做一次认证探测（agent/panel_url_switch.go），通了才落盘，
  不通就继续用原来的地址 —— 填错一个字不会把 Agent 弄丢。只有认得这套探测的 Agent
  （HOST_AGENT_PANEL_URL_AGENT_VERSION 起）才会收到独立地址；更旧的 Agent 收到地址就直接切，
  所以对它们继续发全局地址，行为和以前一样，要用独立地址就先升级或者用新地址重装。

  面板迁移进行中 / 已经迁走时一律发全局地址：迁移有自己的切换和回退流程，不能被这里插一脚。
*/

export type HostAgentPanelUrlFields = {
  id?: unknown;
  agentPanelUrlEnabled?: unknown;
  agentPanelUrl?: unknown;
  agentVersion?: unknown;
};

/** 这台主机配置的独立地址（没开、填的不合法都回空串）。 */
export function hostAgentPanelUrlOverride(host: HostAgentPanelUrlFields | null | undefined): string {
  if (!host || !hostPolicyBool(host.agentPanelUrlEnabled)) return "";
  return normalizePanelUrl(String(host.agentPanelUrl || ""));
}

/** 纯判定，单独导出给测试：有独立地址、Agent 够新、没有迁移在进行时用独立地址。 */
export function selectHostAgentPanelUrl(input: {
  host: HostAgentPanelUrlFields | null | undefined;
  globalPanelUrl: string;
  migrationActive: boolean;
}) {
  const override = hostAgentPanelUrlOverride(input.host);
  if (!override || input.migrationActive) return input.globalPanelUrl;
  if (!isAgentVersionAtLeast(String(input.host?.agentVersion || ""), HOST_AGENT_PANEL_URL_AGENT_VERSION)) return input.globalPanelUrl;
  return override;
}

/** 心跳回包里给这台主机的 panelUrl。 */
export async function resolveHostAgentAdvertisedPanelUrl(host: HostAgentPanelUrlFields | null | undefined): Promise<string> {
  const globalPanelUrl = await resolveAgentAdvertisedPanelUrl();
  if (!hostAgentPanelUrlOverride(host)) return globalPanelUrl;
  const hostId = Number(host?.id || 0);
  const migrationActive = !!(await getMigratedToPanelUrl().catch(() => null))
    || !!(await getPanelMigrationAgentDirective(hostId > 0 ? hostId : undefined).catch(() => null));
  return selectHostAgentPanelUrl({ host, globalPanelUrl, migrationActive });
}
