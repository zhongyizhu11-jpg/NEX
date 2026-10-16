import assert from "node:assert/strict";
import test from "node:test";

import { vultrProvider } from "./vultr";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const CREDS = { apiKey: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" };
const ID = "cb676a46-66fd-4dfb-b839-443f2e6c0b60";
const TARGET = { instanceId: ID };
const API = "https://api.vultr.com/v2";

function call(method: string, url: string, json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return { method, url, status, json, check: (req) => { assert.equal(req.headers.authorization, `Bearer ${CREDS.apiKey}`); check?.(req.json); } };
}
const instance = call("GET", `${API}/instances/${ID}`, { instance: { id: ID, os: "Ubuntu 24.04 x64", main_ip: "149.28.1.1", region: "nrt", status: "active", power_status: "running", v6_main_ip: "" } });
const reserved = (id: string, subnet: string, instanceId = "") => ({ id, region: "nrt", ip_type: "v4", subnet, subnet_size: 32, label: "x", instance_id: instanceId });

test("Vultr：创建 → 卸下旧附加 IP → 挂新 → 删除旧 → 重启", async () => {
  const mock = createMockContext([
    instance,
    call("GET", `${API}/reserved-ips?per_page=500`, { reserved_ips: [reserved("old-1", "45.76.2.2", ID)], meta: { total: 1, links: { next: "", prev: "" } } }),
    call("POST", `${API}/reserved-ips`, { reserved_ip: reserved("new-1", "45.76.3.3") }, (body) => {
      assert.equal(body.region, "nrt");
      assert.equal(body.ip_type, "v4");
      assert.match(body.label, /^nex-/);
    }, 201),
    { method: "POST", url: `${API}/reserved-ips/old-1/detach`, status: 204 },
    { method: "POST", url: `${API}/reserved-ips/new-1/attach`, status: 204, check: (req) => assert.deepEqual(req.json, { instance_id: ID }) },
    call("GET", `${API}/reserved-ips/new-1`, { reserved_ip: reserved("new-1", "45.76.3.3", ID) }),
    { method: "DELETE", url: `${API}/reserved-ips/old-1`, status: 204 },
    { method: "POST", url: `${API}/instances/${ID}/reboot`, status: 204 },
  ]);
  const result = await vultrProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.ipRole, result.releasedOldIp], ["45.76.2.2", "45.76.3.3", "entry", true]);
});

test("Vultr：主 IP 本身是保留 IP 时不卸它；挂载失败删除新 IP；不重启", async () => {
  const mock = createMockContext([
    instance,
    call("GET", `${API}/reserved-ips?per_page=500`, { reserved_ips: [reserved("main-1", "149.28.1.1", ID)], meta: { links: { next: "" } } }),
    call("POST", `${API}/reserved-ips`, { reserved_ip: reserved("new-1", "45.76.3.3") }, undefined, 201),
    call("POST", `${API}/reserved-ips/new-1/attach`, { error: "Unable to attach reserved IP: instance is locked", status: 400 }, undefined, 400),
    { method: "DELETE", url: `${API}/reserved-ips/new-1`, status: 204 },
  ]);
  await rejectsWith(vultrProvider.changeIp(CREDS, { ...TARGET, reboot: "no" }, mock.ctx, { releaseOldIp: true }), /instance is locked.*已删除新建的保留 IP 45\.76\.3\.3/);
  mock.assertDone();
});

test("Vultr：getCurrentIp 优先附加保留 IP；401 提示白名单", async () => {
  const mock = createMockContext([
    instance,
    call("GET", `${API}/reserved-ips?per_page=500`, { reserved_ips: [reserved("x", "45.76.9.9", "other")], meta: { links: { next: "c2" } } }),
    call("GET", `${API}/reserved-ips?per_page=500&cursor=c2`, { reserved_ips: [reserved("y", "45.76.2.2", ID)], meta: { links: { next: "" } } }),
    call("GET", `${API}/instances/${ID}`, { error: "Invalid API token.", status: 401 }, undefined, 401),
  ]);
  assert.equal(await vultrProvider.getCurrentIp(CREDS, TARGET, mock.ctx), "45.76.2.2");
  await rejectsWith(vultrProvider.testCredentials(CREDS, TARGET, mock.ctx), /白名单/);
  mock.assertDone();
});
