/*
  Google Cloud Compute Engine：删掉实例的外部访问配置（access config）再加回来，拿到新的临时外部 IP。

  流程：服务账号 JSON → RS256 JWT → POST https://oauth2.googleapis.com/token 换 access token
  （scope https://www.googleapis.com/auth/compute）→ GET instances/{name}（nic0 的 accessConfigs[0]：
  name 通常是 "External NAT"、natIP、networkTier）→ 旧 IP 若是保留的静态地址，在 regions/{region}/addresses
  里能查到 → POST deleteAccessConfig?accessConfig=…&networkInterface=nic0 → 等 zone operation DONE →
  POST addAccessConfig?networkInterface=nic0 {type ONE_TO_ONE_NAT, name, networkTier}（不带 natIP = 新临时 IP）
  → 等 DONE → 重新 GET 实例读 natIP。旧地址是静态保留地址且要求释放时 DELETE regions/{region}/addresses/{name}。
  删除和添加之间实例没有公网 IP（通常十几秒），所以 requiresDowntime = true。

  参考：
  - https://developers.google.com/identity/protocols/oauth2/service-account#httprest
  - https://cloud.google.com/compute/docs/reference/rest/v1/instances/get
  - https://cloud.google.com/compute/docs/reference/rest/v1/instances/deleteAccessConfig
  - https://cloud.google.com/compute/docs/reference/rest/v1/instances/addAccessConfig
  - https://cloud.google.com/compute/docs/reference/rest/v1/zoneOperations/get
  - https://cloud.google.com/compute/docs/reference/rest/v1/addresses/list
  - https://cloud.google.com/compute/docs/reference/rest/v1/addresses/delete
  - https://cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address
*/
import {
  appendToError,
  assertIp,
  bestEffort,
  defineProvider,
  httpRequest,
  httpStatusError,
  invalidInput,
  ipOrNull,
  markAmbiguous,
  optionalPattern,
  pollUntil,
  requireField,
  requirePattern,
  truncate,
} from "./common";
import { GOOGLE_TOKEN_URL, createJwtAssertion, parseServiceAccountKey } from "./signing/googleJwt";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "Google Cloud";
const API = "https://compute.googleapis.com/compute/v1";
const SCOPE = "https://www.googleapis.com/auth/compute";

type Ctx = { ctx: IpChangeContext; token: string; project: string; zone: string; region: string; instance: string };

async function getAccessToken(ctx: IpChangeContext, keyJson: string): Promise<{ token: string; projectId?: string }> {
  let account;
  try {
    account = parseServiceAccountKey(keyJson);
  } catch (error) {
    throw invalidInput(`${LABEL}：${(error as Error).message}`);
  }
  const assertion = createJwtAssertion(account, SCOPE, ctx.now());
  const resp = await httpRequest(ctx, {
    label: `${LABEL} OAuth`,
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const token = resp.json?.access_token;
  if (resp.status === 200 && typeof token === "string" && token) return { token, projectId: account.projectId };
  const detail = [resp.json?.error, resp.json?.error_description].filter(Boolean).join("：") || truncate(resp.text, 200);
  if (resp.status === 400 || resp.status === 401) {
    throw new IpChangeProviderError(`${LABEL}：服务账号密钥无效、已删除或被禁用（${detail}）`, { retryable: false });
  }
  throw httpStatusError(`${LABEL} OAuth`, resp.status, detail);
}

async function gce(c: Ctx, method: string, url: string, body?: unknown, mutating = false): Promise<any> {
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method}`,
    method,
    url,
    headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  const err = resp.json?.error;
  const reason = err?.errors?.[0]?.reason || err?.status || "";
  const detail = [reason, err?.message].filter(Boolean).join("：") || truncate(resp.text, 200);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：访问令牌无效（${detail}）`, { retryable: false });
  if (resp.status === 403) {
    throw new IpChangeProviderError(`${LABEL}：权限不足或项目未启用 Compute Engine API（${detail}）`, { retryable: false });
  }
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：资源不存在，请确认项目、可用区和实例名（${detail}）`, { retryable: false });
  throw httpStatusError(`${LABEL} ${method}`, resp.status, detail, { mutating });
}

function operationError(op: any): string | null {
  const errors = Array.isArray(op?.error?.errors) ? op.error.errors : [];
  if (!errors.length) return null;
  return errors.map((item: any) => [item?.code, item?.message].filter(Boolean).join("：")).join("；");
}

async function waitOperation(c: Ctx, op: any, scope: "zone" | "region", what: string) {
  const name = String(op?.name || "");
  if (!name) throw new IpChangeProviderError(`${LABEL}：${what}的响应里没有 operation 名称`, { retryable: false, ambiguous: true });
  let current = op;
  if (current?.status !== "DONE") {
    const base = scope === "zone" ? `${API}/projects/${c.project}/zones/${c.zone}` : `${API}/projects/${c.project}/regions/${c.region}`;
    current = await pollUntil(c.ctx, `${LABEL} ${what}完成`, async () => {
      const got = await gce(c, "GET", `${base}/operations/${encodeURIComponent(name)}`);
      return got?.status === "DONE" ? got : null;
    });
  }
  const failed = operationError(current);
  if (failed) throw new IpChangeProviderError(`${LABEL}：${what}失败（${failed}）`, { retryable: false });
  return current;
}

const instanceUrl = (c: Ctx) => `${API}/projects/${c.project}/zones/${c.zone}/instances/${c.instance}`;

async function readInstance(c: Ctx) {
  const body = await gce(c, "GET", instanceUrl(c));
  const nic = Array.isArray(body?.networkInterfaces) ? body.networkInterfaces[0] : null;
  if (!nic) throw new IpChangeProviderError(`${LABEL}：实例没有网卡`, { retryable: false });
  const configs: any[] = Array.isArray(nic.accessConfigs) ? nic.accessConfigs : [];
  const access = configs.find((item) => item?.type === "ONE_TO_ONE_NAT") || null;
  return {
    status: String(body?.status || ""),
    nicName: String(nic.name || "nic0"),
    access: access ? { name: String(access.name || "External NAT"), natIp: ipOrNull(access.natIP), networkTier: access.networkTier ? String(access.networkTier) : undefined } : null,
  };
}

async function open(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Promise<Ctx> {
  const keyJson = requireField(credentials, "serviceAccountKey", "服务账号 JSON 密钥");
  const zone = requirePattern(target, "zone", "可用区", /^[a-z]+-[a-z]+\d+-[a-z]$/, "形如 asia-east1-b");
  const instance = requirePattern(target, "instanceName", "实例名", /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/, "小写字母开头，只含小写字母、数字和短横线");
  let project = optionalPattern(target, "project", "项目 ID", /^[a-z][-a-z0-9.:]{4,62}[a-z0-9]$/, "形如 my-project-123456");
  const { token, projectId } = await getAccessToken(ctx, keyJson);
  if (!project) project = projectId || "";
  if (!project) throw invalidInput(`${LABEL}：密钥里没有 project_id，请填写「项目 ID」`);
  return { ctx, token, project, zone, region: zone.replace(/-[a-z]$/, ""), instance };
}

export const gcpGceProvider = defineProvider({
  id: "gcp-gce",
  label: "Google Cloud（GCE）",
  docsHint:
    "IAM → 服务账号 → 密钥 → 添加密钥（JSON），整份粘贴；角色需要 Compute Instance Admin (v1)（compute.instances.get/addAccessConfig/deleteAccessConfig、compute.zoneOperations.get），释放静态 IP 还需要 compute.addresses.list/delete。换 IP 时实例会有十几秒没有公网 IP。",
  credentialFields: [
    { key: "serviceAccountKey", label: "服务账号 JSON 密钥", type: "textarea", required: true, placeholder: '{"type": "service_account", ...}' },
  ],
  targetFields: [
    { key: "project", label: "项目 ID", type: "text", placeholder: "默认取密钥里的 project_id" },
    { key: "zone", label: "可用区", type: "text", required: true, placeholder: "asia-east1-b" },
    { key: "instanceName", label: "实例名", type: "text", required: true, placeholder: "instance-1" },
  ],
  requiresDowntime: true,

  async testCredentials(credentials, target, ctx) {
    const c = await open(credentials, target, ctx);
    return { currentIp: (await readInstance(c)).access?.natIp ?? null };
  },

  async getCurrentIp(credentials, target, ctx) {
    const c = await open(credentials, target, ctx);
    return (await readInstance(c)).access?.natIp ?? null;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = await open(credentials, target, ctx);
    const before = await readInstance(c);
    const oldIp = before.access?.natIp ?? null;
    const notes: string[] = [];

    let staticName: string | null = null;
    if (oldIp) {
      const filter = encodeURIComponent(`address="${oldIp}"`);
      const list = await gce(c, "GET", `${API}/projects/${c.project}/regions/${c.region}/addresses?filter=${filter}`);
      const found = (Array.isArray(list?.items) ? list.items : []).find((item: any) => item?.address === oldIp);
      staticName = found?.name ? String(found.name) : null;
    }
    ctx.log(`${LABEL}：当前外部 IP ${oldIp || "（无）"}${staticName ? `（静态地址 ${staticName}）` : "（临时 IP）"}`);

    const accessName = before.access?.name || "External NAT";
    if (before.access) {
      const query = `accessConfig=${encodeURIComponent(accessName)}&networkInterface=${encodeURIComponent(before.nicName)}`;
      const op = await gce(c, "POST", `${instanceUrl(c)}/deleteAccessConfig?${query}`, undefined, true);
      await waitOperation(c, op, "zone", "删除外部访问配置");
      ctx.log(`${LABEL}：已删除访问配置 ${accessName}`);
    }

    const addConfig = (natIp?: string) => {
      const body: Record<string, unknown> = { kind: "compute#accessConfig", type: "ONE_TO_ONE_NAT", name: accessName };
      if (before.access?.networkTier) body.networkTier = before.access.networkTier;
      if (natIp) body.natIP = natIp;
      return gce(c, "POST", `${instanceUrl(c)}/addAccessConfig?networkInterface=${encodeURIComponent(before.nicName)}`, body, true).then((op) =>
        waitOperation(c, op, "zone", "添加外部访问配置"),
      );
    };
    try {
      await addConfig();
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw markAmbiguous(error, "实例的外部访问配置状态未知，请到控制台确认实例是否有外部 IP");
      }
      let tail = "实例现在没有外部 IP，请到控制台手动添加";
      if (staticName && oldIp) {
        const ok = await bestEffort(ctx, `${LABEL}：把静态地址 ${oldIp} 加回去`, () => addConfig(oldIp));
        tail = ok ? `已把原静态地址 ${oldIp} 加回实例` : `原静态地址 ${oldIp} 加回失败，${tail}`;
      }
      throw appendToError(error, tail);
    }

    const after = await readInstance(c);
    const newIp = assertIp(after.access?.natIp, `${LABEL} 实例 `);

    let releasedOldIp = false;
    if (staticName) {
      if (options.releaseOldIp) {
        try {
          const op = await gce(c, "DELETE", `${API}/projects/${c.project}/regions/${c.region}/addresses/${encodeURIComponent(staticName)}`, undefined, true);
          await waitOperation(c, op, "region", "释放静态地址");
          releasedOldIp = true;
          notes.push(`已释放静态地址 ${staticName}（${oldIp}）`);
        } catch (error) {
          notes.push(`静态地址 ${staticName}（${oldIp}）释放失败，请到控制台手动释放：${(error as Error).message}`);
        }
      } else {
        notes.push(`原静态地址 ${staticName}（${oldIp}）已从实例上卸下但仍保留，闲置静态地址会计费`);
      }
    } else if (oldIp) {
      releasedOldIp = true;
      notes.push(`旧 IP ${oldIp} 是临时外部 IP，删除访问配置后已归还 Google`);
    }
    if (oldIp && newIp === oldIp) notes.push("Google 分配回了同一个 IP，可以稍后再试一次");
    notes.push(`新 IP ${newIp} 是临时外部 IP：实例停止再启动后可能会变`);
    return { oldIp, newIp, ipRole: "primary", releasedOldIp, notes };
  },
});
