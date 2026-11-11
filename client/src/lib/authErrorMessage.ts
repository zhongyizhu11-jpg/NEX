/**
 * 登录、双重验证、注册和初始化向导里，服务端用错误码（有的带「:N」重试等待）表示可预期的失败，
 * 前端靠它做分支判断。但这些码不能原样弹给用户 —— 「LOGIN_RATE_LIMITED:5」谁也看不懂。
 * 所有展示错误的地方都过一遍这里；认不出来的消息原样返回（多半本来就是中文提示）。
 */

type RetryCode = {
  pattern: RegExp;
  message: (wait: number) => string;
};

const RETRY_CODES: RetryCode[] = [
  { pattern: /^LOGIN_RATE_LIMITED:(\d+)$/, message: (n) => `登录尝试过于频繁，请 ${n} 分钟后重试` },
  { pattern: /^TWO_FACTOR_RATE_LIMITED:(\d+)$/, message: (n) => `双重验证尝试过于频繁，请 ${n} 分钟后重试` },
  { pattern: /^TWO_FACTOR_CHALLENGE_RATE_LIMITED:(\d+)$/, message: (n) => `双重验证请求过于频繁，请 ${n} 分钟后重试` },
  { pattern: /^TELEGRAM_LOGIN_RATE_LIMITED:(\d+)$/, message: (n) => `Telegram 登录尝试过于频繁，请 ${n} 分钟后重试` },
  // 这个码带的是秒数，不是分钟。
  { pattern: /^CAPTCHA_REFRESH_RATE_LIMITED:(\d+)$/, message: (n) => `验证码刷新过于频繁，请 ${n} 秒后重试` },
];

const PLAIN_CODES: Record<string, string> = {
  EMAIL_RATE_LIMITED: "验证码发送过于频繁，请稍后再试",
  CAPTCHA_REQUIRED: "请先完成人机验证",
  CAPTCHA_REQUIRED_AFTER_FAIL: "用户名或密码错误，请完成人机验证后重试",
  CAPTCHA_INVALID: "验证码错误或已过期，请重新输入",
  CAPTCHA_CHALLENGE_UNAVAILABLE: "人机验证服务暂不可用，请稍后重试",
  CAPTCHA_LOAD_FAILED: "人机验证组件加载失败，请检查网络后重试",
  CAPTCHA_MODE_MISMATCH: "管理员刚换了人机验证方式，请刷新页面后重试",
  TELEGRAM_LOGIN_DISABLED: "Telegram 登录未启用，请改用账号密码登录",
  TELEGRAM_NOT_BOUND: "当前 Telegram 未绑定面板账号，请先使用账号密码登录并在面板完成绑定",
  TELEGRAM_WIDGET_REPLAYED: "Telegram 登录请求已失效，请重新发起登录",
  TELEGRAM_WEBAPP_REPLAYED: "自动登录请求已失效，请返回机器人重新打开 WebApp",
  TELEGRAM_WEBAPP_CHALLENGE_INVALID: "登录入口已失效，请返回机器人重新点击“打开面板”",
  TELEGRAM_WEBAPP_VERIFY_FAILED: "Telegram 自动登录校验失败，请在机器人中重新打开 WebApp",
  SETUP_LOCKED: "面板已完成初始化，初始化向导已锁定；请刷新页面后直接登录",
  SETUP_MIGRATION_RUNNING: "数据迁移正在进行，请等待迁移完成后再操作",
};

/** 把认证相关的错误码翻成中文；为空时用 fallback，认不出来的原样返回。 */
export function authErrorMessage(message: unknown, fallback = ""): string {
  const text = String(
    typeof message === "string" ? message : (message as { message?: unknown } | null | undefined)?.message ?? "",
  ).trim();
  if (!text) return fallback;
  for (const { pattern, message: format } of RETRY_CODES) {
    const match = pattern.exec(text);
    if (match) return format(Math.max(1, Number(match[1]) || 1));
  }
  return PLAIN_CODES[text] ?? text;
}
