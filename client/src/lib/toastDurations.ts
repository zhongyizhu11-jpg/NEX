import { toast } from "sonner";

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

let installed = false;

export function installToastDurations(target: typeof toast = toast) {
  if (installed && target === toast) return;
  if (target === toast) installed = true;
  target.success = withFixedDuration(target.success.bind(target));
  target.info = withFixedDuration(target.info.bind(target));
  target.message = withFixedDuration(target.message.bind(target));
  target.error = withFixedDuration(target.error.bind(target));
  target.warning = withFixedDuration(target.warning.bind(target));
}
