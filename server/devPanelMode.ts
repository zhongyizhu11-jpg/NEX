/*
  开发面板（FORWARDX_DEV_PANEL=1）的开关和固定账号。单独放一个小文件：
  运行时上下文、setup 路由、后台服务只需要「现在是不是开发面板」这一个判断，
  不该为此把 devPanel.ts 里几千行的演示数据种子一起拉进生产包。
*/
export const DEV_PANEL_FLAG = "FORWARDX_DEV_PANEL";
export const DEV_ADMIN_USERNAME = "dev.admin@forwardx.local";
export const DEV_ADMIN_PASSWORD = "forwardx-dev";

export function isDevPanelMode() {
  if (process.env.NODE_ENV === "production") return false;
  return process.env[DEV_PANEL_FLAG] === "1" || process.env[DEV_PANEL_FLAG] === "true";
}
