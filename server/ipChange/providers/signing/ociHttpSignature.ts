/*
  Oracle Cloud Infrastructure 请求签名（draft-cavage-http-signatures-08，rsa-sha256）。

  参考：https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
  - GET / DELETE 签：date（或 x-date）、(request-target)、host
  - PUT / POST 额外签：content-length、content-type、x-content-sha256（body 的 SHA-256，base64）
  - Authorization: Signature version="1",keyId="<tenancy>/<user>/<fingerprint>",algorithm="rsa-sha256",headers="...",signature="..."
  官方文档现在的示例把签名值换成了 <your_signature>；同一组测试密钥和请求在 Oracle 官方
  oci-go-sdk 的 common/http_signer_test.go 里给出了期望签名，单测逐字复现这两组值。
*/
import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";

export type OciSignInput = {
  method: string;
  url: string;
  /** 已有的请求头；date 或 x-date 必须给一个 */
  headers: Record<string, string>;
  body?: string;
  keyId: string;
  privateKey: KeyObject;
};

export function ociBodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

export function loadOciPrivateKey(pem: string, passphrase?: string): KeyObject {
  return createPrivateKey({ key: pem, format: "pem", passphrase: passphrase || undefined });
}

export function ociSign(input: OciSignInput) {
  const method = input.method.toUpperCase();
  const url = new URL(input.url);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  if (!headers.host) headers.host = url.host;
  const dateHeader = headers["x-date"] !== undefined ? "x-date" : "date";
  if (headers[dateHeader] === undefined) throw new Error("OCI 签名缺少 date / x-date 头");
  const signed: string[] = [dateHeader, "(request-target)", "host"];
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const body = input.body ?? "";
    if (headers["content-length"] === undefined) headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
    if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
    if (headers["x-content-sha256"] === undefined) headers["x-content-sha256"] = ociBodySha256(body);
    signed.push("content-length", "content-type", "x-content-sha256");
  }
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const signingString = signed
    .map((name) => (name === "(request-target)" ? `(request-target): ${requestTarget}` : `${name}: ${headers[name]}`))
    .join("\n");
  const signature = createSign("RSA-SHA256").update(signingString, "utf8").sign(input.privateKey, "base64");
  const authorization =
    `Signature version="1",keyId="${input.keyId}",algorithm="rsa-sha256",` +
    `headers="${signed.join(" ")}",signature="${signature}"`;
  const allHeaders: Record<string, string> = { ...headers, authorization };
  return { signingString, signature, authorization, headers: allHeaders };
}
