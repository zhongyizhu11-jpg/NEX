import type { ComponentProps } from "react";
import { trpc } from "@/lib/trpc";
import { OAuthLoginButton, type OAuthLoginProvider } from "@/features/oauthLogin/OAuthLoginButton";
import GoogleMark from "./GoogleMark";
import { googleWebStartUrl } from "./googleLoginReturn";

const GOOGLE: OAuthLoginProvider = {
  label: "Google",
  mark: <GoogleMark />,
  webStartUrl: googleWebStartUrl,
  appWaitingHint: "在打开的浏览器里选好 Google 账号后回到这里，会自动登录。",
  useAppMutations: () => ({
    start: trpc.googleAuth.appStart.useMutation(),
    status: trpc.googleAuth.appStatus.useMutation(),
    cancel: trpc.googleAuth.appCancel.useMutation(),
  }),
};

/** 登录页的「使用 Google 登录」，做法见 OAuthLoginButton。 */
export default function GoogleLoginButton(props: Omit<ComponentProps<typeof OAuthLoginButton>, "provider">) {
  return <OAuthLoginButton provider={GOOGLE} {...props} />;
}
