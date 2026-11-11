import { OIDC_START_PATH, oidcLoginErrorMessage } from "@shared/oidcLogin";
import { sanitizeGoogleInviteCode } from "@shared/googleLogin";
import { createOAuthLoginReturn } from "@/features/oauthLogin/oauthLoginReturn";

// 通用 OIDC 回调带回来的 ?oidcError / ?oidcLinked / #oidcTwoFactor，规则见 oauthLoginReturn.ts（和 Google、Discord 同一套）。
const oidc = createOAuthLoginReturn({
  key: "oidc",
  fallbackUsername: "OIDC 账号",
  startPath: OIDC_START_PATH,
  errorMessage: oidcLoginErrorMessage,
  // 邀请码规则和 Google 一样（字母数字 4~32 位），服务端也是用同一个函数清洗的
  sanitizeInviteCode: sanitizeGoogleInviteCode,
});

export const parseOidcLoginReturn = oidc.parse;
export const stripOidcLoginReturnFromUrl = oidc.stripFromUrl;
export const oidcWebStartUrl = oidc.webStartUrl;
