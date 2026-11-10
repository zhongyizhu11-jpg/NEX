import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import {
  appendJsonLog,
  clearJsonLogFile,
  flushJsonLogWrites,
  pruneJsonLogFile,
  readRecentJsonLogPageAsync,
} from "./logFileStore";

test("JSON logs batch writes without losing order and serialize maintenance", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-"));
  const filePath = path.join(dir, "panel.jsonl");
  try {
    appendJsonLog(filePath, { id: "old", level: "info", message: "old", createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString() });
    appendJsonLog(filePath, { id: "first", level: "info", message: "first", createdAt: new Date().toISOString() });
    appendJsonLog(filePath, { id: "second", level: "warn", message: "second", createdAt: new Date().toISOString() });
    await flushJsonLogWrites(filePath);

    const rawLines = (await fs.promises.readFile(filePath, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(rawLines.map((line) => JSON.parse(line).id), ["old", "first", "second"]);

    const page = await readRecentJsonLogPageAsync(filePath, { limit: 10 });
    assert.deepEqual(page.logs.map((entry) => entry.id), ["second", "first"]);
    await pruneJsonLogFile(filePath);
    assert.deepEqual((await fs.promises.readFile(filePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line).id), ["first", "second"]);

    appendJsonLog(filePath, { id: "before-clear", level: "info", message: "pending", createdAt: new Date().toISOString() });
    await clearJsonLogFile(filePath);
    assert.equal(await fs.promises.readFile(filePath, "utf8"), "");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("append, prune, and clear operations preserve call order under concurrency", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-order-"));
  const filePath = path.join(dir, "panel.jsonl");
  const entry = (id: string) => ({ id, level: "info", message: id, createdAt: new Date().toISOString() });
  try {
    appendJsonLog(filePath, entry("before-prune"));
    const pruning = pruneJsonLogFile(filePath);
    appendJsonLog(filePath, entry("before-clear"));
    const clearing = clearJsonLogFile(filePath);
    appendJsonLog(filePath, entry("after-clear"));

    await Promise.all([pruning, clearing]);
    await flushJsonLogWrites(filePath);
    const page = await readRecentJsonLogPageAsync(filePath, { limit: 10 });
    assert.deepEqual(page.logs.map((item) => item.id), ["after-clear"]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("面板日志留今天和前两天：按北京时间零点切，三天以前的整理时去掉、读的时候也不出现", async () => {
  const { logRetentionCutoff, LOG_RETENTION_DAYS } = await import("./logFileStore");
  assert.equal(LOG_RETENTION_DAYS, 3);
  // 北京时间 2026-11-10 09:30 = UTC 01:30
  const now = Date.parse("2026-11-10T01:30:00Z");
  // 北京时间 11-08 00:00 = UTC 11-07 16:00
  assert.equal(new Date(logRetentionCutoff(now)).toISOString(), "2026-11-07T16:00:00.000Z");
  // 北京时间刚过零点：还是往前数两天
  assert.equal(new Date(logRetentionCutoff(Date.parse("2026-11-09T16:00:00Z"))).toISOString(), "2026-11-07T16:00:00.000Z");
  assert.equal(new Date(logRetentionCutoff(Date.parse("2026-11-09T15:59:59Z"))).toISOString(), "2026-11-06T16:00:00.000Z");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-log-retention-"));
  const file = path.join(directory, "panel.jsonl");
  try {
    const at = (offsetHours: number) => new Date(Date.now() - offsetHours * 3_600_000).toISOString();
    appendJsonLog(file, { id: 1, level: "info", message: "四天前", createdAt: at(96) });
    appendJsonLog(file, { id: 2, level: "info", message: "昨天", createdAt: at(24) });
    appendJsonLog(file, { id: 3, level: "warn", message: "刚才", createdAt: at(0) });
    await flushJsonLogWrites(file);
    const page = await readRecentJsonLogPageAsync(file, { limit: 10 });
    assert.deepEqual(page.logs.map((entry) => entry.message), ["刚才", "昨天"]);
    await pruneJsonLogFile(file);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).message);
    assert.deepEqual(lines, ["昨天", "刚才"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
