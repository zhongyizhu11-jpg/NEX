import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { formatTrpcErrorShape, zodErrorMessage } from "./errorFormatter";
import { publicProcedure, router } from "./trpc";

function zodErrorOf(schema: z.ZodTypeAny, value: unknown) {
  const result = schema.safeParse(value);
  assert.equal(result.success, false);
  return (result as z.SafeParseError<unknown>).error;
}

const baseShape = () => ({
  message: "raw",
  code: -32600,
  data: { code: "BAD_REQUEST", httpStatus: 400, path: "x" } as Record<string, unknown>,
});

test("zod validation errors become a readable first-issue message", () => {
  const error = zodErrorOf(z.object({ name: z.string().min(1).max(128) }), { name: "x".repeat(200) });
  assert.equal(zodErrorMessage(error), "name: 最多 128 个字符");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ name: z.string().min(1) }), { name: "" })), "name: 不能为空");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ port: z.number().int().min(1) }), { port: 0 })), "port: 不能小于 1");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ a: z.object({ b: z.string() }) }), { a: {} })), "a.b: 不能为空");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ kind: z.enum(["a", "b"]) }), { kind: "c" })), "kind: 取值无效");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ email: z.string().email() }), { email: "nope" })), "email: 格式不正确");
});

test("custom Chinese messages in schemas are kept as-is", () => {
  const error = zodErrorOf(z.object({ name: z.string().min(1, "请填写名称") }), { name: "" });
  assert.equal(zodErrorMessage(error), "name: 请填写名称");
  assert.equal(zodErrorMessage(zodErrorOf(z.number().min(1), 0)), "输入参数无效：不能小于 1");
});

test("errorFormatter rewrites zod errors and keeps zodError details", () => {
  const cause = zodErrorOf(z.object({ name: z.string().max(2) }), { name: "abcd" });
  const error = new TRPCError({ code: "BAD_REQUEST", message: cause.message, cause });
  const shape = formatTrpcErrorShape({ shape: baseShape(), error });
  assert.equal(shape.message, "name: 最多 2 个字符");
  assert.ok(shape.data.zodError);
  assert.deepEqual(Object.keys(shape.data.zodError!.fieldErrors), ["name"]);
  assert.equal(shape.data.code, "BAD_REQUEST");
});

test("errorFormatter leaves non-zod messages (client-parsed codes) untouched", () => {
  const error = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "LOGIN_RATE_LIMITED:5" });
  const shape = formatTrpcErrorShape({ shape: { ...baseShape(), message: "LOGIN_RATE_LIMITED:5" }, error });
  assert.equal(shape.message, "LOGIN_RATE_LIMITED:5");
  assert.equal(shape.data.zodError, null);
});

test("the tRPC instance uses the formatter for input validation failures", async () => {
  const appRouter = router({
    echo: publicProcedure.input(z.object({ name: z.string().min(1).max(4) })).mutation(({ input }) => input.name),
  });
  const caller = appRouter.createCaller({} as any);
  const thrown = await caller.echo({ name: "toolong" }).then(() => null, (e) => e);
  assert.ok(thrown instanceof TRPCError);
  const config = (appRouter as any)._def._config;
  const shape = config.errorFormatter({
    shape: { ...baseShape(), message: thrown.message },
    error: thrown,
    type: "mutation",
    path: "echo",
    input: { name: "toolong" },
    ctx: undefined,
  });
  assert.equal(shape.message, "name: 最多 4 个字符");
});

function internalShape(message: string) {
  return { message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "rules.create" } as Record<string, unknown> };
}

function captureConsoleError<T>(run: () => T): { result: T; logs: string[] } {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    return { result: run(), logs };
  } finally {
    console.error = original;
  }
}

test("driver and runtime errors are masked with an error id and logged with the original text", () => {
  const samples: Array<{ message: string; cause?: unknown }> = [
    { message: "UNIQUE constraint failed: forward_rules.sourcePort" },
    { message: "SQLITE_BUSY: database is locked" },
    { message: "SQLITE_BUSY" },
    { message: "ER_DUP_ENTRY: Duplicate entry '1-80' for key 'uniq_host_port'" },
    { message: 'duplicate key value violates unique constraint "forward_rules_pkey"' },
    { message: "Failed query: insert into \"forward_rules\" (\"name\") values ($1)\nparams: x" },
    { message: "Cannot read properties of undefined (reading 'id')" },
    { message: "connect ECONNREFUSED 127.0.0.1:3306" },
    { message: "something odd", cause: Object.assign(new Error("something odd"), { code: "SQLITE_CONSTRAINT_UNIQUE" }) },
    { message: "x.map is wrong", cause: new TypeError("x.map is wrong") },
    { message: "bad", cause: Object.assign(new Error("bad"), { code: "23505", severity: "ERROR" }) },
  ];
  for (const sample of samples) {
    const cause = sample.cause ?? new Error(sample.message);
    const error = new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: sample.message, cause });
    const { result: shape, logs } = captureConsoleError(() =>
      formatTrpcErrorShape({ shape: internalShape(sample.message), error, path: "rules.create" }),
    );
    const match = /^操作失败，请稍后重试（编号 ([0-9a-f]{8})）$/.exec(shape.message);
    assert.ok(match, `should mask: ${sample.message} -> ${shape.message}`);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes(`编号=${match![1]}`));
    assert.ok(logs[0].includes("path=rules.create"));
    assert.ok(logs[0].includes(sample.message.split("\n")[0]));
    assert.equal(shape.data.code, "INTERNAL_SERVER_ERROR");
  }
});

test("Chinese messages and client-parsed error codes are never masked", () => {
  const keep = [
    "端口 8080 已被占用",
    "规则不存在",
    "LOGIN_RATE_LIMITED:5",
    "CAPTCHA_REFRESH_RATE_LIMITED:30",
    "SETUP_LOCKED",
    "SETUP_MIGRATION_RUNNING",
    "TELEGRAM_WEBAPP_VERIFY_FAILED",
    "EMAIL_RATE_LIMITED",
    // 业务代码已经包了一层中文，交给业务决定
    "保存失败：UNIQUE constraint failed: x",
    // 普通英文业务提示不算驱动报错
    "Host not found",
  ];
  for (const message of keep) {
    const error = new TRPCError({ code: "INTERNAL_SERVER_ERROR", message, cause: new Error(message) });
    const { result: shape, logs } = captureConsoleError(() => formatTrpcErrorShape({ shape: internalShape(message), error }));
    assert.equal(shape.message, message);
    assert.equal(logs.length, 0);
  }
});

test("only INTERNAL_SERVER_ERROR is masked; deliberate codes keep their text", () => {
  const message = "UNIQUE constraint failed: users.email";
  const error = new TRPCError({ code: "CONFLICT", message });
  const shape = formatTrpcErrorShape({ shape: { ...baseShape(), message, data: { code: "CONFLICT" } }, error });
  assert.equal(shape.message, message);
});

test("plain thrown driver errors inside a procedure reach the client masked", async () => {
  const appRouter = router({
    boom: publicProcedure.mutation(() => {
      throw Object.assign(new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed: hosts.name"), { code: "SQLITE_CONSTRAINT_NOTNULL" });
    }),
  });
  const thrown = await appRouter.createCaller({} as any).boom().then(() => null, (e) => e);
  assert.ok(thrown instanceof TRPCError);
  const config = (appRouter as any)._def._config;
  const { result: shape, logs } = captureConsoleError(() => config.errorFormatter({
    shape: internalShape(thrown.message),
    error: thrown,
    type: "mutation",
    path: "boom",
    input: undefined,
    ctx: undefined,
  }));
  assert.match(shape.message, /^操作失败，请稍后重试（编号 [0-9a-f]{8}）$/);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("NOT NULL constraint failed: hosts.name"));
});
