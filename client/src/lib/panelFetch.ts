import { mobileAuth } from "./mobileAuth";

/**
 * 请求面板的 /api/…：浏览器里直接同源发；手机 App 里换成登录时填的面板地址，并带上 App 的登录令牌。
 * tRPC（main.tsx）和实时通知（hooks/useLiveEvents.ts）共用这一份，两边认人的方式一样。
 */
export function panelFetch(input: RequestInfo | URL, init?: RequestInit) {
  let requestInput = input;
  if (mobileAuth.isNative) {
    const panelUrl = mobileAuth.getPanelUrl();
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const parsed = new URL(rawUrl, window.location.href);
    if (panelUrl && parsed.pathname.startsWith("/api/")) {
      requestInput = `${panelUrl}${parsed.pathname}${parsed.search}`;
    }
  }
  const headers = new Headers(init?.headers);
  if (mobileAuth.isNative) {
    headers.set("x-forwardx-mobile", "1");
    const token = mobileAuth.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return globalThis.fetch(requestInput, {
    ...(init ?? {}),
    headers,
    credentials: "include",
  });
}
