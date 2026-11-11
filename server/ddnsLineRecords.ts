import type { DdnsLineRef } from "@shared/ddnsLines";
import {
  ddnsRecordLockKey,
  getDdnsSettings,
  parseDdnsTtl,
  planDdnsValueChanges,
  splitDdnsName,
  tencentCloudRequest,
  uniqueDdnsValues,
  withProviderMinTtl,
  type DdnsSettings,
} from "./ddns";
import { listDnspodRecordLines, type DnspodRecordLine } from "./dnspodRecords";
import { normalizeManagedDnsName } from "./dnsManagedNames";
import { withKeyedTaskLock } from "./keyedTaskLock";

/*
  分线路解析在服务商那边的读写：某个名字、某种记录类型、某条线路上的一组记录。

  只支持腾讯云 DNSPod。阿里云（DescribeSupportLines + Line 参数）和华为云（固定的 line_id 列表）
  也有线路，但面板手里没有能对着测的账号，响应格式猜错的代价是误删记录，先不做；选了别的服务商时
  界面上的线路选择是灰的，服务端也完全不看成员上的线路配置（等于没分线路）。

  和默认线路的区别（默认线路的写法见 server/ddns.ts 的 updateTencentCloudValues）：
  - 每次写都返回这条线路上面板管着的记录 ID，存进组的 ddnsLineState；
  - 删一条线路（不再有成员 / 按设置回落）时只删存下来的那些 ID，并且先列一遍这条线路确认这些 ID
    还在、还是这个名字和类型 —— 别人在同一条线路上手加的记录不动；
  - 发布时和默认线路一样，同名同类型同线路的记录按值对账（这个名字归面板管，见 dnsManagedNames）。
*/

export type DdnsLineTransport = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

type Deps = {
  /** 拿一个能调 DNSPod 的函数；测试里换成假的。 */
  transport: (settings: DdnsSettings) => DdnsLineTransport;
  listLines: (rootDomain: string) => Promise<DnspodRecordLine[]>;
};

const defaultDeps: Deps = {
  transport: (settings) => (action, payload) => tencentCloudRequest(settings, action, payload),
  listLines: (rootDomain) => listDnspodRecordLines(rootDomain),
};
let deps: Deps = defaultDeps;

/** 测试用：换掉 DNSPod 请求。传 null 恢复默认。 */
export function configureDdnsLineRecordsForTests(overrides: Partial<Deps> | null) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

export type DdnsLineSupport = {
  supported: boolean;
  /** 不支持时给人看的原因。 */
  reason: string | null;
  /** DNSPod 主域名（拉线路列表、判断组域名在不在它下面用）。 */
  rootDomain: string | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  webhook: "Webhook",
  huaweicloud: "华为云 DNS",
  aliyun: "阿里云 DNS",
  tencentcloud: "腾讯云 DNSPod",
};

/** 现在的 DDNS 设置能不能按线路解析。纯判断，不发请求。 */
export function ddnsLineSupport(settings: DdnsSettings): DdnsLineSupport {
  if (!settings.enabled || settings.provider === "disabled") {
    return { supported: false, reason: "系统 DDNS 没有启用：分线路解析需要先在 系统设置 → DDNS 里配好并启用腾讯云 DNSPod", rootDomain: null };
  }
  if (settings.provider !== "tencentcloud") {
    return {
      supported: false,
      reason: `当前 DDNS 服务商（${PROVIDER_LABELS[settings.provider] || settings.provider}）暂不支持按运营商线路解析；目前只有腾讯云 DNSPod 支持分线路`,
      rootDomain: null,
    };
  }
  const rootDomain = normalizeManagedDnsName(settings.tencentcloudDomainName);
  if (!settings.tencentcloudSecretId.trim() || !settings.tencentcloudSecretKey.trim() || !rootDomain) {
    return { supported: false, reason: "腾讯云 DNSPod 的 SecretId / SecretKey 或主域名没有填全", rootDomain: null };
  }
  return { supported: true, reason: null, rootDomain };
}

/**
 * 组的「默认线路」：DDNS 设置里填的线路（没填就是 DNSPod 的「默认」，线路 ID 0）。
 * 组原来那条记录就写在这条线路上，分线路解析不改它。
 */
export function ddnsDefaultLine(settings: DdnsSettings): DdnsLineRef {
  const name = settings.tencentcloudRecordLine.trim() || "默认";
  const id = settings.tencentcloudRecordLineId.trim() || (name === "默认" ? "0" : "");
  return { id, name };
}

/** 给组编辑框用：能不能分线路、能选哪些线路。 */
export async function listDdnsLinesForGroups(domainValue?: string | null) {
  const settings = await getDdnsSettings();
  const support = ddnsLineSupport(settings);
  const defaultLine = ddnsDefaultLine(settings);
  if (!support.supported || !support.rootDomain) {
    return { supported: false as const, reason: support.reason, rootDomain: null, defaultLine, lines: [] as DdnsLineRef[], domainWarning: null };
  }
  const domain = normalizeManagedDnsName(domainValue);
  const domainWarning = domain && domain !== support.rootDomain && !domain.endsWith(`.${support.rootDomain}`)
    ? `入口域名 ${domain} 不在 DNSPod 主域名 ${support.rootDomain} 下，面板写不了它的记录`
    : null;
  const lines = await deps.listLines(support.rootDomain);
  return { supported: true as const, reason: null, rootDomain: support.rootDomain, defaultLine, lines, domainWarning };
}

export type DdnsLineRecordTarget = {
  domain: string;
  recordType: string;
  line: DdnsLineRef;
};

type DnspodRecordRow = { RecordId: string; Value: string };

function assertDnspod(settings: DdnsSettings) {
  const support = ddnsLineSupport(settings);
  if (!support.supported) throw new Error(support.reason || "当前 DDNS 服务商不支持分线路解析");
}

function normalizeRecordValue(recordType: string, value: unknown) {
  const text = String(value ?? "").trim();
  return recordType === "CNAME" ? text.toLowerCase().replace(/\.+$/, "") : text;
}

/** 每条线路一把锁：不同线路的记录互不相干，同一条线路的对账不能交错。 */
function lockKey(settings: DdnsSettings, target: DdnsLineRecordTarget) {
  return `${ddnsRecordLockKey(settings, target)}:line:${target.line.id || target.line.name}`;
}

/** 这个名字、类型、线路上现在的记录（只认 ID 是正整数的）。 */
async function listLineRecords(transport: DdnsLineTransport, root: string, subDomain: string, recordType: string, line: DdnsLineRef): Promise<DnspodRecordRow[]> {
  const payload: Record<string, unknown> = {
    Domain: root,
    Subdomain: subDomain,
    RecordType: recordType,
    RecordLine: line.name,
    Limit: 3000,
    ErrorOnEmpty: "no",
  };
  if (line.id) payload.RecordLineId = line.id;
  const list = await transport("DescribeRecordList", payload) as { RecordList?: unknown } | null;
  const rows: Array<Record<string, unknown> | null> = Array.isArray(list?.RecordList) ? list.RecordList : [];
  return rows
    .filter((item) => (
      String(item?.Name || "") === subDomain
      && String(item?.Type || "").toUpperCase() === recordType
      // DNSPod 按 RecordLineId 过滤过了，这里再核对一遍：宁可漏改，不能动到别的线路。
      && (line.id ? String(item?.LineId ?? "") === line.id : String(item?.Line || "") === line.name)
    ))
    .map((item) => ({ RecordId: String(item?.RecordId ?? "").trim(), Value: String(item?.Value ?? "") }))
    .filter((item: DnspodRecordRow) => /^\d{1,20}$/.test(item.RecordId) && Number(item.RecordId) > 0);
}

/**
 * 把一条线路上的记录改成 values（非空）。返回之后这条线路上面板管着的记录 ID。
 */
export async function publishDdnsLineRecords(
  settings: DdnsSettings,
  target: DdnsLineRecordTarget & { values: string[]; ttl?: number },
): Promise<{ recordIds: string[]; writes: number }> {
  assertDnspod(settings);
  const recordType = String(target.recordType || "A").trim().toUpperCase();
  const values = uniqueDdnsValues(target.values.map((value) => normalizeRecordValue(recordType, value)));
  if (values.length === 0) throw new Error("线路记录不能为空：要删掉请走删除");
  if (recordType === "CNAME" && values.length > 1) throw new Error("CNAME 记录只能指向一个值");
  const { root, subDomain } = splitDdnsName(target.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const transport = deps.transport(settings);
  const ttl = parseDdnsTtl(target.ttl, settings.tencentcloudTtl);
  return withKeyedTaskLock(lockKey(settings, { ...target, recordType }), async () => {
    const existing = await listLineRecords(transport, root, subDomain, recordType, target.line);
    const plan = planDdnsValueChanges(existing, values, (record) => normalizeRecordValue(recordType, record.Value));
    const kept = existing
      .filter((record) => !plan.removals.includes(record) && !plan.updates.some((change) => change.record === record))
      .map((record) => record.RecordId);
    let writes = 0;
    let created: string[] = [];
    await withProviderMinTtl("tencentcloud", root, ttl, async (effectiveTtl) => {
      created = [];
      const payloadFor = (value: string) => {
        const payload: Record<string, unknown> = {
          Domain: root,
          SubDomain: subDomain,
          RecordType: recordType,
          RecordLine: target.line.name,
          Value: value,
          TTL: effectiveTtl,
        };
        if (target.line.id) payload.RecordLineId = target.line.id;
        return payload;
      };
      for (const change of plan.updates) {
        await transport("ModifyRecord", { ...payloadFor(change.value), RecordId: Number(change.record.RecordId) });
        writes += 1;
      }
      for (const value of plan.creates) {
        const response = await transport("CreateRecord", payloadFor(value));
        writes += 1;
        const id = String((response as { RecordId?: unknown } | null)?.RecordId ?? "").trim();
        if (/^\d{1,20}$/.test(id)) created.push(id);
      }
    });
    for (const record of plan.removals) {
      await transport("DeleteRecord", { Domain: root, RecordId: Number(record.RecordId) });
      writes += 1;
    }
    let recordIds = [...kept, ...plan.updates.map((change) => change.record.RecordId), ...created];
    if (created.length < plan.creates.length) {
      // CreateRecord 没回 RecordId（不该发生）：重新列一遍拿 ID，不然以后删不到它。
      recordIds = (await listLineRecords(transport, root, subDomain, recordType, target.line)).map((record) => record.RecordId);
    }
    return { recordIds: Array.from(new Set(recordIds)), writes };
  });
}

/**
 * 删掉一条线路上面板写过的记录：只删 recordIds 里、此刻仍在这个名字 / 类型 / 线路上的。
 * 返回删掉的 ID 和没删的（不是面板写的）记录数。
 */
export async function deleteDdnsLineRecords(
  settings: DdnsSettings,
  target: DdnsLineRecordTarget & { recordIds: string[] },
): Promise<{ deleted: string[]; untouched: number }> {
  assertDnspod(settings);
  const tracked = new Set(target.recordIds.map((id) => String(id).trim()).filter((id) => /^\d{1,20}$/.test(id)));
  if (tracked.size === 0) return { deleted: [], untouched: 0 };
  const recordType = String(target.recordType || "A").trim().toUpperCase();
  const { root, subDomain } = splitDdnsName(target.domain, settings.tencentcloudDomainName, "腾讯云 DNSPod");
  const transport = deps.transport(settings);
  return withKeyedTaskLock(lockKey(settings, { ...target, recordType }), async () => {
    const existing = await listLineRecords(transport, root, subDomain, recordType, target.line);
    const deleted: string[] = [];
    for (const record of existing) {
      if (!tracked.has(record.RecordId)) continue;
      await transport("DeleteRecord", { Domain: root, RecordId: Number(record.RecordId) });
      deleted.push(record.RecordId);
    }
    return { deleted, untouched: existing.length - deleted.length };
  });
}
