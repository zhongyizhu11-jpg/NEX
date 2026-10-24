import type { ComponentProps } from "react";
import { trpc } from "@/lib/trpc";
import { OAuthLoginButton, type OAuthLoginProvider } from "@/features/oauthLogin/OAuthLoginButton";
import DiscordMark from "./DiscordMark";
import { discordWebStartUrl } from "./discordLoginReturn";

const DISCORD: OAuthLoginProvider = {
  label: "Discord",
  mark: <DiscordMark />,
  webStartUrl: discordWebStartUrl,
  appWaitingHint: "在打开的浏览器里授权 Discord 后回到这里，会自动登录。",
  useAppMutations: () => ({
    start: trpc.discordAuth.appStart.useMutation(),
    status: trpc.discordAuth.appStatus.useMutation(),
    cancel: trpc.discordAuth.appCancel.useMutation(),
  }),
};

/** 登录页的「使用 Discord 登录」，做法见 OAuthLoginButton。 */
export default function DiscordLoginButton(props: Omit<ComponentProps<typeof OAuthLoginButton>, "provider">) {
  return <OAuthLoginButton provider={DISCORD} {...props} />;
}
