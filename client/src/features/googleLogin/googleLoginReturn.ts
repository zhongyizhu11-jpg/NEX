import { GOOGLE_START_PATH, googleLoginErrorMessage, sanitizeGoogleInviteCode } from "@shared/googleLogin";
import { createOAuthLoginReturn } from "@/features/oauthLogin/oauthLoginReturn";

// Google 回调带回来的 ?googleError / ?googleLinked / #googleTwoFactor，规则见 oauthLoginReturn.ts。
const google = createOAuthLoginReturn({
  key: "google",
  fallbackUsername: "Google 账号",
  startPath: GOOGLE_START_PATH,
  errorMessage: googleLoginErrorMessage,
  sanitizeInviteCode: sanitizeGoogleInviteCode,
});

export const parseGoogleLoginReturn = google.parse;
export const stripGoogleLoginReturnFromUrl = google.stripFromUrl;
export const googleWebStartUrl = google.webStartUrl;
