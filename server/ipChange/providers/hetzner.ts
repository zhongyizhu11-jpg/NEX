/*
  Hetzner Cloud：换服务器的 Primary IPv4。Primary IP 的分配 / 解除 / 删除都要求服务器处于 off，所以要停机。

  流程：GET /servers/{id}（public_net.ipv4.id / ip，status）→ GET /primary_ips/{旧 id}（auto_delete、删除保护）→
  POST /servers/{id}/actions/shutdown（ACPI 优雅关机，文档说 action 成功只代表信号已发出）→ 轮询 status=off，
  90 秒还没关就 POST poweroff（断电）→ POST /primary_ips/{旧}/actions/unassign → 等 action →
  POST /primary_ips {name, type ipv4, assignee_type server, assignee_id, auto_delete = 旧的 auto_delete} → 等 action →
  要求释放时 DELETE /primary_ips/{旧}（2026-05-01 起必须先解除分配，且服务器必须 off）→
  POST /servers/{id}/actions/poweron → 等 action → 再读一次服务器确认新 IP。
  任何一步失败都会尽量把旧 IP 分配回去并开机。

  参考：
  - https://docs.hetzner.cloud/reference/cloud#tag/primary-ips
  - https://docs.hetzner.cloud/reference/cloud#tag/primary-ip-actions
  - https://docs.hetzner.cloud/reference/cloud#tag/server-actions （shutdown / poweroff / poweron）
  - https://docs.hetzner.cloud/reference/cloud#tag/actions
  - OpenAPI：https://docs.hetzner.cloud/cloud.spec.json（server_not_stopped / must_be_unassigned 等错误码、字段结构）
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
  resourceSuffix,
  truncate,
} from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "Hetzner";
const API = "https://api.hetzner.cloud/v1";

type Ctx = { ctx: IpChangeContext; token: string; serverId: string };

async function hz(c: Ctx, method: string, path: string, body?: unknown, mutating = false): Promise<any> {
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method} ${path}`,
    method,
    url: `${API}${path}`,
    headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  const code = String(resp.json?.error?.code || "");
  const detail = code ? `${code}${resp.json?.error?.message ? `：${resp.json.error.message}` : ""}` : truncate(resp.text, 200);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：API Token 无效（${detail}）`, { retryable: false });
  if (resp.status === 403) throw new IpChangeProviderError(`${LABEL}：API Token 没有写权限（需要 Read & Write）（${detail}）`, { retryable: false });
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：资源不存在（${detail}）`, { retryable: false });
  if (resp.status === 423 || code === "locked" || code === "conflict") {
    throw new IpChangeProviderError(`${LABEL}：资源正被其他操作锁定（${detail}）`, { retryable: true });
  }
  throw httpStatusError(`${LABEL} ${method} ${path}`, resp.status, detail, { mutating });
}

async function waitAction(c: Ctx, action: any, what: string) {
  const id = action?.id;
  if (id === undefined || id === null) return;
  if (action.status === "success") return;
  if (action.status === "error") throw new IpChangeProviderError(`${LABEL}：${what}失败（${action?.error?.message || "error"}）`, { retryable: false });
  await pollUntil(c.ctx, `${LABEL} ${what}`, async () => {
    const got = (await hz(c, "GET", `/actions/${id}`))?.action;
    if (got?.status === "error") {
      throw new IpChangeProviderError(`${LABEL}：${what}失败（${[got?.error?.code, got?.error?.message].filter(Boolean).join("：") || "error"}）`, { retryable: false });
    }
    return got?.status === "success";
  });
}

async function readServer(c: Ctx) {
  const server = (await hz(c, "GET", `/servers/${c.serverId}`))?.server;
  if (!server) throw new IpChangeProviderError(`${LABEL}：找不到服务器 ${c.serverId}`, { retryable: false });
  const v4 = server?.public_net?.ipv4;
  return { status: String(server.status || ""), ipv4Id: v4?.id ?? null, ip: ipOrNull(v4?.ip) };
}

async function waitOff(c: Ctx, timeoutMs: number) {
  await pollUntil(c.ctx, `${LABEL} 服务器关机`, async () => (await readServer(c)).status === "off", { timeoutMs });
}

function open(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    token: requirePattern(credentials, "token", "API Token", /^[A-Za-z0-9]{32,128}$/, "项目 → 安全 → API 令牌里生成的 64 位字符串"),
    serverId: requirePattern(target, "serverId", "服务器 ID", /^\d{1,20}$/, "纯数字"),
  };
}

export const hetznerProvider = defineProvider({
  id: "hetzner",
  label: "Hetzner Cloud",
  docsHint:
    "Cloud Console → 项目 → 安全 → API 令牌，生成「读写」令牌。换 Primary IPv4 需要先关机（先 ACPI 关机，90 秒没关就断电），换完自动开机；旧 IP 不释放的话会作为未分配的 Primary IP 继续计费。",
  credentialFields: [{ key: "token", label: "API Token", type: "password", required: true }],
  targetFields: [{ key: "serverId", label: "服务器 ID", type: "text", required: true, placeholder: "12345678" }],
  requiresDowntime: true,

  async testCredentials(credentials, target, ctx) {
    return { currentIp: (await readServer(open(credentials, target, ctx))).ip };
  },

  async getCurrentIp(credentials, target, ctx) {
    return (await readServer(open(credentials, target, ctx))).ip;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = open(credentials, target, ctx);
    const server = await readServer(c);
    const oldIp = server.ip;
    const old = server.ipv4Id !== null ? (await hz(c, "GET", `/primary_ips/${server.ipv4Id}`))?.primary_ip : null;
    const wasOn = server.status !== "off";
    const notes: string[] = [];
    const serverIdNum = Number(c.serverId);

    const powerOn = async () => {
      const body = await hz(c, "POST", `/servers/${c.serverId}/actions/poweron`, undefined, true);
      await waitAction(c, body?.action, "开机");
    };

    // 1. 关机
    if (wasOn) {
      ctx.log(`${LABEL}：发送 ACPI 关机`);
      await hz(c, "POST", `/servers/${c.serverId}/actions/shutdown`, undefined, true);
      try {
        await waitOff(c, 90_000);
      } catch {
        ctx.log(`${LABEL}：90 秒内没有关机，改为断电`);
        const body = await hz(c, "POST", `/servers/${c.serverId}/actions/poweroff`, undefined, true);
        await waitAction(c, body?.action, "断电");
        await waitOff(c, 60_000);
        notes.push("服务器没有响应 ACPI 关机，已强制断电");
      }
    }

    let newIp: string;
    let newId: number | null = null;
    let unassigned = false;
    try {
      // 2. 解除旧 IP
      if (old?.id) {
        const body = await hz(c, "POST", `/primary_ips/${old.id}/actions/unassign`, undefined, true);
        await waitAction(c, body?.action, `解除 Primary IP ${oldIp}`);
        unassigned = true;
      }
      // 3. 新建并分配
      const body = await hz(
        c,
        "POST",
        "/primary_ips",
        { name: `nex-${c.serverId}-${resourceSuffix(ctx)}`, type: "ipv4", assignee_type: "server", assignee_id: serverIdNum, auto_delete: Boolean(old?.auto_delete) },
        true,
      );
      newId = body?.primary_ip?.id ?? null;
      newIp = assertIp(body?.primary_ip?.ip, `${LABEL} 新建 Primary IP `);
      await waitAction(c, body?.action, `分配 Primary IP ${newIp}`);
    } catch (error) {
      const parts: string[] = [];
      const ambiguous = error instanceof IpChangeProviderError && error.options.ambiguous;
      if (!ambiguous && newId !== null) {
        const ok = await bestEffort(ctx, `${LABEL}：删除新建的 Primary IP`, () => hz(c, "DELETE", `/primary_ips/${newId}`, undefined, true));
        parts.push(ok ? "已删除新建的 Primary IP" : `新建的 Primary IP（${newId}）删除失败，请到控制台手动删除`);
      }
      if (!ambiguous && unassigned && old?.id) {
        const ok = await bestEffort(ctx, `${LABEL}：把旧 Primary IP 分配回去`, async () => {
          const body = await hz(c, "POST", `/primary_ips/${old.id}/actions/assign`, { assignee_type: "server", assignee_id: serverIdNum }, true);
          await waitAction(c, body?.action, "分配回旧 Primary IP");
        });
        parts.push(ok ? `已把旧 IP ${oldIp} 分配回服务器` : `旧 IP ${oldIp} 分配回去失败，请到控制台处理`);
      }
      if (wasOn) {
        const ok = await bestEffort(ctx, `${LABEL}：开机`, powerOn);
        parts.push(ok ? "服务器已重新开机" : "服务器开机失败，请到控制台手动开机");
      }
      throw parts.length ? appendToError(error, parts.join("；")) : error;
    }

    // 4. 释放旧 IP（服务器必须 off）
    let releasedOldIp = false;
    if (old?.id) {
      if (options.releaseOldIp) {
        if (old?.protection?.delete) {
          notes.push(`旧 Primary IP ${oldIp} 开启了删除保护，没有删除`);
        } else {
          try {
            await hz(c, "DELETE", `/primary_ips/${old.id}`, undefined, true);
            releasedOldIp = true;
            notes.push(`已删除旧 Primary IP ${oldIp}`);
          } catch (error) {
            notes.push(`旧 Primary IP ${oldIp} 删除失败，请到控制台手动删除：${(error as Error).message}`);
          }
        }
      } else {
        notes.push(`旧 Primary IP ${oldIp}（${old.id}）已解除分配但仍保留，会继续计费`);
      }
    }

    // 5. 开机并确认
    if (wasOn) {
      try {
        await powerOn();
      } catch (error) {
        throw appendToError(error, `IP 已换成 ${newIp}，但服务器开机失败，请到控制台手动开机`);
      }
    }
    const after = await readServer(c);
    if (after.ip !== newIp) {
      throw new IpChangeProviderError(`${LABEL}：服务器当前 IP 是 ${after.ip || "（无）"}，不是新分配的 ${newIp}，请到控制台确认`, { retryable: false, ambiguous: true });
    }
    notes.push(`新 IP ${newIp} 是 Primary IP${old?.auto_delete ? "（随服务器删除）" : ""}`);
    return { oldIp, newIp, ipRole: "primary", releasedOldIp, notes };
  },
});
