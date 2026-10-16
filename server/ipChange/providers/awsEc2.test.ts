import assert from "node:assert/strict";
import test from "node:test";

import { awsEc2Provider } from "./awsEc2";
import { createMockContext, rejectsWith, type RecordedRequest } from "./testing";

const CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const TARGET = { region: "ap-northeast-1", instanceId: "i-1234567890abcdef0" };
const EC2_URL = "https://ec2.ap-northeast-1.amazonaws.com/";

function describeInstancesXml(publicIp: string | null) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>8f7724cf-496f-496e-8fe3-example</requestId>
  <reservationSet>
    <item>
      <reservationId>r-1234567890abcdef0</reservationId>
      <ownerId>123456789012</ownerId>
      <groupSet/>
      <instancesSet>
        <item>
          <instanceId>i-1234567890abcdef0</instanceId>
          <imageId>ami-bff32ccc</imageId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <privateIpAddress>192.168.1.88</privateIpAddress>
          ${publicIp ? `<ipAddress>${publicIp}</ipAddress>` : ""}
          <networkInterfaceSet>
            <item>
              <networkInterfaceId>eni-0f7db7d5ef2b6a6a1</networkInterfaceId>
              <subnetId>subnet-56f5f633</subnetId>
              <privateIpAddress>192.168.1.88</privateIpAddress>
              <attachment><attachmentId>eni-attach-0326646c0e5e1e5e8</attachmentId><deviceIndex>0</deviceIndex><status>attached</status></attachment>
              ${publicIp ? `<association><publicIp>${publicIp}</publicIp><ipOwnerId>amazon</ipOwnerId></association>` : ""}
              <privateIpAddressesSet><item><privateIpAddress>192.168.1.88</privateIpAddress><primary>true</primary></item></privateIpAddressesSet>
            </item>
          </networkInterfaceSet>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;
}

function describeAddressesXml(items: Array<{ ip: string; alloc: string }>) {
  return `<DescribeAddressesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>f7de5e98-491a-4c19-a92d-908d6EXAMPLE</requestId>
  <addressesSet>
    ${items
      .map(
        (item) => `<item>
      <publicIp>${item.ip}</publicIp>
      <allocationId>${item.alloc}</allocationId>
      <domain>vpc</domain>
      <instanceId>i-1234567890abcdef0</instanceId>
      <associationId>eipassoc-12345678</associationId>
      <networkInterfaceId>eni-0f7db7d5ef2b6a6a1</networkInterfaceId>
      <networkInterfaceOwnerId>123456789012</networkInterfaceOwnerId>
      <privateIpAddress>192.168.1.88</privateIpAddress>
    </item>`,
      )
      .join("")}
  </addressesSet>
</DescribeAddressesResponse>`;
}

const ALLOCATE_XML = `<AllocateAddressResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
   <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
   <publicIp>198.51.100.1</publicIp>
   <domain>vpc</domain>
   <allocationId>eipalloc-5723d13e</allocationId>
</AllocateAddressResponse>`;
const ASSOCIATE_XML = `<AssociateAddressResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
   <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
   <return>true</return>
   <associationId>eipassoc-fc5ca095</associationId>
</AssociateAddressResponse>`;
const RELEASE_XML = `<ReleaseAddressResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
   <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
   <return>true</return>
</ReleaseAddressResponse>`;

function ec2(action: string, check?: (req: RecordedRequest) => void) {
  return (req: RecordedRequest) => {
    assert.equal(req.form.get("Action"), action);
    assert.equal(req.form.get("Version"), "2016-11-15");
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded; charset=utf-8");
    assert.equal(req.headers["x-amz-date"], "20261015T080000Z");
    assert.match(
      req.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261015\/ap-northeast-1\/ec2\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    check?.(req);
  };
}

test("EC2：旧 IP 是弹性 IP，换新并释放旧的", async () => {
  const mock = createMockContext([
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances", (r) => assert.equal(r.form.get("InstanceId.1"), TARGET.instanceId)), text: describeInstancesXml("203.0.113.10") },
    {
      method: "POST",
      url: EC2_URL,
      check: ec2("DescribeAddresses", (r) => {
        assert.equal(r.form.get("Filter.1.Name"), "instance-id");
        assert.equal(r.form.get("Filter.1.Value.1"), TARGET.instanceId);
      }),
      text: describeAddressesXml([{ ip: "203.0.113.10", alloc: "eipalloc-old" }]),
    },
    {
      method: "POST",
      url: EC2_URL,
      check: ec2("AllocateAddress", (r) => {
        assert.equal(r.form.get("Domain"), "vpc");
        assert.equal(r.form.get("TagSpecification.1.ResourceType"), "elastic-ip");
        assert.equal(r.form.get("TagSpecification.1.Tag.1.Value"), "nex-i-1234567890abcdef0");
      }),
      text: ALLOCATE_XML,
    },
    {
      method: "POST",
      url: EC2_URL,
      check: ec2("AssociateAddress", (r) => {
        assert.equal(r.form.get("AllocationId"), "eipalloc-5723d13e");
        assert.equal(r.form.get("NetworkInterfaceId"), "eni-0f7db7d5ef2b6a6a1");
        assert.equal(r.form.get("PrivateIpAddress"), "192.168.1.88");
        assert.equal(r.form.get("AllowReassociation"), "true");
      }),
      text: ASSOCIATE_XML,
    },
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("203.0.113.10") },
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("198.51.100.1") },
    { method: "POST", url: EC2_URL, check: ec2("ReleaseAddress", (r) => assert.equal(r.form.get("AllocationId"), "eipalloc-old")), text: RELEASE_XML },
  ]);
  const result = await awsEc2Provider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.equal(result.oldIp, "203.0.113.10");
  assert.equal(result.newIp, "198.51.100.1");
  assert.equal(result.ipRole, "primary");
  assert.equal(result.releasedOldIp, true);
  assert.deepEqual(mock.sleeps, [5000, 5000]);
});

test("EC2：自动分配的公网 IP，不释放旧 IP 时只记说明", async () => {
  const mock = createMockContext([
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("54.194.252.215") },
    { method: "POST", url: EC2_URL, check: ec2("DescribeAddresses"), text: describeAddressesXml([]) },
    { method: "POST", url: EC2_URL, check: ec2("AllocateAddress"), text: ALLOCATE_XML },
    { method: "POST", url: EC2_URL, check: ec2("AssociateAddress"), text: ASSOCIATE_XML },
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("198.51.100.1") },
  ]);
  const result = await awsEc2Provider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: false });
  mock.assertDone();
  assert.equal(result.oldIp, "54.194.252.215");
  assert.equal(result.releasedOldIp, true);
  assert.ok(result.notes.some((note) => note.includes("被 AWS 回收")));
});

test("EC2：关联失败（4xx）时释放新申请的弹性 IP 再抛错", async () => {
  const mock = createMockContext([
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("54.194.252.215") },
    { method: "POST", url: EC2_URL, check: ec2("DescribeAddresses"), text: describeAddressesXml([]) },
    { method: "POST", url: EC2_URL, check: ec2("AllocateAddress"), text: ALLOCATE_XML },
    {
      method: "POST",
      url: EC2_URL,
      check: ec2("AssociateAddress"),
      status: 400,
      text: `<?xml version="1.0" encoding="UTF-8"?>
<Response><Errors><Error><Code>InvalidInstanceID</Code><Message>The instance ID 'i-1234567890abcdef0' is not in a state from which it can be associated.</Message></Error></Errors><RequestID>ea966190-f9aa-478e-9ede-example</RequestID></Response>`,
    },
    { method: "POST", url: EC2_URL, check: ec2("ReleaseAddress", (r) => assert.equal(r.form.get("AllocationId"), "eipalloc-5723d13e")), text: RELEASE_XML },
  ]);
  const error = await rejectsWith(awsEc2Provider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /已释放新申请的弹性 IP 198\.51\.100\.1/);
  assert.equal(error.options.retryable, false);
  mock.assertDone();
});

test("EC2：关联时 5xx 是 ambiguous，不去释放（可能已关联）", async () => {
  const mock = createMockContext([
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("54.194.252.215") },
    { method: "POST", url: EC2_URL, check: ec2("DescribeAddresses"), text: describeAddressesXml([]) },
    { method: "POST", url: EC2_URL, check: ec2("AllocateAddress"), text: ALLOCATE_XML },
    { method: "POST", url: EC2_URL, check: ec2("AssociateAddress"), status: 500, text: "<Response><Errors><Error><Code>InternalError</Code><Message>An internal error has occurred</Message></Error></Errors></Response>" },
  ]);
  const error = await rejectsWith(awsEc2Provider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /可能已经关联/);
  assert.equal(error.options.ambiguous, true);
  assert.equal(error.options.retryable, true);
  mock.assertDone();
});

test("EC2：AuthFailure → 不可重试，且错误里没有密钥", async () => {
  const mock = createMockContext([
    {
      method: "POST",
      url: EC2_URL,
      status: 401,
      text: `<Response><Errors><Error><Code>AuthFailure</Code><Message>AWS was not able to validate the provided access credentials (wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY)</Message></Error></Errors><RequestID>x</RequestID></Response>`,
    },
  ]);
  const error = await rejectsWith(awsEc2Provider.testCredentials(CREDS, TARGET, mock.ctx), /Access Key 无效/);
  assert.equal(error.options.retryable, false);
  assert.ok(!error.message.includes(CREDS.secretAccessKey));
  assert.match(error.message, /\*\*\*/);
});

test("EC2：getCurrentIp 读 ipAddress；没有公网 IP 时返回 null", async () => {
  const mock = createMockContext([
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml("54.194.252.215") },
    { method: "POST", url: EC2_URL, check: ec2("DescribeInstances"), text: describeInstancesXml(null) },
  ]);
  assert.equal(await awsEc2Provider.getCurrentIp(CREDS, TARGET, mock.ctx), "54.194.252.215");
  assert.equal(await awsEc2Provider.getCurrentIp(CREDS, TARGET, mock.ctx), null);
  mock.assertDone();
});

test("EC2：输入校验", async () => {
  const mock = createMockContext([]);
  await rejectsWith(awsEc2Provider.getCurrentIp(CREDS, { region: "ap-northeast-1", instanceId: "web-1" }, mock.ctx), /实例 ID/);
  await rejectsWith(awsEc2Provider.getCurrentIp(CREDS, { region: "Tokyo!", instanceId: "i-1234567890abcdef0" }, mock.ctx), /地域/);
  await rejectsWith(awsEc2Provider.getCurrentIp({ accessKeyId: "", secretAccessKey: "x" }, TARGET, mock.ctx), /缺少「Access Key ID」/);
});

test("EC2：中国区端点是 amazonaws.com.cn", async () => {
  const mock = createMockContext([
    { method: "POST", url: "https://ec2.cn-north-1.amazonaws.com.cn/", text: describeInstancesXml("52.80.0.1") },
  ]);
  assert.equal(await awsEc2Provider.getCurrentIp(CREDS, { ...TARGET, region: "cn-north-1" }, mock.ctx), "52.80.0.1");
});
