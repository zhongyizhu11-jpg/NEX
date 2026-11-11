/*
  登录 / 注册 / 找回密码的人机验证方式（上游 2.3.286），服务端和页面共用。

  · click：点一下的验证（自建的 Cap.js 工作量证明，server/authCaptcha.ts），默认。
  · image：混淆过的图片字符验证码（svg-captcha）。有些环境里浏览器跑不动 Cap 的 Web Worker
    （老内核、只走 HTTP 拿不到 crypto.subtle），管理员可以换成图片。

  选了哪种，服务端就只认哪种：另一种的答案一律当 CAPTCHA_INVALID，另一种的挑战也不发。
  不然「换成图片」只是换了页面上的样子，脚本照样能挑它更好过的那一种来刷。
*/

export const AUTH_CAPTCHA_MODES = ["click", "image"] as const;
export type AuthCaptchaMode = (typeof AUTH_CAPTCHA_MODES)[number];
export const DEFAULT_AUTH_CAPTCHA_MODE: AuthCaptchaMode = "click";

/** 库里存的值认不出来（空、旧版本没有、被手改坏）一律按点击验证。 */
export function normalizeAuthCaptchaMode(value: unknown): AuthCaptchaMode {
  return value === "image" ? "image" : DEFAULT_AUTH_CAPTCHA_MODE;
}

export const AUTH_CAPTCHA_MODE_LABELS: Record<AuthCaptchaMode, string> = {
  click: "点击验证",
  image: "图片验证码",
};

/** 页面交给服务端的那份验证结果：点击验证是一枚令牌，图片是「挑战 id + 填的字符」。 */
export type AuthCaptchaSubmission =
  | { capToken: string }
  | { captchaId: string; captchaAnswer: string };

export type AuthCaptchaInput = {
  capToken?: string | null;
  captchaId?: string | null;
  captchaAnswer?: string | null;
};

/**
 * 这次请求带的是哪种验证、带全了没有：
 * · none：什么都没带（页面该先让人验证，服务端回 CAPTCHA_REQUIRED）
 * · mismatch：带了另一种的答案，或者两种都带了 —— 当成验证失败
 * · incomplete：图片验证码只带了 id 或只带了答案 —— 也当成验证失败
 * · ok：只带了选中那一种，且字段齐全
 */
export function classifyAuthCaptchaInput(mode: AuthCaptchaMode, input: AuthCaptchaInput): "none" | "mismatch" | "incomplete" | "ok" {
  const hasCap = !!String(input.capToken ?? "").trim();
  const hasImageId = !!String(input.captchaId ?? "").trim();
  const hasImageAnswer = !!String(input.captchaAnswer ?? "").trim();
  const hasImage = hasImageId || hasImageAnswer;
  if (!hasCap && !hasImage) return "none";
  if (mode === "click") return hasImage ? "mismatch" : "ok";
  if (hasCap) return "mismatch";
  return hasImageId && hasImageAnswer ? "ok" : "incomplete";
}

/** 页面拿到的验证结果 → 请求里那几个字段（没验证就什么都不带）。 */
export type AuthCaptchaFields = { capToken?: string; captchaId?: string; captchaAnswer?: string };

export function authCaptchaSubmissionFields(submission: AuthCaptchaSubmission | null | undefined): AuthCaptchaFields {
  if (!submission) return {};
  if ("capToken" in submission) {
    const capToken = submission.capToken.trim();
    return capToken ? { capToken } : {};
  }
  const captchaId = submission.captchaId.trim();
  const captchaAnswer = submission.captchaAnswer.trim();
  return captchaId && captchaAnswer ? { captchaId, captchaAnswer } : {};
}
