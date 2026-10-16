/*
  华为云 ECS：用弹性公网 IP（EIP，VPC API v1）换公网 IP。

  流程：
  1. ECS GET /v1/{project_id}/cloudservers/{server_id}：addresses 里 OS-EXT-IPS:type=floating 的是 EIP，
     取它（或第一个 fixed IPv4）的 OS-EXT-IPS:port_id 作为要绑定的网卡端口。
  2. EIP GET /v1/{project_id}/publicips?port_id=… 找当前绑在这个端口上的 EIP。
  3. POST /v1/{project_id}/publicips（bandwidth.share_type=PER 时 name 必填）→ 等 status=DOWN（未绑定）
     → 旧 EIP PUT {"publicip":{"port_id":""}} 解绑（文档：port_id 为空即解绑）→ 等 DOWN
     → 新 EIP PUT {"publicip":{"port_id":"…"}} 绑定 → 等 ACTIVE → 要求释放时 DELETE 旧 EIP。
  华为云 ECS 的公网 IP 只有 EIP 一种，不存在「固定公网 IP 转 EIP」的问题。

  签名：SDK-HMAC-SHA256（signing/huaweiSdk.ts），签 content-type;host;x-sdk-date。
  端点：ecs.<region>.myhuaweicloud.com、vpc.<region>.myhuaweicloud.com。

  参考：
  - https://support.huaweicloud.com/api-eip/eip_api_0001.html （申请 EIP）
  - https://support.huaweicloud.com/api-eip/eip_api_0003.html （查询 EIP 列表，status 取值）
  - https://support.huaweicloud.com/api-eip/eip_api_0004.html （更新 EIP：绑定 / 解绑）
  （查询单个 EIP、释放 EIP、ECS 查询云服务器详情 /v1/{project_id}/cloudservers/{server_id} 按文档目录的同系列页面，未逐页抓取；
   addresses 里 OS-EXT-IPS:type / OS-EXT-IPS:port_id 字段按 ECS 详情接口的常规返回结构）
  - https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-002.html （签名示例）
*/
import {
  REGION_HINT,
  REGION_PATTERN,
  assertIp,
  defineProvider,
  httpRequest,
  httpStatusError,
  ipOrNull,
  optionalChoice,
  optionalInt,
  optionalPattern,
  pollUntil,
  requirePattern,
  resourceSuffix,
  truncate,
} from "./common";
import { runEipSwap, type EipRef } from "./eipSwap";
import { compactIsoDate } from "./signing/hmacV4";
import { huaweiCanonicalQuery, huaweiEncode, huaweiSign } from "./signing/huaweiSdk";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "华为云";

type Ctx = { ctx: IpChangeContext; ak: string; sk: string; region: string; projectId: string; instanceId: string };

function huaweiErrorDetail(body: any, text: string): string {
  const code = body?.error_code || body?.error?.code || body?.code || "";
  const msg = body?.error_msg || body?.error?.message || body?.NeutronError?.message || body?.message || "";
  return code || msg ? [code, msg].filter(Boolean).join("：") : truncate(text, 200);
}

async function hwCall(
  c: Ctx,
  service: "ecs" | "vpc",
  method: string,
  path: string,
  query: Array<[string, string]> = [],
  payload?: unknown,
  mutating = false,
): Promise<any> {
  const host = `${service}.${c.region}.myhuaweicloud.com`;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const sdkDate = compactIsoDate(c.ctx.now());
  const signed = huaweiSign({
    method,
    path,
    query,
    headers: { "content-type": "application/json", host, "x-sdk-date": sdkDate },
    body,
    accessKey: c.ak,
    secretKey: c.sk,
    sdkDate,
  });
  const encodedPath = path.split("/").map((part) => huaweiEncode(part)).join("/");
  const qs = huaweiCanonicalQuery(query);
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method} ${service}`,
    method,
    url: `https://${host}${encodedPath}${qs ? `?${qs}` : ""}`,
    headers: { "Content-Type": "application/json", "X-Sdk-Date": sdkDate, Authorization: signed.authorization },
    body: method === "GET" || method === "DELETE" ? undefined : body,
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  const detail = huaweiErrorDetail(resp.json, resp.text);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：AK / SK 无效或时钟偏差过大（${detail}）`, { retryable: false });
  if (resp.status === 403) throw new IpChangeProviderError(`${LABEL}：IAM 权限不足（${detail}）`, { retryable: false });
  if (resp.status === 404 && service === "ecs") {
    throw new IpChangeProviderError(`${LABEL}：找不到云服务器 ${c.instanceId}，请确认地域、项目 ID 和实例 ID（${detail}）`, { retryable: false });
  }
  throw httpStatusError(`${LABEL} ${method} ${service}`, resp.status, detail, { mutating });
}

async function describeServer(c: Ctx) {
  const body = await hwCall(c, "ecs", "GET", `/v1/${c.projectId}/cloudservers/${c.instanceId}`);
  const server = body?.server;
  if (!server) throw new IpChangeProviderError(`${LABEL}：找不到云服务器 ${c.instanceId}`, { retryable: false });
  const addresses: any[] = Object.values(server.addresses || {}).flatMap((list: any) => (Array.isArray(list) ? list : []));
  const floating = addresses.find((item) => item?.["OS-EXT-IPS:type"] === "floating" && String(item?.version) === "4");
  const fixed = addresses.find((item) => item?.["OS-EXT-IPS:type"] === "fixed" && String(item?.version) === "4");
  const portId = String(floating?.["OS-EXT-IPS:port_id"] || fixed?.["OS-EXT-IPS:port_id"] || "");
  return { status: String(server.status || ""), publicIp: ipOrNull(floating?.addr), portId };
}

type PublicIp = { id: string; ip: string; status: string; portId: string };

function parsePublicIp(item: any): PublicIp {
  return {
    id: String(item?.id || ""),
    ip: String(item?.public_ip_address || ""),
    status: String(item?.status || ""),
    portId: String(item?.port_id || ""),
  };
}

async function getPublicIp(c: Ctx, id: string) {
  const body = await hwCall(c, "vpc", "GET", `/v1/${c.projectId}/publicips/${id}`);
  return parsePublicIp(body?.publicip);
}

function waitStatus(c: Ctx, eip: EipRef, status: "DOWN" | "ACTIVE", what: string) {
  return pollUntil(c.ctx, `${LABEL} EIP ${what}`, async () => {
    const info = await getPublicIp(c, eip.id);
    if (info.status === "ERROR" || info.status === "BIND_ERROR") {
      throw new IpChangeProviderError(`${LABEL}：EIP ${eip.ip || eip.id} 状态异常（${info.status}）`, { retryable: false, ambiguous: true });
    }
    return info.status === status ? info : null;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readAll(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    ak: requirePattern(credentials, "accessKey", "Access Key（AK）", /^[A-Za-z0-9]{10,64}$/, "应为字母和数字"),
    sk: requirePattern(credentials, "secretKey", "Secret Key（SK）", /^\S{16,128}$/, "长度不对或含空白"),
    region: requirePattern(target, "region", "地域", REGION_PATTERN, `${REGION_HINT}（华为云如 cn-north-4、ap-southeast-1）`),
    projectId: requirePattern(target, "projectId", "项目 ID", /^[0-9a-f]{32}$/, "32 位十六进制，在「我的凭证 → API 凭证」里按地域查看"),
    instanceId: requirePattern(target, "instanceId", "云服务器 ID", UUID, "UUID 格式"),
  };
}

export const huaweiEcsProvider = defineProvider({
  id: "huawei-ecs",
  label: "华为云 ECS（EIP）",
  docsHint:
    "「我的凭证 → 访问密钥」创建 AK/SK，同页「API 凭证」里查各地域的项目 ID；IAM 需要 ECS ReadOnlyAccess 和 VPC FullAccess（eip:publicIps:create/update/delete/get/list）。",
  credentialFields: [
    { key: "accessKey", label: "Access Key（AK）", type: "text", required: true },
    { key: "secretKey", label: "Secret Key（SK）", type: "password", required: true },
  ],
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "cn-north-4" },
    { key: "projectId", label: "项目 ID", type: "text", required: true, placeholder: "32 位十六进制" },
    { key: "instanceId", label: "云服务器 ID", type: "text", required: true, placeholder: "UUID" },
    { key: "bandwidthSize", label: "新 EIP 带宽（Mbit/s）", type: "text", placeholder: "100" },
    {
      key: "chargeMode",
      label: "新 EIP 带宽计费",
      type: "select",
      options: [
        { value: "traffic", label: "按流量（默认）" },
        { value: "bandwidth", label: "按带宽" },
      ],
    },
    { key: "eipType", label: "EIP 线路类型", type: "text", placeholder: "5_bgp", help: "默认 5_bgp（全动态 BGP）；部分地域只支持 5_sbgp" },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    return { currentIp: (await describeServer(readAll(credentials, target, ctx))).publicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    return (await describeServer(readAll(credentials, target, ctx))).publicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = readAll(credentials, target, ctx);
    const size = optionalInt(target, "bandwidthSize", "新 EIP 带宽", 100, 1, 2000);
    const chargeMode = optionalChoice(target, "chargeMode", "新 EIP 带宽计费", ["traffic", "bandwidth"], "traffic");
    const eipType = optionalPattern(target, "eipType", "EIP 线路类型", /^[0-9a-z_-]{2,32}$/, "如 5_bgp / 5_sbgp") || "5_bgp";
    const server = await describeServer(c);
    if (!server.portId) throw new IpChangeProviderError(`${LABEL}：云服务器没有 IPv4 网卡端口，无法绑定 EIP`, { retryable: false });
    const list = await hwCall(c, "vpc", "GET", `/v1/${c.projectId}/publicips`, [["port_id", server.portId]]);
    const bound = (Array.isArray(list?.publicips) ? list.publicips : []).map(parsePublicIp).find((item: PublicIp) => item.portId === server.portId);
    const oldEip: EipRef | null = bound ? { id: bound.id, ip: bound.ip } : null;
    const oldIp = server.publicIp || (bound ? ipOrNull(bound.ip) : null);
    const name = `nex-${resourceSuffix(ctx)}`;

    return runEipSwap(
      ctx,
      {
        label: LABEL,
        async allocate() {
          const body = await hwCall(
            c,
            "vpc",
            "POST",
            `/v1/${c.projectId}/publicips`,
            [],
            {
              publicip: { type: eipType, ip_version: 4, alias: name },
              bandwidth: { name, size, share_type: "PER", charge_mode: chargeMode },
            },
            true,
          );
          const created = parsePublicIp(body?.publicip);
          if (!created.id) throw new IpChangeProviderError(`${LABEL}：申请 EIP 的响应缺少 id`, { retryable: false, ambiguous: true });
          const ready = await waitStatus(c, { id: created.id, ip: created.ip }, "DOWN", "创建完成");
          return { id: created.id, ip: assertIp(ready.ip || created.ip, `${LABEL} 申请 EIP `) };
        },
        async disassociate(eip) {
          await hwCall(c, "vpc", "PUT", `/v1/${c.projectId}/publicips/${eip.id}`, [], { publicip: { port_id: "" } }, true);
          await waitStatus(c, eip, "DOWN", `${eip.ip} 解绑完成`);
        },
        async associate(eip) {
          await hwCall(c, "vpc", "PUT", `/v1/${c.projectId}/publicips/${eip.id}`, [], { publicip: { port_id: server.portId } }, true);
          await waitStatus(c, eip, "ACTIVE", `${eip.ip} 绑定完成`);
        },
        async release(eip) {
          await hwCall(c, "vpc", "DELETE", `/v1/${c.projectId}/publicips/${eip.id}`, [], undefined, true);
        },
      },
      { oldEip, oldIp, releaseOldIp: options.releaseOldIp },
    );
  },
});
