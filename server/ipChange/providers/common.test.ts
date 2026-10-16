import assert from "node:assert/strict";
import test from "node:test";

import { collectSecrets, defineProvider, httpRequest, pollUntil, scrubText } from "./common";
import { IP_CHANGE_PROVIDERS, getIpChangeProvider } from "./index";
import { createMockContext, rejectsWith } from "./testing";
import { IpChangeProviderError, type IpChangeProvider } from "./types";

test("注册表：14 个 provider，顺序与 id 唯一，字段定义完整", () => {
  assert.deepEqual(
    IP_CHANGE_PROVIDERS.map((p) => p.id),
    ["aws-ec2", "aws-lightsail", "aliyun-ecs", "tencent-cvm", "huawei-ecs", "volcengine-ecs", "gcp-gce", "oci", "azure-vm", "digitalocean", "hetzner", "vultr", "aws-sb", "webhook"],
  );
  for (const provider of IP_CHANGE_PROVIDERS) {
    assert.ok(provider.label && provider.docsHint, provider.id);
    const keys = [...provider.credentialFields, ...provider.targetFields].map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${provider.id} 字段 key 重复`);
    for (const field of [...provider.credentialFields, ...provider.targetFields]) {
      if (field.type === "select") assert.ok(field.options?.length, `${provider.id}.${field.key} 缺少 options`);
    }
  }
  assert.equal(getIpChangeProvider("hetzner")?.requiresDowntime, true);
  assert.equal(getIpChangeProvider("nope"), undefined);
});

test("脱敏：整值、多行值的行、JSON 里的长字符串、请求头里的令牌", () => {
  const secrets = collectSecrets(
    {
      secret: "plainSecretValue",
      key: JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----", client_email: "a@b.c" }),
      headers: "Authorization: Bearer abcdefgh12345678",
    },
    [
      { key: "secret", label: "s", type: "password" },
      { key: "key", label: "k", type: "textarea" },
      { key: "headers", label: "h", type: "textarea" },
    ],
  );
  const text = scrubText("x plainSecretValue y MIIEvQIBADANBgkqhkiG9w0BAQEFAASC z abcdefgh12345678", secrets);
  assert.equal(text, "x *** y *** z ***");
});

test("defineProvider：错误与日志里的凭据被替换，非 IpChangeProviderError 被包装", async () => {
  const inner: IpChangeProvider = {
    id: "webhook",
    label: "t",
    docsHint: "t",
    credentialFields: [{ key: "token", label: "token", type: "password" }],
    targetFields: [],
    requiresDowntime: false,
    async testCredentials(_c, _t, ctx) {
      ctx.log("using token tokentoken123");
      throw new IpChangeProviderError("bad tokentoken123", { retryable: true });
    },
    async getCurrentIp() {
      throw new TypeError("boom tokentoken123");
    },
    async changeIp() {
      return { oldIp: null, newIp: "1.1.1.1", ipRole: "primary", releasedOldIp: false, notes: ["n tokentoken123"] };
    },
  };
  const wrapped = defineProvider(inner);
  const mock = createMockContext([]);
  const error = await rejectsWith(wrapped.testCredentials({ token: "tokentoken123" }, {}, mock.ctx), /^bad \*\*\*$/);
  assert.equal(error.options.retryable, true);
  assert.deepEqual(mock.logs, ["using token ***"]);
  await rejectsWith(wrapped.getCurrentIp({ token: "tokentoken123" }, {}, mock.ctx), /^内部错误：boom \*\*\*$/);
  assert.deepEqual((await wrapped.changeIp({ token: "tokentoken123" }, {}, mock.ctx, { releaseOldIp: false })).notes, ["n ***"]);
});

test("httpRequest：网络错误可重试；修改请求的网络错误是 ambiguous；已取消", async () => {
  const mock = createMockContext([
    { method: "GET", url: "https://a.example.com/", error: new TypeError("fetch failed") },
    { method: "POST", url: "https://a.example.com/", error: new TypeError("fetch failed") },
  ]);
  const read = await rejectsWith(httpRequest(mock.ctx, { label: "X", method: "GET", url: "https://a.example.com/" }), /网络错误/);
  assert.deepEqual(read.options, { retryable: true, ambiguous: false });
  const write = await rejectsWith(httpRequest(mock.ctx, { label: "X", method: "POST", url: "https://a.example.com/", mutating: true }), /请求可能已经生效/);
  assert.deepEqual(write.options, { retryable: true, ambiguous: true });
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(httpRequest({ ...mock.ctx, signal: controller.signal }, { label: "X", method: "GET", url: "https://a.example.com/" }), /已取消/);
  mock.assertDone();
});

test("httpRequest：真实超时（AbortSignal.timeout 生效）", async () => {
  const ctx = {
    ...createMockContext([]).ctx,
    fetch: ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch,
  };
  // AbortSignal.timeout 的定时器不占事件循环，这里挂一个普通定时器防止测试进程提前判定结束
  const keepAlive = setTimeout(() => undefined, 5000);
  try {
    const error = await rejectsWith(httpRequest(ctx, { label: "X", method: "GET", url: "https://slow.example.com/", timeoutMs: 20 }), /请求超时/);
    assert.equal(error.options.retryable, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("pollUntil：按次数封顶，超时是 ambiguous", async () => {
  const mock = createMockContext([]);
  let calls = 0;
  const error = await rejectsWith(
    pollUntil(mock.ctx, "测试", async () => {
      calls += 1;
      return null;
    }, { intervalMs: 5000, timeoutMs: 20000 }),
    /等待测试超时（20 秒）/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(mock.sleeps, [5000, 5000, 5000, 5000]);
  assert.equal(error.options.ambiguous, true);
  assert.equal(await pollUntil(mock.ctx, "x", async () => "done", { immediate: true }), "done");
});
