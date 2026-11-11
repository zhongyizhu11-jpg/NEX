/**
 * 批量添加规则：贴多行 `入口端口[-结束] 目标地址:端口[-结束] [备注]`，先逐行预览能不能建，
 * 确认后一行一行建（解析见 shared/portRange.ts 的 parseBatchRuleText）。
 *
 * 预览和真正建用的是两套检查但同一个口径：预览一次把这台主机上的占用全取出来逐行比
 * （不占端口，几百行也只查一次库）；建的时候每一行仍然走 createDirectForwardRuleForActor
 * —— 权限、配额、端口策略、预留、端口段的整段检查一样不少。两步之间被别人抢走的端口，
 * 在建的那一步照样会报出来，结果里逐行写清楚哪几行建了、哪几行没建、为什么。
 *
 * 只做直连主机：隧道、转发组、线路组的规则各有各的入口端口分配，不进这条路。
 */
import * as db from "./db";
import { combinePortPolicies, describePortPolicy, portPolicyFrom } from "@shared/portPolicy";
import {
  BATCH_RULE_MAX_LINES,
  isBatchRuleLineError,
  parseBatchRuleText,
  portRangeUnsupportedReason,
  type BatchRuleLine,
} from "@shared/portRange";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";
import { assertTenantListenPortAllowed } from "./tenantListenPortGuard";
import { firstPortOutsidePolicy, portRangeAgentUnsupportedReason, portRangeRuleRateLimited } from "./rulePortRange";

export type RuleBatchInput = {
  hostId: number;
  forwardType: string;
  protocol: "tcp" | "udp" | "both";
  text: string;
};

export type RuleBatchRow = {
  line: number;
  text: string;
  ok: boolean;
  error?: string;
  sourcePort?: number;
  sourcePortEnd?: number | null;
  targetIp?: string;
  targetPort?: number;
  targetPortEnd?: number | null;
  remark?: string;
  /** 建成功的规则 id（只在 create 的结果里有）。 */
  ruleId?: number;
};

type BatchActor = { id: number; role: string };

function rowFromLine(line: BatchRuleLine): RuleBatchRow {
  return {
    line: line.line,
    text: line.text,
    ok: true,
    sourcePort: line.sourcePort,
    sourcePortEnd: line.sourcePortEnd,
    targetIp: line.targetIp,
    targetPort: line.targetPort,
    targetPortEnd: line.targetPortEnd,
    remark: line.remark,
  };
}

/**
 * 逐行预览。整批层面的问题（主机不存在、一行都没有、超过行数上限）直接抛错；
 * 行上的问题写进那一行的 error，别的行照常给结论。
 */
export async function previewRuleBatch(actor: BatchActor, input: RuleBatchInput): Promise<RuleBatchRow[]> {
  const parsed = parseBatchRuleText(input.text);
  if (parsed.length === 0) throw new Error("没有可添加的行");
  if (parsed.length > BATCH_RULE_MAX_LINES) throw new Error(`一次最多 ${BATCH_RULE_MAX_LINES} 行，现在是 ${parsed.length} 行`);
  const hostId = Number(input.hostId);
  const host = await db.getHostById(hostId) as { id: number; userId?: number | null; agentVersion?: string | null; rateLimitMbps?: number | null } | undefined;
  if (!host) throw new Error("主机不存在");
  const protocol = normalizeForwardRuleProtocol(input.protocol, "both");
  const entryPolicy = portPolicyFrom(host as never);
  const planRange = actor.role !== "admin" ? await db.getUserPlanPortRange(actor.id, hostId) : null;
  const effectivePolicy = planRange ? combinePortPolicies(entryPolicy, portPolicyFrom({ portRanges: planRange.ranges })) : entryPolicy;
  const used = await db.getUsedPortsOnHost(hostId, [], protocol, undefined, false);
  const anyRange = parsed.some((row) => !isBatchRuleLineError(row) && row.sourcePortEnd);
  const rangeReason = anyRange
    ? portRangeUnsupportedReason({ forwardType: input.forwardType, rateLimited: await portRangeRuleRateLimited(host, actor.id, 0) })
      || portRangeAgentUnsupportedReason(host)
    : null;

  return parsed.map((entry): RuleBatchRow => {
    if (isBatchRuleLineError(entry)) return { line: entry.line, text: entry.text, ok: false, error: entry.error };
    const row = rowFromLine(entry);
    const fail = (error: string): RuleBatchRow => ({ ...row, ok: false, error });
    const start = entry.sourcePort;
    const end = entry.sourcePortEnd ?? entry.sourcePort;
    if (entry.sourcePortEnd && rangeReason) return fail(rangeReason);
    const outside = firstPortOutsidePolicy(start, end, entryPolicy);
    if (outside !== null) return fail(`${outside} 不在允许范围：${describePortPolicy(entryPolicy)}`);
    if (planRange) {
      const outsidePlan = firstPortOutsidePolicy(start, end, effectivePolicy);
      if (outsidePlan !== null) return fail(`${outsidePlan} 不在套餐端口：${describePortPolicy(effectivePolicy)}`);
    }
    try {
      for (let port = start; port <= end; port += 1) {
        assertTenantListenPortAllowed({ actor, host: host as { userId?: number | null }, port, label: "端口" });
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : "端口不可用");
    }
    for (let port = start; port <= end; port += 1) {
      if (used.has(port)) return fail(start === end ? `端口 ${port} 已被占用` : `段里的 ${port} 已被占用`);
    }
    return row;
  });
}

/**
 * 预览一遍，把能建的行一行一行建出来。一行失败不影响别的行；返回每一行的最终结果。
 * createRule 由调用方传进来（就是 createDirectForwardRuleForActor），这里不直接依赖路由文件。
 */
export async function createRuleBatch(
  actor: BatchActor,
  input: RuleBatchInput,
  createRule: (row: RuleBatchRow) => Promise<{ id: number | string }>,
): Promise<{ rows: RuleBatchRow[]; created: number; failed: number }> {
  const preview = await previewRuleBatch(actor, input);
  const rows: RuleBatchRow[] = [];
  for (const row of preview) {
    if (!row.ok) {
      rows.push(row);
      continue;
    }
    try {
      const created = await createRule(row);
      rows.push({ ...row, ruleId: Number(created.id) });
    } catch (error) {
      rows.push({ ...row, ok: false, error: error instanceof Error ? error.message : "创建失败" });
    }
  }
  const created = rows.filter((row) => row.ok).length;
  return { rows, created, failed: rows.length - created };
}

/** 结果的一句话总结：全成 / 全败 / 部分成，给 toast 和审计用。 */
export function describeRuleBatchResult(result: { created: number; failed: number }) {
  if (result.failed === 0) return `已添加 ${result.created} 条规则`;
  if (result.created === 0) return `一条都没建成（${result.failed} 行失败）`;
  return `已添加 ${result.created} 条，${result.failed} 行没建成`;
}
