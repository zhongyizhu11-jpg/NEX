import { normalizePublicAddress, parseHostDetectedAddresses, MAX_HOST_PUBLIC_ADDRESSES } from "./hostPublicAddresses";

/**
 * 主机 DDNS 发哪些记录（上游 2.3.286：A + AAAA 双栈，「仅主 IP / 全部 IP」）。
 *
 * 记录类型（hosts.ddnsIpVersion）：ipv4 → A，ipv6 → AAAA，dual → A 和 AAAA 都发。
 * 记录值（hosts.ddnsValueMode）：primary → 只发主 IP（= hosts.ipv4 / ipv6，见 shared/hostPublicAddresses），
 * all → 把 Agent 检测到的这一族全部地址发成同名的多条记录。
 *
 * **老配置一个字节都不变**：ipv4 / ipv6 + 仅主 IP 就是原来那条路 —— 单值接口 updateDdnsRecord，
 * lastDdnsValue 还是那个裸地址。新模式才用 `A=1.1.1.1,2.2.2.2;AAAA=2001:db8::1` 这种带类型的签名，
 * 好知道上次发过哪些类型：切回单栈时把面板自己发过的另一族删掉，不然双栈客户端会优先连一条
 * 早就不该存在的 AAAA。签名是裸地址（老配置留下的）时不删任何东西 —— 那不是这套逻辑发的。
 *
 * 一个名字只能挂一个值的服务商（Webhook：接收端认不认多值面板不知道，原来主机 DDNS 发的就是单个 value）
 * 选了「全部 IP」也退回主 IP，并在界面上说明；也不替它删记录。
 */

export type HostDdnsIpVersion = "ipv4" | "ipv6" | "dual";
export type HostDdnsValueMode = "primary" | "all";
export type HostDdnsRecordType = "A" | "AAAA";

export function normalizeHostDdnsIpVersion(value: unknown, recordType?: unknown): HostDdnsIpVersion {
  if (value === "dual") return "dual";
  if (value === "ipv6" || (!value && String(recordType || "").toUpperCase() === "AAAA")) return "ipv6";
  return "ipv4";
}

export function normalizeHostDdnsValueMode(value: unknown): HostDdnsValueMode {
  return value === "all" ? "all" : "primary";
}

/** 存进 ddnsRecordType 的值：dual 记成 A（主记录），老代码读到它也只当成 IPv4。 */
export function hostDdnsRecordTypeFor(ipVersion: HostDdnsIpVersion): HostDdnsRecordType {
  return ipVersion === "ipv6" ? "AAAA" : "A";
}

/**
 * 服务商能不能给同一个名字挂多个值（server/ddns.ts 的 updateDdnsRecordValues 支持的那几家）。
 * Webhook 按单值算：原来主机 DDNS 发给它的只有一个 value，接收端很可能只认一个。
 */
export function ddnsProviderSupportsMultipleValues(provider: unknown): boolean {
  const text = String(provider || "").trim().toLowerCase();
  return text === "cloudflare" || text === "huaweicloud" || text === "aliyun" || text === "tencentcloud";
}

export const DDNS_PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  huaweicloud: "华为云",
  aliyun: "阿里云",
  tencentcloud: "腾讯云 DNSPod",
  webhook: "Webhook",
};

/** 界面上「全部 IP」旁边那句：这个服务商会怎么发。 */
export function hostDdnsProviderValueModeNote(provider: unknown): string {
  const text = String(provider || "").trim().toLowerCase();
  const label = DDNS_PROVIDER_LABELS[text] || "当前服务商";
  if (ddnsProviderSupportsMultipleValues(text)) return `${label} 支持同名多条记录：每个地址一条，多出来的旧记录会删掉。`;
  return `${label} 一个名字只按单个地址推送，「全部 IP」会退回主 IP。`;
}

export type HostDdnsRecordPlan = {
  recordType: HostDdnsRecordType;
  values: string[];
  /** true 走多值接口（updateDdnsRecordValues，会删掉多余的同类型记录）；false 走原来的单值接口 */
  multiValue: boolean;
};

export type HostDdnsPlan = {
  ipVersion: HostDdnsIpVersion;
  valueMode: HostDdnsValueMode;
  /** 老配置（单栈 + 仅主 IP）：完全按原来的方式更新 */
  legacy: boolean;
  records: HostDdnsRecordPlan[];
  /** 面板上次发过、这次不再要的类型：清掉（多值接口传空列表） */
  removals: HostDdnsRecordType[];
  /** 要发但这台机器没有地址的族 */
  missing: Array<"ipv4" | "ipv6">;
  /** 存进 lastDdnsValue；和库里的一样就不用再调服务商 */
  signature: string;
  /** 给日志和界面的说明（例如服务商只能单值、退回主 IP） */
  notices: string[];
};

export type HostDdnsPlanSource = {
  ip?: unknown;
  ipv4?: unknown;
  ipv6?: unknown;
  ddnsRecordType?: unknown;
  ddnsIpVersion?: unknown;
  ddnsValueMode?: unknown;
  detectedAddresses?: unknown;
};

const RECORD_FAMILY: Record<HostDdnsRecordType, "ipv4" | "ipv6"> = { A: "ipv4", AAAA: "ipv6" };

function familyOfLiteral(value: string): HostDdnsRecordType | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return "A";
  if (value.includes(":")) return "AAAA";
  return null;
}

/**
 * 读 lastDdnsValue。新格式 `A=…;AAAA=…` 拆成类型 → 值列表，typed=true；
 * 老格式（一个裸地址）按地址族归类，typed=false。
 */
export function parseHostDdnsSignature(value: unknown): { typed: boolean; records: Partial<Record<HostDdnsRecordType, string[]>> } {
  const text = String(value ?? "").trim();
  if (!text) return { typed: false, records: {} };
  if (!/^(A|AAAA)=/i.test(text)) {
    const type = familyOfLiteral(text);
    return { typed: false, records: type ? { [type]: [text] } : {} };
  }
  const records: Partial<Record<HostDdnsRecordType, string[]>> = {};
  for (const part of text.split(";")) {
    const [rawType, rawValues = ""] = part.split("=");
    const type = String(rawType || "").trim().toUpperCase();
    if (type !== "A" && type !== "AAAA") continue;
    records[type] = rawValues.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return { typed: true, records };
}

export function formatHostDdnsSignature(records: Partial<Record<HostDdnsRecordType, string[]>>): string {
  return (["A", "AAAA"] as const)
    .filter((type) => (records[type] || []).length > 0)
    .map((type) => `${type}=${(records[type] || []).join(",")}`)
    .join(";");
}

/** 主 IP：和原来 hostDdnsTargetValue 读的一样，ipv4 / ipv6 那一栏（主 IP 选择已经喂进去了）。 */
function primaryValue(host: HostDdnsPlanSource, family: "ipv4" | "ipv6") {
  return String((family === "ipv4" ? host?.ipv4 : host?.ipv6) || "").trim();
}

function allValues(host: HostDdnsPlanSource, family: "ipv4" | "ipv6") {
  const detected = parseHostDetectedAddresses(host?.detectedAddresses);
  const primary = primaryValue(host, family);
  const out: string[] = [];
  // 主 IP 排第一：有的客户端只取第一条，有的服务商按顺序展示
  for (const value of [primary, ...((family === "ipv4" ? detected?.ipv4 : detected?.ipv6) || [])]) {
    const normalized = value === primary ? value : normalizePublicAddress(value, family);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_HOST_PUBLIC_ADDRESSES) break;
  }
  return out;
}

export function planHostDdnsRecords(
  host: HostDdnsPlanSource,
  options: { provider?: unknown; previous?: unknown } = {},
): HostDdnsPlan {
  const ipVersion = normalizeHostDdnsIpVersion(host?.ddnsIpVersion, host?.ddnsRecordType);
  const valueMode = normalizeHostDdnsValueMode(host?.ddnsValueMode);
  const multiProvider = ddnsProviderSupportsMultipleValues(options.provider);
  const previous = parseHostDdnsSignature(options.previous);
  const wanted: HostDdnsRecordType[] = ipVersion === "dual" ? ["A", "AAAA"] : [hostDdnsRecordTypeFor(ipVersion)];
  const legacy = ipVersion !== "dual" && valueMode === "primary";
  const notices: string[] = [];
  const records: HostDdnsRecordPlan[] = [];
  const missing: Array<"ipv4" | "ipv6"> = [];
  const published: Partial<Record<HostDdnsRecordType, string[]>> = {};

  if (valueMode === "all" && !multiProvider) {
    notices.push(hostDdnsProviderValueModeNote(options.provider));
  }

  for (const recordType of wanted) {
    const family = RECORD_FAMILY[recordType];
    const primary = primaryValue(host, family);
    let values = valueMode === "all" && multiProvider ? allValues(host, family) : (primary ? [primary] : []);
    if (values.length === 0 && valueMode === "all" && !multiProvider) {
      // 主 IP 栏空着、列表里却有：单值服务商就发列表里第一个
      values = allValues(host, family).slice(0, 1);
    }
    if (values.length === 0) {
      missing.push(family);
      // 这一族这次没地址：服务商那边的记录原样留着，签名里也照抄，免得下次误判成「变了」或漏删
      if (previous.typed && previous.records[recordType]?.length) published[recordType] = previous.records[recordType];
      continue;
    }
    const previousValues = previous.records[recordType] || [];
    // 多值接口：要发多个；或者上次发过多个、这次只剩一个（单值接口只改一条，多出来的会一直挂着）
    const multiValue = multiProvider && (values.length > 1 || previousValues.length > 1);
    records.push({ recordType, values, multiValue });
    published[recordType] = values;
  }

  const removals: HostDdnsRecordType[] = [];
  if (previous.typed) {
    for (const recordType of ["A", "AAAA"] as const) {
      if (wanted.includes(recordType) || !(previous.records[recordType] || []).length) continue;
      if (multiProvider) {
        removals.push(recordType);
      } else {
        notices.push(`${DDNS_PROVIDER_LABELS[String(options.provider || "").toLowerCase()] || "当前服务商"} 不能按名字删除记录，之前发的 ${recordType} 记录请手动清理。`);
      }
    }
  }

  // 老配置：签名就是那个裸地址，和原来写进 lastDdnsValue 的一模一样
  const signature = legacy ? records[0]?.values[0] || "" : formatHostDdnsSignature(published);
  return { ipVersion, valueMode, legacy, records, removals, missing, signature, notices };
}

/** 计划里有没有要对服务商做的事。 */
export function hostDdnsPlanHasWork(plan: HostDdnsPlan) {
  return plan.records.length > 0 || plan.removals.length > 0;
}

/** 日志 / 界面一句话说清楚这次发什么：`A 1.1.1.1, 2.2.2.2；AAAA 2001:db8::1`。 */
export function describeHostDdnsPlan(plan: HostDdnsPlan) {
  const parts = plan.records.map((record) => `${record.recordType} ${record.values.join(", ")}`);
  for (const type of plan.removals) parts.push(`删除 ${type}`);
  return parts.join("；") || "-";
}
