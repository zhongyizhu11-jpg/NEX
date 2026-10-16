/*
  阿里云 ECS：用弹性公网 IP（EIP）换公网 IP。

  流程：
  1. ECS DescribeInstances 读实例的 EipAddress / PublicIpAddress。
  2. 没绑 EIP、但有固定公网 IP（NAT 公网 IP）时，先 ECS ConvertNatPublicIpToEip 把它转成 EIP
     （阿里云规定：实例带固定公网 IP 时不能再绑 EIP，会报 Forbidden.InstanceBandwidthNotZero），
     等 DescribeEipAddresses 里出现这个 EIP 且状态为 InUse。
  3. VPC AllocateEipAddress → 等 Available → UnassociateEipAddress(旧) → 等 Available →
     AssociateEipAddress(新, InstanceType=EcsInstance) → 等 InUse → 要求释放时 ReleaseEipAddress(旧)。
  Associate / Unassociate 都是异步接口（文档原文），所以每步都轮询 DescribeEipAddresses 的 Status。

  签名：RPC 风格 SignatureVersion 1.0 / HMAC-SHA1（见 signing/aliyunRpc.ts，单测复现了文档示例）。
  端点：vpc.<region>.aliyuncs.com（VPC 2016-04-28，文档「服务接入点」列出了各地域的公网接入地址），
        ecs.<region>.aliyuncs.com（ECS 2014-05-26）。

  参考：
  - https://help.aliyun.com/zh/eip/developer-reference/api-vpc-2016-04-28-allocateeipaddress-eips
  - https://help.aliyun.com/zh/eip/developer-reference/api-vpc-2016-04-28-associateeipaddress-eips
  - https://help.aliyun.com/zh/eip/developer-reference/api-vpc-2016-04-28-describeeipaddresses-eips
  - https://help.aliyun.com/zh/vpc/developer-reference/api-vpc-2016-04-28-endpoint
  - https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-convertnatpubliciptoeip
  （UnassociateEipAddress / ReleaseEipAddress / ECS DescribeInstances 按同一文档目录的同名页面，参数为常规用法，未逐页抓取）
  - https://help.aliyun.com/zh/sdk/product-overview/rpc-mechanism
*/
import { randomUUID } from "node:crypto";

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
import { aliyunRpcSign, aliyunTimestamp } from "./signing/aliyunRpc";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "阿里云";
const AUTH_CODES = new Set(["InvalidAccessKeyId.NotFound", "InvalidAccessKeyId.Inactive", "SignatureDoesNotMatch", "InvalidAccessKeyId", "IncompleteSignature"]);

type AliyunCreds = { accessKeyId: string; accessKeySecret: string };

async function aliyunCall(
  ctx: IpChangeContext,
  creds: AliyunCreds,
  host: string,
  version: string,
  action: string,
  params: Record<string, string>,
  mutating = false,
): Promise<any> {
  const all: Record<string, string> = {
    Action: action,
    Version: version,
    Format: "JSON",
    AccessKeyId: creds.accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: randomUUID(),
    Timestamp: aliyunTimestamp(ctx.now()),
    ...params,
  };
  const signed = aliyunRpcSign({ method: "GET", params: all, accessKeySecret: creds.accessKeySecret });
  const resp = await httpRequest(ctx, { label: `${LABEL} ${action}`, method: "GET", url: `https://${host}/?${signed.query}`, mutating });
  const body = resp.json;
  const code = String(body?.Code || "");
  if (resp.status >= 200 && resp.status < 300 && !code) return body ?? {};
  const detail = code ? `${code}${body?.Message ? `：${body.Message}` : ""}` : truncate(resp.text, 200);
  if (AUTH_CODES.has(code)) throw new IpChangeProviderError(`${LABEL}：AccessKey 无效或已禁用（${detail}）`, { retryable: false });
  if (code.startsWith("Forbidden") || code === "NoPermission" || code.startsWith("Forbbiden")) {
    throw new IpChangeProviderError(`${LABEL}：RAM 权限不足或操作被禁止，无法调用 ${action}（${detail}）`, { retryable: false });
  }
  if (code.startsWith("Throttling") || code === "ServiceUnavailable" || code === "OperationConflict" || code === "TaskConflict") {
    throw new IpChangeProviderError(`${LABEL} ${action} 暂时不可用（${detail}）`, { retryable: true, ambiguous: mutating && code === "ServiceUnavailable" });
  }
  throw httpStatusError(`${LABEL} ${action}`, resp.status >= 300 ? resp.status : 400, detail, { mutating });
}

type Ctx = { ctx: IpChangeContext; creds: AliyunCreds; region: string; instanceId: string };

const vpcHost = (region: string) => `vpc.${region}.aliyuncs.com`;
const ecsHost = (region: string) => `ecs.${region}.aliyuncs.com`;
const vpc = (c: Ctx, action: string, params: Record<string, string>, mutating = false) =>
  aliyunCall(c.ctx, c.creds, vpcHost(c.region), "2016-04-28", action, { RegionId: c.region, ...params }, mutating);
const ecs = (c: Ctx, action: string, params: Record<string, string>, mutating = false) =>
  aliyunCall(c.ctx, c.creds, ecsHost(c.region), "2014-05-26", action, { RegionId: c.region, ...params }, mutating);

async function describeInstance(c: Ctx) {
  const body = await ecs(c, "DescribeInstances", { InstanceIds: JSON.stringify([c.instanceId]) });
  const list = body?.Instances?.Instance;
  const instance = Array.isArray(list) ? list.find((item: any) => item?.InstanceId === c.instanceId) || list[0] : null;
  if (!instance) throw new IpChangeProviderError(`${LABEL}：找不到实例 ${c.instanceId}，请确认地域和实例 ID`, { retryable: false });
  const natIps = Array.isArray(instance?.PublicIpAddress?.IpAddress) ? instance.PublicIpAddress.IpAddress : [];
  return {
    status: String(instance.Status || ""),
    eipId: String(instance?.EipAddress?.AllocationId || ""),
    eipIp: ipOrNull(instance?.EipAddress?.IpAddress),
    natIp: ipOrNull(natIps[0]),
  };
}

type EipInfo = { id: string; ip: string; status: string; instanceId: string };

function parseEips(body: any): EipInfo[] {
  const list = body?.EipAddresses?.EipAddress;
  return (Array.isArray(list) ? list : []).map((item: any) => ({
    id: String(item?.AllocationId || ""),
    ip: String(item?.IpAddress || ""),
    status: String(item?.Status || ""),
    instanceId: String(item?.InstanceId || ""),
  }));
}

async function getEip(c: Ctx, allocationId: string): Promise<EipInfo | null> {
  return parseEips(await vpc(c, "DescribeEipAddresses", { AllocationId: allocationId })).find((item) => item.id === allocationId) || null;
}

async function waitEipStatus(c: Ctx, eip: EipRef, status: string, extra?: (info: EipInfo) => boolean) {
  return pollUntil(c.ctx, `${LABEL} EIP ${eip.ip} 变为 ${status}`, async () => {
    const info = await getEip(c, eip.id);
    if (!info) throw new IpChangeProviderError(`${LABEL}：EIP ${eip.id} 不见了`, { retryable: false, ambiguous: true });
    return info.status === status && (!extra || extra(info)) ? info : null;
  });
}

function readAll(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    creds: {
      accessKeyId: requirePattern(credentials, "accessKeyId", "AccessKey ID", /^[A-Za-z0-9]{12,64}$/, "应为字母和数字"),
      accessKeySecret: requirePattern(credentials, "accessKeySecret", "AccessKey Secret", /^\S{16,128}$/, "长度不对或含空白"),
    },
    region: requirePattern(target, "region", "地域", REGION_PATTERN, `${REGION_HINT}（阿里云如 cn-hangzhou）`),
    instanceId: requirePattern(target, "instanceId", "实例 ID", /^i-[a-z0-9]{8,32}$/, "形如 i-bp1xxxxxxxxxxxxxxxxx"),
  };
}

export const aliyunEcsProvider = defineProvider({
  id: "aliyun-ecs",
  label: "阿里云 ECS（EIP）",
  docsHint:
    "RAM 控制台创建 AccessKey；权限需要 AliyunEIPFullAccess（或 vpc:AllocateEipAddress/AssociateEipAddress/UnassociateEipAddress/ReleaseEipAddress/DescribeEipAddresses）和 ecs:DescribeInstances、ecs:ConvertNatPublicIpToEip。实例带固定公网 IP 时会先转成 EIP 再换。",
  credentialFields: [
    { key: "accessKeyId", label: "AccessKey ID", type: "text", required: true, placeholder: "LTAI…" },
    { key: "accessKeySecret", label: "AccessKey Secret", type: "password", required: true },
  ],
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "cn-hangzhou" },
    { key: "instanceId", label: "实例 ID", type: "text", required: true, placeholder: "i-bp1xxxxxxxxxxxxxxxxx" },
    { key: "bandwidth", label: "新 EIP 带宽（Mbps）", type: "text", placeholder: "100", help: "按流量计费时是带宽峰值，默认 100" },
    {
      key: "internetChargeType",
      label: "新 EIP 计费方式",
      type: "select",
      options: [
        { value: "PayByTraffic", label: "按使用流量（默认）" },
        { value: "PayByBandwidth", label: "按固定带宽" },
      ],
    },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    const c = readAll(credentials, target, ctx);
    const instance = await describeInstance(c);
    return { currentIp: instance.eipIp || instance.natIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    const instance = await describeInstance(readAll(credentials, target, ctx));
    return instance.eipIp || instance.natIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = readAll(credentials, target, ctx);
    const bandwidth = optionalInt(target, "bandwidth", "新 EIP 带宽", 100, 1, 1000);
    const chargeType = optionalChoice(target, "internetChargeType", "新 EIP 计费方式", ["PayByTraffic", "PayByBandwidth"], "PayByTraffic");
    const instance = await describeInstance(c);
    const notes: string[] = [];
    let oldEip: EipRef | null = instance.eipId && instance.eipIp ? { id: instance.eipId, ip: instance.eipIp } : null;
    const oldIp = instance.eipIp || instance.natIp;

    if (!oldEip && instance.natIp) {
      const natIp = instance.natIp;
      ctx.log(`${LABEL}：实例使用固定公网 IP ${natIp}，先转换为 EIP`);
      await ecs(c, "ConvertNatPublicIpToEip", { InstanceId: c.instanceId }, true);
      const converted = await pollUntil(ctx, `${LABEL} 固定公网 IP ${natIp} 转换为 EIP`, async () => {
        const list = parseEips(await vpc(c, "DescribeEipAddresses", { AssociatedInstanceType: "EcsInstance", AssociatedInstanceId: c.instanceId }));
        return list.find((item) => item.ip === natIp && item.status === "InUse") || null;
      });
      oldEip = { id: converted.id, ip: converted.ip };
      notes.push(`已把固定公网 IP ${natIp} 转换为 EIP（${converted.id}）`);
    }

    return runEipSwap(
      ctx,
      {
        label: LABEL,
        async allocate() {
          const body = await vpc(
            c,
            "AllocateEipAddress",
            {
              Bandwidth: String(bandwidth),
              InternetChargeType: chargeType,
              InstanceChargeType: "PostPaid",
              Name: `nex-${resourceSuffix(ctx)}`,
              ClientToken: randomUUID(),
            },
            true,
          );
          const eip: EipRef = { id: String(body?.AllocationId || ""), ip: assertIp(body?.EipAddress, `${LABEL} AllocateEipAddress `) };
          if (!eip.id) throw new IpChangeProviderError(`${LABEL}：AllocateEipAddress 响应缺少 AllocationId`, { retryable: false, ambiguous: true });
          await waitEipStatus(c, eip, "Available");
          return eip;
        },
        async disassociate(eip) {
          await vpc(c, "UnassociateEipAddress", { AllocationId: eip.id, InstanceId: c.instanceId, InstanceType: "EcsInstance" }, true);
          await waitEipStatus(c, eip, "Available");
        },
        async associate(eip) {
          await vpc(c, "AssociateEipAddress", { AllocationId: eip.id, InstanceId: c.instanceId, InstanceType: "EcsInstance" }, true);
          await waitEipStatus(c, eip, "InUse", (info) => !info.instanceId || info.instanceId === c.instanceId);
        },
        async release(eip) {
          await vpc(c, "ReleaseEipAddress", { AllocationId: eip.id }, true);
        },
      },
      { oldEip, oldIp, releaseOldIp: options.releaseOldIp, notes },
    );
  },
});
