import { toast } from "sonner";
import { friendlyErrorNotificationText } from "./errorNotificationText";
import { translateServerText, translateText } from "@/i18n";

/*
  结果通知的显示时长：所有通知一律 1 秒。

  「规则已更新」「已复制」这类提示只是确认一下，停久了会一直盖在手机屏幕的列表上，
  挡住下一步要点的开关和按钮。用户要求报错、警告也一样 1 秒（2026-10-10），
  原因写在页面上（诊断结果、表单提示），通知只负责提一句。
  调用处传了 duration 也按 1 秒，免得个别地方又停很久。
*/
export const TOAST_DURATION_MS = 1000;

type ToastFn = (message: Parameters<typeof toast.success>[0], data?: Parameters<typeof toast.success>[1]) => string | number;

function withFixedDuration(original: ToastFn): ToastFn {
  return (message, data) => original(message, { ...data, duration: TOAST_DURATION_MS });
}

/*
  英文界面：通知里的中文在调用处就换掉（页面上的 DOM 翻译器也会翻，但这样连读屏播报的也是英文）。
  报错多半是服务端原话，只认词典里整句对得上的，认不出就留中文；成功 / 提示是前端拼的，模板也可以套。
*/
function translateToastData(data: Parameters<ToastFn>[1], translate: (text: string) => string): Parameters<ToastFn>[1] {
  if (!data || typeof data.description !== "string") return data;
  return { ...data, description: translate(data.description) };
}

function withTranslatedText(original: ToastFn): ToastFn {
  return (message, data) => original(typeof message === "string" ? translateText(message) : message, translateToastData(data, translateText));
}

/** 报错通知顺手把认得出的底层报错（OpenSSL / fetch failed）换成人话，见 errorNotificationText.ts。 */
function withFriendlyErrorText(original: ToastFn): ToastFn {
  const friendly = (text: string) => translateServerText(friendlyErrorNotificationText(text));
  return (message, data) => original(typeof message === "string" ? friendly(message) : message, translateToastData(data, friendly));
}

let installed = false;

export function installToastDurations(target: typeof toast = toast) {
  if (installed && target === toast) return;
  if (target === toast) installed = true;
  target.success = withTranslatedText(withFixedDuration(target.success.bind(target)));
  target.info = withTranslatedText(withFixedDuration(target.info.bind(target)));
  target.message = withTranslatedText(withFixedDuration(target.message.bind(target)));
  target.error = withFriendlyErrorText(withFixedDuration(target.error.bind(target)));
  target.warning = withTranslatedText(withFixedDuration(target.warning.bind(target)));
}
