import * as db from "./db";
import {
  buildDiagnosticsReport,
  DIAGNOSTIC_GROUPS,
  type DiagnosticItem,
  type LinkDiagnosticsReport,
} from "../shared/linkDiagnostics";
import { hostTrafficExcluded } from "../shared/hostTrafficPolicy";
import { AGENT_VERSION } from "../shared/versions";
import { requireHostAccess } from "./routers/helpers";
import { buildPanelOnlyDiagnostics } from "./linkDiagnostics";
import { getRulePortWarnings } from "./rulePortOccupancy";
import { dbBool } from "./repositories/repositoryUtils";
import {
  annotateRuleCheckItems,
  enabledRules,
  evaluateHostCheckItems,
  evaluatePortItems,
  evaluateResourceItem,
  evaluateRuleRuntimeItems,
  evaluateUpgradeItem,
  MAX_RULE_ITEMS,
  type ConfigCheckRuleFacts,
} from "./networkConfigCheckItems";

/*
  网络测试页的「配置体检」（对应上游 ForwardX 2.3.286 的「主机 / 规则配置体检」）。

  只读：查库、读内存里的运行状态和端口告警，不给主机派任务、不改任何东西。每一项怎么判在
  networkConfigCheckItems.ts。

  · 主机体检：Agent 装没装、在不在线、版本和 FXP（hostUpgradeReason）、IPv6 监听、资源占用、
    维护 / 流量暂停，以及这台主机上（管理员是全部、普通用户是自己的）启用规则的运行状态和端口冲突；
  · 规则体检：一键诊断的面板那一半（buildPanelOnlyDiagnostics：开关、目标、端口范围、转发方式、
    账户额度、经过的主机、运行状态、端口占用、入口域名、目标地址），再补上「为什么没运行」和外来程序
    占端口；要到主机上实测的项（端口有没有在听、防火墙、目标拨不拨得通）只报个数，让用户去点「诊断」。
*/

type Ctx = { user: { id: number; role: string } };

export type NetworkConfigCheckResult = {
  scope: "host" | "rule";
  report: LinkDiagnosticsReport;
  /** 规则体检：一键诊断里还有这么多项要主机实测，体检没做。 */
  pendingAgentChecks: number;
};

function sortByGroup(items: DiagnosticItem[]) {
  const order = new Map(DIAGNOSTIC_GROUPS.map((group, index) => [group, index] as const));
  return items.map((value, index) => ({ value, index }))
    .sort((a, b) => (order.get(a.value.group)! - order.get(b.value.group)!) || a.index - b.index)
    .map(({ value }) => value);
}

type ForwardRuleRow = Awaited<ReturnType<typeof db.getForwardRules>>[number];

function ruleFacts(rule: ForwardRuleRow, hostId: number, admin: boolean): ConfigCheckRuleFacts {
  return {
    id: Number(rule.id),
    name: String(rule.name || `规则 #${rule.id}`),
    sourcePort: Number(rule.sourcePort || 0),
    sourcePortEnd: rule.sourcePortEnd == null ? null : Number(rule.sourcePortEnd),
    protocol: rule.protocol,
    isEnabled: dbBool(rule.isEnabled, true),
    isRunning: dbBool(rule.isRunning),
    pendingDelete: dbBool(rule.pendingDelete),
    warnings: getRulePortWarnings(rule, admin).filter((warning) => warning.hostId === hostId),
  };
}

export type ConfigCheckRuleOption = {
  id: number;
  name: string;
  sourcePort: number;
  sourcePortEnd: number | null;
  isEnabled: boolean;
  isRunning: boolean;
};

/** 体检能选的规则：这台主机上的（管理员是全部，普通用户只有自己的）。 */
export async function listConfigCheckRules(ctx: Ctx, hostId: number): Promise<ConfigCheckRuleOption[]> {
  await requireHostAccess(ctx, hostId);
  const admin = ctx.user.role === "admin";
  const rules = await db.getForwardRules(admin ? undefined : Number(ctx.user.id), hostId);
  return rules.slice(0, 500).map((rule: ForwardRuleRow) => ({
    id: Number(rule.id),
    name: String(rule.name || `规则 #${rule.id}`),
    sourcePort: Number(rule.sourcePort || 0),
    sourcePortEnd: rule.sourcePortEnd == null ? null : Number(rule.sourcePortEnd),
    isEnabled: dbBool(rule.isEnabled, true),
    isRunning: dbBool(rule.isRunning),
  }));
}

export async function checkHostConfig(ctx: Ctx, hostId: number): Promise<NetworkConfigCheckResult> {
  const host = await requireHostAccess(ctx, hostId);
  const admin = ctx.user.role === "admin";
  // 维护、流量暂停、资源占用是主机自己的状态：管理员和主机主人看；被授权用这台机器的普通用户不看。
  const showHostState = admin || Number(host.userId) === Number(ctx.user.id);
  const name = String(host.name || `主机 #${hostId}`);
  const items: DiagnosticItem[] = evaluateHostCheckItems({
    id: hostId,
    name,
    isOnline: host.isOnline,
    lastHeartbeat: host.lastHeartbeat,
    hasAgent: !!String(host.agentToken || ""),
    agentVersion: host.agentVersion,
    fxpVersion: host.fxpVersion,
    ipv6ListenAvailable: host.ipv6ListenAvailable,
    maintenanceMode: host.maintenanceMode,
    trafficExcluded: hostTrafficExcluded({ ...host, maintenanceMode: false }),
  }, { latestAgentVersion: AGENT_VERSION, showHostState });

  if (showHostState && host.agentToken) {
    const [metric] = await db.getLatestHostMetricRows([hostId]).catch(() => []);
    items.push(evaluateResourceItem({ id: hostId, name, isOnline: host.isOnline }, metric || null));
  }

  if (host.agentToken) {
    const rules = (await db.getForwardRules(admin ? undefined : Number(ctx.user.id), hostId))
      .map((rule: ForwardRuleRow) => ruleFacts(rule, hostId, admin));
    // 没在运行的规则才去端口占用表里查（在跑的显然已经监听成功）；最多查几条，免得一台机器上几百条规则时查太久。
    if (dbBool(host.isOnline)) {
      const stopped = enabledRules(rules).filter((rule) => !rule.isRunning).slice(0, MAX_RULE_ITEMS);
      for (const rule of stopped) {
        if (!rule.sourcePort) continue;
        try {
          const used = await db.isPortUsedOnHost(hostId, rule.sourcePort, [rule.id], rule.protocol, undefined, false);
          const reason = used ? await db.entryBridgePortConflictMessageForHosts([hostId], rule.sourcePort, [rule.id]).catch(() => null) : null;
          rule.portConflict = { used, reason };
        } catch {
          rule.portConflict = null;
        }
      }
    }
    items.push(...evaluateRuleRuntimeItems({ id: hostId, name, isOnline: host.isOnline }, rules));
    items.push(...evaluatePortItems({ id: hostId, name, agentVersion: host.agentVersion }, rules));
  }

  return {
    scope: "host",
    report: buildDiagnosticsReport({
      sessionId: "config-check",
      subject: { kind: "host", id: hostId, name },
      startedAt: new Date().toISOString(),
      items: sortByGroup(items),
    }),
    pendingAgentChecks: 0,
  };
}

export async function checkRuleConfig(ctx: Ctx, ruleId: number): Promise<NetworkConfigCheckResult> {
  // 权限和规则卡上的「诊断」一样（管理员，或规则的主人），在 buildPlan 里查。
  const panel = await buildPanelOnlyDiagnostics(ctx, { kind: "rule", id: ruleId });
  const admin = ctx.user.role === "admin";
  const rule = await db.getForwardRuleById(ruleId);
  let items = annotateRuleCheckItems(panel.report.items, rule ? getRulePortWarnings(rule, admin) : []);
  // 经过的每台主机：版本该不该升级（一键诊断里只写一句「可升级到 x」、算通过）。
  const hosts = await db.getHostsByIds(panel.hostIds).catch(() => []);
  for (const host of hosts) {
    const upgrade = evaluateUpgradeItem({
      id: Number(host.id),
      name: String(host.name || `主机 #${host.id}`),
      agentVersion: host.agentVersion,
      fxpVersion: host.fxpVersion,
    }, AGENT_VERSION, { withName: true, agentOnly: true });
    if (upgrade && upgrade.status !== "pass") items.push(upgrade);
  }
  items = sortByGroup(items);
  return {
    scope: "rule",
    report: buildDiagnosticsReport({
      sessionId: "config-check",
      subject: { kind: "rule", id: ruleId, name: panel.name },
      startedAt: new Date().toISOString(),
      items,
    }),
    pendingAgentChecks: panel.pendingAgentChecks,
  };
}
