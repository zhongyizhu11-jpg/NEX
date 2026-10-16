import assert from "node:assert/strict";
import test from "node:test";

import { awsLightsailProvider } from "./awsLightsail";
import { createMockContext, rejectsWith, type RecordedRequest } from "./testing";

const CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const TARGET = { region: "ap-northeast-1", instanceName: "Ubuntu-1" };
const URL_ = "https://lightsail.ap-northeast-1.amazonaws.com/";

function op(name: string, check?: (req: RecordedRequest) => void) {
  return (req: RecordedRequest) => {
    assert.equal(req.headers["x-amz-target"], `Lightsail_20161128.${name}`);
    assert.equal(req.headers["content-type"], "application/x-amz-json-1.1");
    assert.match(
      req.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261015\/ap-northeast-1\/lightsail\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    check?.(req);
  };
}

const instance = (ip: string, isStaticIp: boolean) => ({
  instance: {
    name: "Ubuntu-1",
    arn: "arn:aws:lightsail:ap-northeast-1:123456789012:Instance/abc",
    publicIpAddress: ip,
    privateIpAddress: "172.26.0.10",
    isStaticIp,
    state: { code: 16, name: "running" },
  },
});
const operation = (type: string) => ({ operations: [{ id: "op-1", resourceName: "x", operationType: type, status: "Succeeded" }] });

test("Lightsail：旧静态 IP 卸下、新静态 IP 挂上、释放旧的", async () => {
  const mock = createMockContext([
    { method: "POST", url: URL_, check: op("GetInstance", (r) => assert.deepEqual(r.json, { instanceName: "Ubuntu-1" })), json: instance("203.0.113.5", true) },
    {
      method: "POST",
      url: URL_,
      check: op("GetStaticIps", (r) => assert.deepEqual(r.json, {})),
      json: { staticIps: [{ name: "other", ipAddress: "203.0.113.9", attachedTo: "Other-1", isAttached: true }], nextPageToken: "p2" },
    },
    {
      method: "POST",
      url: URL_,
      check: op("GetStaticIps", (r) => assert.deepEqual(r.json, { pageToken: "p2" })),
      json: { staticIps: [{ name: "StaticIp-1", ipAddress: "203.0.113.5", attachedTo: "Ubuntu-1", isAttached: true }] },
    },
    { method: "POST", url: URL_, check: op("AllocateStaticIp", (r) => assert.match(r.json.staticIpName, /^nex-20261015-080000-[0-9a-f]{4}$/)), json: operation("AllocateStaticIp") },
    { method: "POST", url: URL_, check: op("GetStaticIp"), json: { staticIp: { name: "nex", ipAddress: "198.51.100.7", isAttached: false } } },
    { method: "POST", url: URL_, check: op("DetachStaticIp", (r) => assert.deepEqual(r.json, { staticIpName: "StaticIp-1" })), json: operation("DetachStaticIp") },
    {
      method: "POST",
      url: URL_,
      check: op("AttachStaticIp", (r) => {
        assert.equal(r.json.instanceName, "Ubuntu-1");
        assert.match(r.json.staticIpName, /^nex-/);
      }),
      json: operation("AttachStaticIp"),
    },
    { method: "POST", url: URL_, check: op("GetInstance"), json: instance("198.51.100.7", true) },
    { method: "POST", url: URL_, check: op("ReleaseStaticIp", (r) => assert.deepEqual(r.json, { staticIpName: "StaticIp-1" })), json: operation("ReleaseStaticIp") },
  ]);
  const result = await awsLightsailProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual(
    { oldIp: result.oldIp, newIp: result.newIp, ipRole: result.ipRole, releasedOldIp: result.releasedOldIp },
    { oldIp: "203.0.113.5", newIp: "198.51.100.7", ipRole: "primary", releasedOldIp: true },
  );
});

test("Lightsail：挂载失败 → 把旧静态 IP 挂回去、释放新的", async () => {
  const mock = createMockContext([
    { method: "POST", url: URL_, check: op("GetInstance"), json: instance("203.0.113.5", true) },
    { method: "POST", url: URL_, check: op("GetStaticIps"), json: { staticIps: [{ name: "StaticIp-1", ipAddress: "203.0.113.5", attachedTo: "Ubuntu-1", isAttached: true }] } },
    { method: "POST", url: URL_, check: op("AllocateStaticIp"), json: operation("AllocateStaticIp") },
    { method: "POST", url: URL_, check: op("GetStaticIp"), json: { staticIp: { ipAddress: "198.51.100.7" } } },
    { method: "POST", url: URL_, check: op("DetachStaticIp"), json: operation("DetachStaticIp") },
    {
      method: "POST",
      url: URL_,
      check: op("AttachStaticIp"),
      status: 400,
      json: { __type: "InvalidInputException", code: "InvalidInput", message: "Some names are already in use: Ubuntu-1" },
    },
    { method: "POST", url: URL_, check: op("AttachStaticIp", (r) => assert.equal(r.json.staticIpName, "StaticIp-1")), json: operation("AttachStaticIp") },
    { method: "POST", url: URL_, check: op("ReleaseStaticIp", (r) => assert.match(r.json.staticIpName, /^nex-/)), json: operation("ReleaseStaticIp") },
  ]);
  const error = await rejectsWith(awsLightsailProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /InvalidInputException.*已把旧静态 IP 203\.0\.113\.5 挂回实例；已释放新申请的静态 IP 198\.51\.100\.7/);
  assert.equal(error.options.retryable, false);
  mock.assertDone();
});

test("Lightsail：动态 IP 实例 + 错误类型映射", async () => {
  const mock = createMockContext([
    { method: "POST", url: URL_, check: op("GetInstance"), json: instance("54.0.0.1", false) },
    { method: "POST", url: URL_, check: op("GetStaticIps"), json: { staticIps: [] } },
    { method: "POST", url: URL_, check: op("AllocateStaticIp"), json: operation("AllocateStaticIp") },
    { method: "POST", url: URL_, check: op("GetStaticIp"), json: { staticIp: { ipAddress: "198.51.100.8" } } },
    { method: "POST", url: URL_, check: op("AttachStaticIp"), json: operation("AttachStaticIp") },
    { method: "POST", url: URL_, check: op("GetInstance"), json: instance("198.51.100.8", true) },
  ]);
  const result = await awsLightsailProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: false });
  mock.assertDone();
  assert.equal(result.oldIp, "54.0.0.1");
  assert.equal(result.newIp, "198.51.100.8");

  const denied = createMockContext([
    { method: "POST", url: URL_, status: 400, json: { __type: "AccessDeniedException", code: "AccessDenied", message: "User is not authorized" } },
    { method: "POST", url: URL_, status: 400, json: { __type: "UnrecognizedClientException", message: "The security token included in the request is invalid." } },
    { method: "POST", url: URL_, status: 500, json: { __type: "ServiceException", message: "boom" } },
  ]);
  await rejectsWith(awsLightsailProvider.getCurrentIp(CREDS, TARGET, denied.ctx), /IAM 权限不足/);
  await rejectsWith(awsLightsailProvider.getCurrentIp(CREDS, TARGET, denied.ctx), /Access Key 无效/);
  const svc = await rejectsWith(awsLightsailProvider.getCurrentIp(CREDS, TARGET, denied.ctx), /HTTP 500/);
  assert.equal(svc.options.retryable, true);
  assert.equal(svc.options.ambiguous, false);
});
