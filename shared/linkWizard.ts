/**
 * 「按目标新建」：用户说想要什么、哪一段有几台机器，面板告诉他该建哪一种、为什么，再替他打开那个新建框。
 *
 * 面板里能把几条线路一起用的东西有六七种（线路组、转发组、入口组、出口组、隧道中转……），名字又都差不多，新手很难从名字
 * 猜出该用哪个。这里反过来问：要稳、要多人一起快、还是要单条连接也快；多出来的机器在哪一段。
 * 两个问题定下来，答案就只有一个。
 */

import { LINK_TERM_FAILOVER, LINK_TERM_LOAD_BALANCE, LINK_TERM_SPLIT_CONNECTION } from "./linkTerms";

export const LINK_WIZARD_GOALS = ["stable", "throughput", "single"] as const;
export type LinkWizardGoal = (typeof LINK_WIZARD_GOALS)[number];

export const LINK_WIZARD_GOAL_LABELS: Record<LinkWizardGoal, { label: string; hint: string }> = {
  stable: { label: "稳定优先", hint: `坏了自动换（${LINK_TERM_FAILOVER}）` },
  throughput: { label: "多人一起快", hint: `新连接分到几台上，人多、多线程下载时带宽相加（${LINK_TERM_LOAD_BALANCE}）` },
  single: { label: "单条连接也要快", hint: `一条连接拆开同时走几条，单线程下载、测速也能叠（${LINK_TERM_SPLIT_CONNECTION}）` },
};

export const LINK_WIZARD_PLACES = ["entry", "relay", "exit", "path", "one"] as const;
export type LinkWizardPlace = (typeof LINK_WIZARD_PLACES)[number];

export const LINK_WIZARD_PLACE_LABELS: Record<LinkWizardPlace, { label: string; hint: string }> = {
  entry: { label: "几台入口", hint: "用户可以连其中任意一台" },
  relay: { label: "几台中转", hint: "入口和出口之间有几台机器可以走" },
  exit: { label: "几台出口", hint: "最后从哪台出去都行" },
  path: { label: "几条不同的路", hint: "同一个入口，后面有几条不同的路线（不同中转、不同目标）" },
  one: { label: "只有一条线", hint: "入口、出口各一台，但单条连接跑不满" },
};

export type LinkWizardAction =
  | { type: "group"; mode: "failover" | "entry" | "exit"; exitStrategy?: "fallback" | "least_load" }
  | { type: "tunnel"; relayMode: "chain" | "failover" | "aggregate" | "hot_standby"; needsForwardX: boolean }
  | { type: "rule" };

export type LinkWizardAdvice = {
  /** 建什么。 */
  title: string;
  /** 它会怎么做，为什么是它。 */
  explain: string;
  /** 建完还要做的一步，或者这个组合做不到时的说明。 */
  next?: string;
  /** 没有可建的（比如只有一条线却要主备）时为 null。 */
  action: LinkWizardAction | null;
};

const RULE_ROUTE_GROUP_NEXT = "在新建规则的编辑框里勾上「线路组」，把几条路径加进去。";

export function linkWizardAdvice(goal: LinkWizardGoal, place: LinkWizardPlace): LinkWizardAdvice {
  if (goal === "stable") {
    if (place === "entry") return {
      title: "转发组（入口主备）",
      explain: "一个域名指向其中健康的一台入口，坏了自动改解析，用户不用换地址。",
      next: "要配好 DDNS（系统设置里），域名才会跟着换。",
      action: { type: "group", mode: "failover" },
    };
    if (place === "relay") return {
      title: "隧道，中转选「热备」",
      explain: "每条连接同时连上全部中转，平时只走第一台；它停住几百毫秒内下一台就接手，连接不断、不用重连。",
      next: "新建 NEX 隧道时加两台以上中转，中转方式选「热备」；不是 NEX 隧道就选「主备」（坏了换下一台，新连接走新的）。",
      action: { type: "tunnel", relayMode: "hot_standby", needsForwardX: true },
    };
    if (place === "exit") return {
      title: "出口组（主备），再给隧道用",
      explain: "隧道平时从第一台出口出去，坏了换下一台。",
      next: "建好出口组后，在隧道里选它当出口。",
      action: { type: "group", mode: "exit", exitStrategy: "fallback" },
    };
    if (place === "path") return {
      title: "规则里的线路组",
      explain: "入口不变，后面几条路排好先后，主线路出问题几秒内自动换，恢复后再换回来；也能按时段、按延迟挑。",
      next: RULE_ROUTE_GROUP_NEXT,
      action: { type: "rule" },
    };
    return {
      title: "只有一条线没得换",
      explain: "主备至少要两条：多一台入口、中转或出口都行。现在能做的是给这条线开诊断和告警，坏了第一时间知道。",
      action: null,
    };
  }
  if (goal === "throughput") {
    if (place === "entry") return {
      title: "入口组",
      explain: "一个域名解析出几台入口，带宽大的排前面，客户端连哪台由它自己挑。",
      next: "手机上用订阅更好：同一个落地的几台前置，订阅里会自动生成「负载均衡」组，按带宽分连接。",
      action: { type: "group", mode: "entry" },
    };
    if (place === "relay") return {
      title: "叠加",
      explain: "每条连接都拆到全部中转同时送，在出口拼回来；连接多的时候也一样把几台中转的带宽加起来。",
      next: "在「叠加」页签新建：选入口、两台以上中转和落地。",
      action: { type: "tunnel", relayMode: "aggregate", needsForwardX: true },
    };
    if (place === "exit") return {
      title: "出口组（按负载），再给隧道用",
      explain: "新连接给现在最闲的那台出口：按实时流量、连接数、延迟和线路带宽算，500M 那台自然多接一些。",
      next: "先在主机设置里填好每台的「线路带宽」，再在隧道里选这个出口组。",
      action: { type: "group", mode: "exit", exitStrategy: "least_load" },
    };
    if (place === "path") return {
      title: "规则里的线路组（权重负载）",
      explain: "新连接按权重分到几条路径，哪条坏了先跳过它。",
      next: RULE_ROUTE_GROUP_NEXT,
      action: { type: "rule" },
    };
    return {
      title: "只有一条线分不了",
      explain: "负载均衡要几条线一起分。单条连接跑不满的话，选「单条连接也要快」看多路并发。",
      action: null,
    };
  }
  // 单条连接也要快：一条连接只能从一个地址进、一台出口出，能拆的只有中间那段。
  if (place === "relay") return {
    title: "叠加",
    explain: "一条连接被拆到全部中转同时送，在出口拼回来，单线程下载、测速也能用上几台中转的带宽之和。",
    next: "在「叠加」页签新建：选入口、两台以上中转和落地。",
    action: { type: "tunnel", relayMode: "aggregate", needsForwardX: true },
  };
  if (place === "one") return {
    title: "NEX 隧道 + 多路并发",
    explain: "同一条线开几条并行连接一起送，绕开运营商对单条连接的限速；线路本身满了就没用。",
    next: "建好隧道后在它的 ⋯ 菜单里打开「多路并发」，从 4 条试起。",
    action: { type: "tunnel", relayMode: "chain", needsForwardX: true },
  };
  if (place === "entry") return {
    title: "几台入口没法拆一条连接",
    explain: "手机、电脑一条连接只连一个地址，进不了两台入口。可以换个摆法：一台当入口，其余几台当中转，建一条「叠加」。",
    next: "家里有常开的 Linux（软路由、NAS）也能当入口：入口只往外拨，不用公网 IP。",
    action: { type: "tunnel", relayMode: "aggregate", needsForwardX: true },
  };
  if (place === "exit") return {
    title: "几台出口没法拆一条连接",
    explain: "一条连接只能从一台出口出去（目标看到的 IP 必须一致）。能拆的是出口前面那段：加两台中转，建一条「叠加」。",
    action: { type: "tunnel", relayMode: "aggregate", needsForwardX: true },
  };
  return {
    title: "线路组拆不了一条连接",
    explain: "线路组是按连接挑路径。要拆一条连接，得让几条路在出口汇合：把几条路的中间机器当中转，建一条「叠加」。",
    action: { type: "tunnel", relayMode: "aggregate", needsForwardX: true },
  };
}
