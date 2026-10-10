import { toast } from "sonner";

/*
  结果通知的显示时长。

  「规则已更新」这类成功提示只是确认一下，默认 4 秒会一直盖在手机屏幕的列表上，
  挡住下一步要点的开关和按钮。成功 / 普通 / 提示缩短到 1 秒；错误和警告保持
  默认，要留时间读原因。调用处显式传了 duration 的照旧以调用处为准。
*/
export const SHORT_TOAST_DURATION_MS = 1000;

type ToastFn = (message: Parameters<typeof toast.success>[0], data?: Parameters<typeof toast.success>[1]) => string | number;

function withShortDuration(original: ToastFn): ToastFn {
  return (message, data) => original(message, { duration: SHORT_TOAST_DURATION_MS, ...data });
}

let installed = false;

export function installShortToastDurations(target: typeof toast = toast) {
  if (installed && target === toast) return;
  if (target === toast) installed = true;
  target.success = withShortDuration(target.success.bind(target));
  target.info = withShortDuration(target.info.bind(target));
  target.message = withShortDuration(target.message.bind(target));
}
