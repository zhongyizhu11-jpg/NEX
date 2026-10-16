import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { gcpGceProvider } from "./gcpGce";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY = JSON.stringify({
  type: "service_account",
  project_id: "nex-demo-123",
  private_key_id: "0123456789abcdef0123456789abcdef01234567",
  private_key: PEM,
  client_email: "ipchanger@nex-demo-123.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  token_uri: "https://oauth2.googleapis.com/token",
});
const CREDS = { serviceAccountKey: KEY };
const TARGET = { zone: "asia-east1-b", instanceName: "instance-1" };
const BASE = "https://compute.googleapis.com/compute/v1/projects/nex-demo-123";
const INSTANCE = `${BASE}/zones/asia-east1-b/instances/instance-1`;

const tokenCall: ExpectedCall = {
  method: "POST",
  url: "https://oauth2.googleapis.com/token",
  check: (req) => {
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(req.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(Buffer.from(String(req.form.get("assertion")).split(".")[1], "base64url").toString());
    assert.equal(claims.iss, "ipchanger@nex-demo-123.iam.gserviceaccount.com");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/compute");
    assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  },
  json: { access_token: "ya29.c.EXAMPLE-TOKEN", expires_in: 3599, token_type: "Bearer" },
};

function api(method: string, url: string, json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return {
    method,
    url,
    status,
    json,
    check: (req) => {
      assert.equal(req.headers.authorization, "Bearer ya29.c.EXAMPLE-TOKEN");
      check?.(req.json);
    },
  };
}

const instance = (natIP: string | null) => ({
  kind: "compute#instance",
  id: "1234567890123456789",
  name: "instance-1",
  status: "RUNNING",
  networkInterfaces: [
    {
      kind: "compute#networkInterface",
      name: "nic0",
      network: `${BASE}/global/networks/default`,
      networkIP: "10.140.0.2",
      accessConfigs: natIP ? [{ kind: "compute#accessConfig", type: "ONE_TO_ONE_NAT", name: "External NAT", natIP, networkTier: "PREMIUM" }] : [],
    },
  ],
});
const op = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  kind: "compute#operation",
  id: "777",
  name,
  zone: `${BASE}/zones/asia-east1-b`,
  operationType: "deleteAccessConfig",
  status,
  progress: status === "DONE" ? 100 : 0,
  ...extra,
});

test("GCE：删除并重建访问配置，旧静态地址按要求释放", async () => {
  const mock = createMockContext([
    tokenCall,
    api("GET", INSTANCE, instance("34.80.1.1")),
    {
      method: "GET",
      url: (url) => url.pathname === "/compute/v1/projects/nex-demo-123/regions/asia-east1/addresses" && url.searchParams.get("filter") === 'address="34.80.1.1"',
      json: { kind: "compute#addressList", items: [{ kind: "compute#address", name: "my-static", address: "34.80.1.1", status: "IN_USE", addressType: "EXTERNAL", region: `${BASE}/regions/asia-east1` }] },
    },
    {
      method: "POST",
      url: (url) =>
        url.href.startsWith(`${INSTANCE}/deleteAccessConfig?`) && url.searchParams.get("accessConfig") === "External NAT" && url.searchParams.get("networkInterface") === "nic0",
      json: op("operation-del", "RUNNING"),
    },
    api("GET", `${BASE}/zones/asia-east1-b/operations/operation-del`, op("operation-del", "RUNNING")),
    api("GET", `${BASE}/zones/asia-east1-b/operations/operation-del`, op("operation-del", "DONE")),
    api("POST", `${INSTANCE}/addAccessConfig?networkInterface=nic0`, op("operation-add", "DONE"), (body) =>
      assert.deepEqual(body, { kind: "compute#accessConfig", type: "ONE_TO_ONE_NAT", name: "External NAT", networkTier: "PREMIUM" }),
    ),
    api("GET", INSTANCE, instance("35.201.2.2")),
    api("DELETE", `${BASE}/regions/asia-east1/addresses/my-static`, op("operation-addr", "PENDING")),
    api("GET", `${BASE}/regions/asia-east1/operations/operation-addr`, op("operation-addr", "DONE")),
  ]);
  const result = await gcpGceProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.releasedOldIp], ["34.80.1.1", "35.201.2.2", true]);
});

test("GCE：添加访问配置的 operation 报错 → 抛错并说明实例没有外部 IP", async () => {
  const mock = createMockContext([
    tokenCall,
    api("GET", INSTANCE, instance("34.80.1.1")),
    api("GET", (`${BASE}/regions/asia-east1/addresses?filter=` + encodeURIComponent('address="34.80.1.1"')), { kind: "compute#addressList" }),
    { method: "POST", url: /deleteAccessConfig/, json: op("operation-del", "DONE") },
    api("POST", `${INSTANCE}/addAccessConfig?networkInterface=nic0`, op("operation-add", "DONE", { error: { errors: [{ code: "IP_SPACE_EXHAUSTED", message: "No more external IP addresses available" }] } })),
  ]);
  const error = await rejectsWith(gcpGceProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /IP_SPACE_EXHAUSTED.*实例现在没有外部 IP/);
  assert.equal(error.options.retryable, false);
  mock.assertDone();
});

test("GCE：token 失败 / 403 / 密钥格式", async () => {
  const mock = createMockContext([
    { method: "POST", url: "https://oauth2.googleapis.com/token", status: 400, json: { error: "invalid_grant", error_description: "Invalid JWT Signature." } },
    tokenCall,
    api("GET", INSTANCE, { error: { code: 403, message: "Compute Engine API has not been used in project nex-demo-123", errors: [{ reason: "accessNotConfigured" }], status: "PERMISSION_DENIED" } }, undefined, 403),
    tokenCall,
    api("GET", INSTANCE, instance(null)),
  ]);
  await rejectsWith(gcpGceProvider.testCredentials(CREDS, TARGET, mock.ctx), /服务账号密钥无效.*invalid_grant/);
  await rejectsWith(gcpGceProvider.getCurrentIp(CREDS, TARGET, mock.ctx), /未启用 Compute Engine API/);
  assert.equal(await gcpGceProvider.getCurrentIp(CREDS, TARGET, mock.ctx), null);
  const bad = await rejectsWith(gcpGceProvider.getCurrentIp({ serviceAccountKey: "{oops" }, TARGET, mock.ctx), /不是合法的 JSON/);
  assert.ok(!bad.message.includes("PRIVATE KEY"));
  mock.assertDone();
});
