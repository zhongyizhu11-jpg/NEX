import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve(import.meta.dirname, "..", "docker", "panel", "entrypoint.sh");

function decide(env: Record<string, string>) {
  const result = spawnSync("sh", [script, "node", "dist/index.js"], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", FORWARDX_ENTRYPOINT_DRY_RUN: "1", ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("entrypoint drops to the panel user when it starts as root with no docker socket", () => {
  const sock = path.join(os.tmpdir(), `nex-missing-${process.pid}.sock`);
  // 容器里有 forwardx 用户；这台机器上未必有，用当前用户名代替「存在的用户」。
  const user = os.userInfo().username;
  assert.equal(decide({ FORWARDX_ENTRYPOINT_UID: "0", FORWARDX_DOCKER_SOCK: sock, FORWARDX_PANEL_USER: user }), "drop");
});

test("entrypoint keeps root when asked, when the docker socket is mounted, or when the user is missing", () => {
  const sock = path.join(os.tmpdir(), `nex-missing-${process.pid}.sock`);
  const user = os.userInfo().username;
  assert.equal(decide({ FORWARDX_ENTRYPOINT_UID: "0", FORWARDX_DOCKER_SOCK: sock, FORWARDX_PANEL_USER: user, FORWARDX_RUN_AS_ROOT: "1" }), "root:requested");
  assert.equal(decide({ FORWARDX_ENTRYPOINT_UID: "0", FORWARDX_DOCKER_SOCK: sock, FORWARDX_PANEL_USER: "nex-no-such-user-xyz" }), "root:no-user");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nex-sock-"));
  try {
    // 用一个真正的 unix socket 文件模拟挂进来的 docker.sock
    const server = net.createServer();
    const sockPath = path.join(dir, "docker.sock");
    server.listen(sockPath);
    try {
      assert.equal(decide({ FORWARDX_ENTRYPOINT_UID: "0", FORWARDX_DOCKER_SOCK: sockPath, FORWARDX_PANEL_USER: user }), "root:docker-socket");
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("entrypoint does nothing special when it is already unprivileged", () => {
  assert.equal(decide({ FORWARDX_ENTRYPOINT_UID: "10001" }), "already-unprivileged");
});
