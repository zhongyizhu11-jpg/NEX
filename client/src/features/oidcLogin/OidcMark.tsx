import { KeyRound } from "lucide-react";

/**
 * 通用 OIDC 的图标：一把钥匙。自建 IdP 五花八门（Pocket ID、Keycloak……），不去仿哪一家的标志。
 * 纯装饰：按钮上已经写了「使用 … 登录」，读屏不必再念一遍。
 */
export default function OidcMark({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return <KeyRound className={`${className} text-primary`} aria-hidden="true" focusable="false" />;
}
