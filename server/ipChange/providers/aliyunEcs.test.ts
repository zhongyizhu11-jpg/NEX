import assert from "node:assert/strict";
import test from "node:test";

import { aliyunEcsProvider } from "./aliyunEcs";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const CREDS = { accessKeyId: "LTAI5tExampleKeyId0000", accessKeySecret: "ExampleSecretValue0123456789ab" };
const TARGET = { region: "cn-hangzhou", instanceId: "i-bp67acfmxazb4ph0001" };
const ECS = "ecs.cn-hangzhou.aliyuncs.com";
const VPC = "vpc.cn-hangzhou.aliyuncs.com";

function call(host: string, action: string, json: unknown, check?: (q: URLSearchParams) => void, status = 200): ExpectedCall {
  return {
    method: "GET",
    url: (url) => url.host === host && url.searchParams.get("Action") === action,
    check: (req) => {
      const q = req.url.searchParams;
      assert.equal(q.get("Version"), host.startsWith("ecs") ? "2014-05-26" : "2016-04-28");
      assert.equal(q.get("RegionId"), "cn-hangzhou");
      assert.equal(q.get("AccessKeyId"), CREDS.accessKeyId);
      assert.equal(q.get("SignatureMethod"), "HMAC-SHA1");
      assert.equal(q.get("SignatureVersion"), "1.0");
      assert.equal(q.get("Timestamp"), "2026-10-15T08:00:00Z");
      assert.match(q.get("Signature") || "", /^[A-Za-z0-9+/]{27}=$/);
      assert.ok(!req.url.href.includes(CREDS.accessKeySecret));
      check?.(q);
    },
    status,
    json,
  };
}

const instance = (natIp: string | null, eip: { id: string; ip: string } | null) => ({
  RequestId: "473469C7-AA6F-4DC5-B3DB-A3DC0DE3C83E",
  TotalCount: 1,
  Instances: {
    Instance: [
      {
        InstanceId: TARGET.instanceId,
        Status: "Running",
        InstanceNetworkType: "vpc",
        PublicIpAddress: { IpAddress: natIp ? [natIp] : [] },
        EipAddress: { AllocationId: eip?.id || "", IpAddress: eip?.ip || "", InternetChargeType: "" },
      },
    ],
  },
});
const eips = (...items: Array<{ id: string; ip: string; status: string; instanceId?: string }>) => ({
  RequestId: "4CD5F3A8-7E4C-4E4C-9D4B-EXAMPLE",
  TotalCount: items.length,
  PageNumber: 1,
  PageSize: 10,
  EipAddresses: {
    EipAddress: items.map((item) => ({
      AllocationId: item.id,
      IpAddress: item.ip,
      Status: item.status,
      InstanceId: item.instanceId ?? (item.status === "InUse" ? TARGET.instanceId : ""),
      InstanceType: item.status === "InUse" ? "EcsInstance" : "",
      RegionId: "cn-hangzhou",
      Bandwidth: "100",
      InternetChargeType: "PayByTraffic",
    })),
  },
});
const ok = { RequestId: "0ED8D006-F706-4D23-88ED-E11ED28DCAC0" };

test("阿里云：固定公网 IP 先转 EIP，再换新 EIP 并释放旧的", async () => {
  const mock = createMockContext([
    call(ECS, "DescribeInstances", instance("47.98.1.1", null), (q) => assert.equal(q.get("InstanceIds"), '["i-bp67acfmxazb4ph0001"]')),
    call(ECS, "ConvertNatPublicIpToEip", ok, (q) => assert.equal(q.get("InstanceId"), TARGET.instanceId)),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-old", ip: "47.98.1.1", status: "InUse" }), (q) => {
      assert.equal(q.get("AssociatedInstanceType"), "EcsInstance");
      assert.equal(q.get("AssociatedInstanceId"), TARGET.instanceId);
    }),
    call(VPC, "AllocateEipAddress", { RequestId: "x", AllocationId: "eip-new", EipAddress: "47.99.2.2", ResourceGroupId: "rg-acfm" }, (q) => {
      assert.equal(q.get("Bandwidth"), "100");
      assert.equal(q.get("InternetChargeType"), "PayByTraffic");
      assert.equal(q.get("InstanceChargeType"), "PostPaid");
      assert.ok(q.get("ClientToken"));
    }),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-new", ip: "47.99.2.2", status: "Available" }), (q) => assert.equal(q.get("AllocationId"), "eip-new")),
    call(VPC, "UnassociateEipAddress", ok, (q) => {
      assert.equal(q.get("AllocationId"), "eip-old");
      assert.equal(q.get("InstanceId"), TARGET.instanceId);
      assert.equal(q.get("InstanceType"), "EcsInstance");
    }),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-old", ip: "47.98.1.1", status: "Unassociating" })),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-old", ip: "47.98.1.1", status: "Available" })),
    call(VPC, "AssociateEipAddress", ok, (q) => {
      assert.equal(q.get("AllocationId"), "eip-new");
      assert.equal(q.get("InstanceType"), "EcsInstance");
    }),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-new", ip: "47.99.2.2", status: "InUse" })),
    call(VPC, "ReleaseEipAddress", ok, (q) => assert.equal(q.get("AllocationId"), "eip-old")),
  ]);
  const result = await aliyunEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.equal(result.oldIp, "47.98.1.1");
  assert.equal(result.newIp, "47.99.2.2");
  assert.equal(result.releasedOldIp, true);
  assert.ok(result.notes[0].includes("转换为 EIP"));
});

test("阿里云：绑定失败 → 旧 EIP 绑回去、释放新 EIP", async () => {
  const mock = createMockContext([
    call(ECS, "DescribeInstances", instance(null, { id: "eip-old", ip: "47.98.1.1" })),
    call(VPC, "AllocateEipAddress", { RequestId: "x", AllocationId: "eip-new", EipAddress: "47.99.2.2" }),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-new", ip: "47.99.2.2", status: "Available" })),
    call(VPC, "UnassociateEipAddress", ok),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-old", ip: "47.98.1.1", status: "Available" })),
    call(VPC, "AssociateEipAddress", { RequestId: "x", Code: "IncorrectInstanceStatus", Message: "The current status of the resource does not support this operation." }, undefined, 400),
    call(VPC, "AssociateEipAddress", ok, (q) => assert.equal(q.get("AllocationId"), "eip-old")),
    call(VPC, "DescribeEipAddresses", eips({ id: "eip-old", ip: "47.98.1.1", status: "InUse" })),
    call(VPC, "ReleaseEipAddress", ok, (q) => assert.equal(q.get("AllocationId"), "eip-new")),
  ]);
  const error = await rejectsWith(
    aliyunEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }),
    /IncorrectInstanceStatus.*已把旧 EIP 47\.98\.1\.1 绑回实例；已释放新申请的 EIP 47\.99\.2\.2/,
  );
  assert.equal(error.options.retryable, false);
  mock.assertDone();
});

test("阿里云：错误码映射（凭据 / 限流 / 5xx 的修改请求）", async () => {
  const mock = createMockContext([
    call(ECS, "DescribeInstances", { RequestId: "x", HostId: "ecs.aliyuncs.com", Code: "InvalidAccessKeyId.NotFound", Message: "Specified access key is not found." }, undefined, 404),
    call(ECS, "DescribeInstances", { RequestId: "x", Code: "Throttling.User", Message: "Request was denied due to user flow control." }, undefined, 400),
    call(ECS, "DescribeInstances", instance(null, { id: "eip-old", ip: "47.98.1.1" })),
    call(VPC, "AllocateEipAddress", { RequestId: "x", Code: "InternalError", Message: "The request processing has failed due to some unknown error." }, undefined, 500),
  ]);
  const auth = await rejectsWith(aliyunEcsProvider.testCredentials(CREDS, TARGET, mock.ctx), /AccessKey 无效/);
  assert.equal(auth.options.retryable, false);
  const throttled = await rejectsWith(aliyunEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), /暂时不可用/);
  assert.equal(throttled.options.retryable, true);
  const ambiguous = await rejectsWith(aliyunEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: false }), /可能已经申请了一个新的 EIP/);
  assert.equal(ambiguous.options.ambiguous, true);
  mock.assertDone();
});

test("阿里云：getCurrentIp 优先 EIP，其次固定公网 IP；参数校验", async () => {
  const mock = createMockContext([
    call(ECS, "DescribeInstances", instance(null, { id: "eip-old", ip: "47.98.1.1" })),
    call(ECS, "DescribeInstances", instance("47.98.3.3", null)),
    call(ECS, "DescribeInstances", instance(null, null)),
  ]);
  assert.equal(await aliyunEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), "47.98.1.1");
  assert.equal(await aliyunEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), "47.98.3.3");
  assert.equal(await aliyunEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), null);
  await rejectsWith(aliyunEcsProvider.changeIp(CREDS, { ...TARGET, bandwidth: "abc" }, mock.ctx, { releaseOldIp: false }), /带宽/);
  await rejectsWith(aliyunEcsProvider.changeIp(CREDS, { ...TARGET, internetChargeType: "Free" }, mock.ctx, { releaseOldIp: false }), /计费方式/);
});
