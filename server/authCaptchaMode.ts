import { classifyAuthCaptchaInput, normalizeAuthCaptchaMode, type AuthCaptchaInput, type AuthCaptchaMode } from "../shared/authCaptchaMode";
import { getSetting } from "./repositories/settingsRepository";
import type { AuthCaptchaService, CaptchaPurpose } from "./authCaptcha";

export const AUTH_CAPTCHA_MODE_SETTING = "authCaptchaMode";

/** 系统设置里选的验证方式（shared/authCaptchaMode.ts）。没设过、存坏了都按点击验证。 */
export async function readAuthCaptchaMode(): Promise<AuthCaptchaMode> {
  return normalizeAuthCaptchaMode(await getSetting(AUTH_CAPTCHA_MODE_SETTING));
}

export type AuthCaptchaVerdict = "missing" | "invalid" | "ok";

/**
 * 按选中的方式验一次：只认这一种的答案。
 *
 * 另一种的答案（比如图片模式下送来一枚 Cap 令牌）直接判 invalid，不去验它 —— 也就不会消耗它，
 * 但同样记一次失败（调用方按 invalid 处理）。两种都带的也算 invalid：不能让请求自己挑一种来过。
 */
export async function verifyAuthCaptcha(
  service: AuthCaptchaService,
  mode: AuthCaptchaMode,
  ip: string,
  purpose: CaptchaPurpose,
  input: AuthCaptchaInput,
): Promise<AuthCaptchaVerdict> {
  const shape = classifyAuthCaptchaInput(mode, input);
  if (shape === "none") return "missing";
  if (shape !== "ok") return "invalid";
  const valid = mode === "click"
    ? await service.verifyCapToken(ip, purpose, String(input.capToken).trim())
    : service.verifyChallenge(String(input.captchaId).trim(), String(input.captchaAnswer).trim(), ip, purpose);
  return valid ? "ok" : "invalid";
}

/** 当前方式下能不能发这种挑战：点击模式不发图片，图片模式不发 Cap 挑战。 */
export function captchaChallengeAllowed(mode: AuthCaptchaMode, kind: "cap" | "image") {
  return mode === "click" ? kind === "cap" : kind === "image";
}
