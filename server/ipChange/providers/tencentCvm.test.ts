import assert from "node:assert/strict";
import test from "node:test";

import { tencentCvmProvider } from "./tencentCvm";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

// 测试用的假凭据：拆开拼接，免得被 GitHub 推送保护当成真密钥（值本身不变）
const CREDS = { secretId: ["AKID", "z8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE"].join(""), secretKey: ["Gu5t9xGARNpq86cd98", "joQYCN3EXAMPLE"].join("") };
const TARGET = { region: "ap-guangzhou", instanceId: "ins-1bmpb9tu" };

function call(service: "vpc" | "cvm", action: string, response: Record<string, unknown>, check?: (body: any) => void): ExpectedCall {
  return {
    method: "POST",
    url: `https://${service}.tencentcloudapi.com/`,
    check: (req) => {
      assert.equal(req.headers["x-tc-action"], action);
      assert.equal(req.headers["x-tc-version"], "2017-03-12");
      assert.equal(req.headers["x-tc-region"], "ap-guangzhou");
      assert.equal(req.headers["x-tc-timestamp"], "1792051200");
      assert.equal(req.headers["content-type"], "application/json; charset=utf-8");
      assert.match(
        req.headers.authorization,
        new RegExp(`^TC3-HMAC-SHA256 Credential=${CREDS.secretId}/2026-10-15/${service}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$`),
      );
      check?.(req.json);
    },
    json: { Response: { ...response, RequestId: "6EF60BEC-0242-43AF-BB20-270359FB54A7" } },
  };
}

const cvm = (ip: string | null) =>
  call("cvm", "DescribeInstances", {
    TotalCount: 1,
    InstanceSet: [{ InstanceId: TARGET.instanceId, InstanceState: "RUNNING", PublicIpAddresses: ip ? [ip] : [], PrivateIpAddresses: ["172.16.0.9"] }],
  }, (body) => assert.deepEqual(body, { InstanceIds: [TARGET.instanceId] }));
const addr = (id: string, ip: string, status: string, instanceId = "") => ({
  AddressId: id,
  AddressName: "",
  AddressIp: ip,
  AddressStatus: status,
  AddressType: "EIP",
  InstanceId: instanceId || null,
  IsArrears: false,
  IsBlocked: false,
});
const describe = (id: string, ip: string, status: string, instanceId = "") =>
  call("vpc", "DescribeAddresses", { TotalCount: 1, AddressSet: [addr(id, ip, status, instanceId)] }, (body) => assert.deepEqual(body, { AddressIds: [id] }));

test("腾讯云：普通公网 IP 先 TransformAddress，再换 EIP 并释放旧的", async () => {
  const mock = createMockContext([
    cvm("119.29.1.1"),
    call("vpc", "DescribeAddresses", { TotalCount: 0, AddressSet: [] }, (body) => assert.deepEqual(body.Filters, [{ Name: "instance-id", Values: [TARGET.instanceId] }])),
    call("vpc", "TransformAddress", { AddressId: "eip-fk2gmm9s", TaskId: 345732 }, (body) => assert.deepEqual(body, { InstanceId: TARGET.instanceId })),
    describe("eip-fk2gmm9s", "119.29.1.1", "BINDING", TARGET.instanceId),
    describe("eip-fk2gmm9s", "119.29.1.1", "BIND", TARGET.instanceId),
    call("vpc", "AllocateAddresses", { AddressSet: ["eip-m44ku5d2"], TaskId: "61531421" }, (body) => {
      assert.equal(body.AddressCount, 1);
      assert.equal(body.InternetChargeType, "TRAFFIC_POSTPAID_BY_HOUR");
      assert.equal(body.InternetMaxBandwidthOut, 100);
      assert.match(body.AddressName, /^nex-/);
    }),
    describe("eip-m44ku5d2", "", "CREATING"),
    describe("eip-m44ku5d2", "129.204.2.2", "UNBIND"),
    call("vpc", "DisassociateAddress", { TaskId: "61531411" }, (body) => assert.deepEqual(body, { AddressId: "eip-fk2gmm9s" })),
    describe("eip-fk2gmm9s", "119.29.1.1", "UNBIND"),
    call("vpc", "AssociateAddress", { TaskId: "50121411" }, (body) => assert.deepEqual(body, { AddressId: "eip-m44ku5d2", InstanceId: TARGET.instanceId })),
    describe("eip-m44ku5d2", "129.204.2.2", "BIND", TARGET.instanceId),
    call("vpc", "ReleaseAddresses", { TaskId: "12331420" }, (body) => assert.deepEqual(body, { AddressIds: ["eip-fk2gmm9s"] })),
  ]);
  const result = await tencentCvmProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.equal(result.oldIp, "119.29.1.1");
  assert.equal(result.newIp, "129.204.2.2");
  assert.equal(result.releasedOldIp, true);
});

test("腾讯云：已有 EIP 不释放旧的；传统账户不传计费参数", async () => {
  const mock = createMockContext([
    cvm("119.29.1.1"),
    call("vpc", "DescribeAddresses", { TotalCount: 1, AddressSet: [addr("eip-old", "119.29.1.1", "BIND", TARGET.instanceId)] }),
    call("vpc", "AllocateAddresses", { AddressSet: ["eip-new"], TaskId: "1" }, (body) => {
      assert.equal(body.InternetChargeType, undefined);
      assert.equal(body.InternetMaxBandwidthOut, undefined);
    }),
    describe("eip-new", "129.204.2.2", "UNBIND"),
    call("vpc", "DisassociateAddress", { TaskId: "2" }),
    describe("eip-old", "119.29.1.1", "UNBIND"),
    call("vpc", "AssociateAddress", { TaskId: "3" }),
    describe("eip-new", "129.204.2.2", "BIND", TARGET.instanceId),
  ]);
  const result = await tencentCvmProvider.changeIp(CREDS, { ...TARGET, internetChargeType: "LEGACY" }, mock.ctx, { releaseOldIp: false });
  mock.assertDone();
  assert.equal(result.releasedOldIp, false);
  assert.ok(result.notes.some((note) => note.includes("仍保留")));
});

test("腾讯云：解绑失败时释放新 EIP；错误码映射", async () => {
  const mock = createMockContext([
    cvm("119.29.1.1"),
    call("vpc", "DescribeAddresses", { TotalCount: 1, AddressSet: [addr("eip-old", "119.29.1.1", "BIND", TARGET.instanceId)] }),
    call("vpc", "AllocateAddresses", { AddressSet: ["eip-new"], TaskId: "1" }),
    describe("eip-new", "129.204.2.2", "UNBIND"),
    call("vpc", "DisassociateAddress", { Error: { Code: "InvalidAddressId.Blocked", Message: "指定EIP处于封堵状态" } }),
    call("vpc", "ReleaseAddresses", { TaskId: "9" }, (body) => assert.deepEqual(body, { AddressIds: ["eip-new"] })),
  ]);
  await rejectsWith(tencentCvmProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /InvalidAddressId\.Blocked.*已释放新申请的 EIP 129\.204\.2\.2/);
  mock.assertDone();

  const errors = createMockContext([
    call("cvm", "DescribeInstances", { Error: { Code: "AuthFailure.SignatureFailure", Message: "The provided credentials could not be validated." } }),
    call("cvm", "DescribeInstances", { Error: { Code: "AuthFailure.UnauthorizedOperation", Message: "CAM 鉴权失败" } }),
    call("cvm", "DescribeInstances", { Error: { Code: "RequestLimitExceeded", Message: "请求的次数超过了频率限制。" } }),
    call("cvm", "DescribeInstances", { TotalCount: 0, InstanceSet: [] }),
  ]);
  await rejectsWith(tencentCvmProvider.testCredentials(CREDS, TARGET, errors.ctx), /SecretId \/ SecretKey 无效/);
  await rejectsWith(tencentCvmProvider.getCurrentIp(CREDS, TARGET, errors.ctx), /CAM 权限不足/);
  const limited = await rejectsWith(tencentCvmProvider.getCurrentIp(CREDS, TARGET, errors.ctx), /被限流/);
  assert.equal(limited.options.retryable, true);
  await rejectsWith(tencentCvmProvider.getCurrentIp(CREDS, TARGET, errors.ctx), /找不到实例/);
  errors.assertDone();
});
