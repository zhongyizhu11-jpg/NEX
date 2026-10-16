/*
  火山引擎 ECS：用弹性公网 IP（EIP）换公网 IP。

  流程：ECS DescribeInstances（确认实例存在，读 EipAddress）→ VPC DescribeEipAddresses
  (AssociatedInstanceType=EcsInstance, AssociatedInstanceId) 找已绑定的 EIP →
  AllocateEipAddress → 等 Available → DisassociateEipAddress(旧) → 等 Available →
  AssociateEipAddress(新, InstanceType=EcsInstance) → 等 Attached → 要求释放时 ReleaseEipAddress(旧)。
  EIP 状态取值：Attaching / Detaching / Attached / Available。

  协议：GET https://open.volcengineapi.com/?Action=…&Version=2020-04-01&…，Service=vpc / ecs，
  签名 HMAC-SHA256（signing/hmacV4.ts 的 VOLCENGINE_V4，单测复现了官方文档的两组期望值），
  签 host;x-date。错误在 ResponseMetadata.Error {Code, Message}。
  参数名 / 枚举值核对了官方 volcengine-go-sdk（service/vpc、service/ecs）里由 API 定义生成的结构体。

  参考：
  - https://www.volcengine.com/docs/6369/67269 （签名方法）
  - https://docs.byteplus.com/en/docs/eip/AllocateEipAddress （国际站 EIP API 文档；页面由 JS 渲染，
    抓不到正文，参数以下面 SDK 里的生成代码为准）
  - https://github.com/volcengine/volcengine-go-sdk/tree/master/service/vpc
  - https://github.com/volcengine/volcengine-go-sdk/blob/master/service/ecs/api_describe_instances.go
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
  pollUntil,
  requirePattern,
  resourceSuffix,
  truncate,
} from "./common";
import { runEipSwap, type EipRef } from "./eipSwap";
import { VOLCENGINE_V4, canonicalQueryString, compactIsoDate, sha256Hex, signHmacV4 } from "./signing/hmacV4";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "火山引擎";
const HOST = "open.volcengineapi.com";
const AUTH_CODES = new Set(["InvalidAccessKey", "SignatureDoesNotMatch", "InvalidCredential", "InvalidSecretToken", "MissingAuthenticationToken"]);

type Ctx = { ctx: IpChangeContext; ak: string; sk: string; region: string; instanceId: string };

async function volcCall(c: Ctx, service: "vpc" | "ecs", action: string, params: Record<string, string>, mutating = false): Promise<any> {
  const query: Array<[string, string]> = [["Action", action], ["Version", "2020-04-01"], ...Object.entries(params)];
  const xDate = compactIsoDate(c.ctx.now());
  const signed = signHmacV4(VOLCENGINE_V4, {
    method: "GET",
    query,
    headers: { host: HOST, "x-date": xDate },
    payloadHash: sha256Hex(""),
    region: c.region,
    service,
    accessKeyId: c.ak,
    secretAccessKey: c.sk,
    requestDate: xDate,
  });
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${action}`,
    method: "GET",
    url: `https://${HOST}/?${canonicalQueryString(query)}`,
    headers: { "X-Date": xDate, Authorization: signed.authorization },
    mutating,
  });
  const error = resp.json?.ResponseMetadata?.Error;
  if (resp.status >= 200 && resp.status < 300 && !error) return resp.json?.Result ?? {};
  const code = String(error?.Code || "");
  const detail = code ? `${code}${error?.Message ? `：${error.Message}` : ""}` : truncate(resp.text, 200);
  if (AUTH_CODES.has(code)) throw new IpChangeProviderError(`${LABEL}：AccessKey 无效或签名错误（${detail}）`, { retryable: false });
  if (code === "AccessDenied" || code.startsWith("Forbidden") || code === "OperationDenied.AccessDenied") {
    throw new IpChangeProviderError(`${LABEL}：IAM 权限不足，无法调用 ${action}（${detail}）`, { retryable: false });
  }
  if (code === "FlowLimitExceeded" || code.includes("Throttl") || code === "RequestLimitExceeded") {
    throw new IpChangeProviderError(`${LABEL} ${action} 被限流（${detail}）`, { retryable: true });
  }
  if (code === "InternalError" || code === "InternalServiceError" || code === "ServiceUnavailable") {
    throw new IpChangeProviderError(`${LABEL} ${action} 服务端错误（${detail}）${mutating ? "；请求可能已经生效" : ""}`, { retryable: true, ambiguous: mutating });
  }
  throw httpStatusError(`${LABEL} ${action}`, resp.status >= 300 ? resp.status : 400, detail, { mutating });
}

type Eip = { id: string; ip: string; status: string; instanceId: string };

function parseEips(result: any): Eip[] {
  return (Array.isArray(result?.EipAddresses) ? result.EipAddresses : []).map((item: any) => ({
    id: String(item?.AllocationId || ""),
    ip: String(item?.EipAddress || ""),
    status: String(item?.Status || ""),
    instanceId: String(item?.InstanceId || ""),
  }));
}

function waitStatus(c: Ctx, eip: EipRef, status: string, what: string) {
  return pollUntil(c.ctx, `${LABEL} EIP ${what}`, async () => {
    const info = parseEips(await volcCall(c, "vpc", "DescribeEipAddresses", { "AllocationIds.1": eip.id })).find((item) => item.id === eip.id);
    if (!info) throw new IpChangeProviderError(`${LABEL}：EIP ${eip.id} 不见了`, { retryable: false, ambiguous: true });
    return info.status === status ? info : null;
  });
}

async function describeInstance(c: Ctx) {
  const result = await volcCall(c, "ecs", "DescribeInstances", { "InstanceIds.1": c.instanceId });
  const instance = (Array.isArray(result?.Instances) ? result.Instances : []).find((item: any) => item?.InstanceId === c.instanceId);
  if (!instance) throw new IpChangeProviderError(`${LABEL}：找不到实例 ${c.instanceId}，请确认地域和实例 ID`, { retryable: false });
  return { status: String(instance.Status || ""), eipId: String(instance?.EipAddress?.AllocationId || ""), eipIp: ipOrNull(instance?.EipAddress?.IpAddress) };
}

function readAll(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    ak: requirePattern(credentials, "accessKeyId", "Access Key ID", /^[A-Za-z0-9]{16,128}$/, "应为字母和数字（AKLT 开头）"),
    sk: requirePattern(credentials, "secretAccessKey", "Secret Access Key", /^\S{16,128}$/, "长度不对或含空白"),
    region: requirePattern(target, "region", "地域", REGION_PATTERN, `${REGION_HINT}（火山引擎如 cn-beijing）`),
    instanceId: requirePattern(target, "instanceId", "实例 ID", /^i-[a-z0-9]{8,32}$/, "形如 i-xxxxxxxxxxxx"),
  };
}

export const volcengineEcsProvider = defineProvider({
  id: "volcengine-ecs",
  label: "火山引擎 ECS（EIP）",
  docsHint:
    "访问控制 → 密钥管理创建 AccessKey；权限需要 VPCFullAccess（或 vpc:AllocateEipAddress/AssociateEipAddress/DisassociateEipAddress/ReleaseEipAddress/DescribeEipAddresses）和 ECSReadOnlyAccess。",
  credentialFields: [
    { key: "accessKeyId", label: "Access Key ID", type: "text", required: true, placeholder: "AKLT…" },
    { key: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
  ],
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "cn-beijing" },
    { key: "instanceId", label: "实例 ID", type: "text", required: true, placeholder: "i-xxxxxxxxxxxx" },
    { key: "bandwidth", label: "新 EIP 带宽上限（Mbps）", type: "text", placeholder: "100" },
    {
      key: "billingType",
      label: "新 EIP 计费方式",
      type: "select",
      options: [
        { value: "3", label: "按量计费 - 按实际流量（默认）" },
        { value: "2", label: "按量计费 - 按带宽上限" },
      ],
    },
    { key: "isp", label: "线路类型", type: "text", placeholder: "BGP", help: "默认 BGP；也可填 ChinaMobile / ChinaUnicom / ChinaTelecom 等" },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    return { currentIp: (await describeInstance(readAll(credentials, target, ctx))).eipIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    return (await describeInstance(readAll(credentials, target, ctx))).eipIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = readAll(credentials, target, ctx);
    const bandwidth = optionalInt(target, "bandwidth", "新 EIP 带宽上限", 100, 1, 500);
    const billingType = optionalChoice(target, "billingType", "新 EIP 计费方式", ["2", "3"], "3");
    const isp = optionalChoice(
      target,
      "isp",
      "线路类型",
      ["BGP", "SingleLine_BGP", "Static_BGP", "Fusion_BGP", "ChinaMobile", "ChinaUnicom", "ChinaTelecom", "ChinaMobile_Value", "ChinaUnicom_Value", "ChinaTelecom_Value"],
      "BGP",
    );
    const instance = await describeInstance(c);
    const bound = parseEips(
      await volcCall(c, "vpc", "DescribeEipAddresses", { AssociatedInstanceType: "EcsInstance", AssociatedInstanceId: c.instanceId }),
    ).find((item) => item.status === "Attached" && (!item.instanceId || item.instanceId === c.instanceId));
    const oldEip: EipRef | null = bound ? { id: bound.id, ip: bound.ip } : instance.eipId && instance.eipIp ? { id: instance.eipId, ip: instance.eipIp } : null;
    const oldIp = instance.eipIp || (bound ? ipOrNull(bound.ip) : null);

    return runEipSwap(
      ctx,
      {
        label: LABEL,
        async allocate() {
          const result = await volcCall(
            c,
            "vpc",
            "AllocateEipAddress",
            { BillingType: billingType, Bandwidth: String(bandwidth), ISP: isp, Name: `nex-${resourceSuffix(ctx)}` },
            true,
          );
          const eip: EipRef = { id: String(result?.AllocationId || ""), ip: assertIp(result?.EipAddress, `${LABEL} AllocateEipAddress `) };
          if (!eip.id) throw new IpChangeProviderError(`${LABEL}：AllocateEipAddress 响应缺少 AllocationId`, { retryable: false, ambiguous: true });
          await waitStatus(c, eip, "Available", "创建完成");
          return eip;
        },
        async disassociate(eip) {
          await volcCall(c, "vpc", "DisassociateEipAddress", { AllocationId: eip.id, InstanceId: c.instanceId, InstanceType: "EcsInstance" }, true);
          await waitStatus(c, eip, "Available", `${eip.ip} 解绑完成`);
        },
        async associate(eip) {
          await volcCall(c, "vpc", "AssociateEipAddress", { AllocationId: eip.id, InstanceId: c.instanceId, InstanceType: "EcsInstance" }, true);
          await waitStatus(c, eip, "Attached", `${eip.ip} 绑定完成`);
        },
        async release(eip) {
          await volcCall(c, "vpc", "ReleaseEipAddress", { AllocationId: eip.id }, true);
        },
      },
      { oldEip, oldIp, releaseOldIp: options.releaseOldIp },
    );
  },
});
