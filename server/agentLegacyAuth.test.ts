import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import {
  AGENT_AUTH_RESULT_ACCEPTED,
  AGENT_AUTH_RESULT_HEADER,
  AGENT_AUTH_RESULT_REJECTED,
  isHostUsingLegacyAgentAuth,
  legacyAgentAuthHosts,
  noteAgentAuthScheme,
  setLegacyAgentAuthRejectedCache,
} from "./agentAuth";
import { encryptPayload, resetAgentCryptoCaches } from "./agentCrypto";
import { agentEncryptionMiddleware } from "./agentEncryptionMiddleware";

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.post("/api/sync", agentEncryptionMiddleware, (req, res) => {
    res.status(403).json({ legacy: (req as any).agentLegacyAuth === true });
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

function legacyRequest(baseUrl: string, token: string, ruleId: number) {
  return fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(encryptPayload({ path: "/api/agent/protocol-block", payload: { ruleId } }, token)),
  });
}

test("旧式认证（明文 token）默认照旧接受，打开「拒绝旧式 Agent 认证」后被拒", async () => {
  resetAgentCryptoCaches();
  const token = "agent-legacy-auth-token";
  try {
    await withServer(async (baseUrl) => {
      setLegacyAgentAuthRejectedCache(false);
      const accepted = await legacyRequest(baseUrl, token, 1);
      assert.equal(accepted.status, 403);
      assert.equal(accepted.headers.get(AGENT_AUTH_RESULT_HEADER), AGENT_AUTH_RESULT_ACCEPTED);

      setLegacyAgentAuthRejectedCache(true);
      const rejected = await legacyRequest(baseUrl, token, 2);
      assert.equal(rejected.status, 401);
      assert.equal(rejected.headers.get(AGENT_AUTH_RESULT_HEADER), AGENT_AUTH_RESULT_REJECTED);
    });
  } finally {
    setLegacyAgentAuthRejectedCache(false);
    resetAgentCryptoCaches();
  }
});

test("每台主机记下最近一次是不是旧式认证，换成签名认证后清掉", () => {
  noteAgentAuthScheme({ agentLegacyAuth: true } as any, 41);
  noteAgentAuthScheme({ agentLegacyAuth: true } as any, 42);
  assert.equal(isHostUsingLegacyAgentAuth(41), true);
  assert.deepEqual(legacyAgentAuthHosts().map((item) => item.hostId).sort(), [41, 42]);
  noteAgentAuthScheme({ agentAuthVersion: "v2" } as any, 41);
  assert.equal(isHostUsingLegacyAgentAuth(41), false);
  assert.equal(isHostUsingLegacyAgentAuth(42), true);
  // 没验过签名、也不是旧式（比如还没走到认证）的请求不改记录。
  noteAgentAuthScheme({} as any, 42);
  assert.equal(isHostUsingLegacyAgentAuth(42), true);
});
