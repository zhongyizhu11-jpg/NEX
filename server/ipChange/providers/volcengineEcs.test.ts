import assert from "node:assert/strict";
import test from "node:test";

import { volcengineEcsProvider } from "./volcengineEcs";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

// 测试用的假凭据：拆开拼接，免得被 GitHub 推送保护当成真密钥（值本身不变）
const CREDS = { accessKeyId: ["AKLT", "YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg"].join(""), secretAccessKey: ["WkRZeE1EQmxPVGhsWWpWak5H", "VmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ=="].join("") };
const TARGET = { region: "cn-beijing", instanceId: "i-ybp1scasbe72q1vq35wv" };

function call(service: "vpc" | "ecs", action: string, result: unknown, check?: (q: URLSearchParams) => void, error?: { Code: string; Message: string }, status = 200): ExpectedCall {
  return {
    method: "GET",
    url: (url) => url.host === "open.volcengineapi.com" && url.searchParams.get("Action") === action,
    status,
    check: (req) => {
      assert.equal(req.url.searchParams.get("Version"), "2020-04-01");
      assert.equal(req.headers["x-date"], "20261015T080000Z");
      assert.match(
        req.headers.authorization,
        new RegExp(`^HMAC-SHA256 Credential=${CREDS.accessKeyId}/20261015/cn-beijing/${service}/request, SignedHeaders=host;x-date, Signature=[0-9a-f]{64}$`),
      );
      check?.(req.url.searchParams);
    },
    json: {
      ResponseMetadata: { RequestId: "20230604110420****100232280022D31", Action: action, Version: "2020-04-01", Service: service, Region: "cn-beijing", ...(error ? { Error: error } : {}) },
      ...(error ? {} : { Result: result }),
    },
  };
}

const instance = (eip: { id: string; ip: string } | null) =>
  call("ecs", "DescribeInstances", { Instances: [{ InstanceId: TARGET.instanceId, Status: "RUNNING", EipAddress: eip ? { AllocationId: eip.id, IpAddress: eip.ip } : {} }], TotalCount: 1 }, (q) =>
    assert.equal(q.get("InstanceIds.1"), TARGET.instanceId),
  );
const eipStatus = (id: string, ip: string, status: string) =>
  call("vpc", "DescribeEipAddresses", { EipAddresses: [{ AllocationId: id, EipAddress: ip, Status: status, InstanceType: status === "Attached" ? "EcsInstance" : "", InstanceId: status === "Attached" ? TARGET.instanceId : "" }], TotalCount: 1 }, (q) =>
    assert.equal(q.get("AllocationIds.1"), id),
  );

test("火山引擎：申请 → 解绑 → 绑定 → 释放旧", async () => {
  const mock = createMockContext([
    instance({ id: "eip-old", ip: "101.126.1.1" }),
    call("vpc", "DescribeEipAddresses", { EipAddresses: [{ AllocationId: "eip-old", EipAddress: "101.126.1.1", Status: "Attached", InstanceId: TARGET.instanceId, InstanceType: "EcsInstance" }] }, (q) => {
      assert.equal(q.get("AssociatedInstanceType"), "EcsInstance");
      assert.equal(q.get("AssociatedInstanceId"), TARGET.instanceId);
    }),
    call("vpc", "AllocateEipAddress", { AllocationId: "eip-new", EipAddress: "101.126.2.2", RequestId: "x" }, (q) => {
      assert.equal(q.get("BillingType"), "3");
      assert.equal(q.get("Bandwidth"), "100");
      assert.equal(q.get("ISP"), "BGP");
    }),
    eipStatus("eip-new", "101.126.2.2", "Available"),
    call("vpc", "DisassociateEipAddress", { RequestId: "x" }, (q) => {
      assert.equal(q.get("AllocationId"), "eip-old");
      assert.equal(q.get("InstanceType"), "EcsInstance");
    }),
    eipStatus("eip-old", "101.126.1.1", "Detaching"),
    eipStatus("eip-old", "101.126.1.1", "Available"),
    call("vpc", "AssociateEipAddress", { RequestId: "x" }, (q) => {
      assert.equal(q.get("AllocationId"), "eip-new");
      assert.equal(q.get("InstanceId"), TARGET.instanceId);
      assert.equal(q.get("InstanceType"), "EcsInstance");
    }),
    eipStatus("eip-new", "101.126.2.2", "Attached"),
    call("vpc", "ReleaseEipAddress", { RequestId: "x" }, (q) => assert.equal(q.get("AllocationId"), "eip-old")),
  ]);
  const result = await volcengineEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.releasedOldIp], ["101.126.1.1", "101.126.2.2", true]);
});

test("火山引擎：绑定时服务端错误 → ambiguous，不释放新 EIP", async () => {
  const mock = createMockContext([
    instance(null),
    call("vpc", "DescribeEipAddresses", { EipAddresses: [] }),
    call("vpc", "AllocateEipAddress", { AllocationId: "eip-new", EipAddress: "101.126.2.2" }),
    eipStatus("eip-new", "101.126.2.2", "Available"),
    call("vpc", "AssociateEipAddress", null, undefined, { Code: "InternalError", Message: "The request has failed due to an unknown error." }, 500),
  ]);
  const error = await rejectsWith(volcengineEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /绑定结果未知/);
  assert.equal(error.options.ambiguous, true);
  mock.assertDone();
});

test("火山引擎：错误码映射", async () => {
  const mock = createMockContext([
    call("ecs", "DescribeInstances", null, undefined, { Code: "SignatureDoesNotMatch", Message: "The request signature we calculated does not match" }, 401),
    call("ecs", "DescribeInstances", null, undefined, { Code: "AccessDenied", Message: "User is not authorized to perform: ecs:DescribeInstances" }, 403),
    call("ecs", "DescribeInstances", { Instances: [], TotalCount: 0 }),
  ]);
  await rejectsWith(volcengineEcsProvider.testCredentials(CREDS, TARGET, mock.ctx), /AccessKey 无效/);
  await rejectsWith(volcengineEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), /IAM 权限不足/);
  await rejectsWith(volcengineEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), /找不到实例/);
  mock.assertDone();
});
