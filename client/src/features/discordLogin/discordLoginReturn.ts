import { DISCORD_START_PATH, discordLoginErrorMessage, isDiscordLoginErrorCode, sanitizeDiscordInviteCode } from "@shared/discordLogin";
import { sanitizeRedirectPath } from "@shared/googleLogin";

/*
  Discord 回调跳回登录页 / 个人资料页时带回来的东西（和 Google 登录一个套路）：
  - ?discordError=<码>          失败了，按码显示中文提示
  - ?discordLinked=1             绑定成功（个人资料页）
  - #discordTwoFactor=<挑战 ID>&u=<用户名>&exp=<秒>&next=<路径>
                                 Discord 认出了人，但账户开了双重验证，要在登录页输验证码
  挑战 ID 放在 # 后面：不会发给服务器、不进 Referer；读到后立刻从地址栏抹掉。
*/

export type DiscordLoginReturn = {
  errorMessage: string | null;
  linked: boolean;
  twoFactor: { challengeId: string; username: string; expiresInSeconds: number; next: string } | null;
};

export function parseDiscordLoginReturn(search: string, hash: string): DiscordLoginReturn {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const errorCode = query.get("discordError");
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const challengeId = String(fragment.get("discordTwoFactor") || "").trim();
  const twoFactor = /^[a-f0-9]{16,128}$/i.test(challengeId)
    ? {
      challengeId,
      username: String(fragment.get("u") || "").slice(0, 128) || "Discord 账号",
      expiresInSeconds: Math.min(600, Math.max(30, Number(fragment.get("exp")) || 300)),
      next: sanitizeRedirectPath(fragment.get("next"), "/"),
    }
    : null;
  return {
    errorMessage: errorCode ? discordLoginErrorMessage(isDiscordLoginErrorCode(errorCode) ? errorCode : "server_error") : null,
    linked: query.get("discordLinked") === "1",
    twoFactor,
  };
}

/** 把上面这些参数从地址栏去掉（不刷新页面），刷新或分享链接时不会再弹一次。 */
export function stripDiscordLoginReturnFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["discordError", "discordLinked"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (url.hash.includes("discordTwoFactor=")) {
    url.hash = "";
    changed = true;
  }
  if (changed) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** 网页里点「使用 Discord 登录」要去的地址（服务端会再换到面板公开地址上）。 */
export function discordWebStartUrl(mode: "login" | "link", redirect: string, inviteCode?: string | null) {
  const params = new URLSearchParams({ mode, redirect: sanitizeRedirectPath(redirect, mode === "link" ? "/profile" : "/") });
  const invite = mode === "login" ? sanitizeDiscordInviteCode(inviteCode) : null;
  if (invite) params.set("invite", invite);
  return `${DISCORD_START_PATH}?${params.toString()}`;
}
