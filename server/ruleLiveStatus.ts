import { withRuleExitTargets } from "./exitTargetHealth";
import { withRuleLiveSamples } from "./ruleLatencyView";
import { withRuleLiveRates } from "./ruleLiveRates";
import { withRuleProbeFailures } from "./ruleProbeFailure";

/*
  规则「现在」的状态只在这里拼一次（2.3.559，用户：「能统一就统一成一体」）：
    数据库那条（最新一次探测 / 诊断、字节数）
    → 内存里更新的实时样本（每次上报、每次诊断都写，比数据库那条新才盖）
    → 失败种类、实时速率
    → 负载均衡：在用哪台出口、整链延迟、指定的出口能不能用
  规则卡、表格、订阅（按延迟排序、节点通不通）、Telegram 都读这一份，不各拼各的。以前订阅只补了最后一层、Telegram 一层都没补，
  同一条规则卡片上通、Telegram 里却是几分钟前的超时。
*/
export function withLiveRuleStatus<T extends { ruleId: number | string }>(rows: T[], nowMs = Date.now()) {
  return withRuleExitTargets(withRuleLiveRates(withRuleProbeFailures(withRuleLiveSamples(rows, nowMs)), nowMs), nowMs);
}
