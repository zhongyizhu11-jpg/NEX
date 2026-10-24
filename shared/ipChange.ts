/*
  自动换 IP（插件 auto-ip-change）前后端共用的常量、默认值和校验。

  功能本身写在核心里（server/ipChange/），插件只是开关：插件装上并启用、且「插件功能」总开关打开，
  这里的接口和定时任务才干活。原因见 docs/guide/auto-ip-change.md 和 shared/pluginTypes.ts 的
  PLUGIN_SECURITY_MODEL —— 插件不能跑面板后端代码，而换 IP 要拿云账号凭据调云厂商 API。
*/

export const AUTO_IP_CHANGE_PLUGIN_ID = "auto-ip-change";
/** 核心里的管理页。插件的侧边栏入口直接指向这里（见 pluginRepository.resolvePluginSidebarCapability）。 */
export const AUTO_IP_CHANGE_ROUTE = "/ip-change";

export const IP_CHANGE_STATES = [
  "idle",
  "healthy",
  "failing",
  "changing",
  "cooldown",
  "uncertain",
  "error",
  "disabled",
] as const;
export type IpChangeState = typeof IP_CHANGE_STATES[number];

export const IP_CHANGE_STATE_LABELS: Record<IpChangeState, string> = {
  idle: "等待探测",
  healthy: "正常",
  failing: "探测失败",
  changing: "正在更换",
  cooldown: "冷却中",
  uncertain: "结果不确定",
  error: "出错",
  disabled: "已停用",
};

/** 状态在界面上的语气：对应 --fx-healthy / --fx-warn / --fx-down / --fx-standby。 */
export const IP_CHANGE_STATE_TONES: Record<IpChangeState, "healthy" | "warn" | "down" | "standby"> = {
  idle: "standby",
  healthy: "healthy",
  failing: "warn",
  changing: "warn",
  cooldown: "standby",
  uncertain: "down",
  error: "down",
  disabled: "standby",
};

export function normalizeIpChangeState(value: unknown): IpChangeState {
  return (IP_CHANGE_STATES as readonly string[]).includes(String(value)) ? value as IpChangeState : "idle";
}

export const IP_CHANGE_TRIGGERS = ["manual", "auto", "test"] as const;
export type IpChangeTrigger = typeof IP_CHANGE_TRIGGERS[number];
export const IP_CHANGE_TRIGGER_LABELS: Record<IpChangeTrigger, string> = { manual: "手动", auto: "自动", test: "测试" };

export const IP_CHANGE_EVENT_STATUSES = ["running", "succeeded", "failed", "uncertain"] as const;
export type IpChangeEventStatus = typeof IP_CHANGE_EVENT_STATUSES[number];
export const IP_CHANGE_EVENT_STATUS_LABELS: Record<IpChangeEventStatus, string> = {
  running: "进行中",
  succeeded: "成功",
  failed: "失败",
  uncertain: "结果不确定",
};

export type IpChangeCheckMethod = "tcp" | "ping";

/*
  默认探测目标：三家运营商的官网，都只在大陆有节点。

  没有放 www.qq.com、www.baidu.com 这类大站：它们在海外有 CDN 边缘节点，从境外机器解析出来的是
  境外 IP，被墙了照样通 —— 而「一轮里只要有一个目标通就算正常」，一个永远通的目标会让检测永远不触发。
  换成自己的目标时也要挑只在大陆有节点的（或直接写大陆 IP）。
*/
export const IP_CHANGE_DEFAULT_CHECK_TARGETS = "www.189.cn:80\nwww.10086.cn:80\nwww.10010.com:80";

export const IP_CHANGE_DEFAULTS = {
  checkTargets: IP_CHANGE_DEFAULT_CHECK_TARGETS,
  checkMethod: "tcp" as IpChangeCheckMethod,
  failureThreshold: 5,
  checkIntervalSeconds: 60,
  cooldownMinutes: 30,
  maxChangesPerDay: 3,
  releaseOldIp: true,
};

export const IP_CHANGE_LIMITS = {
  maxTargets: 8,
  failureThreshold: { min: 2, max: 100 },
  checkIntervalSeconds: { min: 30, max: 3600 },
  cooldownMinutes: { min: 5, max: 7 * 24 * 60 },
  maxChangesPerDay: { min: 1, max: 48 },
};

/*
  探测借用的是「主机探测服务」那条现成的通道（面板在心跳里下发 hostProbeServices，Agent 按
  serviceId 回报），所以 Agent 不用改。自动换 IP 的探测不进 host_probe_services 表，用一段保留的
  serviceId 区分：真实服务的自增 ID 到不了 20 亿；上限也留在 int32 以内（32 位 Agent 上 Go 的 int）。
*/
export const IP_CHANGE_PROBE_SERVICE_ID_BASE = 2_000_000_000;

export function ipChangeProbeServiceId(index: number) {
  return IP_CHANGE_PROBE_SERVICE_ID_BASE + Math.max(0, Math.floor(index));
}

/** 是自动换 IP 的探测就返回它对应第几个目标，否则 -1。 */
export function ipChangeProbeIndex(serviceId: unknown) {
  const id = Number(serviceId);
  if (!Number.isInteger(id)) return -1;
  const index = id - IP_CHANGE_PROBE_SERVICE_ID_BASE;
  return index >= 0 && index < IP_CHANGE_LIMITS.maxTargets ? index : -1;
}

export function isIpChangeProbeServiceId(serviceId: unknown) {
  return ipChangeProbeIndex(serviceId) >= 0;
}

export type IpChangeCheckTarget = { host: string; port: number };

/**
 * 一行一个目标：`域名:端口`、`IP:端口`、`[IPv6]:端口`，或只写主机（TCP 默认 80 端口，ping 不看端口）。
 * 逗号、空格分隔也认。返回能用的目标和每一行的错误。
 */
export function parseIpChangeCheckTargets(text: unknown, method: IpChangeCheckMethod = "tcp") {
  const targets: IpChangeCheckTarget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const items = String(text ?? "").split(/[\n,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    const raw = item.replace(/^(?:tcp|icmp|ping):\/\//i, "").replace(/：/g, ":");
    let host = raw;
    let port = 80;
    const bracket = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracket) {
      host = bracket[1];
      if (bracket[2]) port = Number(bracket[2]);
    } else if (raw.split(":").length === 2) {
      const [left, right] = raw.split(":");
      host = left;
      port = /^\d+$/.test(right) ? Number(right) : Number.NaN;
    } else if (raw.includes(":") && !/^[0-9a-f:.]+$/i.test(raw)) {
      errors.push(`${item}：格式不对`);
      continue;
    }
    host = host.trim().toLowerCase();
    if (!host || host.length > 253 || !/^[a-z0-9.:_-]+$/i.test(host)) {
      errors.push(`${item}：主机名不合法`);
      continue;
    }
    if (method === "tcp" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      errors.push(`${item}：端口要在 1-65535 之间`);
      continue;
    }
    const normalized = { host, port: method === "tcp" ? port : 0 };
    const key = `${normalized.host}:${normalized.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(normalized);
  }
  if (targets.length > IP_CHANGE_LIMITS.maxTargets) {
    errors.push(`最多 ${IP_CHANGE_LIMITS.maxTargets} 个探测目标`);
  }
  return { targets: targets.slice(0, IP_CHANGE_LIMITS.maxTargets), errors };
}

function clampInt(value: unknown, fallback: number, range: { min: number; max: number }) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(range.min, Math.min(range.max, n));
}

/** 数值类设置统一夹到合法范围（前端表单和后端保存都用这一份）。 */
export function normalizeIpChangeNumbers(input: {
  failureThreshold?: unknown;
  checkIntervalSeconds?: unknown;
  cooldownMinutes?: unknown;
  maxChangesPerDay?: unknown;
}) {
  return {
    failureThreshold: clampInt(input.failureThreshold, IP_CHANGE_DEFAULTS.failureThreshold, IP_CHANGE_LIMITS.failureThreshold),
    checkIntervalSeconds: clampInt(input.checkIntervalSeconds, IP_CHANGE_DEFAULTS.checkIntervalSeconds, IP_CHANGE_LIMITS.checkIntervalSeconds),
    cooldownMinutes: clampInt(input.cooldownMinutes, IP_CHANGE_DEFAULTS.cooldownMinutes, IP_CHANGE_LIMITS.cooldownMinutes),
    maxChangesPerDay: clampInt(input.maxChangesPerDay, IP_CHANGE_DEFAULTS.maxChangesPerDay, IP_CHANGE_LIMITS.maxChangesPerDay),
  };
}
