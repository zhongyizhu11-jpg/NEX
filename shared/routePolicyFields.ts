/*
  规则上决定「线路组怎么调度」的列 —— 只有这一份清单。

  端口转发（转发组模板）不跑，跑的是每台成员机上的子规则，子规则的这些列是组同步时从模板抄过来的
  （server/repositories/forwardGroupRepository.ts）。2.3.522 线上「切到备用 1 还是走主线路」就是这里漏抄了
  人工指定那两列：读法（routePolicyOf）认得、界面按模板显示得好好的、机器上的子规则却没有。

  以后给线路组加一个调度参数，要做的是：
    1. 规则表加列，routePolicyOf / readFailoverPin 里读它；
    2. 加进下面这份清单。
  漏了第 2 步 shared/routePolicyFields.test.ts 会红（它拿一个记录读取的代理去跑 routePolicyOf，读到了清单外的列就报错）；
  加进清单却没从模板带到子规则，server/routePolicyTemplateSync.test.ts 会红（逐列改模板、同步、比子规则算出来的策略）。

  路径本身（routePaths / routeLines / failoverTargets / failoverProbeTarget）不在这里：子规则的路径带着它自己那台入口机
  解析出来的拨号地址，不是照抄。
*/
export const ROUTE_POLICY_RULE_FIELDS = [
  "failoverStrategy",
  "failoverSchedule",
  "failoverPreferFastest",
  "failoverPinnedIndex",
  "failoverPinnedUntil",
  "failoverMinHoldSeconds",
  "failoverSeconds",
  "recoverSeconds",
  "autoFailback",
  "routeMode",
  "routeFailureThreshold",
  "routeScoreMargin",
  "routeScoreHoldSeconds",
  "routePrewarmSeconds",
  "routeSwitchMode",
  "routeDelivery",
] as const;

export type RoutePolicyRuleField = (typeof ROUTE_POLICY_RULE_FIELDS)[number];

/** 读策略时还会碰到、但不属于「调度参数」的列：开关和路径（子规则各有各的）。 */
export const ROUTE_POLICY_NON_POLICY_READS = ["failoverEnabled", "routePaths", "routeLines", "failoverTargets", "failoverProbeTarget", "targetIp", "targetPort"] as const;
