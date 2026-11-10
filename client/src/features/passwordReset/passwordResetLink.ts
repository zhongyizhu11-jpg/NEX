import { PASSWORD_RESET_HASH_PARAM } from "@shared/passwordReset";

/*
  重置链接长这样：https://面板/login#password-reset=nxr_…

  令牌放在 # 后面：浏览器不会把它发给服务器，访问日志、反代日志、Referer 里都没有。
  页面一拿到就从地址栏里删掉（replaceState），不留在浏览器历史里 —— 别人翻历史记录、
  或者用户把地址栏复制给别人看，都拿不到一条还能用的链接。令牌之后只放在组件的内存里。
*/
export function takePasswordResetToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): string | null {
  const params = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
  const token = params.get(PASSWORD_RESET_HASH_PARAM);
  if (token === null) return null;
  params.delete(PASSWORD_RESET_HASH_PARAM);
  const rest = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  // 长得不对的也照样「拿走」并返回空串：页面显示「链接无效」，而不是装作没看见。
  return token.length <= 128 ? token.trim() : "";
}
