/*
  AWS EC2：用弹性 IP（Elastic IP）换公网 IP。

  流程：DescribeInstances（找主网卡 deviceIndex=0 及其主私网 IP）→ DescribeAddresses（instance-id 过滤，
  找已关联的 EIP）→ AllocateAddress(Domain=vpc) → AssociateAddress(NetworkInterfaceId + PrivateIpAddress,
  AllowReassociation=true) → 轮询 DescribeInstances 直到 ipAddress 变成新 IP → 旧 IP 是 EIP 且要求释放时 ReleaseAddress。

  AssociateAddress 文档原文：已有 EIP 的实例再关联新 EIP，旧的会被自动解除关联但仍留在账号里；
  实例原来只有自动分配的公网 IP 时，关联 EIP 后那个 IP 会被 AWS 回收，无法找回。

  参考（Query API，Version 2016-11-15，SigV4 service=ec2）：
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_AllocateAddress.html
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_AssociateAddress.html
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeAddresses.html
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstances.html
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ReleaseAddress.html
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html
  - https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Query-Requests.html
*/
import { AWS_CREDENTIAL_FIELDS, awsSignedPost, readAwsCredentials, readAwsRegion, type AwsCredentials } from "./awsShared";
import {
  appendToError,
  assertIp,
  bestEffort,
  defineProvider,
  formEncode,
  httpStatusError,
  invalidInput,
  ipOrNull,
  pollUntil,
  requirePattern,
  truncate,
} from "./common";
import { rfc3986 } from "./signing/hmacV4";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";
import { parseXml, xmlFind, xmlItems, xmlText, type XmlNode } from "./xml";

const LABEL = "AWS EC2";
const VERSION = "2016-11-15";
const THROTTLE_CODES = new Set(["RequestLimitExceeded", "Throttling", "ServiceUnavailable", "Unavailable", "InternalError"]);

function ec2Error(status: number, doc: XmlNode, text: string, action: string, mutating: boolean): IpChangeProviderError {
  const code = xmlText(xmlFind(doc, "Error"), "Code");
  const message = xmlText(xmlFind(doc, "Error"), "Message");
  const detail = code ? `${code}${message ? `：${message}` : ""}` : truncate(text, 200);
  if (code === "AuthFailure" || code === "SignatureDoesNotMatch" || code === "InvalidClientTokenId") {
    return new IpChangeProviderError(`${LABEL}：Access Key 无效、已停用或时钟偏差过大（${detail}）`, { retryable: false });
  }
  if (code === "UnauthorizedOperation") {
    return new IpChangeProviderError(`${LABEL}：IAM 权限不足，无法调用 ${action}（${detail}）`, { retryable: false });
  }
  if (code.startsWith("InvalidInstanceID")) {
    return new IpChangeProviderError(`${LABEL}：找不到实例，请确认地域和实例 ID（${detail}）`, { retryable: false });
  }
  if (code === "AddressLimitExceeded") {
    return new IpChangeProviderError(`${LABEL}：该地域的弹性 IP 配额已用完（${detail}）`, { retryable: false });
  }
  if (THROTTLE_CODES.has(code)) {
    return new IpChangeProviderError(`${LABEL} ${action} 暂时不可用（${detail}）${mutating && status >= 500 ? "；请求可能已经生效" : ""}`, {
      retryable: true,
      ambiguous: mutating && status >= 500,
    });
  }
  return httpStatusError(`${LABEL} ${action}`, status, detail, { mutating });
}

async function ec2Call(
  ctx: IpChangeContext,
  creds: AwsCredentials,
  region: string,
  action: string,
  params: Record<string, string>,
  mutating = false,
): Promise<XmlNode> {
  const body = formEncode({ Action: action, Version: VERSION, ...params }, (value) => rfc3986(value));
  const resp = await awsSignedPost(ctx, {
    label: `${LABEL} ${action}`,
    service: "ec2",
    region,
    creds,
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    body,
    mutating,
  });
  const doc = parseXml(resp.text);
  if (resp.status < 200 || resp.status >= 300) throw ec2Error(resp.status, doc, resp.text, action, mutating);
  return doc;
}

type Ec2Instance = {
  state: string;
  publicIp: string | null;
  eni: { id: string; privateIp: string } | null;
};

async function describeInstance(ctx: IpChangeContext, creds: AwsCredentials, region: string, instanceId: string): Promise<Ec2Instance> {
  const doc = await ec2Call(ctx, creds, region, "DescribeInstances", { "InstanceId.1": instanceId });
  const reservation = xmlItems(xmlFind(doc, "DescribeInstancesResponse"), "reservationSet")[0];
  const item = xmlItems(reservation, "instancesSet")[0];
  if (!item) throw new IpChangeProviderError(`${LABEL}：找不到实例 ${instanceId}，请确认地域和实例 ID`, { retryable: false });
  const enis = xmlItems(item, "networkInterfaceSet");
  const primary = enis.find((eni) => xmlText(eni, "attachment/deviceIndex") === "0") || enis[0];
  return {
    state: xmlText(item, "instanceState/name"),
    publicIp: ipOrNull(xmlText(item, "ipAddress")),
    eni: primary
      ? { id: xmlText(primary, "networkInterfaceId"), privateIp: xmlText(primary, "privateIpAddress") }
      : null,
  };
}

type Ec2Address = {
  publicIp: string;
  allocationId: string;
  associationId: string;
  networkInterfaceId: string;
  privateIpAddress: string;
  instanceId: string;
};

function parseAddresses(doc: XmlNode): Ec2Address[] {
  return xmlItems(xmlFind(doc, "DescribeAddressesResponse"), "addressesSet").map((item) => ({
    publicIp: xmlText(item, "publicIp"),
    allocationId: xmlText(item, "allocationId"),
    associationId: xmlText(item, "associationId"),
    networkInterfaceId: xmlText(item, "networkInterfaceId"),
    privateIpAddress: xmlText(item, "privateIpAddress"),
    instanceId: xmlText(item, "instanceId"),
  }));
}

function readTarget(credentials: IpChangeCredentials, target: IpChangeTarget) {
  return {
    creds: readAwsCredentials(credentials),
    region: readAwsRegion(target),
    instanceId: requirePattern(target, "instanceId", "实例 ID", /^i-[0-9a-f]{8,17}$/, "形如 i-0123456789abcdef0"),
  };
}

export const awsEc2Provider = defineProvider({
  id: "aws-ec2",
  label: "AWS EC2",
  docsHint:
    "IAM → 用户 → 安全凭证里创建访问密钥；策略需要 ec2:DescribeInstances、ec2:DescribeAddresses、ec2:AllocateAddress、ec2:AssociateAddress、ec2:ReleaseAddress、ec2:CreateTags。换 IP 用弹性 IP，旧的自动分配公网 IP 会被 AWS 回收。",
  credentialFields: AWS_CREDENTIAL_FIELDS,
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "ap-northeast-1" },
    { key: "instanceId", label: "实例 ID", type: "text", required: true, placeholder: "i-0123456789abcdef0" },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    const { creds, region, instanceId } = readTarget(credentials, target);
    const instance = await describeInstance(ctx, creds, region, instanceId);
    return { currentIp: instance.publicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    const { creds, region, instanceId } = readTarget(credentials, target);
    return (await describeInstance(ctx, creds, region, instanceId)).publicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const { creds, region, instanceId } = readTarget(credentials, target);
    const instance = await describeInstance(ctx, creds, region, instanceId);
    const eni = instance.eni;
    if (!eni?.id || !eni.privateIp) throw invalidInput(`${LABEL}：实例 ${instanceId} 没有可用的主网卡（可能是 EC2-Classic 或已终止）`);
    if (instance.state === "terminated" || instance.state === "shutting-down") {
      throw invalidInput(`${LABEL}：实例状态为 ${instance.state}，无法换 IP`);
    }
    const attached = parseAddresses(
      await ec2Call(ctx, creds, region, "DescribeAddresses", { "Filter.1.Name": "instance-id", "Filter.1.Value.1": instanceId }),
    );
    const oldEip =
      attached.find((addr) => addr.networkInterfaceId === eni.id && addr.privateIpAddress === eni.privateIp) ||
      attached.find((addr) => instance.publicIp && addr.publicIp === instance.publicIp) ||
      null;
    const oldIp = instance.publicIp;
    ctx.log(`${LABEL}：当前公网 IP ${oldIp || "（无）"}${oldEip ? `（弹性 IP ${oldEip.allocationId}）` : "（非弹性 IP）"}`);

    let newAllocationId: string;
    let newIp: string;
    try {
      const doc = await ec2Call(
        ctx,
        creds,
        region,
        "AllocateAddress",
        {
          Domain: "vpc",
          "TagSpecification.1.ResourceType": "elastic-ip",
          "TagSpecification.1.Tag.1.Key": "Name",
          "TagSpecification.1.Tag.1.Value": `nex-${instanceId}`,
        },
        true,
      );
      newAllocationId = xmlText(xmlFind(doc, "AllocateAddressResponse"), "allocationId");
      newIp = assertIp(xmlText(xmlFind(doc, "AllocateAddressResponse"), "publicIp"), `${LABEL} AllocateAddress `);
      if (!newAllocationId) throw new IpChangeProviderError(`${LABEL}：AllocateAddress 响应缺少 allocationId`, { retryable: false, ambiguous: true });
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, "可能已经申请了一个新的弹性 IP，请到 EC2 控制台「弹性 IP」检查，未关联的请手动释放");
      }
      throw error;
    }
    ctx.log(`${LABEL}：已申请弹性 IP ${newIp}（${newAllocationId}）`);

    try {
      await ec2Call(
        ctx,
        creds,
        region,
        "AssociateAddress",
        { AllocationId: newAllocationId, NetworkInterfaceId: eni.id, PrivateIpAddress: eni.privateIp, AllowReassociation: "true" },
        true,
      );
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, `新弹性 IP ${newIp}（${newAllocationId}）可能已经关联，请到控制台确认；如未关联请手动释放`);
      }
      const released = await bestEffort(ctx, `${LABEL}：释放新申请的弹性 IP ${newIp}`, () =>
        ec2Call(ctx, creds, region, "ReleaseAddress", { AllocationId: newAllocationId }, true),
      );
      throw appendToError(
        error,
        released ? `已释放新申请的弹性 IP ${newIp}` : `新申请的弹性 IP ${newIp}（${newAllocationId}）释放失败，请到控制台手动释放以免继续计费`,
      );
    }
    ctx.log(`${LABEL}：已关联 ${newIp} 到网卡 ${eni.id}`);

    await pollUntil(
      ctx,
      `${LABEL} 实例公网 IP 变为 ${newIp}`,
      async () => (await describeInstance(ctx, creds, region, instanceId)).publicIp === newIp,
      { timeoutMs: 120_000 },
    );

    const notes: string[] = [];
    let releasedOldIp = false;
    if (oldEip) {
      if (options.releaseOldIp) {
        try {
          await ec2Call(ctx, creds, region, "ReleaseAddress", { AllocationId: oldEip.allocationId }, true);
          releasedOldIp = true;
          notes.push(`已释放旧弹性 IP ${oldEip.publicIp}`);
        } catch (error) {
          notes.push(`旧弹性 IP ${oldEip.publicIp}（${oldEip.allocationId}）释放失败，请到控制台手动释放：${(error as Error).message}`);
        }
      } else {
        notes.push(`旧弹性 IP ${oldEip.publicIp}（${oldEip.allocationId}）已解除关联但仍保留在账号里，闲置 EIP 会按小时计费`);
      }
    } else if (oldIp) {
      releasedOldIp = true;
      notes.push(`旧 IP ${oldIp} 是实例自动分配的公网 IP，关联弹性 IP 后已被 AWS 回收`);
    }
    notes.push(`新 IP ${newIp} 是弹性 IP（${newAllocationId}），实例停止再启动也不会变`);
    return { oldIp, newIp, ipRole: "primary", releasedOldIp, notes };
  },
});
