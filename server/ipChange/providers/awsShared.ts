/*
  AWS 两个 provider（EC2 / Lightsail）共用：凭据字段、端点、SigV4 签名请求。
  端点规则：https://docs.aws.amazon.com/general/latest/gr/rande.html
  （中国区 cn-north-1 / cn-northwest-1 用 amazonaws.com.cn）。
*/
import { REGION_HINT, REGION_PATTERN, httpRequest, requirePattern, type HttpResponse } from "./common";
import { AWS_SIGV4, compactIsoDate, sha256Hex, signHmacV4 } from "./signing/hmacV4";
import type { IpChangeContext, IpChangeCredentials, IpChangeFieldDef, IpChangeTarget } from "./types";

export const AWS_CREDENTIAL_FIELDS: IpChangeFieldDef[] = [
  { key: "accessKeyId", label: "Access Key ID", type: "text", required: true, placeholder: "AKIA…" },
  { key: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
];

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string };

export function readAwsCredentials(credentials: IpChangeCredentials): AwsCredentials {
  return {
    accessKeyId: requirePattern(credentials, "accessKeyId", "Access Key ID", /^[A-Z0-9]{16,128}$/, "应为 16–128 位大写字母和数字"),
    secretAccessKey: requirePattern(credentials, "secretAccessKey", "Secret Access Key", /^\S{16,128}$/, "长度不对或含空白"),
  };
}

export function readAwsRegion(target: IpChangeTarget): string {
  return requirePattern(target, "region", "地域", REGION_PATTERN, REGION_HINT);
}

export function awsHost(service: string, region: string): string {
  return region.startsWith("cn-") ? `${service}.${region}.amazonaws.com.cn` : `${service}.${region}.amazonaws.com`;
}

export async function awsSignedPost(
  ctx: IpChangeContext,
  input: {
    label: string;
    service: string;
    region: string;
    creds: AwsCredentials;
    contentType: string;
    body: string;
    extraHeaders?: Record<string, string>;
    mutating?: boolean;
  },
): Promise<HttpResponse> {
  const host = awsHost(input.service, input.region);
  const amzDate = compactIsoDate(ctx.now());
  const signedHeaders: Record<string, string> = {
    "content-type": input.contentType,
    host,
    "x-amz-date": amzDate,
    ...(input.extraHeaders || {}),
  };
  const signed = signHmacV4(AWS_SIGV4, {
    method: "POST",
    canonicalUri: "/",
    query: [],
    headers: signedHeaders,
    payloadHash: sha256Hex(input.body),
    region: input.region,
    service: input.service,
    accessKeyId: input.creds.accessKeyId,
    secretAccessKey: input.creds.secretAccessKey,
    requestDate: amzDate,
  });
  const { host: _host, ...sendHeaders } = signedHeaders;
  return httpRequest(ctx, {
    label: input.label,
    method: "POST",
    url: `https://${host}/`,
    headers: { ...sendHeaders, authorization: signed.authorization },
    body: input.body,
    mutating: input.mutating,
  });
}
