import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthCaptchaService } from "./authCaptcha";
import { captchaChallengeAllowed, verifyAuthCaptcha } from "./authCaptchaMode";
import { authCaptchaSubmissionFields, classifyAuthCaptchaInput, normalizeAuthCaptchaMode } from "../shared/authCaptchaMode";

test("验证方式：存坏了 / 没设过都按点击验证", () => {
  assert.equal(normalizeAuthCaptchaMode(null), "click");
  assert.equal(normalizeAuthCaptchaMode("IMAGE"), "click");
  assert.equal(normalizeAuthCaptchaMode("image"), "image");
  assert.equal(captchaChallengeAllowed("click", "cap"), true);
  assert.equal(captchaChallengeAllowed("click", "image"), false);
  assert.equal(captchaChallengeAllowed("image", "image"), true);
  assert.equal(captchaChallengeAllowed("image", "cap"), false);
});

test("只认选中的那一种：另一种、两种都带、只带一半都是失败，什么都没带才是「还没验证」", () => {
  assert.equal(classifyAuthCaptchaInput("click", {}), "none");
  assert.equal(classifyAuthCaptchaInput("click", { capToken: " " }), "none");
  assert.equal(classifyAuthCaptchaInput("click", { capToken: "t" }), "ok");
  assert.equal(classifyAuthCaptchaInput("click", { captchaId: "i", captchaAnswer: "a" }), "mismatch");
  assert.equal(classifyAuthCaptchaInput("click", { capToken: "t", captchaId: "i", captchaAnswer: "a" }), "mismatch");
  assert.equal(classifyAuthCaptchaInput("image", { captchaId: "i", captchaAnswer: "a" }), "ok");
  assert.equal(classifyAuthCaptchaInput("image", { capToken: "t" }), "mismatch");
  assert.equal(classifyAuthCaptchaInput("image", { captchaId: "i" }), "incomplete");
  // 页面交上来的结果只展开成那一种的字段，没验完就什么都不带
  assert.deepEqual(authCaptchaSubmissionFields(null), {});
  assert.deepEqual(authCaptchaSubmissionFields({ capToken: " t " }), { capToken: "t" });
  assert.deepEqual(authCaptchaSubmissionFields({ captchaId: "i", captchaAnswer: " " }), {});
  assert.deepEqual(authCaptchaSubmissionFields({ captchaId: "i", captchaAnswer: " ab " }), { captchaId: "i", captchaAnswer: "ab" });
});

test("图片模式下一个对的图片答案能过，同一张换到点击模式下验就不认（也不消耗它）", async () => {
  const service = new AuthCaptchaService({ svgGenerator: () => ({ text: "A7K9P", data: "<svg></svg>" }) });
  const challenge = service.createImageChallenge("192.0.2.70", "login");
  const input = { captchaId: challenge.captchaId, captchaAnswer: "a7k9p" };
  assert.equal(await verifyAuthCaptcha(service, "click", "192.0.2.70", "login", input), "invalid");
  assert.equal(await verifyAuthCaptcha(service, "image", "192.0.2.70", "login", input), "ok");
  assert.equal(await verifyAuthCaptcha(service, "image", "192.0.2.70", "login", input), "invalid", "一张只能用一次");
  assert.equal(await verifyAuthCaptcha(service, "image", "192.0.2.70", "login", {}), "missing");
});

test("登录 / 注册 / 找回密码和 Cap 接口按系统设置的验证方式严格校验（两个方向）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-captcha-mode-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/authCaptchaMode.fixture.ts"], {
      encoding: "utf8", timeout: 90_000, windowsHide: true,
      env: { ...process.env, DATABASE_CONFIG_PATH: path.join(directory, "database.json"), DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "auth.db"), JWT_SECRET: "captcha-mode-fixture-secret-long-enough", FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
