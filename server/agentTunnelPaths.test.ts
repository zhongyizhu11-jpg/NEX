import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AGENT_TUNNEL_PATHS } from "./agentEncryptionMiddleware";

/*
  Agent 的每个请求都走加密的 /api/sync，面板只把 AGENT_TUNNEL_PATHS 里的内层路径转给对应接口，
  其余一律 400。新加 Agent 上报接口忘了登记，Agent 那边就永远报不上来（2.3.440 的 mimic 安装
  进度和结果就是这样全丢了）。这里把面板注册的 /api/agent/* POST 接口和 Agent 代码里发的路径
  都和白名单对一遍。
*/

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.name.endsWith(ext) && !entry.name.includes(".test.") && !entry.name.endsWith("_test.go")) out.push(full);
  }
  return out;
}

test("面板注册的每个 Agent POST 接口都在 /api/sync 白名单里", () => {
  const routes = new Set<string>();
  for (const file of listFiles(path.join(process.cwd(), "server"), ".ts")) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/Router\.post\(\s*"(\/api\/agent\/[a-z0-9/-]+)"/g)) routes.add(match[1]);
  }
  assert.ok(routes.has("/api/agent/heartbeat"), "should find the heartbeat route");
  const missing = [...routes].filter((route) => !AGENT_TUNNEL_PATHS.has(route));
  assert.deepEqual(missing, [], `these agent routes are unreachable through /api/sync: ${missing.join(", ")}`);
});

test("Agent 代码里上报的每个路径都在 /api/sync 白名单里", () => {
  const paths = new Set<string>();
  for (const file of listFiles(path.join(process.cwd(), "agent"), ".go")) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/"(\/api\/agent\/[a-z0-9/-]+)"/g)) paths.add(match[1]);
  }
  // auth-challenge 不走加密信封（它就是拿信封之前的那一步）
  paths.delete("/api/agent/auth-challenge");
  assert.ok(paths.has("/api/agent/mimic-install-result"));
  const missing = [...paths].filter((p) => !AGENT_TUNNEL_PATHS.has(p));
  assert.deepEqual(missing, [], `the agent posts to paths the panel rejects: ${missing.join(", ")}`);
});
