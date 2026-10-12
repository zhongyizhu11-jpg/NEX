/*
  全部重启（#15）和导入现有配置（#16）里不碰数据库的部分：谁会被跳过、结果那句话怎么说、
  扫描到的一项怎么变成一条规则的入参。单独放一个文件，方便写单元测试。
*/
import { isAgentVersionAtLeast } from "../../shared/version";

/** 和 agentExt.ts 的 AGENT_EXT_MIN_VERSION 一致（这里不引它，免得测试拖进事件流那一串模块）。 */
const AGENT_EXT_MIN_VERSION = "2.2.216";

export type RestartTargetHost = { id: number; name: string; online: boolean; agentVersion?: string | null };

export type RestartSkip = { hostId: number; name: string; reason: string };

/** 在线且 Agent 够新的才发；其余列进「跳过」并写明原因。 */
export function classifyRestartTargets(hosts: RestartTargetHost[]) {
  const targets: RestartTargetHost[] = [];
  const skipped: RestartSkip[] = [];
  for (const host of hosts) {
    if (!host.online) {
      skipped.push({ hostId: host.id, name: host.name, reason: "离线" });
    } else if (!isAgentVersionAtLeast(String(host.agentVersion || ""), AGENT_EXT_MIN_VERSION)) {
      skipped.push({ hostId: host.id, name: host.name, reason: "Agent 太旧" });
    } else {
      targets.push(host);
    }
  }
  return { targets, skipped };
}

export type RestartHostResult = {
  hostId: number;
  name: string;
  status: "pending" | "done" | "timeout";
  restarted: string[];
  failed: Array<{ name: string; error: string }>;
};

/** 「已重启 5 台，跳过 2 台（东京-1：Agent 太旧；香港-2：离线）」。 */
export function restartAllSummary(results: RestartHostResult[], skipped: RestartSkip[]) {
  const done = results.filter((item) => item.status === "done");
  const pending = results.filter((item) => item.status === "pending");
  const timeout = results.filter((item) => item.status === "timeout");
  const withFailures = done.filter((item) => item.failed.length > 0);
  const parts: string[] = [];
  if (pending.length > 0) parts.push(`还在等 ${pending.length} 台`);
  parts.push(`已重启 ${done.length} 台`);
  if (withFailures.length > 0) parts.push(`其中 ${withFailures.length} 台有进程没起来`);
  if (timeout.length > 0) parts.push(`${timeout.length} 台没回应（${timeout.slice(0, 3).map((item) => item.name).join("、")}${timeout.length > 3 ? " 等" : ""}）`);
  if (skipped.length > 0) {
    const listed = skipped.slice(0, 3).map((item) => `${item.name}：${item.reason}`).join("；");
    parts.push(`跳过 ${skipped.length} 台（${listed}${skipped.length > 3 ? " 等" : ""}）`);
  }
  return parts.join("，");
}

export type ScanItem = {
  key: string;
  tool: string;
  protocol?: string;
  listenAddr?: string;
  listenPort?: number;
  target?: string;
  source: string;
  unit?: string;
  unitActive?: boolean;
  importable: boolean;
  reason?: string;
};

const TOOL_FORWARD_TYPES: Record<string, "realm" | "gost" | "socat" | "iptables" | "nftables"> = {
  realm: "realm",
  gost: "gost",
  socat: "socat",
  iptables: "iptables",
  nftables: "nftables",
};

/** 把 Agent 上报的一项清洗成可信的形状（字段截断、类型校验）。 */
export function sanitizeScanItem(raw: unknown): ScanItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : undefined);
  const key = text(r.key, 64);
  const tool = text(r.tool, 32);
  if (!key || !/^[0-9a-f]{1,64}$/i.test(key) || !tool) return null;
  const port = Number(r.listenPort);
  return {
    key,
    tool,
    protocol: ["tcp", "udp", "both"].includes(String(r.protocol)) ? String(r.protocol) : undefined,
    listenAddr: text(r.listenAddr, 64),
    listenPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined,
    target: text(r.target, 300),
    source: text(r.source, 300) || "",
    unit: text(r.unit, 128),
    unitActive: r.unitActive === true,
    importable: r.importable === true,
    reason: text(r.reason, 300),
  };
}

export type ImportRuleInput = {
  name: string;
  forwardType: "realm" | "gost" | "socat" | "iptables" | "nftables";
  protocol: "tcp" | "udp" | "both";
  sourcePort: number;
  targetIp: string;
  targetPort: number;
};

/** 扫描到的一项 → rules.create 的入参；不能导入时返回原因。 */
export function scanItemToRuleInput(item: ScanItem): { input: ImportRuleInput } | { error: string } {
  if (!item.importable) return { error: item.reason || "这一项不能导入" };
  const forwardType = TOOL_FORWARD_TYPES[item.tool];
  if (!forwardType) return { error: `面板没有 ${item.tool} 这种转发方式` };
  if (!item.listenPort) return { error: "没有监听端口" };
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(item.target || "").trim());
  if (!match) return { error: `看不懂目标地址 ${item.target || ""}` };
  const targetPort = Number(match[2]);
  if (!(targetPort > 0 && targetPort <= 65535)) return { error: `目标端口不对 ${match[2]}` };
  const protocol = item.protocol === "udp" || item.protocol === "both" ? item.protocol : "tcp";
  return {
    input: {
      name: `导入 ${item.tool} :${item.listenPort}`,
      forwardType,
      protocol,
      sourcePort: item.listenPort,
      targetIp: match[1],
      targetPort,
    },
  };
}

/** 原来只听某个地址（不是 0.0.0.0 / ::）时提醒一句：面板的规则会听所有地址。 */
export function listenAddrNote(item: ScanItem): string | null {
  const addr = String(item.listenAddr || "").trim();
  if (!addr || addr === "0.0.0.0" || addr === "::" || addr === "[::]") return null;
  return `原来只听 ${addr}，导入后会听所有地址`;
}
