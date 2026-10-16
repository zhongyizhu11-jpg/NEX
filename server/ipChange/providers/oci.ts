/*
  甲骨文云 OCI：删掉主私网 IP 上的临时公网 IP（或卸下预留公网 IP），再给它建一个新的临时公网 IP。

  流程（Core Services API 20160918，https://iaas.<region>.oraclecloud.com）：
  ListVnicAttachments(compartmentId, instanceId) → GetVnic（找 isPrimary）→ ListPrivateIps(vnicId)（找 isPrimary）
  → POST /publicIps/actions/getByPrivateIpId（404 = 没有公网 IP）
  → EPHEMERAL：DeletePublicIp，等它 404 / TERMINATED；RESERVED：UpdatePublicIp {"privateIpId": ""} 卸下，等 AVAILABLE
  → CreatePublicIp {compartmentId = 私网 IP 所在 compartment, lifetime EPHEMERAL, privateIpId} → 等 ASSIGNED
  → 旧的是 RESERVED 且要求释放时 DeletePublicIp(旧)。
  中间实例没有公网 IP（通常几秒到十几秒），requiresDowntime = true。

  签名：draft-cavage HTTP Signature rsa-sha256（signing/ociHttpSignature.ts，单测复现了官方测试向量）。

  参考：
  - https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
  - https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm
  - https://docs.oracle.com/en-us/iaas/api/#/en/iaas/20160918/PublicIp/
  - https://github.com/oracle/oci-go-sdk/blob/master/core/create_public_ip_details.go
    （ephemeral 公网 IP 的 compartmentId 必须是私网 IP 的 compartment；privateIpId 必须是主私网 IP）
  - https://github.com/oracle/oci-go-sdk/blob/master/core/update_public_ip_details.go （privateIpId 设为空串 = 卸下）
  - https://github.com/oracle/oci-go-sdk/blob/master/core/public_ip.go （lifecycleState 取值）
  - https://github.com/oracle/oci-go-sdk/blob/master/core/core_virtualnetwork_client.go （各接口路径）
*/
import {
  REGION_HINT,
  REGION_PATTERN,
  appendToError,
  assertIp,
  bestEffort,
  defineProvider,
  httpRequest,
  httpStatusError,
  invalidInput,
  ipOrNull,
  markAmbiguous,
  pollUntil,
  readField,
  requireField,
  requirePattern,
  resourceSuffix,
  truncate,
} from "./common";
import { loadOciPrivateKey, ociSign } from "./signing/ociHttpSignature";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";
import type { KeyObject } from "node:crypto";

const LABEL = "OCI";
const OCID = (kind: string) => new RegExp(`^ocid1\\.${kind}\\.[a-z0-9-]+\\.[a-z0-9-]*\\.[a-z0-9]+$`);

type Ctx = { ctx: IpChangeContext; keyId: string; key: KeyObject; region: string; compartmentId: string; instanceId: string };

async function ociCall(c: Ctx, method: string, path: string, body?: unknown, options: { mutating?: boolean; allow404?: boolean } = {}): Promise<any> {
  const url = `https://iaas.${c.region}.oraclecloud.com/20160918${path}`;
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { date: c.ctx.now().toUTCString(), accept: "application/json" };
  if (text !== undefined) headers["content-type"] = "application/json";
  const signed = ociSign({ method, url, headers, body: text, keyId: c.keyId, privateKey: c.key });
  const { host: _host, "content-length": _len, ...send } = signed.headers;
  const resp = await httpRequest(c.ctx, { label: `${LABEL} ${method} ${path.split("?")[0]}`, method, url, headers: send, body: text, mutating: options.mutating });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  if (resp.status === 404 && options.allow404) return null;
  const code = String(resp.json?.code || "");
  const detail = code ? `${code}${resp.json?.message ? `：${resp.json.message}` : ""}` : truncate(resp.text, 200);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：API 签名密钥无效（检查租户 / 用户 OCID、指纹和私钥是否匹配）（${detail}）`, { retryable: false });
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：资源不存在或策略不允许访问（${detail}）`, { retryable: false });
  if (resp.status === 409 || resp.status === 429) {
    throw new IpChangeProviderError(`${LABEL} ${method} ${path.split("?")[0]} 暂时冲突或被限流（${detail}）`, { retryable: true });
  }
  throw httpStatusError(`${LABEL} ${method}`, resp.status, detail, { mutating: options.mutating });
}

type PublicIp = { id: string; ip: string | null; lifetime: string; state: string };
const toPublicIp = (item: any): PublicIp => ({
  id: String(item?.id || ""),
  ip: ipOrNull(item?.ipAddress),
  lifetime: String(item?.lifetime || ""),
  state: String(item?.lifecycleState || ""),
});

async function locate(c: Ctx) {
  const q = new URLSearchParams({ compartmentId: c.compartmentId, instanceId: c.instanceId }).toString();
  const attachments = await ociCall(c, "GET", `/vnicAttachments?${q}`);
  const attached = (Array.isArray(attachments) ? attachments : []).filter((item: any) => item?.lifecycleState === "ATTACHED" && item?.vnicId);
  if (!attached.length) throw new IpChangeProviderError(`${LABEL}：实例没有已挂载的 VNIC，请确认 compartment 和实例 OCID`, { retryable: false });
  let vnic: any = null;
  for (const attachment of attached) {
    const got = await ociCall(c, "GET", `/vnics/${encodeURIComponent(attachment.vnicId)}`);
    if (got?.isPrimary) {
      vnic = got;
      break;
    }
  }
  if (!vnic) throw new IpChangeProviderError(`${LABEL}：找不到主 VNIC`, { retryable: false });
  const privateIps = await ociCall(c, "GET", `/privateIps?${new URLSearchParams({ vnicId: String(vnic.id) }).toString()}`);
  const primary = (Array.isArray(privateIps) ? privateIps : []).find((item: any) => item?.isPrimary);
  if (!primary?.id) throw new IpChangeProviderError(`${LABEL}：找不到主私网 IP`, { retryable: false });
  const pub = await ociCall(c, "POST", "/publicIps/actions/getByPrivateIpId", { privateIpId: primary.id }, { allow404: true });
  return {
    vnicCompartmentId: String(vnic.compartmentId || primary.compartmentId || c.compartmentId),
    privateIpId: String(primary.id),
    publicIp: pub ? toPublicIp(pub) : null,
    vnicPublicIp: ipOrNull(vnic.publicIp),
  };
}

async function getPublicIp(c: Ctx, id: string): Promise<PublicIp | null> {
  const got = await ociCall(c, "GET", `/publicIps/${encodeURIComponent(id)}`, undefined, { allow404: true });
  return got ? toPublicIp(got) : null;
}

function readAll(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  const tenancy = requirePattern(credentials, "tenancyOcid", "租户 OCID", OCID("tenancy"), "形如 ocid1.tenancy.oc1..aaaa…");
  const user = requirePattern(credentials, "userOcid", "用户 OCID", OCID("user"), "形如 ocid1.user.oc1..aaaa…");
  const fingerprint = requirePattern(credentials, "fingerprint", "密钥指纹", /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/, "形如 20:3b:97:13:…（16 组十六进制）");
  const pem = requireField(credentials, "privateKey", "API 私钥（PEM）");
  let key: KeyObject;
  try {
    key = loadOciPrivateKey(pem, readField(credentials, "passphrase"));
  } catch {
    throw invalidInput(`${LABEL}：API 私钥无法解析（需要 PEM 格式；有口令的私钥请填写口令）`);
  }
  return {
    ctx,
    keyId: `${tenancy}/${user}/${fingerprint}`,
    key,
    region: requirePattern(target, "region", "地域", REGION_PATTERN, `${REGION_HINT}（OCI 如 ap-tokyo-1）`),
    compartmentId: requirePattern(target, "compartmentId", "Compartment OCID", /^ocid1\.(compartment|tenancy)\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9]+$/, "形如 ocid1.compartment.oc1..aaaa…（根 compartment 就是租户 OCID）"),
    instanceId: requirePattern(target, "instanceId", "实例 OCID", OCID("instance"), "形如 ocid1.instance.oc1.ap-tokyo-1.aaaa…"),
  };
}

export const ociProvider = defineProvider({
  id: "oci",
  label: "甲骨文云 OCI",
  docsHint:
    "控制台 → 我的概要信息 → API 密钥 → 添加 API 密钥，记下配置文件里的 tenancy / user / fingerprint 并粘贴私钥；IAM 策略需要 manage public-ips、read vnic-attachments、read vnics、read private-ips（in compartment）。换的是临时公网 IP，期间实例会有几秒没有公网 IP。",
  credentialFields: [
    { key: "tenancyOcid", label: "租户 OCID", type: "text", required: true, placeholder: "ocid1.tenancy.oc1..aaaa…" },
    { key: "userOcid", label: "用户 OCID", type: "text", required: true, placeholder: "ocid1.user.oc1..aaaa…" },
    { key: "fingerprint", label: "密钥指纹", type: "text", required: true, placeholder: "20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34" },
    { key: "privateKey", label: "API 私钥（PEM）", type: "textarea", required: true, placeholder: "-----BEGIN PRIVATE KEY-----" },
    { key: "passphrase", label: "私钥口令", type: "password", help: "私钥没有加密就留空" },
  ],
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "ap-tokyo-1" },
    { key: "compartmentId", label: "Compartment OCID", type: "text", required: true, placeholder: "ocid1.compartment.oc1..aaaa…" },
    { key: "instanceId", label: "实例 OCID", type: "text", required: true, placeholder: "ocid1.instance.oc1.ap-tokyo-1.aaaa…" },
  ],
  requiresDowntime: true,

  async testCredentials(credentials, target, ctx) {
    const found = await locate(readAll(credentials, target, ctx));
    return { currentIp: found.publicIp?.ip ?? found.vnicPublicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    const found = await locate(readAll(credentials, target, ctx));
    return found.publicIp?.ip ?? found.vnicPublicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = readAll(credentials, target, ctx);
    const found = await locate(c);
    const old = found.publicIp;
    const oldIp = old?.ip ?? found.vnicPublicIp;
    const notes: string[] = [];
    ctx.log(`${LABEL}：当前公网 IP ${oldIp || "（无）"}${old ? `（${old.lifetime}）` : ""}`);

    let unassignedReserved = false;
    if (old?.lifetime === "EPHEMERAL") {
      await ociCall(c, "DELETE", `/publicIps/${encodeURIComponent(old.id)}`, undefined, { mutating: true });
      await pollUntil(ctx, `${LABEL} 旧临时公网 IP ${oldIp} 删除`, async () => {
        const got = await getPublicIp(c, old.id);
        return !got || got.state === "TERMINATED";
      });
      ctx.log(`${LABEL}：已删除临时公网 IP ${oldIp}`);
    } else if (old) {
      await ociCall(c, "PUT", `/publicIps/${encodeURIComponent(old.id)}`, { privateIpId: "" }, { mutating: true });
      await pollUntil(ctx, `${LABEL} 预留公网 IP ${oldIp} 卸下`, async () => {
        const got = await getPublicIp(c, old.id);
        return got && (got.state === "AVAILABLE" || got.state === "UNASSIGNED");
      });
      unassignedReserved = true;
      ctx.log(`${LABEL}：已卸下预留公网 IP ${oldIp}`);
    }

    let created: PublicIp;
    try {
      const body = await ociCall(
        c,
        "POST",
        "/publicIps",
        { compartmentId: found.vnicCompartmentId, lifetime: "EPHEMERAL", privateIpId: found.privateIpId, displayName: `nex-${resourceSuffix(ctx)}` },
        { mutating: true },
      );
      created = toPublicIp(body);
      if (!created.id) throw new IpChangeProviderError(`${LABEL}：CreatePublicIp 响应缺少 id`, { retryable: false, ambiguous: true });
      if (created.state !== "ASSIGNED" || !created.ip) {
        const id = created.id;
        created = await pollUntil(ctx, `${LABEL} 新公网 IP 分配`, async () => {
          const got = await getPublicIp(c, id);
          return got && got.state === "ASSIGNED" && got.ip ? got : null;
        });
      }
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw markAmbiguous(error, "新公网 IP 是否已创建未知，请到控制台查看实例主 VNIC");
      }
      let tail = "实例现在没有公网 IP，请到控制台给主 VNIC 添加公网 IP";
      if (unassignedReserved && old) {
        const ok = await bestEffort(ctx, `${LABEL}：把预留公网 IP ${oldIp} 挂回去`, () =>
          ociCall(c, "PUT", `/publicIps/${encodeURIComponent(old.id)}`, { privateIpId: found.privateIpId }, { mutating: true }),
        );
        tail = ok ? `已把原预留公网 IP ${oldIp} 挂回实例` : `原预留公网 IP ${oldIp} 挂回失败，${tail}`;
      }
      throw appendToError(error, tail);
    }
    const newIp = assertIp(created.ip, `${LABEL} CreatePublicIp `);

    let releasedOldIp = false;
    if (old?.lifetime === "EPHEMERAL") {
      releasedOldIp = true;
      notes.push(`旧临时公网 IP ${oldIp} 已删除`);
    } else if (old) {
      if (options.releaseOldIp) {
        try {
          await ociCall(c, "DELETE", `/publicIps/${encodeURIComponent(old.id)}`, undefined, { mutating: true });
          releasedOldIp = true;
          notes.push(`已删除原预留公网 IP ${oldIp}`);
        } catch (error) {
          notes.push(`原预留公网 IP ${oldIp} 删除失败，请到控制台处理：${(error as Error).message}`);
        }
      } else {
        notes.push(`原预留公网 IP ${oldIp} 已卸下但仍保留在账号里`);
      }
    }
    if (oldIp && newIp === oldIp) notes.push("OCI 分配回了同一个 IP，可以稍后再试一次");
    notes.push(`新 IP ${newIp} 是临时公网 IP（${created.id}）`);
    return { oldIp, newIp, ipRole: "primary", releasedOldIp, notes };
  },
});
