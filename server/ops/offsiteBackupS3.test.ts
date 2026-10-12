import assert from "node:assert/strict";
import test from "node:test";

import { buildSignedS3Request, parseListObjectsV2, parseS3Error, s3RequestTarget, sha256Hex, signV4, uriEncode } from "./offsiteBackupS3";

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("空串的 SHA-256", () => {
  assert.equal(sha256Hex(""), EMPTY_HASH);
});

/*
  AWS 文档「Signature Calculations for the Authorization Header」里的 GET Object 示例：
  examplebucket / test.txt / Range bytes=0-9，期望签名 f0e8bdb8…bdb41。
*/
test("SigV4：AWS 文档 S3 GET Object 示例", () => {
  const signed = signV4({
    method: "GET",
    canonicalPath: "/test.txt",
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
    amzDate: "20130524T000000Z",
  });
  assert.equal(signed.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, /);
});

/* AWS SigV4 测试套件 get-vanilla。 */
test("SigV4：官方测试套件 get-vanilla", () => {
  const signed = signV4({
    method: "GET",
    canonicalPath: "/",
    query: [],
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: EMPTY_HASH,
    region: "us-east-1",
    service: "service",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    amzDate: "20150830T123600Z",
  });
  assert.equal(signed.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});

/* AWS 文档的 GET Bucket（列对象）示例：查询串要排序、编码后参与签名。 */
test("SigV4：AWS 文档 S3 列对象示例（带查询串）", () => {
  const signed = signV4({
    method: "GET",
    canonicalPath: "/",
    query: [["prefix", "J"], ["max-keys", "2"]],
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": EMPTY_HASH,
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: EMPTY_HASH,
    region: "us-east-1",
    service: "s3",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    amzDate: "20130524T000000Z",
  });
  assert.equal(signed.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("URI 编码：空格是 %20，斜杠按需保留", () => {
  assert.equal(uriEncode("a b/c~"), "a%20b%2Fc~");
  assert.equal(uriEncode("a b/c~", true), "a%20b/c~");
  assert.equal(uriEncode("中"), "%E4%B8%AD");
});

test("路径风格与虚拟主机风格", () => {
  const path = s3RequestTarget({ endpoint: "https://minio.example.com:9000", bucket: "nex", pathStyle: true }, "backups/a.fwxbak");
  assert.equal(path.host, "minio.example.com:9000");
  assert.equal(path.canonicalPath, "/nex/backups/a.fwxbak");
  const bucketOnly = s3RequestTarget({ endpoint: "https://minio.example.com", bucket: "nex", pathStyle: true }, "");
  assert.equal(bucketOnly.canonicalPath, "/nex/");
  const vhost = s3RequestTarget({ endpoint: "https://oss-cn-hangzhou.aliyuncs.com", bucket: "nex", pathStyle: false }, "a.fwxbak");
  assert.equal(vhost.host, "nex.oss-cn-hangzhou.aliyuncs.com");
  assert.equal(vhost.canonicalPath, "/a.fwxbak");
});

test("签好名的请求带上 Authorization 与内容哈希，不带 host 头", () => {
  const request = buildSignedS3Request(
    { endpoint: "https://r2.example.com", region: "auto", bucket: "b", prefix: "", accessKeyId: "AK", secretAccessKey: "SK", pathStyle: true },
    { method: "PUT", key: "x.fwxbak", body: Buffer.from("hello"), contentType: "application/octet-stream" },
    new Date("2026-10-12T00:00:00Z"),
  );
  assert.equal(request.url, "https://r2.example.com/b/x.fwxbak");
  assert.equal(request.headers["x-amz-content-sha256"], sha256Hex("hello"));
  assert.equal(request.headers["x-amz-date"], "20261012T000000Z");
  assert.match(request.headers.authorization, /Credential=AK\/20261012\/auto\/s3\/aws4_request/);
  assert.ok(!("host" in request.headers));
});

test("解析 ListObjectsV2 与错误响应", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>nex/</Prefix><KeyCount>2</KeyCount><IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok&amp;1</NextContinuationToken>
  <Contents><Key>nex/nex-backup-20261004-0400.fwxbak</Key><LastModified>2026-10-03T20:00:05.000Z</LastModified><Size>1024</Size></Contents>
  <Contents><Key>nex/a&amp;b.txt</Key><LastModified>2026-10-03T20:00:05.000Z</LastModified><Size>3</Size></Contents>
</ListBucketResult>`;
  const parsed = parseListObjectsV2(xml);
  assert.equal(parsed.objects.length, 2);
  assert.equal(parsed.objects[0].size, 1024);
  assert.equal(parsed.objects[1].key, "nex/a&b.txt");
  assert.equal(parsed.isTruncated, true);
  assert.equal(parsed.nextToken, "tok&1");
  assert.equal(parseS3Error("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"), "AccessDenied：Access Denied");
});
