import { agentReportsRuntimeFailureDetail, IPV6_LISTEN_REPORT_AGENT_VERSION } from "@shared/hostIpv6Listen";

/*
  规则跑不起来时 Agent 报的英文原因 → 中文。

  Agent 的动作状态（/api/agent/rule-status）里带的是它自己的英文，例如：

    managed runtime listener not ready after apply port=30021 protocol=tcp forwardType=realm
      ; port 30021/tcp occupied by nginx (pid 812)                     ← 端口被别的进程占着（2.2.255 起）
      ; cause=ipv6-unavailable; log: [tcp]failed to bind [::]:30021: Address family not supported…
                                                                       ← 2.2.256 起：分好的类 + 服务日志最后一两行
    kernel forward apply failed: [docker-compat] …                     ← 内核转发没装全

  这里认出几种常见的，给规则卡（portWarnings，见 rulePortOccupancy.ts）、事件时间线（rule.error）和
  规则异常提醒用：管理员看到具体原因和日志，普通用户只看到结论（日志里可能有别的进程、主机路径）。
  认不出的返回 null，调用方照旧显示原文。
*/

export type RuleRuntimeFailureKind = "bind" | "kernel" | "runtime";

export type RuleRuntimeFailure = {
  kind: RuleRuntimeFailureKind;
  /** 规则卡上那一枚的字：端口绑定失败 / 内核转发未就绪 / 监听没起来 / 运行时没安装。 */
  label: string;
  port: number;
  admin: string;
  user: string;
};

export const RULE_RUNTIME_FAILURE_LABELS = {
  bind: "端口绑定失败",
  kernel: "内核转发未就绪",
  listener: "监听没起来",
  runtimeMissing: "运行时没安装",
} as const;

/** 普通用户看到的几句（固定文案，英文界面在 client/src/i18n/en.json 里有对应）。 */
export const RULE_RUNTIME_FAILURE_USER_TEXT = {
  ipv6: "监听没起来：IPv6 在这台机器上不可用",
  runtimeMissing: "运行时没安装：转发程序不在这台机器上，请联系管理员",
  permission: "监听没起来：没有权限监听这个端口",
  listener: "监听没起来：转发程序没能在入口端口上监听，请联系管理员",
  kernel: "内核转发未就绪：主机防火墙拦下了转发，或规则没装全，请联系管理员",
} as const;

const OCCUPANT_PATTERN = /port (\d{1,5})\/(tcp|udp) occupied by ([^;()]{1,64}?) \(pid (\d{1,8})\)/gi;
const BIND_FAILURE_PATTERN = /address already in use|listen port still busy|port still busy|occupied by|端口[^，。]{0,12}(?:被占|占用)|cause=address-in-use/i;
const KERNEL_FAILURE_PATTERN = /\[docker-compat\]|kernel firewall state mismatch|kernel forward (?:apply|cleanup) failed/i;
const LISTENER_NOT_READY_PATTERN = /managed runtime listener not ready/i;
const IPV6_FAILURE_PATTERN = /cause=ipv6-unavailable|address family not supported|os error 97|EAFNOSUPPORT/i;
const RUNTIME_MISSING_PATTERN = /cause=runtime-missing|runtime binary (?:not installed|missing)/i;
const PERMISSION_PATTERN = /cause=permission-denied/i;

function cleanText(value: unknown, limit: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);
}

/** Agent 2.2.256 起接在后面的「log: …」：服务日志最后一两行（Agent 那头已经去掉控制字符、打了码）。 */
export function agentRuntimeFailureLogTail(text: string) {
  const match = /(?:^|;\s*)log:\s*(.+)$/i.exec(text);
  return match ? match[1].trim() : "";
}

function binaryOf(text: string) {
  return /binary=(\S+)/i.exec(text)?.[1]?.replace(/[;,]+$/, "") || "";
}

function withLog(base: string, log: string) {
  return log ? `${base}（日志：${log}）` : base;
}

export type RuleRuntimeFailureOptions = {
  /** 报这条状态的 Agent 版本：老 Agent 不带原因，提示升级。 */
  agentVersion?: string | null;
};

/**
 * 把规则动作状态里的失败原因归类。认不出返回 null（照旧只显示「没运行」）。
 *
 * 先后顺序有讲究：先认「端口被谁占着」（最具体），再认 IPv6 / 运行时没装 / 权限，最后才是笼统的
 * 「监听没起来」。
 */
export function classifyRuleRuntimeFailure(message: unknown, port: number, options: RuleRuntimeFailureOptions = {}): RuleRuntimeFailure | null {
  const text = cleanText(message, 400);
  if (!text) return null;
  const log = agentRuntimeFailureLogTail(text);
  if (RUNTIME_MISSING_PATTERN.test(text)) {
    const binary = binaryOf(text);
    return {
      kind: "runtime",
      label: RULE_RUNTIME_FAILURE_LABELS.runtimeMissing,
      port,
      admin: withLog(`运行时没安装（重新执行安装命令或升级 Agent）${binary ? `：${binary}` : ""}`, log),
      user: RULE_RUNTIME_FAILURE_USER_TEXT.runtimeMissing,
    };
  }
  if (BIND_FAILURE_PATTERN.test(text)) {
    const occupants = Array.from(text.matchAll(OCCUPANT_PATTERN)).map((match) => ({
      port: Number(match[1]), protocol: match[2].toUpperCase(), process: match[3].trim(), pid: Number(match[4]),
    }));
    const failedPort = occupants[0]?.port || port;
    if (occupants.length > 0) {
      return {
        kind: "bind",
        label: RULE_RUNTIME_FAILURE_LABELS.bind,
        port: failedPort,
        admin: `端口绑定失败：${occupants.map((item) => `${item.port}/${item.protocol} 被 ${item.process}（pid ${item.pid}）占用`).join("；")}`,
        user: `端口绑定失败：${occupants.map((item) => `${item.port}/${item.protocol}`).join("、")} 已被其他程序占用`,
      };
    }
    return {
      kind: "bind",
      label: RULE_RUNTIME_FAILURE_LABELS.bind,
      port: failedPort,
      admin: LISTENER_NOT_READY_PATTERN.test(text)
        ? withLog(failedPort ? `端口绑定失败：入口端口 ${failedPort} 已被占用` : "端口绑定失败：入口端口已被占用", log)
        : `端口绑定失败：${text}`,
      user: failedPort ? `端口绑定失败：入口端口 ${failedPort} 已被占用` : "端口绑定失败：入口端口已被占用",
    };
  }
  if (IPV6_FAILURE_PATTERN.test(text)) {
    return {
      kind: "runtime",
      label: RULE_RUNTIME_FAILURE_LABELS.listener,
      port,
      admin: withLog(RULE_RUNTIME_FAILURE_USER_TEXT.ipv6, log),
      user: RULE_RUNTIME_FAILURE_USER_TEXT.ipv6,
    };
  }
  if (PERMISSION_PATTERN.test(text)) {
    return {
      kind: "runtime",
      label: RULE_RUNTIME_FAILURE_LABELS.listener,
      port,
      admin: withLog(RULE_RUNTIME_FAILURE_USER_TEXT.permission, log),
      user: RULE_RUNTIME_FAILURE_USER_TEXT.permission,
    };
  }
  if (KERNEL_FAILURE_PATTERN.test(text)) {
    return {
      kind: "kernel",
      label: RULE_RUNTIME_FAILURE_LABELS.kernel,
      port,
      admin: `内核转发未就绪：${text}`,
      user: RULE_RUNTIME_FAILURE_USER_TEXT.kernel,
    };
  }
  if (LISTENER_NOT_READY_PATTERN.test(text)) {
    let admin = "监听没起来";
    if (log) admin = `监听没起来：${log}`;
    else if (options.agentVersion && !agentReportsRuntimeFailureDetail(options.agentVersion)) {
      admin = `监听没起来（Agent ${options.agentVersion} 不带原因，升级到 ${IPV6_LISTEN_REPORT_AGENT_VERSION} 以上可看到服务日志）`;
    } else admin = "监听没起来（服务日志里没有线索，到主机上看这个服务的日志）";
    return { kind: "runtime", label: RULE_RUNTIME_FAILURE_LABELS.listener, port, admin, user: RULE_RUNTIME_FAILURE_USER_TEXT.listener };
  }
  return null;
}

/** 事件时间线、规则异常提醒用的那句原因（只给管理员看）：认得出就是中文，认不出照旧是原文。 */
export function ruleRuntimeFailureReason(message: unknown, port: number, options: RuleRuntimeFailureOptions = {}) {
  const raw = cleanText(message, 400);
  if (!raw) return "";
  return classifyRuleRuntimeFailure(raw, port, options)?.admin || raw;
}
