/** 用户流量 / 速率输入框的解析：Users 页和「流量与权限设置」弹窗共用。 */

export function parseTrafficInputGB(value: string): number {
  // 纯数字输入，单位 GB，0 表示不限制
  const num = parseFloat(String(value).trim());
  if (isNaN(num) || num <= 0) return 0;
  return Math.floor(num * 1024 * 1024 * 1024);
}

export function parseSpeedInputMbps(value: string): number {
  const num = parseFloat(String(value).trim());
  if (isNaN(num) || num <= 0) return 0;
  return Math.floor(num);
}
