import assert from "node:assert/strict";
import test from "node:test";

import { awsSbProvider } from "./awsSb";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const CREDS = { authToken: "sb_token_0123456789abcdef", shareGroupToken: "" };
const EC2 = { instanceType: "ec2", accountId: "acc123", region: "ap-northeast-1", instanceId: "i-0123456789abcdef0", static: "yes" };
const LS = { instanceType: "lightsail", accountId: "acc123", region: "ap-northeast-1", instanceId: "Ubuntu-1" };

function call(method: string, url: string, json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return {
    method,
    url,
    status,
    json,
    check: (req) => {
      assert.equal(req.headers["x-auth-token"], CREDS.authToken);
      assert.equal(req.headers["x-account-id"], "acc123");
      assert.equal(req.headers["x-region-name"], "ap-northeast-1");
      check?.(req.json);
    },
  };
}

test("aws.sb EC2：PATCH ip-address → 轮询任务和实例直到 IP 变化", async () => {
  const mock = createMockContext([
    call("GET", "https://api.aws.sb/ec2-instances/i-0123456789abcdef0", { instanceId: "i-0123456789abcdef0", ipAddress: "13.1.1.1", state: "running" }),
    call("PATCH", "https://api.aws.sb/ec2-instances/i-0123456789abcdef0/ip-address", { tag: "task-abc", status: "pending" }, (body) => assert.deepEqual(body, { static: true, gfw_blocked_check: false })),
    call("POST", "https://api.aws.sb/filter-tasks", [{ tag: "task-abc", status: "running" }], (body) => assert.deepEqual(body, { tags: ["task-abc"] })),
    call("GET", "https://api.aws.sb/ec2-instances/i-0123456789abcdef0", { ipAddress: "13.1.1.1" }),
    call("POST", "https://api.aws.sb/filter-tasks", [{ tag: "task-abc", status: "finished" }]),
    call("GET", "https://api.aws.sb/ec2-instances/i-0123456789abcdef0", { ipAddress: "13.2.2.2" }),
  ]);
  const result = await awsSbProvider.changeIp(CREDS, EC2, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.ipRole, result.releasedOldIp], ["13.1.1.1", "13.2.2.2", "primary", false]);
  assert.equal(mock.requests[0].headers["x-share-group-token"], undefined);
});

test("aws.sb Lightsail：任务 error 立即失败；共享组令牌带上", async () => {
  const mock = createMockContext([
    call("GET", "https://api.aws.sb/lightsail-instances/Ubuntu-1", { name: "Ubuntu-1", ip_address: "3.1.1.1" }),
    call("PATCH", "https://api.aws.sb/lightsail-instances/Ubuntu-1/ip-address", { tag: "t1", status: "pending" }, (body) => assert.deepEqual(body, { static: false })),
    call("POST", "https://api.aws.sb/filter-tasks", [{ tag: "t1", status: "error", message: "OperationFailureException" }]),
  ]);
  await rejectsWith(awsSbProvider.changeIp({ ...CREDS, shareGroupToken: "share-token-xyz" }, LS, mock.ctx, { releaseOldIp: false }), /任务失败.*OperationFailureException/);
  assert.equal(mock.requests[0].headers["x-share-group-token"], "share-token-xyz");
  mock.assertDone();
});

test("aws.sb：任务完成但 60 秒后 IP 未变 → 失败；401", async () => {
  const unchanged: ExpectedCall[] = Array.from({ length: 13 }, () => call("GET", "https://api.aws.sb/lightsail-instances/Ubuntu-1", { ip_address: "3.1.1.1" }));
  const mock = createMockContext([
    call("GET", "https://api.aws.sb/lightsail-instances/Ubuntu-1", { ip_address: "3.1.1.1" }),
    call("PATCH", "https://api.aws.sb/lightsail-instances/Ubuntu-1/ip-address", { tag: "t2", status: "pending" }),
    call("POST", "https://api.aws.sb/filter-tasks", { data: [{ tag: "t2", status: "finished" }] }),
    ...unchanged,
  ]);
  const error = await rejectsWith(awsSbProvider.changeIp(CREDS, LS, mock.ctx, { releaseOldIp: false }), /60 秒后实例 IP 仍是 3\.1\.1\.1/);
  assert.equal(error.options.ambiguous, true);
  mock.assertDone();

  const denied = createMockContext([call("GET", "https://api.aws.sb/ec2-instances/i-0123456789abcdef0", { detail: "Invalid token" }, undefined, 401)]);
  await rejectsWith(awsSbProvider.testCredentials(CREDS, EC2, denied.ctx), /令牌无效.*Invalid token/);
  await rejectsWith(awsSbProvider.getCurrentIp(CREDS, { ...EC2, instanceType: "" }, denied.ctx), /实例类型/);
});
