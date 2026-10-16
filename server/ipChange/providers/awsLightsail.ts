/*
  AWS Lightsail：用静态 IP 换公网 IP。

  流程：GetInstance（当前 publicIpAddress）→ GetStaticIps（翻页，找 attachedTo == 实例名）→
  AllocateStaticIp(新名字) → GetStaticIp 读新地址 → 有旧静态 IP 时 DetachStaticIp →
  AttachStaticIp(新) → 轮询 GetInstance 直到 publicIpAddress == 新 IP → 要求释放时 ReleaseStaticIp(旧)。
  实例只有动态公网 IP 时，挂上静态 IP 后原来的动态 IP 就没了。

  协议：JSON 1.1，POST https://lightsail.<region>.amazonaws.com/，
  X-Amz-Target: Lightsail_20161128.<Op>，Content-Type: application/x-amz-json-1.1，SigV4 service=lightsail。
  错误：HTTP 400/500 + {"__type": "...Exception", "message": "..."}。

  参考：
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_AllocateStaticIp.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_AttachStaticIp.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_DetachStaticIp.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_ReleaseStaticIp.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetStaticIps.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetStaticIp.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetInstance.html
  - https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/CommonErrors.html
*/
import { AWS_CREDENTIAL_FIELDS, awsSignedPost, readAwsCredentials, readAwsRegion, type AwsCredentials } from "./awsShared";
import {
  appendToError,
  assertIp,
  bestEffort,
  defineProvider,
  httpStatusError,
  ipOrNull,
  pollUntil,
  requirePattern,
  resourceSuffix,
  truncate,
} from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "AWS Lightsail";
const AUTH_TYPES = new Set(["UnrecognizedClientException", "InvalidSignatureException", "UnauthenticatedException", "IncompleteSignature"]);

async function lightsailCall(
  ctx: IpChangeContext,
  creds: AwsCredentials,
  region: string,
  op: string,
  payload: Record<string, unknown>,
  mutating = false,
): Promise<any> {
  const resp = await awsSignedPost(ctx, {
    label: `${LABEL} ${op}`,
    service: "lightsail",
    region,
    creds,
    contentType: "application/x-amz-json-1.1",
    body: JSON.stringify(payload),
    extraHeaders: { "x-amz-target": `Lightsail_20161128.${op}` },
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) {
    const failed = (Array.isArray(resp.json?.operations) ? resp.json.operations : []).find((item: any) => item?.status === "Failed");
    if (failed) {
      throw new IpChangeProviderError(`${LABEL} ${op} 失败：${truncate(String(failed.errorDetails || failed.errorCode || "operation failed"))}`, {
        retryable: false,
        ambiguous: mutating,
      });
    }
    return resp.json ?? {};
  }
  const type = String(resp.json?.__type || "").split("#").pop() || "";
  const message = String(resp.json?.message || resp.json?.Message || "");
  const detail = type ? `${type}${message ? `：${message}` : ""}` : truncate(resp.text, 200);
  if (AUTH_TYPES.has(type)) {
    throw new IpChangeProviderError(`${LABEL}：Access Key 无效、已停用或时钟偏差过大（${detail}）`, { retryable: false });
  }
  if (type === "AccessDeniedException") {
    throw new IpChangeProviderError(`${LABEL}：IAM 权限不足，无法调用 ${op}（${detail}）`, { retryable: false });
  }
  if (type === "NotFoundException") {
    throw new IpChangeProviderError(`${LABEL}：资源不存在，请确认地域和实例名（${detail}）`, { retryable: false });
  }
  if (type === "ThrottlingException") {
    throw new IpChangeProviderError(`${LABEL} ${op} 被限流（${detail}）`, { retryable: true });
  }
  throw httpStatusError(`${LABEL} ${op}`, resp.status, detail, { mutating });
}

type StaticIp = { name: string; ipAddress: string; attachedTo: string; isAttached: boolean };

async function listStaticIps(ctx: IpChangeContext, creds: AwsCredentials, region: string): Promise<StaticIp[]> {
  const out: StaticIp[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const body = await lightsailCall(ctx, creds, region, "GetStaticIps", pageToken ? { pageToken } : {});
    for (const item of Array.isArray(body?.staticIps) ? body.staticIps : []) {
      out.push({
        name: String(item?.name || ""),
        ipAddress: String(item?.ipAddress || ""),
        attachedTo: String(item?.attachedTo || ""),
        isAttached: Boolean(item?.isAttached),
      });
    }
    pageToken = body?.nextPageToken ? String(body.nextPageToken) : undefined;
    if (!pageToken) break;
  }
  return out;
}

async function getInstanceIp(ctx: IpChangeContext, creds: AwsCredentials, region: string, instanceName: string) {
  const body = await lightsailCall(ctx, creds, region, "GetInstance", { instanceName });
  if (!body?.instance) throw new IpChangeProviderError(`${LABEL}：找不到实例 ${instanceName}`, { retryable: false });
  return { publicIp: ipOrNull(body.instance.publicIpAddress), isStaticIp: Boolean(body.instance.isStaticIp) };
}

function readTarget(credentials: IpChangeCredentials, target: IpChangeTarget) {
  return {
    creds: readAwsCredentials(credentials),
    region: readAwsRegion(target),
    instanceName: requirePattern(target, "instanceName", "实例名", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/, "Lightsail 控制台里的实例名称"),
  };
}

export const awsLightsailProvider = defineProvider({
  id: "aws-lightsail",
  label: "AWS Lightsail",
  docsHint:
    "IAM 访问密钥；策略需要 lightsail:GetInstance、GetStaticIps、GetStaticIp、AllocateStaticIp、AttachStaticIp、DetachStaticIp、ReleaseStaticIp。换 IP 用静态 IP（挂在实例上免费，闲置收费）。",
  credentialFields: AWS_CREDENTIAL_FIELDS,
  targetFields: [
    { key: "region", label: "地域", type: "text", required: true, placeholder: "ap-northeast-1" },
    { key: "instanceName", label: "实例名", type: "text", required: true, placeholder: "Ubuntu-1" },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    const { creds, region, instanceName } = readTarget(credentials, target);
    return { currentIp: (await getInstanceIp(ctx, creds, region, instanceName)).publicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    const { creds, region, instanceName } = readTarget(credentials, target);
    return (await getInstanceIp(ctx, creds, region, instanceName)).publicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const { creds, region, instanceName } = readTarget(credentials, target);
    const current = await getInstanceIp(ctx, creds, region, instanceName);
    const oldStatic = (await listStaticIps(ctx, creds, region)).find((item) => item.isAttached && item.attachedTo === instanceName) || null;
    const oldIp = current.publicIp;
    ctx.log(`${LABEL}：当前公网 IP ${oldIp || "（无）"}${oldStatic ? `（静态 IP ${oldStatic.name}）` : "（动态 IP）"}`);

    const newName = `nex-${resourceSuffix(ctx)}`;
    try {
      await lightsailCall(ctx, creds, region, "AllocateStaticIp", { staticIpName: newName }, true);
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, `可能已经申请了静态 IP ${newName}，请到 Lightsail 控制台检查，闲置的请手动释放`);
      }
      throw error;
    }
    const releaseNew = async () =>
      bestEffort(ctx, `${LABEL}：释放新申请的静态 IP ${newName}`, () =>
        lightsailCall(ctx, creds, region, "ReleaseStaticIp", { staticIpName: newName }, true),
      );

    let newIp: string;
    try {
      const got = await lightsailCall(ctx, creds, region, "GetStaticIp", { staticIpName: newName });
      newIp = assertIp(got?.staticIp?.ipAddress, `${LABEL} GetStaticIp `);
    } catch (error) {
      const released = await releaseNew();
      throw appendToError(error, released ? `已释放新申请的静态 IP ${newName}` : `新静态 IP ${newName} 释放失败，请到控制台手动释放`);
    }
    ctx.log(`${LABEL}：已申请静态 IP ${newName}（${newIp}）`);

    let detachedOld = false;
    try {
      if (oldStatic) {
        await lightsailCall(ctx, creds, region, "DetachStaticIp", { staticIpName: oldStatic.name }, true);
        detachedOld = true;
      }
      await lightsailCall(ctx, creds, region, "AttachStaticIp", { staticIpName: newName, instanceName }, true);
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, `静态 IP 的挂载状态未知，请到 Lightsail 控制台确认实例 ${instanceName} 当前挂的是哪个静态 IP`);
      }
      const notes: string[] = [];
      if (detachedOld && oldStatic) {
        const ok = await bestEffort(ctx, `${LABEL}：把旧静态 IP ${oldStatic.name} 挂回去`, () =>
          lightsailCall(ctx, creds, region, "AttachStaticIp", { staticIpName: oldStatic.name, instanceName }, true),
        );
        notes.push(ok ? `已把旧静态 IP ${oldStatic.ipAddress} 挂回实例` : `旧静态 IP ${oldStatic.ipAddress} 挂回失败，请到控制台处理`);
      }
      const released = await releaseNew();
      notes.push(released ? `已释放新申请的静态 IP ${newIp}` : `新静态 IP ${newIp}（${newName}）释放失败，请到控制台手动释放`);
      throw appendToError(error, notes.join("；"));
    }

    await pollUntil(
      ctx,
      `${LABEL} 实例公网 IP 变为 ${newIp}`,
      async () => (await getInstanceIp(ctx, creds, region, instanceName)).publicIp === newIp,
      { timeoutMs: 120_000 },
    );

    const notes: string[] = [];
    let releasedOldIp = false;
    if (oldStatic) {
      if (options.releaseOldIp) {
        try {
          await lightsailCall(ctx, creds, region, "ReleaseStaticIp", { staticIpName: oldStatic.name }, true);
          releasedOldIp = true;
          notes.push(`已释放旧静态 IP ${oldStatic.ipAddress}（${oldStatic.name}）`);
        } catch (error) {
          notes.push(`旧静态 IP ${oldStatic.ipAddress}（${oldStatic.name}）释放失败，请到控制台手动释放：${(error as Error).message}`);
        }
      } else {
        notes.push(`旧静态 IP ${oldStatic.ipAddress}（${oldStatic.name}）已卸下但仍保留，闲置静态 IP 会收费`);
      }
    } else if (oldIp) {
      releasedOldIp = true;
      notes.push(`旧 IP ${oldIp} 是动态公网 IP，挂上静态 IP 后已被回收`);
    }
    notes.push(`新 IP ${newIp} 是静态 IP（${newName}）`);
    return { oldIp, newIp, ipRole: "primary", releasedOldIp, notes };
  },
});
