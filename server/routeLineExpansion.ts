import { appendPanelLog } from "./_core/panelLogger";
import { buildRouteExpandContext } from "./nodePools";
import { getForwardRuleById, updateForwardRule } from "./repositories/forwardRuleRepository";
import { getTunnelById } from "./repositories/tunnelRepository";
import { getUserById } from "./repositories/userRepository";
import { dbBool } from "./repositories/repositoryUtils";
import { legacyFailoverColumns, syncRouteRelayRulesForRule } from "./routeGroups";
import { parseRoutePaths, routeGroupOf, serializeRoutePaths, type RoutePath } from "../shared/routeGroup";
import { expandRouteLines, parseRouteLines, routeLinesOf, serializeRouteLines, type RouteLine } from "../shared/routeLines";

/*
  线路 → 路径（保存时、节点池变了时）。展开本身在 shared/routeLines.ts；这里管上下文（看得见哪些机器、
  池里有谁、隧道在不在）、报错的口径，以及落库后让中继跟上。
*/

/** 调度器在哪台机器上：隧道规则在隧道出口机，其余在规则所在的机器（和 rules.crud 的 routeEntryHostId 一致）。 */
async function schedulerHostOf(hostId: number, tunnelId: number | null | undefined) {
  if (!tunnelId) return hostId;
  const tunnel = await getTunnelById(Number(tunnelId)).catch(() => null) as any;
  return Number(tunnel?.exitHostId || hostId);
}

/**
 * 编辑框提交的 routeGroup 带了 lines：展开成 paths 塞回去（其余字段原样），交给原来的保存流程。
 * 没带 lines 的老界面 / 机器人原样过。展开不出来的线路直接报错：保存一个看着有、实际没路径的线路
 * 比拒绝保存更糟。
 */
export async function expandRouteGroupInputLines<T extends { routeGroup?: any }>(
  input: T,
  actor: { id: number; role: string },
  hostId: number,
  tunnelId: number | null | undefined,
  options: { groupTemplate?: boolean; ruleTargetNodeId?: number | null } = {},
): Promise<T> {
  const group = input.routeGroup;
  if (!group || !Array.isArray(group.lines) || group.lines.length === 0) return input;
  const lines = parseRouteLines(group.lines);
  if (lines.length === 0) throw new Error("线路组至少要有一条线路");
  const entryHostId = await schedulerHostOf(hostId, tunnelId);
  const tunnelInLines = lines.some((line) => line.layers.some((layer) => layer.tunnelIds.length > 0));
  if (tunnelInLines && tunnelId) throw new Error("隧道规则的线路在隧道出口之后选路，不能再在线路里放隧道段：把规则改成端口转发、把隧道放进线路里");
  // 端口转发资源（转发组模板）在每台成员机上各跑一份，入口不是同一台，隧道段的「入口必须是上一个节点」对不上。
  if (tunnelInLines && options.groupTemplate) throw new Error("端口转发资源的线路在每台成员机上各跑一份，入口不是同一台机器，不能放隧道段：用中转机或节点池");
  if (group.delivery === "replicate") await assertReplicateReady(lines[0]);
  // 规则目标绑着落地池的池节点时，「规则目标」那个落地展开成池里每台成员
  const ruleTargetNodeId = (input as any).proxyNodeId !== undefined ? Number((input as any).proxyNodeId || 0) || null : options.ruleTargetNodeId ?? null;
  const context = await buildRouteExpandContext(actor, entryHostId, lines, { ruleTargetNodeId });
  const { paths, issues } = expandRouteLines(lines, context);
  for (const line of lines) {
    const issue = issues.get(line.key);
    if (issue) throw new Error(`线路「${line.name || line.key}」用不了：${issue}`);
  }
  if (paths.length < 2) throw new Error("线路组至少要两条路径：再加一条备用，或者给一层放两个候选");
  /*
    钉子和时段表按「第几条路径」记，编辑框按它自己预览展开的顺序给；服务端这边按实测延迟排，顺序
    可能不同。按线路对上：编辑框那条路径属于哪条线路，就换成服务端这条线路的第一条。
  */
  const clientPaths: Array<{ lineKey?: string | null }> = Array.isArray(group.paths) ? group.paths : [];
  const toServerIndex = (index: number) => {
    const lineKey = clientPaths[index]?.lineKey;
    const found = lineKey ? paths.findIndex((path) => path.lineKey === lineKey) : -1;
    return found >= 0 ? found : Math.min(Math.max(0, index), paths.length - 1);
  };
  const pin = group.pin ? { ...group.pin, index: toServerIndex(Number(group.pin.index) || 0) } : group.pin;
  const schedule = group.schedule && Array.isArray(group.schedule.windows)
    ? { ...group.schedule, windows: group.schedule.windows.map((window: any) => ({ ...window, targetIndex: toServerIndex(Number(window.targetIndex) || 0) })) }
    : group.schedule;
  return {
    ...input,
    routeGroup: {
      ...group,
      pin,
      schedule,
      lines,
      paths: paths.map((path) => ({
        key: path.key,
        name: path.name,
        hops: path.hops,
        hopVia: path.hopVia,
        dest: path.dest,
        destNodeId: path.destNodeId,
        destHostId: path.destHostId ?? null,
        weight: path.weight,
        tier: path.tier,
        paused: path.paused,
        lineKey: path.lineKey,
      })),
    },
  };
}

/** 线路没变、上下文变了（池里加减了机器）：重新展开、落库、同步中继。 */
export async function reexpandRouteLinesForRules(ruleIds: readonly number[], reason: string) {
  let changed = 0;
  for (const ruleId of ruleIds) {
    try {
      const rule = await getForwardRuleById(Number(ruleId)) as any;
      if (!rule || dbBool(rule.pendingDelete) || !routeGroupOf(rule)) continue;
      // 转发组的子规则照抄模板（forwardGroupRepository.childRouteColumns）：只展开模板，子规则跟着组同步走。
      if (Number(rule.forwardGroupRuleId || 0) > 0) continue;
      const lines: RouteLine[] = routeLinesOf(rule);
      if (lines.length === 0) continue;
      const owner = await getUserById(Number(rule.userId)) as any;
      const actor = { id: Number(rule.userId), role: String(owner?.role || "user") };
      const entryHostId = await schedulerHostOf(Number(rule.hostId), rule.tunnelId);
      const context = await buildRouteExpandContext(actor, entryHostId, lines, { ruleTargetNodeId: Number(rule.proxyNodeId || 0) || null });
      const { paths } = expandRouteLines(lines, context);
      if (paths.length < 2) {
        appendPanelLog("warn", `[RouteLines] rule=${ruleId} 重新展开只剩 ${paths.length} 条路径，保持原样（${reason}）`);
        continue;
      }
      const stored = new Map(parseRoutePaths(rule.routePaths).map((path) => [path.key, path]));
      const merged: RoutePath[] = paths.map((path) => {
        const previous = stored.get(path.key);
        const same = previous && previous.hops.join(".") === path.hops.join(".") && (previous.hopVia || []).join(".") === (path.hopVia || []).join(".")
          && Number(previous.destHostId || 0) === Number(path.destHostId || 0);
        return same ? { ...path, dial: previous!.dial, issue: previous!.issue, probe: previous!.probe } : path;
      });
      const next = serializeRoutePaths(merged);
      if (next === rule.routePaths) continue;
      const group = routeGroupOf({ ...rule, routePaths: next })!;
      await updateForwardRule(Number(rule.id), {
        routePaths: next,
        routeLines: serializeRouteLines(lines),
        ...legacyFailoverColumns(group, rule),
      } as any);
      if (dbBool(rule.isForwardGroupTemplate) && Number(rule.forwardGroupId || 0) > 0) {
        const { syncForwardGroupRules } = await import("./repositories/forwardGroupRepository");
        await syncForwardGroupRules(Number(rule.forwardGroupId));
      } else {
        await syncRouteRelayRulesForRule(Number(rule.id), { reason });
      }
      changed += 1;
    } catch (error) {
      appendPanelLog("warn", `[RouteLines] rule=${ruleId} 重新展开失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return changed;
}

/**
 * 「复制」：同一份数据在两条腿上同时发，只有 NEX 隧道的多路（单连接叠加）做得到 —— 两条独立的 TCP
 * 连到同一个落地，落地那头没法把两份合成一份。所以主线路得走 NEX 叠加隧道、而且隧道里开了复制；
 * 不满足就拒绝保存并说清楚，不假装生效。
 */
async function assertReplicateReady(main: RouteLine | undefined) {
  const tunnelIds = main ? main.layers.flatMap((layer) => layer.tunnelIds) : [];
  if (tunnelIds.length === 0) throw new Error("「复制」要主线路走 NEX 隧道：在主线路里加一段 NEX 隧道（单连接叠加），再选复制");
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId).catch(() => null) as any;
    const name = String(tunnel?.name || tunnelId);
    if (!tunnel || String(tunnel.mode || "").toLowerCase() !== "forwardx") throw new Error(`「复制」只有 NEX 隧道做得到：隧道「${name}」不是 NEX 隧道`);
    if (String(tunnel.relayMode || "") !== "aggregate") throw new Error(`隧道「${name}」不是单连接叠加：复制要两条以上的腿同时发`);
    if (!dbBool(tunnel.multipathReplicate)) throw new Error(`隧道「${name}」没开复制：到隧道设置里打开「复制」`);
  }
}
