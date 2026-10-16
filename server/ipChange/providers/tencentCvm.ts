/*
  腾讯云 CVM：用弹性公网 IP（EIP）换公网 IP。

  流程：
  1. CVM DescribeInstances 读 PublicIpAddresses；VPC DescribeAddresses(instance-id) 找已绑定的 EIP
     （DescribeAddresses 不带 address-type 时不返回普通公网 IP WanIP，所以查到的就是 EIP 类）。
  2. 没有 EIP 但有普通公网 IP：先 TransformAddress 把普通公网 IP 转成 EIP（IP 不变，返回 AddressId），
     等它状态为 BIND。AssociateAddress 文档：主网卡主内网 IP 已有普通公网 IP 时必须先退还才能绑 EIP。
  3. AllocateAddresses → 等 UNBIND → DisassociateAddress(旧，ReallocateNormalPublicIp 默认 false)
     → 等 UNBIND → AssociateAddress(新, InstanceId) → 等 BIND → 要求释放时 ReleaseAddresses(旧)。
  这些接口都是异步任务（返回 TaskId），统一轮询 DescribeAddresses 的 AddressStatus。

  签名：TC3-HMAC-SHA256（signing/tc3.ts），vpc.tencentcloudapi.com Version 2017-03-12，
        cvm.tencentcloudapi.com Version 2017-03-12，地域放在 X-TC-Region。

  参考：
  - https://cloud.tencent.com/document/api/215/16699 （AllocateAddresses）
  - https://cloud.tencent.com/document/api/215/16700 （AssociateAddress）
  - https://cloud.tencent.com/document/api/215/16703 （DisassociateAddress）
  - https://cloud.tencent.com/document/api/215/16705 （ReleaseAddresses）
  - https://cloud.tencent.com/document/api/215/16702 （DescribeAddresses）
  - https://cloud.tencent.com/document/api/215/16706 （TransformAddress）
  - https://cloud.tencent.com/document/api/213/15728 （CVM DescribeInstances）
  - https://cloud.tencent.com/document/api/213/30654 （签名方法 v3）
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
import { tc3Sign } from "./signing/tc3";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "腾讯云";
const CHARGE_TYPES = ["TRAFFIC_POSTPAID_BY_HOUR", "BANDWIDTH_POSTPAID_BY_HOUR", "BANDWIDTH_PACKAGE", "LEGACY"] as const;

type Ctx = { ctx: IpChangeContext; secretId: string; secretKey: string; region: string; instanceId: string };

async function tcCall(c: Ctx, service: "vpc" | "cvm", action: string, payload: Record<string, unknown>, mutating = false): Promise<any> {
  const host = `${service}.tencentcloudapi.com`;
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(c.ctx.now().getTime() / 1000);
  const signed = tc3Sign({ secretId: c.secretId, secretKey: c.secretKey, service, host, action, payload: body, timestamp });
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${action}`,
    method: "POST",
    url: `https://${host}/`,
    headers: {
      Authorization: signed.authorization,
      "Content-Type": signed.contentType,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": "2017-03-12",
      "X-TC-Region": c.region,
      "X-TC-Language": "zh-CN",
    },
    body,
    mutating,
  });
  const err = resp.json?.Response?.Error;
  if (resp.status >= 200 && resp.status < 300 && resp.json?.Response && !err) return resp.json.Response;
  const code = String(err?.Code || "");
  const detail = code ? `${code}${err?.Message ? `：${err.Message}` : ""}` : truncate(resp.text, 200);
  if (code === "AuthFailure.UnauthorizedOperation" || code === "UnauthorizedOperation") {
    throw new IpChangeProviderError(`${LABEL}：CAM 权限不足，无法调用 ${action}（${detail}）`, { retryable: false });
  }
  if (code.startsWith("AuthFailure")) throw new IpChangeProviderError(`${LABEL}：SecretId / SecretKey 无效或时钟偏差过大（${detail}）`, { retryable: false });
  if (code === "RequestLimitExceeded" || code.startsWith("RequestLimitExceeded")) {
    throw new IpChangeProviderError(`${LABEL} ${action} 被限流（${detail}）`, { retryable: true });
  }
  if (code === "InternalError" || code.startsWith("InternalError") || code === "FailedOperation.TaskFailed") {
    throw new IpChangeProviderError(`${LABEL} ${action} 服务端错误（${detail}）${mutating ? "；请求可能已经生效" : ""}`, { retryable: true, ambiguous: mutating });
  }
  if (code.startsWith("OperationDenied.MutexTaskRunning")) {
    throw new IpChangeProviderError(`${LABEL} ${action}：有冲突任务在执行（${detail}）`, { retryable: true });
  }
  throw httpStatusError(`${LABEL} ${action}`, resp.status >= 300 ? resp.status : 400, detail, { mutating });
}

type Address = { id: string; ip: string; status: string; type: string; instanceId: string };

function parseAddresses(resp: any): Address[] {
  return (Array.isArray(resp?.AddressSet) ? resp.AddressSet : []).map((item: any) => ({
    id: String(item?.AddressId || ""),
    ip: String(item?.AddressIp || ""),
    status: String(item?.AddressStatus || ""),
    type: String(item?.AddressType || ""),
    instanceId: String(item?.InstanceId || ""),
  }));
}

async function getAddress(c: Ctx, id: string) {
  return parseAddresses(await tcCall(c, "vpc", "DescribeAddresses", { AddressIds: [id] })).find((item) => item.id === id) || null;
}

function waitStatus(c: Ctx, id: string, what: string, ok: (addr: Address) => boolean) {
  return pollUntil(c.ctx, `${LABEL} EIP ${what}`, async () => {
    const addr = await getAddress(c, id);
    if (!addr) throw new IpChangeProviderError(`${LABEL}：EIP ${id} 不见了`, { retryable: false, ambiguous: true });
    return ok(addr) ? addr : null;
  });
}

async function describeInstance(c: Ctx) {
  const resp = await tcCall(c, "cvm", "DescribeInstances", { InstanceIds: [c.instanceId] });
  const instance = (Array.isArray(resp?.InstanceSet) ? resp.InstanceSet : []).find((item: any) => item?.InstanceId === c.instanceId);
  if (!instance) throw new IpChangeProviderError(`${LABEL}：找不到实例 ${c.instanceId}，请确认地域和实例 ID`, { retryable: false });
  const ips = Array.isArray(instance.PublicIpAddresses) ? instance.PublicIpAddresses : [];
  return { state: String(instance.InstanceState || ""), publicIp: ipOrNull(ips[0]) };
}

function readAll(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  return {
    ctx,
    secretId: requirePattern(credentials, "secretId", "SecretId", /^[A-Za-z0-9]{16,128}$/, "应为字母和数字（AKID 开头）"),
    secretKey: requirePattern(credentials, "secretKey", "SecretKey", /^\S{16,128}$/, "长度不对或含空白"),
    region: requirePattern(target, "region", "地域", REGION_PATTERN, `${REGION_HINT}（腾讯云如 ap-guangzhou）`),
    instanceId: requirePattern(target, "instanceId", "实例 ID", /^ins-[a-z0-9]{8,16}$/, "形如 ins-xxxxxxxx"),
  };
}

export const tencentCvmProvider = defineProvider({
  id: "tencent-cvm",
  label: "腾讯云 CVM（EIP）",
  docsHint:
    "访问管理 CAM → API 密钥管理创建 SecretId / SecretKey；需要 QcloudVPCFullAccess（或 vpc:AllocateAddresses/AssociateAddress/DisassociateAddress/ReleaseAddresses/DescribeAddresses/TransformAddress）和 cvm:DescribeInstances。普通公网 IP 会先转成 EIP 再换；腾讯云对每天解绑 / 重新分配次数有限额。",
  credentialFields: [
    { key: "secretId", label: "SecretId", type: "text", required: true, placeholder: "AKID…" },
    { key: "secretKey", label: "SecretKey", type: "password", required: true },
  ],
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "ap-guangzhou" },
    { key: "instanceId", label: "实例 ID", type: "text", required: true, placeholder: "ins-xxxxxxxx" },
    {
      key: "internetChargeType",
      label: "新 EIP 计费方式",
      type: "select",
      help: "标准账户才需要；传统账户选「跟随实例」",
      options: [
        { value: "TRAFFIC_POSTPAID_BY_HOUR", label: "按流量小时后付费（默认）" },
        { value: "BANDWIDTH_POSTPAID_BY_HOUR", label: "按带宽小时后付费" },
        { value: "BANDWIDTH_PACKAGE", label: "共享带宽包" },
        { value: "LEGACY", label: "跟随实例（传统账户）" },
      ],
    },
    { key: "bandwidth", label: "新 EIP 带宽上限（Mbps）", type: "text", placeholder: "100" },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    const c = readAll(credentials, target, ctx);
    return { currentIp: (await describeInstance(c)).publicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    return (await describeInstance(readAll(credentials, target, ctx))).publicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = readAll(credentials, target, ctx);
    const chargeType = optionalChoice(target, "internetChargeType", "新 EIP 计费方式", CHARGE_TYPES, "TRAFFIC_POSTPAID_BY_HOUR");
    const bandwidth = optionalInt(target, "bandwidth", "新 EIP 带宽上限", 100, 1, 2000);
    const instance = await describeInstance(c);
    const bound = parseAddresses(await tcCall(c, "vpc", "DescribeAddresses", { Filters: [{ Name: "instance-id", Values: [c.instanceId] }] })).find(
      (addr) => addr.instanceId === c.instanceId && addr.type !== "WanIP" && (addr.status === "BIND" || addr.status === "BIND_ENI"),
    );
    const notes: string[] = [];
    let oldEip: EipRef | null = bound ? { id: bound.id, ip: bound.ip } : null;
    const oldIp = instance.publicIp || (bound ? ipOrNull(bound.ip) : null);

    if (!oldEip && instance.publicIp) {
      const normalIp = instance.publicIp;
      ctx.log(`${LABEL}：实例使用普通公网 IP ${normalIp}，先转换为 EIP`);
      const resp = await tcCall(c, "vpc", "TransformAddress", { InstanceId: c.instanceId }, true);
      const addressId = String(resp?.AddressId || "");
      if (!addressId) throw new IpChangeProviderError(`${LABEL}：TransformAddress 响应缺少 AddressId`, { retryable: false, ambiguous: true });
      const converted = await waitStatus(c, addressId, `${normalIp} 转换完成`, (addr) => addr.status === "BIND");
      oldEip = { id: converted.id, ip: converted.ip || normalIp };
      notes.push(`已把普通公网 IP ${normalIp} 转换为 EIP（${converted.id}）`);
    }

    return runEipSwap(
      ctx,
      {
        label: LABEL,
        async allocate() {
          const payload: Record<string, unknown> = { AddressCount: 1, AddressName: `nex-${resourceSuffix(ctx)}` };
          if (chargeType !== "LEGACY") {
            payload.InternetChargeType = chargeType;
            if (chargeType !== "BANDWIDTH_PACKAGE") payload.InternetMaxBandwidthOut = bandwidth;
          }
          const resp = await tcCall(c, "vpc", "AllocateAddresses", payload, true);
          const id = String((Array.isArray(resp?.AddressSet) ? resp.AddressSet : [])[0] || "");
          if (!id) throw new IpChangeProviderError(`${LABEL}：AllocateAddresses 响应缺少 AddressSet`, { retryable: false, ambiguous: true });
          const ready = await waitStatus(c, id, "创建完成", (addr) => addr.status === "UNBIND" && Boolean(addr.ip));
          return { id, ip: assertIp(ready.ip, `${LABEL} DescribeAddresses `) };
        },
        async disassociate(eip) {
          await tcCall(c, "vpc", "DisassociateAddress", { AddressId: eip.id }, true);
          await waitStatus(c, eip.id, `${eip.ip} 解绑完成`, (addr) => addr.status === "UNBIND");
        },
        async associate(eip) {
          await tcCall(c, "vpc", "AssociateAddress", { AddressId: eip.id, InstanceId: c.instanceId }, true);
          await waitStatus(c, eip.id, `${eip.ip} 绑定完成`, (addr) => addr.status === "BIND" && (!addr.instanceId || addr.instanceId === c.instanceId));
        },
        async release(eip) {
          await tcCall(c, "vpc", "ReleaseAddresses", { AddressIds: [eip.id] }, true);
        },
      },
      { oldEip, oldIp, releaseOldIp: options.releaseOldIp, notes },
    );
  },
});
