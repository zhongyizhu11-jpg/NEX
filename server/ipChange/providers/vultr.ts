/*
  Vultr：给实例挂一个新的保留 IP（Reserved IP）作为入口。

  Vultr 不能改一台运行中实例的主 IP（main_ip）。官方文档对挂载行为的描述是
  "enables a new public network address on the instance's main network interface"，
  一台实例可以挂多个保留 IP；社区答复和第三方文章都说挂到运行中实例上的保留 IP 是附加 IP，
  不会变成 main_ip，且要在控制台 / API 重启实例后系统里才会配上这个地址（Bare Metal 文档明确要求重启，
  Cloud Compute 文档没写）。所以这里：ipRole = "entry"，默认挂完后重启实例（requiresDowntime = true），
  可在目标里关掉重启。

  流程：GET /v2/instances/{id}（region、main_ip）→ GET /v2/reserved-ips（游标翻页，找 instance_id == 目标）→
  POST /v2/reserved-ips {region, ip_type v4, label} → 旧的附加保留 IP：POST /reserved-ips/{旧}/detach →
  POST /reserved-ips/{新}/attach {instance_id} → 轮询 GET /reserved-ips/{新} 直到 instance_id 匹配 →
  要求释放时 DELETE /reserved-ips/{旧} → 需要时 POST /instances/{id}/reboot。
  如果旧保留 IP 恰好就是 main_ip（部署时用的保留 IP 或做过 convert），不去卸它，只记 note。

  参考：
  - https://www.vultr.com/api/#tag/reserved-ip （页面需要浏览器，抓取被 403，端点名称以下列官方文档为准）
  - https://docs.vultr.com/products/compute/instances/cloud-compute/networking/reserved-ips （attach 的 curl 示例）
  - https://docs.vultr.com/products/network/reserved-ips/management/attachment
  - https://docs.vultr.com/products/compute/instances/bare-metal/networking/reserved-ips （挂载后需重启）
  - https://docs.vultr.com/support/products/compute/can-i-convert-my-existing-instance-ip-into-reserved-ip
  - https://docs.vultr.com/reference/vultr-cli/reserved-ip
*/
import {
  appendToError,
  bestEffort,
  defineProvider,
  httpRequest,
  httpStatusError,
  ipOrNull,
  optionalChoice,
  pollUntil,
  requirePattern,
  resourceSuffix,
  truncate,
  assertIp,
} from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "Vultr";
const API = "https://api.vultr.com/v2";

type Ctx = { ctx: IpChangeContext; apiKey: string; instanceId: string };

async function vultr(c: Ctx, method: string, path: string, body?: unknown, mutating = false): Promise<any> {
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method} ${path.split("?")[0]}`,
    method,
    url: `${API}${path}`,
    headers: { Authorization: `Bearer ${c.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  const detail = String(resp.json?.error || "") || truncate(resp.text, 200);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：API Key 无效，或面板服务器 IP 不在 API 访问白名单里（${detail}）`, { retryable: false });
  if (resp.status === 403) throw new IpChangeProviderError(`${LABEL}：API Key 权限不足（${detail}）`, { retryable: false });
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：资源不存在（${detail}）`, { retryable: false });
  throw httpStatusError(`${LABEL} ${method}`, resp.status, detail, { mutating });
}

type Reserved = { id: string; ip: string | null; ipType: string; region: string; instanceId: string };
const toReserved = (item: any): Reserved => ({
  id: String(item?.id || ""),
  ip: ipOrNull(item?.subnet),
  ipType: String(item?.ip_type || ""),
  region: String(item?.region || ""),
  instanceId: String(item?.instance_id || ""),
});

async function listReserved(c: Ctx): Promise<Reserved[]> {
  const out: Reserved[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const body = await vultr(c, "GET", `/reserved-ips?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const item of Array.isArray(body?.reserved_ips) ? body.reserved_ips : []) out.push(toReserved(item));
    cursor = String(body?.meta?.links?.next || "");
    if (!cursor) break;
  }
  return out;
}

async function readInstance(c: Ctx) {
  const instance = (await vultr(c, "GET", `/instances/${c.instanceId}`))?.instance;
  if (!instance) throw new IpChangeProviderError(`${LABEL}：找不到实例 ${c.instanceId}`, { retryable: false });
  return { region: String(instance.region || ""), mainIp: ipOrNull(instance.main_ip) };
}

function open(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    apiKey: requirePattern(credentials, "apiKey", "API Key", /^[A-Za-z0-9]{20,100}$/, "账户 → API 里的 Personal Access Token"),
    instanceId: requirePattern(target, "instanceId", "实例 ID", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "UUID 格式"),
  };
}

async function entryIp(c: Ctx) {
  const instance = await readInstance(c);
  const extra = (await listReserved(c)).find((item) => item.instanceId === c.instanceId && item.ipType === "v4" && item.ip && item.ip !== instance.mainIp);
  return { instance, extra: extra || null };
}

export const vultrProvider = defineProvider({
  id: "vultr",
  label: "Vultr",
  docsHint:
    "账户 → API 启用并复制 Personal Access Token，记得把面板服务器的 IP 加进 API 访问白名单。Vultr 不能换实例主 IP：这里新建一个保留 IP 挂到实例上作为入口（附加 IP），默认挂完重启实例让系统配上新地址；面板需要把入口地址改成新 IP。",
  credentialFields: [{ key: "apiKey", label: "API Key", type: "password", required: true }],
  targetFields: [
    { key: "instanceId", label: "实例 ID", type: "text", required: true, placeholder: "UUID" },
    {
      key: "reboot",
      label: "挂载后重启实例",
      type: "select",
      help: "附加 IP 需要重启后系统里才会配置；如果你自己在系统里配置地址可以选「否」",
      options: [
        { value: "yes", label: "是（默认）" },
        { value: "no", label: "否" },
      ],
    },
  ],
  requiresDowntime: true,

  async testCredentials(credentials, target, ctx) {
    const found = await entryIp(open(credentials, target, ctx));
    return { currentIp: found.extra?.ip ?? found.instance.mainIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    const found = await entryIp(open(credentials, target, ctx));
    return found.extra?.ip ?? found.instance.mainIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = open(credentials, target, ctx);
    const reboot = optionalChoice(target, "reboot", "挂载后重启实例", ["yes", "no"], "yes") === "yes";
    const { instance, extra: old } = await entryIp(c);
    if (!instance.region) throw new IpChangeProviderError(`${LABEL}：读不到实例所在地域`, { retryable: false });
    const oldIp = old?.ip ?? instance.mainIp;
    const notes: string[] = [];

    let created: Reserved;
    try {
      const body = await vultr(c, "POST", "/reserved-ips", { region: instance.region, ip_type: "v4", label: `nex-${resourceSuffix(ctx)}` }, true);
      created = toReserved(body?.reserved_ip);
      assertIp(created.ip, `${LABEL} 创建保留 IP `);
      if (!created.id) throw new IpChangeProviderError(`${LABEL}：创建保留 IP 的响应缺少 id`, { retryable: false, ambiguous: true });
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, "可能已经创建了一个保留 IP，请到控制台检查，闲置的请删除");
      }
      throw error;
    }
    const newIp = created.ip as string;
    const deleteNew = () => bestEffort(ctx, `${LABEL}：删除新建的保留 IP ${newIp}`, () => vultr(c, "DELETE", `/reserved-ips/${created.id}`, undefined, true));

    let detached = false;
    try {
      if (old) {
        await vultr(c, "POST", `/reserved-ips/${old.id}/detach`, undefined, true);
        detached = true;
      }
      await vultr(c, "POST", `/reserved-ips/${created.id}/attach`, { instance_id: c.instanceId }, true);
      await pollUntil(ctx, `${LABEL} 保留 IP ${newIp} 挂载`, async () => {
        const got = toReserved((await vultr(c, "GET", `/reserved-ips/${created.id}`))?.reserved_ip);
        return got.instanceId === c.instanceId;
      }, { timeoutMs: 120_000 });
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, `保留 IP ${newIp} 的挂载状态未知，请到控制台确认`);
      }
      const parts: string[] = [];
      if (detached && old) {
        const ok = await bestEffort(ctx, `${LABEL}：把旧保留 IP ${old.ip} 挂回去`, () => vultr(c, "POST", `/reserved-ips/${old.id}/attach`, { instance_id: c.instanceId }, true));
        parts.push(ok ? `已把旧保留 IP ${old.ip} 挂回实例` : `旧保留 IP ${old.ip} 挂回失败，请到控制台处理`);
      }
      const ok = await deleteNew();
      parts.push(ok ? `已删除新建的保留 IP ${newIp}` : `新建的保留 IP ${newIp} 删除失败，请到控制台手动删除`);
      throw appendToError(error, parts.join("；"));
    }

    let releasedOldIp = false;
    if (old) {
      if (options.releaseOldIp) {
        try {
          await vultr(c, "DELETE", `/reserved-ips/${old.id}`, undefined, true);
          releasedOldIp = true;
          notes.push(`已删除旧保留 IP ${old.ip}`);
        } catch (error) {
          notes.push(`旧保留 IP ${old.ip} 删除失败，请到控制台手动删除：${(error as Error).message}`);
        }
      } else {
        notes.push(`旧保留 IP ${old.ip} 已卸下但仍保留，会继续计费`);
      }
    }
    if (reboot) {
      try {
        await vultr(c, "POST", `/instances/${c.instanceId}/reboot`, undefined, true);
        notes.push("已重启实例，让系统配置新的附加 IP");
      } catch (error) {
        notes.push(`重启实例失败，请到控制台手动重启后新 IP 才会生效：${(error as Error).message}`);
      }
    } else {
      notes.push(`没有重启实例：需要自己在系统里配置附加 IP ${newIp}，或到控制台重启`);
    }
    notes.push(`新入口 IP ${newIp} 是附加的保留 IP；实例主 IP ${instance.mainIp || "（未知）"} 不变，出站流量仍走主 IP`);
    return { oldIp, newIp, ipRole: "entry", releasedOldIp, notes };
  },
});
