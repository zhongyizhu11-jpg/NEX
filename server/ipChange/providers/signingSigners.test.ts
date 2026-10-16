import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { aliyunPercentEncode, aliyunRpcSign, aliyunTimestamp } from "./signing/aliyunRpc";
import { createJwtAssertion, parseServiceAccountKey } from "./signing/googleJwt";
import { huaweiCanonicalUri, huaweiSign } from "./signing/huaweiSdk";
import { loadOciPrivateKey, ociBodySha256, ociSign } from "./signing/ociHttpSignature";
import { tc3Sign } from "./signing/tc3";

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/* 阿里云「RPC 机制」文档的固定参数签名示例。 */
test("阿里云 RPC 签名：文档示例 DescribeDedicatedHosts", () => {
  const signed = aliyunRpcSign({
    method: "GET",
    accessKeySecret: "testsecret",
    params: {
      AccessKeyId: "testid",
      Action: "DescribeDedicatedHosts",
      Format: "JSON",
      RegionId: "cn-beijing",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: "edb2b34af0af9a6d14deaf7c1a5315eb",
      SignatureVersion: "1.0",
      Timestamp: "2023-03-13T08:34:30Z",
      Version: "2014-05-26",
    },
  });
  assert.ok(signed.canonicalizedQueryString.startsWith("AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing&"));
  assert.ok(signed.stringToSign.startsWith("GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeDedicatedHosts"));
  assert.equal(signed.signature, "9NaGiOspFP5UPcwX8Iwt2YJXXuk=");
  assert.ok(signed.query.startsWith("Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk%3D&"));
});

test("阿里云编码与时间格式", () => {
  assert.equal(aliyunPercentEncode("a b*~'"), "a%20b%2A~%27");
  assert.equal(aliyunTimestamp(new Date("2026-10-15T01:02:03.456Z")), "2026-10-15T01:02:03Z");
});

/*
  腾讯云签名 v3 文档示例：cvm DescribeInstances，时间戳 1551113065。
  文档把 SecretKey 打码了，只能核对 payload 哈希、规范请求哈希、scope 日期。
*/
test("腾讯云 TC3：文档示例的规范请求哈希", () => {
  const payload = '{"Limit": 1, "Filters": [{"Values": ["unnamed"], "Name": "instance-name"}]}';
  const signed = tc3Sign({
    secretId: "AKIDEXAMPLE",
    secretKey: "secret",
    service: "cvm",
    host: "cvm.tencentcloudapi.com",
    action: "DescribeInstances",
    payload,
    timestamp: 1551113065,
    contentType: "application/json; charset=utf-8",
    signAction: false,
  });
  assert.equal(signed.hashedPayload, "99d58dfbc6745f6747f36bfca17dee5e6881dc0428a0a36f96199342bc5b4907");
  assert.equal(sha256Hex(signed.canonicalRequest), "2815843035062fffda5fd6f2a44ea8a34818b0dc46f024b8b3786976a3adda7a");
  assert.equal(
    signed.stringToSign,
    "TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n2815843035062fffda5fd6f2a44ea8a34818b0dc46f024b8b3786976a3adda7a",
  );
  assert.match(signed.authorization, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
});

test("腾讯云 TC3：默认把 x-tc-action 纳入签名", () => {
  const signed = tc3Sign({ secretId: "id", secretKey: "k", service: "vpc", host: "vpc.tencentcloudapi.com", action: "AllocateAddresses", payload: "{}", timestamp: 1700000000 });
  assert.match(signed.canonicalRequest, /x-tc-action:allocateaddresses\n/);
  assert.match(signed.authorization, /SignedHeaders=content-type;host;x-tc-action,/);
});

/* 华为云「API 签名算法详解」示例：GET /v1/{project}/vpcs?limit=2&marker=…，X-Sdk-Date 20191115T033655Z。 */
test("华为云 SDK-HMAC-SHA256：文档示例的规范请求哈希", () => {
  const signed = huaweiSign({
    method: "GET",
    path: "/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs",
    query: [["marker", "13551d6b-755d-4757-b956-536f674975c0"], ["limit", "2"]],
    headers: { "Content-Type": "application/json", Host: "service.region.example.com", "X-Sdk-Date": "20191115T033655Z" },
    body: "",
    accessKey: "AK",
    secretKey: "SK",
    sdkDate: "20191115T033655Z",
  });
  assert.equal(
    signed.canonicalRequest,
    [
      "GET",
      "/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs/",
      "limit=2&marker=13551d6b-755d-4757-b956-536f674975c0",
      "content-type:application/json\nhost:service.region.example.com\nx-sdk-date:20191115T033655Z\n",
      "content-type;host;x-sdk-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n"),
  );
  assert.equal(sha256Hex(signed.canonicalRequest), "b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a");
  assert.equal(signed.stringToSign, "SDK-HMAC-SHA256\n20191115T033655Z\nb25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a");
  assert.match(signed.authorization, /^SDK-HMAC-SHA256 Access=AK, SignedHeaders=content-type;host;x-sdk-date, Signature=[0-9a-f]{64}$/);
  assert.equal(huaweiCanonicalUri("/v1/p/publicips/"), "/v1/p/publicips/");
});

/*
  OCI 请求签名：官方文档的测试密钥与两组示例请求；期望签名取自 Oracle 官方
  oci-go-sdk common/http_signer_test.go（expectedSignature / expectedSignature2）。
*/
const OCI_TEST_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIICXgIBAAKBgQDCFENGw33yGihy92pDjZQhl0C36rPJj+CvfSC8+q28hxA161QF
NUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6Z4UMR7EOcpfdUE9Hf3m/hs+F
UR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJwoYi+1hqp1fIekaxsyQIDAQAB
AoGBAJR8ZkCUvx5kzv+utdl7T5MnordT1TvoXXJGXK7ZZ+UuvMNUCdN2QPc4sBiA
QWvLw1cSKt5DsKZ8UETpYPy8pPYnnDEz2dDYiaew9+xEpubyeW2oH4Zx71wqBtOK
kqwrXa/pzdpiucRRjk6vE6YY7EBBs/g7uanVpGibOVAEsqH1AkEA7DkjVH28WDUg
f1nqvfn2Kj6CT7nIcE3jGJsZZ7zlZmBmHFDONMLUrXR/Zm3pR5m0tCmBqa5RK95u
412jt1dPIwJBANJT3v8pnkth48bQo/fKel6uEYyboRtA5/uHuHkZ6FQF7OUkGogc
mSJluOdc5t6hI1VsLn0QZEjQZMEOWr+wKSMCQQCC4kXJEsHAve77oP6HtG/IiEn7
kpyUXRNvFsDE0czpJJBvL/aRFUJxuRK91jhjC68sA7NsKMGg5OXb5I5Jj36xAkEA
gIT7aFOYBFwGgQAQkWNKLvySgKbAZRTeLBacpHMuQdl1DfdntvAyqpAZ0lY0RKmW
G6aFKaqQfOXKCyWoUiVknQJAXrlgySFci/2ueKlIE1QqIiLSZ8V8OlpFLRnb1pzI
7U1yQXnTAEFYM560yJlzUpOb1V4cScGd365tiSMvxLOvTA==
-----END RSA PRIVATE KEY-----`;
const OCI_KEY_ID =
  "ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq/ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq/20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34";

test("OCI 签名：官方测试向量 GET", () => {
  const signed = ociSign({
    method: "GET",
    url:
      "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&" +
      "compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa" +
      "&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q",
    headers: { date: "Thu, 05 Jan 2014 21:31:40 GMT" },
    keyId: OCI_KEY_ID,
    privateKey: loadOciPrivateKey(OCI_TEST_KEY),
  });
  assert.equal(
    signed.signingString,
    "date: Thu, 05 Jan 2014 21:31:40 GMT\n" +
      "(request-target): get /20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q\n" +
      "host: iaas.us-phoenix-1.oraclecloud.com",
  );
  assert.equal(
    signed.signature,
    "GBas7grhyrhSKHP6AVIj/h5/Vp8bd/peM79H9Wv8kjoaCivujVXlpbKLjMPeDUhxkFIWtTtLBj3sUzaFj34XE6YZAHc9r2DmE4pMwOAy/kiITcZxa1oHPOeRheC0jP2dqbTll8fmTZVwKZOKHYPtrLJIJQHJjNvxFWeHQjMaR7M=",
  );
  assert.equal(
    signed.authorization,
    `Signature version="1",keyId="${OCI_KEY_ID}",algorithm="rsa-sha256",headers="date (request-target) host",signature="${signed.signature}"`,
  );
});

test("OCI 签名：官方测试向量 POST（带 body 哈希）", () => {
  const body = `{
    "compartmentId": "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa",
    "instanceId": "ocid1.instance.oc1.phx.abuw4ljrlsfiqw6vzzxb43vyypt4pkodawglp3wqxjqofakrwvou52gb6s5a",
    "volumeId": "ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q"
}`;
  assert.equal(ociBodySha256(body), "V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=");
  const signed = ociSign({
    method: "POST",
    url: "https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments",
    headers: { date: "Thu, 05 Jan 2014 21:31:40 GMT" },
    body,
    keyId: OCI_KEY_ID,
    privateKey: loadOciPrivateKey(OCI_TEST_KEY),
  });
  assert.equal(
    signed.signingString,
    [
      "date: Thu, 05 Jan 2014 21:31:40 GMT",
      "(request-target): post /20160918/volumeAttachments",
      "host: iaas.us-phoenix-1.oraclecloud.com",
      "content-length: 316",
      "content-type: application/json",
      "x-content-sha256: V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=",
    ].join("\n"),
  );
  assert.equal(
    signed.signature,
    "Mje8vIDPlwIHmD/cTDwRxE7HaAvBg16JnVcsuqaNRim23fFPgQfLoOOxae6WqKb1uPjYEl0qIdazWaBy/Ml8DRhqlocMwoSXv0fbukP8J5N80LCmzT/FFBvIvTB91XuXI3hYfP9Zt1l7S6ieVadHUfqBedWH0itrtPJBgKmrWso=",
  );
  assert.match(signed.authorization, /headers="date \(request-target\) host content-length content-type x-content-sha256"/);
});

test("OCI 签名：x-date 优先", () => {
  const signed = ociSign({
    method: "DELETE",
    url: "https://iaas.ap-tokyo-1.oraclecloud.com/20160918/publicIps/ocid1.publicip.oc1..x",
    headers: { "x-date": "Thu, 15 Oct 2026 00:00:00 GMT" },
    keyId: "t/u/f",
    privateKey: loadOciPrivateKey(OCI_TEST_KEY),
  });
  assert.match(signed.authorization, /headers="x-date \(request-target\) host"/);
});

test("Google 服务账号 JWT：RS256 可被公钥验证，声明正确", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const account = parseServiceAccountKey(
    JSON.stringify({ type: "service_account", project_id: "demo-proj", private_key_id: "kid1", private_key: pem, client_email: "sa@demo-proj.iam.gserviceaccount.com" }),
  );
  assert.equal(account.projectId, "demo-proj");
  const jwt = createJwtAssertion(account, "https://www.googleapis.com/auth/compute", new Date("2026-10-15T00:00:00Z"));
  const [header, claims, signature] = jwt.split(".");
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT", kid: "kid1" });
  assert.deepEqual(decode(claims), {
    iss: "sa@demo-proj.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/compute",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1792022400,
    exp: 1792026000,
  });
  const ok = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
});

test("Google 服务账号 JSON 校验：错误消息不含密钥", () => {
  assert.throws(() => parseServiceAccountKey("not json"), /不是合法的 JSON/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ type: "service_account", client_email: "a@b", private_key: "xx" })), /private_key/);
});
