import { getSetting } from "./repositories/settingsRepository";

/*
  Telegram 登录单独开关（上游 2.3.298）：默认开，只有明确存成 "false" 才关。

  只管「用 Telegram 登录面板」这一件事 —— 登录页的快捷登录、机器人发的一次性网页登录链接、
  WebApp 里自动登录、手机 App 的 Telegram 确认登录。机器人本身、通知、账号绑定 / 解绑都不受影响：
  有的站只拿机器人发提醒，不想让 Telegram 账号变成第二把登录钥匙。
*/
export const TELEGRAM_LOGIN_ENABLED_SETTING = "telegramLoginEnabled";
export const TELEGRAM_LOGIN_SWITCHED_OFF_MESSAGE = "管理员已关闭 Telegram 登录，请使用账号密码登录";

export function telegramLoginSwitchOn(value: string | null | undefined) {
  return value !== "false";
}

export async function isTelegramLoginEnabled() {
  return telegramLoginSwitchOn(await getSetting(TELEGRAM_LOGIN_ENABLED_SETTING));
}
