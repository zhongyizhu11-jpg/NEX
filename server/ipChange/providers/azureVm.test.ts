import assert from "node:assert/strict";
import test from "node:test";

import { azureVmProvider } from "./azureVm";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CREDS = { tenantId: TENANT, clientId: "00000000-1111-2222-3333-444444444444", clientSecret: "Abc8Q~exampleClientSecretValue123", subscriptionId: "12345678-1234-1234-1234-123456789012" };
const TARGET = { resourceGroup: "rg-nex", vmName: "vm1" };
const SUB = `/subscriptions/${CREDS.subscriptionId}/resourceGroups/rg-nex`;
const ARM = "https://management.azure.com";
const NIC_ID = `${SUB}/providers/Microsoft.Network/networkInterfaces/vm1-nic`;
const OLD_PIP = `${SUB}/providers/Microsoft.Network/publicIPAddresses/vm1-ip`;

const tokenCall: ExpectedCall = {
  method: "POST",
  url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  check: (req) => {
    assert.equal(req.form.get("grant_type"), "client_credentials");
    assert.equal(req.form.get("scope"), "https://management.azure.com/.default");
    assert.equal(req.form.get("client_id"), CREDS.clientId);
    assert.equal(req.form.get("client_secret"), CREDS.clientSecret);
  },
  json: { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: "eyJ0eXAiOiJKV1QiEXAMPLE" },
};
function api(method: string, url: ExpectedCall["url"], json: unknown, extra: Partial<ExpectedCall> = {}): ExpectedCall {
  return {
    method,
    url,
    json,
    ...extra,
    check: (req) => {
      assert.equal(req.headers.authorization, "Bearer eyJ0eXAiOiJKV1QiEXAMPLE");
      extra.check?.(req);
    },
  };
}
const vm = { name: "vm1", location: "japaneast", properties: { networkProfile: { networkInterfaces: [{ id: NIC_ID, properties: { primary: true } }] } } };
const nic = (pipId: string) => ({
  name: "vm1-nic",
  id: NIC_ID,
  etag: 'W/"00000000-0000-0000-0000-000000000000"',
  location: "japaneast",
  properties: {
    provisioningState: "Succeeded",
    ipConfigurations: [{ name: "ipconfig1", id: `${NIC_ID}/ipConfigurations/ipconfig1`, properties: { primary: true, privateIPAddress: "10.0.0.4", privateIPAllocationMethod: "Dynamic", subnet: { id: `${SUB}/providers/Microsoft.Network/virtualNetworks/vnet/subnets/default` }, publicIPAddress: { id: pipId } } }],
    networkSecurityGroup: { id: `${SUB}/providers/Microsoft.Network/networkSecurityGroups/vm1-nsg` },
  },
});
const pip = (name: string, ip: string, sku = "Standard") => ({
  name,
  id: `${SUB}/providers/Microsoft.Network/publicIPAddresses/${name}`,
  location: "japaneast",
  sku: { name: sku, tier: "Regional" },
  zones: ["1"],
  properties: { provisioningState: "Succeeded", ipAddress: ip, publicIPAddressVersion: "IPv4", publicIPAllocationMethod: "Static" },
});
const locateCalls = (pipId: string, pipBody: unknown): ExpectedCall[] => [
  api("GET", `${ARM}${SUB}/providers/Microsoft.Compute/virtualMachines/vm1?api-version=2024-07-01`, vm),
  api("GET", `${ARM}${NIC_ID}?api-version=2024-05-01`, nic(pipId)),
  api("GET", `${ARM}${pipId}?api-version=2024-05-01`, pipBody),
];
const asyncOp = "https://management.azure.com/subscriptions/x/providers/Microsoft.Network/locations/japaneast/operations/op-1?api-version=2024-05-01";
const NEW_URL = (u: URL) => u.pathname.startsWith(`${SUB}/providers/Microsoft.Network/publicIPAddresses/nex-vm1-20261015-080000-`) && u.searchParams.get("api-version") === "2024-05-01";

test("Azure：新建 Standard 公共 IP、改网卡、删除旧 IP", async () => {
  let newPath = "";
  const mock = createMockContext([
    tokenCall,
    ...locateCalls(OLD_PIP, pip("vm1-ip", "20.1.1.1", "Basic")),
    api("PUT", NEW_URL, { name: "new", properties: { provisioningState: "Updating" } }, {
      status: 201,
      headers: { "Azure-AsyncOperation": asyncOp },
      check: (req) => {
        newPath = req.url.pathname;
        assert.deepEqual(req.json, {
          location: "japaneast",
          sku: { name: "Standard", tier: "Regional" },
          zones: ["1"],
          properties: { publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4" },
          tags: { "created-by": "nex-ip-change" },
        });
      },
    }),
    api("GET", asyncOp, { status: "InProgress" }),
    api("GET", asyncOp, { status: "Succeeded" }),
    api("GET", NEW_URL, pip("nex", "20.2.2.2")),
    api("PUT", `${ARM}${NIC_ID}?api-version=2024-05-01`, nic("x"), {
      headers: { "Azure-AsyncOperation": asyncOp },
      check: (req) => {
        assert.equal(req.json.properties.ipConfigurations[0].properties.publicIPAddress.id, newPath);
        assert.equal(req.json.properties.networkSecurityGroup.id.endsWith("vm1-nsg"), true);
      },
    }),
    api("GET", asyncOp, { status: "Succeeded" }),
    api("GET", `${ARM}${SUB}/providers/Microsoft.Compute/virtualMachines/vm1?api-version=2024-07-01`, vm),
    api("GET", `${ARM}${NIC_ID}?api-version=2024-05-01`, undefined, { reply: () => nic(newPath) }),
    api("GET", NEW_URL, pip("nex", "20.2.2.2")),
    api("DELETE", `${ARM}${OLD_PIP}?api-version=2024-05-01`, null, { status: 202, headers: { Location: asyncOp } }),
    api("GET", asyncOp, null, { status: 202 }),
    api("GET", asyncOp, null, { status: 200 }),
  ]);
  const result = await azureVmProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.releasedOldIp], ["20.1.1.1", "20.2.2.2", true]);
  assert.ok(result.notes.some((note) => note.includes("NSG")));
});

test("Azure：网卡更新失败 → 删除新建的公共 IP", async () => {
  const mock = createMockContext([
    tokenCall,
    ...locateCalls(OLD_PIP, pip("vm1-ip", "20.1.1.1")),
    api("PUT", NEW_URL, pip("nex", "20.2.2.2"), { status: 200 }),
    api("GET", NEW_URL, pip("nex", "20.2.2.2")),
    api("PUT", `${ARM}${NIC_ID}?api-version=2024-05-01`, { error: { code: "PublicIPAndLBSkuDoNotMatch", message: "Standard sku load balancer and public IP resources are not allowed to be mixed with basic" } }, { status: 400 }),
    api("DELETE", NEW_URL, null, { status: 200 }),
  ]);
  await rejectsWith(azureVmProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /PublicIPAndLBSkuDoNotMatch.*已删除新建的公共 IP/);
  mock.assertDone();
});

test("Azure：登录失败 / 403 / 不跟随非 ARM 的异步地址", async () => {
  const mock = createMockContext([
    { method: "POST", url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, status: 401, json: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x" } },
    tokenCall,
    api("GET", `${ARM}${SUB}/providers/Microsoft.Compute/virtualMachines/vm1?api-version=2024-07-01`, { error: { code: "AuthorizationFailed", message: "does not have authorization to perform action" } }, { status: 403 }),
  ]);
  const login = await rejectsWith(azureVmProvider.testCredentials(CREDS, TARGET, mock.ctx), /客户端密码不正确.*AADSTS7000215/);
  assert.ok(!login.message.includes(CREDS.clientSecret));
  await rejectsWith(azureVmProvider.getCurrentIp(CREDS, TARGET, mock.ctx), /权限不足/);
  mock.assertDone();
});
