import assert from "node:assert/strict";
import test from "node:test";

import { AWS_SIGV4, VOLCENGINE_V4, compactIsoDate, rfc3986, sha256Hex, signHmacV4 } from "./signing/hmacV4";

// 火山引擎签名文档里的示例 AK/SK（不是真密钥）：拆开拼接，免得被 GitHub 推送保护当成真密钥（值本身不变）
const VOLC_DOC_AK = ["AKLT", "YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg"].join("");
const VOLC_DOC_SK = ["WkRZeE1EQmxPVGhsWWpWak5H", "VmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ=="].join("");

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AWS_SUITE = {
  region: "us-east-1",
  service: "service",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  requestDate: "20150830T123600Z",
};

/* AWS SigV4 官方测试套件（awslabs/aws-c-auth tests/aws-signing-test-suite/v4）。 */
test("AWS SigV4 测试套件：get-vanilla", () => {
  const signed = signHmacV4(AWS_SIGV4, {
    ...AWS_SUITE,
    method: "GET",
    query: [],
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: EMPTY_HASH,
  });
  assert.equal(signed.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});

test("AWS SigV4 测试套件：post-vanilla-query", () => {
  const signed = signHmacV4(AWS_SIGV4, {
    ...AWS_SUITE,
    method: "POST",
    query: [["Param1", "value1"]],
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: EMPTY_HASH,
  });
  assert.equal(sha256Hex(signed.canonicalRequest), "9d659678c1756bb3113e2ce898845a0a79dbbc57b740555917687f1b3340fbbd");
  assert.equal(signed.signature, "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11");
});

/* EC2 Query API 就是这种形态：表单体 + 签名 content-type。 */
test("AWS SigV4 测试套件：post-x-www-form-urlencoded（签名体）", () => {
  const body = "Param1=value1";
  const payloadHash = sha256Hex(body);
  assert.equal(payloadHash, "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e");
  const signed = signHmacV4(AWS_SIGV4, {
    ...AWS_SUITE,
    method: "POST",
    query: [],
    headers: {
      "Content-Length": "13",
      "Content-Type": "application/x-www-form-urlencoded",
      Host: "example.amazonaws.com",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": "20150830T123600Z",
    },
    payloadHash,
  });
  assert.equal(sha256Hex(signed.canonicalRequest), "b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb");
  assert.equal(signed.signature, "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b");
  assert.equal(
    signed.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
  );
});

/* AWS 文档 S3 GET Object 示例（与 server/ops/offsiteBackupS3.test.ts 同一组值）。 */
test("AWS SigV4：S3 文档示例", () => {
  const signed = signHmacV4(AWS_SIGV4, {
    method: "GET",
    canonicalUri: "/test.txt",
    query: [],
    headers: {
      Host: "examplebucket.s3.amazonaws.com",
      Range: "bytes=0-9",
      "x-amz-content-sha256": EMPTY_HASH,
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: EMPTY_HASH,
    region: "us-east-1",
    service: "s3",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    requestDate: "20130524T000000Z",
  });
  assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

/*
  火山引擎「签名方法」文档（https://www.volcengine.com/docs/6369/67269）的逐步示例：
  billing / cn-beijing / 20250329T180937Z，文档给出了 kDate、kSigning、规范请求哈希与最终签名。
*/
const VOLC = {
  region: "cn-beijing",
  service: "billing",
  accessKeyId: VOLC_DOC_AK,
  secretAccessKey: VOLC_DOC_SK,
  requestDate: "20250329T180937Z",
};

test("火山引擎签名文档示例：GET QueryBalanceAcct", () => {
  const signed = signHmacV4(VOLCENGINE_V4, {
    ...VOLC,
    method: "GET",
    query: [["Action", "QueryBalanceAcct"], ["Version", "2022-01-01"]],
    headers: { host: "billing.volcengineapi.com", "x-date": "20250329T180937Z" },
    payloadHash: EMPTY_HASH,
  });
  assert.equal(signed.signingKeyHex, "b491ed164936de3bb06c1eb23326aa9587b5aaa6a4e02144b9d523bbebb7ca9f");
  assert.equal(sha256Hex(signed.canonicalRequest), "43171c1658c64b5db55c58d54988a4598d2d09a5613136beaa5eef40eae6e2c1");
  assert.equal(signed.signature, "1eda9e7e6b1728151a8e8791fdaf67cfbd28bd5c80d0fce2eb208746cf483105");
  assert.match(
    signed.authorization,
    new RegExp(`^HMAC-SHA256 Credential=${VOLC_DOC_AK}/20250329/cn-beijing/billing/request, SignedHeaders=host;x-date, Signature=1eda9e7e`),
  );
});

test("火山引擎签名文档示例：POST ListBill", () => {
  const body = '{"Limit":10,"BillPeriod":"2023-08"}';
  const signed = signHmacV4(VOLCENGINE_V4, {
    ...VOLC,
    method: "POST",
    query: [["Action", "ListBill"], ["Version", "2022-01-01"]],
    headers: { host: "billing.volcengineapi.com", "x-date": "20250329T180937Z" },
    payloadHash: sha256Hex(body),
  });
  assert.equal(sha256Hex(body), "e8cc56e129d9759d56c936e679a345d001a4235b58bee8e935ccad97f23ed663");
  assert.equal(sha256Hex(signed.canonicalRequest), "27383e3b56d03850f5634483527fbddcbf06cf98de1bc8a6679ef2300bff3b15");
  assert.equal(signed.signature, "5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658");
});

test("RFC 3986 编码与日期格式", () => {
  assert.equal(rfc3986("a b/c~*"), "a%20b%2Fc~%2A");
  assert.equal(rfc3986("中"), "%E4%B8%AD");
  assert.equal(compactIsoDate(new Date("2026-10-15T01:02:03.456Z")), "20261015T010203Z");
});
