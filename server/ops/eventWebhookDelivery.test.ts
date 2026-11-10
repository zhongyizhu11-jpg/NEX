import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  EVENT_WEBHOOK_QUEUE_MAX,
  EVENT_WEBHOOK_RETRY_DELAYS_MS,
  EVENT_WEBHOOK_TIMEOUT_MS,
  EventWebhookQueue,
  parseEventWebhookUrl,
  postEventWebhook,
  signEventWebhook,
  verifyEventWebhookSignature,
  type EventWebhookPayload,
} from "./eventWebhookDelivery";

type Received = { at: number; url: string; headers: http.IncomingHttpHeaders; body: string };

/** 本地接收方：按 respond 给的状态码回，收到的请求原样记下来。 */
async function startReceiver(respond: (received: Received, index: number) => { status: number; headers?: Record<string, string>; body?: string } | null) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const item: Received = { at: Date.now(), url: req.url || "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(item);
      const answer = respond(item, received.length - 1);
      // null = 不回（测超时）
      if (!answer) return;
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    received,
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function payloadOf(n: number): EventWebhookPayload {
  return { id: `evt_${n}`, type: "host.offline", occurredAt: new Date(1_700_000_000_000 + n * 1000).toISOString(), data: { level: "warn", message: `主机 ${n} 断线`, hostId: n, detail: {} } };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 文档「验签」一节里 Node 例子的写法：不借用面板的任何函数，只用 crypto。 */
function verifyLikeTheDocs(secret: string, headers: http.IncomingHttpHeaders, rawBody: string, nowSeconds = Date.now() / 1000) {
  const timestamp = String(headers["x-nex-timestamp"] || "");
  const signature = String(headers["x-nex-signature"] || "");
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const SECRET = "test-secret-0123456789abcdef";

test("收到的请求能按文档验签：HMAC-SHA256(密钥, 时间戳 + \".\" + body)，body 是 {id,type,occurredAt,data}", async () => {
  const receiver = await startReceiver(() => ({ status: 204 }));
  try {
    const payload = payloadOf(7);
    const result = await postEventWebhook({ url: receiver.url, secret: SECRET }, payload);
    assert.equal(result.ok, true);
    assert.equal(result.status, 204);
    assert.ok(result.durationMs >= 0);
    assert.equal(receiver.received.length, 1);
    const got = receiver.received[0];
    assert.equal(got.headers["content-type"], "application/json");
    assert.equal(got.headers["x-nex-event"], "host.offline");
    assert.equal(got.headers["x-nex-delivery"], "evt_7");
    assert.match(String(got.headers["x-nex-timestamp"]), /^\d{10}$/);
    assert.match(String(got.headers["x-nex-signature"]), /^sha256=[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(JSON.parse(got.body)), ["id", "type", "occurredAt", "data"]);
    assert.deepEqual(JSON.parse(got.body), payload);

    assert.equal(verifyLikeTheDocs(SECRET, got.headers, got.body), true, "按文档的写法验得过");
    assert.equal(verifyLikeTheDocs("another-secret-0123456789", got.headers, got.body), false, "密钥不对验不过");
    assert.equal(verifyLikeTheDocs(SECRET, got.headers, got.body.replace("断线", "上线")), false, "正文被改过验不过");
    assert.equal(verifyLikeTheDocs(SECRET, got.headers, got.body, Date.now() / 1000 + 3600), false, "一小时后重放验不过");

    // 面板自带的参考实现和文档写法结论一致
    const input = { secret: SECRET, timestamp: got.headers["x-nex-timestamp"], signature: got.headers["x-nex-signature"], body: got.body };
    assert.equal(verifyEventWebhookSignature(input), true);
    assert.equal(verifyEventWebhookSignature({ ...input, secret: "another-secret-0123456789" }), false);
    assert.equal(verifyEventWebhookSignature({ ...input, nowMs: Date.now() + 3_600_000 }), false);
    assert.equal(verifyEventWebhookSignature({ ...input, signature: String(input.signature).slice(7) }), false, "没有 sha256= 前缀不认");
    assert.equal(signEventWebhook("k", 1, "{}"), crypto.createHmac("sha256", "k").update("1.{}").digest("hex"));
  } finally {
    await receiver.close();
  }
});

test("失败按退避重试：两次 503 之后成功，一共发三次，间隔不短于设定，每次重新签名、id 不变", async () => {
  const receiver = await startReceiver((_received, index) => ({ status: index < 2 ? 503 : 200, body: index < 2 ? "upstream down" : "" }));
  const delays = [60, 140];
  const queue = new EventWebhookQueue({ resolveTarget: () => ({ url: receiver.url, secret: SECRET }), retryDelaysMs: delays });
  try {
    queue.enqueue("a", payloadOf(1));
    await waitFor(() => queue.idle() && receiver.received.length === 3);
    const [first, second, third] = receiver.received;
    assert.ok(second.at - first.at >= delays[0] - 5, `第一次重试隔了 ${second.at - first.at}ms`);
    assert.ok(third.at - second.at >= delays[1] - 5, `第二次重试隔了 ${third.at - second.at}ms`);
    for (const got of receiver.received) {
      assert.equal(got.headers["x-nex-delivery"], "evt_1");
      assert.equal(verifyLikeTheDocs(SECRET, got.headers, got.body), true);
    }
    const records = queue.recent("a");
    assert.deepEqual(records.map((record) => [record.attempt, record.ok, record.status, record.willRetry]), [
      [3, true, 200, false],
      [2, false, 503, true],
      [1, false, 503, true],
    ]);
    assert.equal(records[2].error, "upstream down");
    assert.ok(records.every((record) => record.durationMs >= 0 && record.eventId === "evt_1" && record.type === "host.offline"));
  } finally {
    await receiver.close();
  }
});

test("重试次数用完就放弃；默认间隔是 5 秒、30 秒、2 分钟、10 分钟，超时 5 秒", async () => {
  assert.deepEqual([...EVENT_WEBHOOK_RETRY_DELAYS_MS], [5_000, 30_000, 120_000, 600_000]);
  assert.equal(EVENT_WEBHOOK_TIMEOUT_MS, 5_000);
  const receiver = await startReceiver(() => ({ status: 500 }));
  const results: boolean[] = [];
  const queue = new EventWebhookQueue({
    resolveTarget: () => ({ url: receiver.url, secret: SECRET }),
    retryDelaysMs: [10, 10],
    onResult: (_id, record) => results.push(record.willRetry),
  });
  try {
    queue.enqueue("a", payloadOf(1));
    await waitFor(() => queue.idle() && receiver.received.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(receiver.received.length, 3, "两次重试用完，不再发");
    assert.deepEqual(results, [true, true, false]);
    assert.equal(queue.recent("a")[0].error, "HTTP 500");
  } finally {
    await receiver.close();
  }
});

test("重定向不跟随；普通 4xx 不重试；429 和连不上会重试", async () => {
  const receiver = await startReceiver((received) => {
    if (received.url === "/redirect") return { status: 302, headers: { Location: "/landed" } };
    if (received.url === "/bad") return { status: 400, body: "signature mismatch" };
    if (received.url === "/busy") return { status: 429 };
    return { status: 200 };
  });
  const base = receiver.url.replace("/hook", "");
  try {
    const redirected = await postEventWebhook({ url: `${base}/redirect`, secret: SECRET }, payloadOf(1));
    assert.equal(redirected.ok, false);
    assert.equal(redirected.status, 302);
    assert.equal(redirected.retriable, false);
    assert.match(String(redirected.error), /不跟随/);
    assert.equal(receiver.received.some((item) => item.url === "/landed"), false, "没有去跳转后的地址");

    const bad = await postEventWebhook({ url: `${base}/bad`, secret: SECRET }, payloadOf(2));
    assert.deepEqual([bad.ok, bad.status, bad.retriable, bad.error], [false, 400, false, "signature mismatch"]);

    const busy = await postEventWebhook({ url: `${base}/busy`, secret: SECRET }, payloadOf(3));
    assert.deepEqual([busy.ok, busy.status, busy.retriable], [false, 429, true]);
  } finally {
    await receiver.close();
  }
  // 接收方已经关了：连不上，值得重试
  const refused = await postEventWebhook({ url: `${base}/hook`, secret: SECRET }, payloadOf(4));
  assert.deepEqual([refused.ok, refused.status, refused.retriable], [false, null, true]);
  assert.match(String(refused.error), /连不上/);
});

test("对方一直不回：到超时就算失败，可以重试", async () => {
  const receiver = await startReceiver(() => null);
  try {
    const started = Date.now();
    const result = await postEventWebhook({ url: receiver.url, secret: SECRET }, payloadOf(1), { timeoutMs: 80 });
    assert.deepEqual([result.ok, result.status, result.retriable], [false, null, true]);
    assert.match(String(result.error), /秒内没有响应/);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await receiver.close();
  }
});

test("队列有上限：满了丢最旧的并计数", async () => {
  assert.equal(EVENT_WEBHOOK_QUEUE_MAX, 500);
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const dropped: number[] = [];
  const queue = new EventWebhookQueue({
    resolveTarget: () => ({ url: "http://receiver.invalid/hook", secret: SECRET }),
    maxQueue: 3,
    // 第一条卡在路上，后面的都排着
    fetchImpl: async (_url, init) => {
      await gate;
      sent.push(JSON.parse(String(init.body)).id);
      return new Response(null, { status: 200 });
    },
    onDropped: (_id, total) => dropped.push(total),
  });
  for (let n = 1; n <= 6; n += 1) queue.enqueue("a", payloadOf(n));
  // evt_1 在发；evt_2…6 五条排队，上限 3：丢掉最旧的 evt_2、evt_3
  assert.deepEqual(queue.stats(), { queued: 3, sending: 1, dropped: 2, max: 3 });
  assert.equal(queue.droppedOf("a"), 2);
  assert.equal(queue.pendingOf("a"), 4);
  assert.deepEqual(dropped, [1, 2]);
  release();
  await waitFor(() => queue.idle());
  assert.deepEqual(sent, ["evt_1", "evt_4", "evt_5", "evt_6"]);
  assert.equal(queue.stats().dropped, 2);
});

test("同一个地址一次只发一条，别的地址不受它拖累", async () => {
  let inFlightA = 0;
  let maxInFlightA = 0;
  const order: string[] = [];
  const queue = new EventWebhookQueue({
    resolveTarget: (id) => ({ url: `http://receiver.invalid/${id}`, secret: SECRET }),
    fetchImpl: async (url, init) => {
      const slow = String(url).endsWith("/a");
      if (slow) {
        inFlightA += 1;
        maxInFlightA = Math.max(maxInFlightA, inFlightA);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlightA -= 1;
      }
      order.push(`${slow ? "a" : "b"}:${JSON.parse(String(init.body)).id}`);
      return new Response(null, { status: 200 });
    },
  });
  queue.enqueue("a", payloadOf(1));
  queue.enqueue("a", payloadOf(2));
  queue.enqueue("b", payloadOf(3));
  await waitFor(() => queue.idle());
  assert.equal(maxInFlightA, 1);
  assert.equal(order[0], "b:evt_3", "快的地址不用等慢的");
  assert.deepEqual(order.filter((item) => item.startsWith("a:")), ["a:evt_1", "a:evt_2"]);
});

test("停用后不发：发之前问不到地址就作废，等重试的也能清掉", async () => {
  let calls = 0;
  let active = true;
  const queue = new EventWebhookQueue({
    resolveTarget: () => (active ? { url: "http://receiver.invalid/hook", secret: SECRET } : null),
    retryDelaysMs: [30, 30],
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });
  queue.enqueue("a", payloadOf(1));
  await waitFor(() => calls === 1 && queue.pendingOf("a") === 1);
  // 第一次失败，正等着重试 —— 这时停用
  active = false;
  await waitFor(() => queue.idle());
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1, "停用后没有再发");

  active = true;
  queue.enqueue("a", payloadOf(2));
  await waitFor(() => calls === 2 && queue.pendingOf("a") === 1);
  assert.equal(queue.discard("a"), 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 2, "清掉之后不再重试");
  assert.equal(queue.idle(), true);

  queue.forget("a");
  assert.deepEqual(queue.recent("a"), []);
});

test("最近投递结果每个地址只留二十条，新的在前", async () => {
  const queue = new EventWebhookQueue({
    resolveTarget: () => ({ url: "http://receiver.invalid/hook", secret: SECRET }),
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  for (let n = 1; n <= 25; n += 1) queue.enqueue("a", payloadOf(n));
  await waitFor(() => queue.idle());
  const recent = queue.recent("a");
  assert.equal(recent.length, 20);
  assert.equal(recent[0].eventId, "evt_25");
  assert.equal(recent[19].eventId, "evt_6");
});

test("接收地址只许 http / https，不许带账号密码；内网地址可以", () => {
  assert.equal(parseEventWebhookUrl(" http://192.168.1.10:5678/webhook/nex ").toString(), "http://192.168.1.10:5678/webhook/nex");
  assert.equal(parseEventWebhookUrl("https://ha.lan/api/webhook/abc?x=1#frag").toString(), "https://ha.lan/api/webhook/abc?x=1");
  assert.equal(parseEventWebhookUrl("http://localhost:1880/nex").hostname, "localhost");
  for (const bad of ["", "ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "example.com/hook", "https://user:pass@example.com/hook", `https://example.com/${"a".repeat(2100)}`]) {
    assert.throws(() => parseEventWebhookUrl(bad), /接收地址/, bad.slice(0, 40));
  }
});

test("库里的地址不合法（比如导入的备份里是 ftp://）：不发请求，记成失败，不重试", async () => {
  let called = false;
  const result = await postEventWebhook({ url: "ftp://example.com/hook", secret: SECRET }, payloadOf(1), {
    fetchImpl: async () => {
      called = true;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(called, false);
  assert.deepEqual([result.ok, result.status, result.retriable], [false, null, false]);
});
