/**
 * 「创建转发」这张表还差什么 —— 一处算，到处用。
 *
 * 按钮的禁用、footer 的那句提示、提交时的拦截，原来就已经读同一个值了。这里把它
 * 挪到 shared 并补上端口范围，是为了让**标签上那个红星**也读同一份规则。
 *
 * 之前这三者对不上，而且是往相反的方向：
 *
 *   · 源端口标着红星「必填」，可新建时留空（0）本来就合法 —— 面板会替你随机分配，
 *     服务端两条路（按量计费主机、保存好的端口转发）都支持。于是用户以为必须自己
 *     挑个号，猜一个，撞上占用，再猜一个。而这个字段他本来可以不用管。
 *   · 反过来，端口填成 70000 时按钮仍然亮着，点下去才弹 toast —— 而别的缺口都是
 *     按钮灰着、footer 说明缺什么。同一张表里两套反馈方式。
 *
 * 判断留在纯函数里，界面只管显示，这样「必填吗」和「拦不拦」不可能再各说各话。
 */

import { parsePortSpec, portRangeShapeError } from "./portRange";

export type ForwardRuleRouteMode = "local" | "tunnel" | "chain" | "group";

export type ForwardRuleFormState = {
  routeMode: ForwardRuleRouteMode;
  tunnelId: number | null;
  forwardGroupId: number | null;
  hostId: number | null;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  protocol: string;
  failoverEnabled: boolean;
  /** 端口段（shared/portRange.ts）：入口段最后一个端口，0 / 不填 = 单端口。 */
  sourcePortEnd?: number;
  /** 用户写的目标段结尾，0 / 不填 = 跟着入口段算。 */
  targetPortEnd?: number;
  /** 两个端口输入框里的原文（能写 20000-20100）；null / 不填 = 按数字显示，不用再解析。 */
  sourcePortText?: string | null;
  targetPortText?: string | null;
};

export type ForwardRuleFormContext = {
  /** 编辑已有规则时为 true —— 这时源端口不能再留空。 */
  editing: boolean;
  /** 这条规则走的是「选一个转发组/转发链/端口转发」那条路，而不是自己挑主机。 */
  usesForwardGroup: boolean;
  canUseLocalForward: boolean;
  canUseForwardChain: boolean;
  canUseFailoverGroup: boolean;
  canUseGost: boolean;
  /** 源端口占用探测的结果。 */
  portStatus: "idle" | "checking" | "available" | "used";
  /** 填了端口段，但这条规则（转发方式 / 线路）用不了端口段的原因；null = 没问题。 */
  portRangeBlocker?: string | null;
};

function portTextError(text: string | null | undefined) {
  if (text == null) return null;
  const spec = parsePortSpec(text);
  return spec && "error" in spec ? spec.error : null;
}

export function isValidForwardPort(port: unknown, allowZero = false): boolean {
  const value = Number(port);
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535;
}

/** 目标地址：域名或 IPv4/IPv6。规则的目标、主备的备用线路都用这一份。 */
export function isValidTargetHost(value: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(value.trim());
}

/**
 * 新建时源端口可以留空（0 = 面板随机分配），编辑时不行。
 *
 * 编辑时之所以不行：这条规则已经占着一个端口在跑，把它改成 0 意思不明 ——
 * 是要换一个随机的，还是别动？与其猜，不如让人把想要的号写出来。
 */
export function isForwardRuleSourcePortRequired(context: Pick<ForwardRuleFormContext, "editing">): boolean {
  return context.editing;
}

/**
 * 还差什么才能提交；null 表示可以。
 *
 * 顺序按填表的顺序来（线路 → 源端口 → 目标 → 主备线路），只报第一个缺口：
 * 一次列三条缺失反而没人读。
 */
export function forwardRuleFormBlocker(
  form: ForwardRuleFormState,
  context: ForwardRuleFormContext,
): string | null {
  if (form.routeMode === "tunnel" && !form.tunnelId) return "还没选隧道";
  if (context.usesForwardGroup && !form.forwardGroupId) {
    return form.routeMode === "local" ? "还没选端口转发"
      : form.routeMode === "chain" ? "还没选转发链"
      : "还没选转发组";
  }
  if (form.routeMode === "local" && !context.canUseLocalForward) return "没有可用的端口转发资源";
  if (form.routeMode === "chain" && !context.canUseForwardChain) return "没有可用的转发链";
  if (form.routeMode === "group" && !context.canUseFailoverGroup) return "没有可用的转发组";
  if (form.routeMode === "tunnel" && !context.canUseGost) return "当前账号没有隧道转发权限";
  if (!context.usesForwardGroup && !form.hostId) return "还没选线路";
  const sourceTextError = portTextError(form.sourcePortText);
  if (sourceTextError) return `源端口：${sourceTextError}`;
  if (context.portRangeBlocker) return context.portRangeBlocker;
  if (context.portStatus === "used") return "源端口已被占用";
  if (!isValidForwardPort(form.sourcePort, !isForwardRuleSourcePortRequired(context))) {
    return isForwardRuleSourcePortRequired(context)
      ? "源端口必须在 1-65535 之间"
      : "源端口必须为 0 或 1-65535，0 表示随机分配";
  }
  if (!form.targetIp) return "还缺目标地址";
  if (!form.targetPort) return "还缺目标端口";
  const targetTextError = portTextError(form.targetPortText);
  if (targetTextError) return `目标端口：${targetTextError}`;
  if (!isValidForwardPort(form.targetPort)) return "目标端口必须在 1-65535 之间";
  const rangeShapeError = portRangeShapeError({
    sourcePort: form.sourcePort,
    sourcePortEnd: form.sourcePortEnd || null,
    targetPort: form.targetPort,
    targetPortEnd: form.targetPortEnd || null,
  });
  if (rangeShapeError) return rangeShapeError;
  // 线路组不卡协议：UDP、TCP+UDP 由入口 Agent 按会话调度（2.2.199 起，更老的走路径 A）。
  return null;
}

/**
 * 这句「还差什么」指向的控件，是不是在折起来的「更多设置」里。
 *
 * footer 说了缺什么、按钮也灰着，可那个控件被折叠藏住了 —— 用户读到一句自己看不见
 * 的话，比什么都不说更糟。所以界面得替他展开。
 *
 * 这份名单必须和 forwardRuleFormBlocker 的返回值逐字对上，测试里逐条验证它确实
 * 能被产生出来：改了文案而忘了改这里，名单会静默失效，而失效的表现正是上面那句
 * 「看得见提示、找不到控件」。
 */
// 现在是空的：以前唯一的一条「主备线路只支持 TCP」已经没了（线路组支持 UDP 了）。
// 机制留着 —— 下一个折进去、又能卡住提交的控件，缺口文案要加在这里。
export const ADVANCED_SECTION_BLOCKERS: readonly string[] = [];

export function isAdvancedSectionBlocker(blocker: string | null | undefined): boolean {
  return !!blocker && (ADVANCED_SECTION_BLOCKERS as readonly string[]).includes(blocker);
}
