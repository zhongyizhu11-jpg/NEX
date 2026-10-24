import { DISCORD_START_PATH, discordLoginErrorMessage, sanitizeDiscordInviteCode } from "@shared/discordLogin";
import { createOAuthLoginReturn } from "@/features/oauthLogin/oauthLoginReturn";

// Discord 回调带回来的 ?discordError / ?discordLinked / #discordTwoFactor，规则见 oauthLoginReturn.ts。
const discord = createOAuthLoginReturn({
  key: "discord",
  fallbackUsername: "Discord 账号",
  startPath: DISCORD_START_PATH,
  errorMessage: discordLoginErrorMessage,
  sanitizeInviteCode: sanitizeDiscordInviteCode,
});

export const parseDiscordLoginReturn = discord.parse;
export const stripDiscordLoginReturnFromUrl = discord.stripFromUrl;
export const discordWebStartUrl = discord.webStartUrl;
