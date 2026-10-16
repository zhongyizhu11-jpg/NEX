import assert from "node:assert/strict";
import test from "node:test";

import { hetznerProvider } from "./hetzner";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

const CREDS = { token: "jEheVytlAoFl7F8MqUQ7jAo2hOXASztX6Bf1yAjkWzEinW4qhKd5ZcmJxBjoUeF8" };
const TARGET = { serverId: "42" };
const API = "https://api.hetzner.cloud/v1";

function call(method: string, url: string, json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return { method, url, status, json, check: (req) => { assert.equal(req.headers.authorization, `Bearer ${CREDS.token}`); check?.(req.json); } };
}
const server = (status: string, ip: string | null, id: number | null = 4711) =>
  call("GET", `${API}/servers/42`, { server: { id: 42, name: "my-server", status, public_net: { ipv4: ip ? { id, ip, blocked: false, dns_ptr: "server01.example.com" } : null, ipv6: null, floating_ips: [] } } });
const action = (id: number, command: string, status = "running") => ({ action: { id, command, status, progress: 0, started: "2026-10-15T08:00:00Z", finished: null, resources: [{ id: 42, type: "server" }], error: null } });

test("Hetzner：关机 → 解除 → 新建分配 → 删除旧 → 开机", async () => {
  const mock = createMockContext([
    server("running", "1.2.3.4"),
    call("GET", `${API}/primary_ips/4711`, { primary_ip: { id: 4711, name: "my-ip", ip: "1.2.3.4", type: "ipv4", auto_delete: true, assignee_type: "server", assignee_id: 42, protection: { delete: false }, blocked: false } }),
    call("POST", `${API}/servers/42/actions/shutdown`, action(1, "shutdown_server"), undefined, 201),
    server("stopping", "1.2.3.4"),
    server("off", "1.2.3.4"),
    call("POST", `${API}/primary_ips/4711/actions/unassign`, action(2, "unassign_primary_ip"), undefined, 201),
    call("GET", `${API}/actions/2`, { action: { ...action(2, "unassign_primary_ip").action, status: "success" } }),
    call("POST", `${API}/primary_ips`, { primary_ip: { id: 5000, name: "nex", ip: "5.6.7.8", type: "ipv4", auto_delete: true, assignee_type: "server", assignee_id: 42 }, action: action(3, "assign_primary_ip").action }, (body) => {
      assert.equal(body.type, "ipv4");
      assert.equal(body.assignee_type, "server");
      assert.equal(body.assignee_id, 42);
      assert.equal(body.auto_delete, true);
      assert.match(body.name, /^nex-42-/);
      assert.equal(body.location, undefined);
    }, 201),
    call("GET", `${API}/actions/3`, { action: { ...action(3, "assign_primary_ip").action, status: "success" } }),
    { method: "DELETE", url: `${API}/primary_ips/4711`, status: 204 },
    call("POST", `${API}/servers/42/actions/poweron`, action(4, "start_server"), undefined, 201),
    call("GET", `${API}/actions/4`, { action: { ...action(4, "start_server").action, status: "success" } }),
    server("running", "5.6.7.8", 5000),
  ]);
  const result = await hetznerProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.releasedOldIp], ["1.2.3.4", "5.6.7.8", true]);
});

test("Hetzner：ACPI 关机超时改断电；新建失败时分配回旧 IP 并开机", async () => {
  const offPolls: ExpectedCall[] = Array.from({ length: 18 }, () => server("running", "1.2.3.4"));
  const mock = createMockContext([
    server("running", "1.2.3.4"),
    call("GET", `${API}/primary_ips/4711`, { primary_ip: { id: 4711, ip: "1.2.3.4", auto_delete: false, protection: { delete: false } } }),
    call("POST", `${API}/servers/42/actions/shutdown`, action(1, "shutdown_server"), undefined, 201),
    ...offPolls,
    call("POST", `${API}/servers/42/actions/poweroff`, { action: { ...action(5, "stop_server").action, status: "success" } }, undefined, 201),
    server("off", "1.2.3.4"),
    call("POST", `${API}/primary_ips/4711/actions/unassign`, { action: { ...action(2, "unassign_primary_ip").action, status: "success" } }, undefined, 201),
    call("POST", `${API}/primary_ips`, { error: { code: "resource_limit_exceeded", message: "primary_ip limit exceeded", details: {} } }, undefined, 403),
    call("POST", `${API}/primary_ips/4711/actions/assign`, { action: { ...action(6, "assign_primary_ip").action, status: "success" } }, (body) => assert.deepEqual(body, { assignee_type: "server", assignee_id: 42 }), 201),
    call("POST", `${API}/servers/42/actions/poweron`, { action: { ...action(7, "start_server").action, status: "success" } }, undefined, 201),
  ]);
  await rejectsWith(hetznerProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /resource_limit_exceeded.*已把旧 IP 1\.2\.3\.4 分配回服务器；服务器已重新开机/);
  mock.assertDone();
});

test("Hetzner：401 / 删除保护", async () => {
  const mock = createMockContext([call("GET", `${API}/servers/42`, { error: { code: "unauthorized", message: "unable to authenticate" } }, undefined, 401)]);
  await rejectsWith(hetznerProvider.testCredentials(CREDS, TARGET, mock.ctx), /API Token 无效/);

  const off = createMockContext([
    server("off", "1.2.3.4"),
    call("GET", `${API}/primary_ips/4711`, { primary_ip: { id: 4711, ip: "1.2.3.4", auto_delete: false, protection: { delete: true } } }),
    call("POST", `${API}/primary_ips/4711/actions/unassign`, { action: { ...action(2, "unassign_primary_ip").action, status: "success" } }, undefined, 201),
    call("POST", `${API}/primary_ips`, { primary_ip: { id: 5000, ip: "5.6.7.8" }, action: { ...action(3, "assign_primary_ip").action, status: "success" } }, undefined, 201),
    server("off", "5.6.7.8", 5000),
  ]);
  const result = await hetznerProvider.changeIp(CREDS, TARGET, off.ctx, { releaseOldIp: true });
  off.assertDone();
  assert.equal(result.releasedOldIp, false);
  assert.ok(result.notes.some((note) => note.includes("删除保护")));
});
