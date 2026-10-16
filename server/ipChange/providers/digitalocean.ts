/*
  DigitalOcean：给 Droplet 换一个保留 IP（Reserved IP）作为入口。

  Droplet 自己的公网 IP 在 DigitalOcean 上换不了；保留 IP 通过 Droplet 的 anchor IP 做 1:1 NAT 进来，
  系统里不用配置就能收到入站流量（出站仍走 Droplet 自己的 IP），所以 ipRole = "entry"：
  面板要把入口地址 / DNS 改成新的保留 IP。

  流程：GET /v2/droplets/{id} → GET /v2/reserved_ips（翻页，找 droplet.id == 目标）→
  有旧保留 IP：POST /v2/reserved_ips/{ip}/actions {type: unassign} → 等 action completed →
  POST /v2/reserved_ips {droplet_id}（创建时直接分配，响应 links.actions 里带 assign 动作）→ 等 completed →
  GET /v2/reserved_ips/{新 ip} 确认 droplet.id → 要求释放时 DELETE /v2/reserved_ips/{旧 ip}（204）。
  新 IP 失败时把旧保留 IP 重新 assign 回去。

  参考：
  - https://docs.digitalocean.com/reference/api/digitalocean/#tag/Reserved-IPs
  - https://docs.digitalocean.com/reference/api/digitalocean/#tag/Reserved-IP-Actions
  - https://docs.digitalocean.com/reference/api/digitalocean/#tag/Actions
  - https://docs.digitalocean.com/products/networking/reserved-ips/
  - OpenAPI：https://api-engineering.nyc3.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml
    （reservedIPs_create 202、reserved_ip_created 的 links.actions、reservedIPs_delete 204）
*/
import {
  appendToError,
  assertIp,
  bestEffort,
  defineProvider,
  httpRequest,
  httpStatusError,
  ipOrNull,
  pollUntil,
  requirePattern,
  truncate,
} from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "DigitalOcean";
const API = "https://api.digitalocean.com/v2";

type Ctx = { ctx: IpChangeContext; token: string; dropletId: string };

async function doCall(c: Ctx, method: string, path: string, body?: unknown, mutating = false): Promise<any> {
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method} ${path.split("?")[0]}`,
    method,
    url: `${API}${path}`,
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  const detail = [resp.json?.id, resp.json?.message].filter(Boolean).join("：") || truncate(resp.text, 200);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：API Token 无效或已撤销（${detail}）`, { retryable: false });
  if (resp.status === 403) throw new IpChangeProviderError(`${LABEL}：API Token 缺少权限（需要 reserved_ip 读写、droplet:read、actions:read）（${detail}）`, { retryable: false });
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：资源不存在（${detail}）`, { retryable: false });
  throw httpStatusError(`${LABEL} ${method}`, resp.status, detail, { mutating });
}

async function waitAction(c: Ctx, action: { id?: unknown; status?: unknown } | undefined, what: string) {
  const id = String(action?.id ?? "");
  if (!/^\d+$/.test(id) || action?.status === "completed") return;
  await pollUntil(c.ctx, `${LABEL} ${what}`, async () => {
    const body = await doCall(c, "GET", `/actions/${id}`);
    const status = String(body?.action?.status || "");
    if (status === "errored") throw new IpChangeProviderError(`${LABEL}：${what}失败（action ${id} errored）`, { retryable: false, ambiguous: true });
    return status === "completed";
  });
}

async function findReservedIp(c: Ctx): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const body = await doCall(c, "GET", `/reserved_ips?page=${page}&per_page=200`);
    const items: any[] = Array.isArray(body?.reserved_ips) ? body.reserved_ips : [];
    const hit = items.find((item) => String(item?.droplet?.id ?? "") === c.dropletId);
    if (hit) return ipOrNull(hit.ip);
    if (!body?.links?.pages?.next || !items.length) break;
  }
  return null;
}

async function dropletPublicIp(c: Ctx): Promise<string | null> {
  const body = await doCall(c, "GET", `/droplets/${c.dropletId}`);
  const v4: any[] = Array.isArray(body?.droplet?.networks?.v4) ? body.droplet.networks.v4 : [];
  return ipOrNull(v4.find((item) => item?.type === "public")?.ip_address);
}

function open(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    token: requirePattern(credentials, "token", "API Token", /^\S{20,200}$/, "长度不对或含空白"),
    dropletId: requirePattern(target, "dropletId", "Droplet ID", /^\d{1,20}$/, "纯数字，控制台 URL 里的那串数字"),
  };
}

async function currentEntryIp(c: Ctx) {
  const publicIp = await dropletPublicIp(c);
  const reserved = await findReservedIp(c);
  return { publicIp, reserved };
}

export const digitaloceanProvider = defineProvider({
  id: "digitalocean",
  label: "DigitalOcean",
  docsHint:
    "控制台 API → Tokens 生成个人访问令牌（勾选 reserved_ip 读写、droplet:read、actions:read 或全部写权限）。换的是保留 IP（入口 IP），Droplet 自己的 IP 不变，面板需要把入口地址改成新 IP。",
  credentialFields: [{ key: "token", label: "API Token", type: "password", required: true, placeholder: "dop_v1_…" }],
  targetFields: [{ key: "dropletId", label: "Droplet ID", type: "text", required: true, placeholder: "123456789" }],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    const found = await currentEntryIp(open(credentials, target, ctx));
    return { currentIp: found.reserved ?? found.publicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    const found = await currentEntryIp(open(credentials, target, ctx));
    return found.reserved ?? found.publicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = open(credentials, target, ctx);
    const { publicIp, reserved: oldReserved } = await currentEntryIp(c);
    const oldIp = oldReserved ?? publicIp;
    const notes: string[] = [];

    if (oldReserved) {
      const body = await doCall(c, "POST", `/reserved_ips/${oldReserved}/actions`, { type: "unassign" }, true);
      await waitAction(c, body?.action, `解除保留 IP ${oldReserved}`);
      ctx.log(`${LABEL}：已解除保留 IP ${oldReserved}`);
    }

    let newIp: string;
    try {
      const body = await doCall(c, "POST", "/reserved_ips", { droplet_id: Number(c.dropletId) }, true);
      newIp = assertIp(body?.reserved_ip?.ip, `${LABEL} 创建保留 IP `);
      const assign = (Array.isArray(body?.links?.actions) ? body.links.actions : []).find((item: any) => item?.rel === "assign_ip") || body?.links?.actions?.[0];
      await waitAction(c, assign, `分配保留 IP ${newIp}`);
      const check = await doCall(c, "GET", `/reserved_ips/${newIp}`);
      if (String(check?.reserved_ip?.droplet?.id ?? "") !== c.dropletId) {
        throw new IpChangeProviderError(`${LABEL}：保留 IP ${newIp} 没有分配到 Droplet ${c.dropletId}`, { retryable: false, ambiguous: true });
      }
    } catch (error) {
      if (oldReserved) {
        const ok = await bestEffort(ctx, `${LABEL}：把保留 IP ${oldReserved} 分配回去`, async () => {
          const body = await doCall(c, "POST", `/reserved_ips/${oldReserved}/actions`, { type: "assign", droplet_id: Number(c.dropletId) }, true);
          await waitAction(c, body?.action, `分配回保留 IP ${oldReserved}`);
        });
        throw appendToError(error, ok ? `已把原保留 IP ${oldReserved} 分配回 Droplet` : `原保留 IP ${oldReserved} 分配回去失败，请到控制台处理`);
      }
      throw error;
    }

    let releasedOldIp = false;
    if (oldReserved) {
      if (options.releaseOldIp) {
        try {
          await doCall(c, "DELETE", `/reserved_ips/${oldReserved}`, undefined, true);
          releasedOldIp = true;
          notes.push(`已删除旧保留 IP ${oldReserved}`);
        } catch (error) {
          notes.push(`旧保留 IP ${oldReserved} 删除失败，请到控制台手动删除：${(error as Error).message}`);
        }
      } else {
        notes.push(`旧保留 IP ${oldReserved} 已解除分配但仍保留，未分配的保留 IP 会计费`);
      }
    }
    notes.push(`新入口 IP ${newIp} 是保留 IP；Droplet 自己的公网 IP ${publicIp || "（未知）"} 不变，出站流量仍走它`);
    return { oldIp, newIp, ipRole: "entry", releasedOldIp, notes };
  },
});
