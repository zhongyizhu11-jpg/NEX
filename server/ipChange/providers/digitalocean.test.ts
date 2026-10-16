import assert from "node:assert/strict";
import test from "node:test";

import { digitaloceanProvider } from "./digitalocean";
import { createMockContext, rejectsWith, type ExpectedCall } from "./testing";

// 测试用的假凭据：拆开拼接，免得被 GitHub 推送保护当成真密钥（值本身不变）
const CREDS = { token: ["dop", "v1", "0123456789abcdef".repeat(4)].join("_") };
const TARGET = { dropletId: "3164444" };
const API = "https://api.digitalocean.com/v2";

function call(method: string, url: string, json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return {
    method,
    url,
    status,
    json,
    check: (req) => {
      assert.equal(req.headers.authorization, `Bearer ${CREDS.token}`);
      check?.(req.json);
    },
  };
}
const droplet = call("GET", `${API}/droplets/3164444`, {
  droplet: {
    id: 3164444,
    name: "example.com",
    status: "active",
    networks: {
      v4: [
        { ip_address: "10.128.192.124", netmask: "255.255.0.0", gateway: "nil", type: "private" },
        { ip_address: "192.241.165.154", netmask: "255.255.255.0", gateway: "192.241.165.1", type: "public" },
      ],
    },
    region: { slug: "nyc3" },
  },
});
const reserved = (ip: string, dropletId: number | null) => ({
  ip,
  droplet: dropletId ? { id: dropletId, name: "example.com" } : null,
  region: { name: "New York 3", slug: "nyc3" },
  locked: false,
  project_id: "746c6152-2fa2-11ed-92d3-27aaa54e4988",
});
const action = (id: number, status: string, type = "assign_ip") => ({ action: { id, status, type, started_at: "2026-10-15T08:00:00Z", resource_type: "reserved_ip" } });

test("DigitalOcean：解除旧保留 IP、创建并分配新的、删除旧的", async () => {
  const mock = createMockContext([
    droplet,
    call("GET", `${API}/reserved_ips?page=1&per_page=200`, { reserved_ips: [reserved("45.55.96.47", 3164444)], links: {}, meta: { total: 1 } }),
    call("POST", `${API}/reserved_ips/45.55.96.47/actions`, action(68212728, "in-progress", "unassign_ip"), (body) => assert.deepEqual(body, { type: "unassign" })),
    call("GET", `${API}/actions/68212728`, action(68212728, "completed", "unassign_ip")),
    call("POST", `${API}/reserved_ips`, { reserved_ip: reserved("45.55.96.99", 3164444), links: { droplets: [{ id: 3164444, rel: "droplet", href: `${API}/droplets/3164444` }], actions: [{ id: 68212773, rel: "assign_ip", href: `${API}/reserved_ips/45.55.96.99/actions/68212773` }] } }, (body) =>
      assert.deepEqual(body, { droplet_id: 3164444 }),
    202,
    ),
    call("GET", `${API}/actions/68212773`, action(68212773, "in-progress")),
    call("GET", `${API}/actions/68212773`, action(68212773, "completed")),
    call("GET", `${API}/reserved_ips/45.55.96.99`, { reserved_ip: reserved("45.55.96.99", 3164444) }),
    { method: "DELETE", url: `${API}/reserved_ips/45.55.96.47`, status: 204 },
  ]);
  const result = await digitaloceanProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.ipRole, result.releasedOldIp], ["45.55.96.47", "45.55.96.99", "entry", true]);
});

test("DigitalOcean：没有保留 IP 时 oldIp 是 Droplet 公网 IP；创建失败直接抛错", async () => {
  const mock = createMockContext([
    droplet,
    call("GET", `${API}/reserved_ips?page=1&per_page=200`, { reserved_ips: [reserved("45.55.96.10", 999)], links: {} }),
    call("POST", `${API}/reserved_ips`, { id: "unprocessable_entity", message: "You have reached the maximum number of reserved IPs." }, undefined, 422),
  ]);
  const error = await rejectsWith(digitaloceanProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /unprocessable_entity/);
  assert.equal(error.options.retryable, false);
  mock.assertDone();

  const ip = createMockContext([droplet, call("GET", `${API}/reserved_ips?page=1&per_page=200`, { reserved_ips: [], links: {} })]);
  assert.equal(await digitaloceanProvider.getCurrentIp(CREDS, TARGET, ip.ctx), "192.241.165.154");
});

test("DigitalOcean：分配新 IP 失败时把旧保留 IP 分配回去；401", async () => {
  const mock = createMockContext([
    droplet,
    call("GET", `${API}/reserved_ips?page=1&per_page=200`, { reserved_ips: [reserved("45.55.96.47", 3164444)], links: {} }),
    call("POST", `${API}/reserved_ips/45.55.96.47/actions`, action(1, "completed", "unassign_ip")),
    call("POST", `${API}/reserved_ips`, { id: "server_error", message: "Unexpected server-side error" }, undefined, 500),
    call("POST", `${API}/reserved_ips/45.55.96.47/actions`, action(2, "completed"), (body) => assert.deepEqual(body, { type: "assign", droplet_id: 3164444 })),
  ]);
  const error = await rejectsWith(digitaloceanProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /已把原保留 IP 45\.55\.96\.47 分配回 Droplet/);
  assert.equal(error.options.ambiguous, true);
  mock.assertDone();

  const denied = createMockContext([call("GET", `${API}/droplets/3164444`, { id: "unauthorized", message: "Unable to authenticate you." }, undefined, 401)]);
  await rejectsWith(digitaloceanProvider.testCredentials(CREDS, TARGET, denied.ctx), /API Token 无效/);
});
