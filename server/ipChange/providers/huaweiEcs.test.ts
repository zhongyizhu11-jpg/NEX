import assert from "node:assert/strict";
import test from "node:test";

import { huaweiEcsProvider } from "./huaweiEcs";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const CREDS = { accessKey: "QTWAOYTTINDUT2QVKYUC", secretKey: "MFyfvK41ba2giqM7Uio6PznpdUKGpownRZlmVmHc" };
const PROJECT = "77b6a44cba5143ab91d13ab9a8ff44fd";
const SERVER = "ae1e4a3d-2c4b-4a8e-9a3b-3f0e5c1d2b11";
const PORT = "f588ccfa-8750-4d7c-bf5d-2ede24414706";
const TARGET = { region: "cn-north-4", projectId: PROJECT, instanceId: SERVER };
const VPC = `https://vpc.cn-north-4.myhuaweicloud.com/v1/${PROJECT}/publicips`;

function call(method: string, url: string, json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return {
    method,
    url,
    status,
    json,
    check: (req) => {
      assert.equal(req.headers["x-sdk-date"], "20261015T080000Z");
      assert.equal(req.headers["content-type"], "application/json");
      assert.match(req.headers.authorization, /^SDK-HMAC-SHA256 Access=QTWAOYTTINDUT2QVKYUC, SignedHeaders=content-type;host;x-sdk-date, Signature=[0-9a-f]{64}$/);
      check?.(req.json);
    },
  };
}

const server = (floating: string | null) => ({
  server: {
    id: SERVER,
    name: "ecs-nex",
    status: "ACTIVE",
    addresses: {
      "68269e6e-4df1-a1b6-7cb4-1e8f3b2f7a01": [
        { version: "4", addr: "192.168.0.80", "OS-EXT-IPS:type": "fixed", "OS-EXT-IPS-MAC:mac_addr": "fa:16:3e:0d:36:b1", "OS-EXT-IPS:port_id": PORT },
        ...(floating ? [{ version: "4", addr: floating, "OS-EXT-IPS:type": "floating", "OS-EXT-IPS-MAC:mac_addr": "fa:16:3e:0d:36:b1", "OS-EXT-IPS:port_id": PORT }] : []),
      ],
    },
  },
});
const pip = (id: string, ip: string, status: string, portId?: string) => ({
  publicip: {
    id,
    status,
    type: "5_bgp",
    public_ip_address: ip,
    tenant_id: "8b7e35ad379141fc9df3e178bd64f55c",
    create_time: "2026-10-15 08:00:00",
    bandwidth_size: 100,
    ip_version: 4,
    bandwidth_share_type: "PER",
    ...(portId ? { port_id: portId, private_ip_address: "192.168.0.80" } : {}),
  },
});

test("华为云：申请 → 解绑旧 → 绑新 → 删除旧", async () => {
  const mock = createMockContext([
    call("GET", `https://ecs.cn-north-4.myhuaweicloud.com/v1/${PROJECT}/cloudservers/${SERVER}`, server("161.17.1.7")),
    call("GET", `${VPC}?port_id=${PORT}`, { publicips: [pip("eip-old-0000", "161.17.1.7", "ACTIVE", PORT).publicip] }),
    call("POST", VPC, pip("eip-new-0000", "161.17.2.9", "PENDING_CREATE"), (body) => {
      assert.deepEqual(body.publicip.type, "5_bgp");
      assert.equal(body.publicip.ip_version, 4);
      assert.deepEqual({ ...body.bandwidth, name: "x" }, { name: "x", size: 100, share_type: "PER", charge_mode: "traffic" });
      assert.match(body.bandwidth.name, /^nex-/);
    }),
    call("GET", `${VPC}/eip-new-0000`, pip("eip-new-0000", "161.17.2.9", "PENDING_CREATE")),
    call("GET", `${VPC}/eip-new-0000`, pip("eip-new-0000", "161.17.2.9", "DOWN")),
    call("PUT", `${VPC}/eip-old-0000`, pip("eip-old-0000", "161.17.1.7", "PENDING_UPDATE"), (body) => assert.deepEqual(body, { publicip: { port_id: "" } })),
    call("GET", `${VPC}/eip-old-0000`, pip("eip-old-0000", "161.17.1.7", "DOWN")),
    call("PUT", `${VPC}/eip-new-0000`, pip("eip-new-0000", "161.17.2.9", "PENDING_UPDATE", PORT), (body) => assert.deepEqual(body, { publicip: { port_id: PORT } })),
    call("GET", `${VPC}/eip-new-0000`, pip("eip-new-0000", "161.17.2.9", "ACTIVE", PORT)),
    { method: "DELETE", url: `${VPC}/eip-old-0000`, status: 204 },
  ]);
  const result = await huaweiEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.releasedOldIp], ["161.17.1.7", "161.17.2.9", true]);
});

test("华为云：没有 EIP 的实例直接绑新 EIP；绑定状态 ERROR → 释放新 EIP", async () => {
  const mock = createMockContext([
    call("GET", `https://ecs.cn-north-4.myhuaweicloud.com/v1/${PROJECT}/cloudservers/${SERVER}`, server(null)),
    call("GET", `${VPC}?port_id=${PORT}`, { publicips: [] }),
    call("POST", VPC, pip("eip-new-0000", "161.17.2.9", "PENDING_CREATE")),
    call("GET", `${VPC}/eip-new-0000`, pip("eip-new-0000", "161.17.2.9", "DOWN")),
    call("PUT", `${VPC}/eip-new-0000`, { error_code: "VPC.0504", error_msg: "port already bound with floating ip" }, undefined, 400),
    { method: "DELETE", url: `${VPC}/eip-new-0000`, status: 204 },
  ]);
  const error = await rejectsWith(huaweiEcsProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /VPC\.0504.*已释放新申请的 EIP 161\.17\.2\.9/);
  assert.equal(error.options.retryable, false);
  mock.assertDone();
});

test("华为云：401 / 404 / 校验", async () => {
  const mock = createMockContext([
    call("GET", `https://ecs.cn-north-4.myhuaweicloud.com/v1/${PROJECT}/cloudservers/${SERVER}`, { error_msg: "Incorrect IAM authentication information: verify aksk signature fail", error_code: "APIGW.0301", request_id: "x" }, undefined, 401),
    call("GET", `https://ecs.cn-north-4.myhuaweicloud.com/v1/${PROJECT}/cloudservers/${SERVER}`, { error: { code: "Ecs.0114", message: "Instance does not exist" } }, undefined, 404),
    call("GET", `https://ecs.cn-north-4.myhuaweicloud.com/v1/${PROJECT}/cloudservers/${SERVER}`, server("161.17.1.7")),
  ]);
  await rejectsWith(huaweiEcsProvider.testCredentials(CREDS, TARGET, mock.ctx), /AK \/ SK 无效.*APIGW\.0301/);
  await rejectsWith(huaweiEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), /找不到云服务器/);
  assert.equal(await huaweiEcsProvider.getCurrentIp(CREDS, TARGET, mock.ctx), "161.17.1.7");
  await rejectsWith(huaweiEcsProvider.getCurrentIp(CREDS, { ...TARGET, projectId: "abc" }, mock.ctx), /项目 ID/);
  mock.assertDone();
});
