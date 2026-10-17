import assert from "node:assert/strict";
import test from "node:test";
import { TOAST_DURATION_MS, installToastDurations } from "./toastDurations";

test("every toast, errors and explicit durations included, lasts one second", () => {
  const calls: Array<{ kind: string; data: any }> = [];
  const record = (kind: string) => (_message: unknown, data?: any) => {
    calls.push({ kind, data });
    return 1;
  };
  const fake: any = {
    success: record("success"),
    info: record("info"),
    message: record("message"),
    error: record("error"),
    warning: record("warning"),
  };
  installToastDurations(fake);
  fake.success("规则已更新");
  fake.info("提示");
  fake.message("普通");
  fake.error("出错了", { description: "原因" });
  fake.warning("注意");
  fake.error("诊断没通过", { duration: 12000 });

  assert.equal(TOAST_DURATION_MS, 1000);
  for (const call of calls) assert.equal(call.data.duration, TOAST_DURATION_MS);
  assert.equal(calls[3].data.description, "原因");
});

test("error toasts replace raw OpenSSL / fetch failures with a readable sentence and leave other text alone", () => {
  const messages: unknown[] = [];
  const record = (message: unknown) => { messages.push(message); return 1; };
  const fake: any = { success: record, info: record, message: record, error: record, warning: record };
  installToastDurations(fake);
  fake.error("error:1E08010C:DECODER routines::unsupported");
  fake.error("fetch failed");
  fake.error("Failed to fetch");
  fake.error("LOGIN_RATE_LIMITED:30");
  fake.error("最低支付金额为 5");
  fake.success("fetch failed");
  assert.deepEqual(messages, [
    "密钥或证书无法解析，请检查格式或联系管理员查看日志。",
    "网络请求失败，请检查连接后重试。",
    "网络请求失败，请检查连接后重试。",
    "LOGIN_RATE_LIMITED:30",
    "最低支付金额为 5",
    "fetch failed",
  ]);
});
