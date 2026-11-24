import fs from "node:fs";
import path from "node:path";

/*
  看心跳路由源码的结构性测试用：/api/agent/heartbeat 的处理器从 2026-11-24 起按阶段抽到 server/heartbeat/*.ts
  （scripts/extract-block.mjs），断言代码片段时要把这些文件一起看。
*/
export function readHeartbeatRouteSource() {
  const serverDir = path.resolve(import.meta.dirname, "..");
  const parts = [fs.readFileSync(path.join(serverDir, "agentHeartbeatRoute.ts"), "utf8")];
  const dir = path.join(serverDir, "heartbeat");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) parts.push(fs.readFileSync(path.join(dir, name), "utf8"));
    }
  }
  return parts.join("\n");
}
