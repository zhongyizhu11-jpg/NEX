function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export function isManagedForwardGroupChildRule(rule: any) {
  return positiveId(rule?.forwardGroupRuleId) > 0 || positiveId(rule?.forwardGroupMemberId) > 0 || isRouteRelayRule(rule);
}

/** 线路组在中转机上生成的中继规则：面板维护，用户界面不列、不算配额（server/routeGroups.ts）。 */
function isRouteRelayRule(rule: any) {
  return positiveId(rule?.routeParentRuleId) > 0;
}

function filterForwardRulesForUserSurface<T>(rules: T[]) {
  return rules.filter((rule) => !isManagedForwardGroupChildRule(rule));
}

export function gateForwardRulesForUserSurface<T extends Record<string, any>>(
  rules: T[],
  hasResourceAccess: (rule: T) => boolean,
) {
  return filterForwardRulesForUserSurface(rules).map((rule) => {
    if (hasResourceAccess(rule)) return rule;
    return {
      ...rule,
      isEnabled: false,
      resourceAccessAllowed: false,
      resourceAccessDenied: true,
    };
  });
}
