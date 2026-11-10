import { IMPERSONATION_ENDED_MESSAGE, IMPERSONATION_HASH_PARAM, IMPERSONATION_TOKEN_PREFIX } from "@shared/userImpersonation";

/*
  管理员「进入用户后台」的那个新标签页（上游 v2.3.299：在新窗口进入普通用户后台，不影响原有登录）。

  浏览器里的登录 cookie 是整个站点共用的，换了它，管理员所有标签页都会变成那个用户。所以代入不碰 cookie：
  新标签页拿到一枚代入令牌（服务端 users.enterUserBackend 发的），之后这个标签页发往本站 /api/ 的每个请求
  都换成 `Authorization: Bearer nxu_…`，并且 credentials: "omit" —— 管理员的 cookie 根本不随请求发出去。
  原来的标签页什么都没变，照常是管理员。

  令牌放在哪：
  · 新标签页地址 #user-session=…（# 后面不发给服务器、不进访问日志），一读到就从地址栏删掉；
  · 之后存在这个标签页自己的 sessionStorage 里（刷新还在，别的标签页看不到），关掉标签页就没了。

  失败关闭：这个标签页一旦被认成代入窗口（window.name 打了记号），令牌没了、坏了、过期了、被服务端判无效，
  都只显示「代入已结束」，所有 /api/ 请求直接拒掉 —— 绝不悄悄落回 cookie 变成管理员。
*/

const STORAGE_KEY = "nex.userImpersonation";
const WINDOW_NAME = "nex-user-impersonation";
const TOKEN_PATTERN = new RegExp(`^${IMPERSONATION_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

export type ImpersonationState =
  | { mode: "normal" }
  | { mode: "active"; expiresAt: number }
  | { mode: "ended" };

type EntryWindow = {
  location: Pick<Location, "hash" | "pathname" | "search" | "href" | "origin">;
  history: Pick<History, "replaceState" | "state">;
  name: string;
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

type Saved = { token: string; expiresAt: number };

function parseSaved(value: string | null): Saved | null {
  if (!value) return null;
  try {
    const data = JSON.parse(value) as Partial<Saved>;
    const token = String(data.token || "");
    const expiresAt = Number(data.expiresAt);
    if (!TOKEN_PATTERN.test(token) || !Number.isFinite(expiresAt)) return null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

export function createImpersonationWindow(browser: EntryWindow, now: () => number = Date.now) {
  let state: ImpersonationState = { mode: "normal" };
  let token = "";
  const listeners = new Set<() => void>();
  const publish = (next: ImpersonationState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  const finish = () => {
    if (state.mode === "normal") return;
    token = "";
    try {
      browser.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // 存储不可用也没关系：window.name 的记号还在，刷新后照样是「已结束」，不会落回 cookie。
    }
    if (state.mode !== "ended") publish({ mode: "ended" });
  };

  function initialize() {
    const params = new URLSearchParams(String(browser.location.hash || "").replace(/^#/, ""));
    const incoming = params.get(IMPERSONATION_HASH_PARAM);
    let saved: string | null = null;
    try {
      saved = browser.sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // 读不了存储：下面按「没有令牌」处理，代入窗口失败关闭。
    }
    if (incoming === null && saved === null && browser.name !== WINDOW_NAME) return;
    browser.name = WINDOW_NAME;
    // 先当成已结束，确认令牌可用才改成 active：中间任何一步出错都停在「已结束」。
    state = { mode: "ended" };
    let candidate: Saved | null = null;
    if (incoming !== null) {
      const expiresAt = Number(params.get("exp"));
      params.delete(IMPERSONATION_HASH_PARAM);
      params.delete("exp");
      const rest = params.toString();
      // 在任何渲染、任何请求之前把令牌从地址栏和历史记录里拿掉。
      browser.history.replaceState(browser.history.state, "", `${browser.location.pathname}${browser.location.search}${rest ? `#${rest}` : ""}`);
      candidate = TOKEN_PATTERN.test(incoming) && Number.isFinite(expiresAt) ? { token: incoming, expiresAt } : null;
      if (candidate) {
        try {
          browser.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
        } catch {
          // 存不下也能用到刷新为止；刷新之后就是「已结束」。
        }
      }
    } else {
      candidate = parseSaved(saved);
    }
    if (!candidate || candidate.expiresAt <= now()) {
      finish();
      return;
    }
    token = candidate.token;
    state = { mode: "active", expiresAt: candidate.expiresAt };
  }

  function wrapFetch(original: typeof fetch): typeof fetch {
    return (input, init) => {
      if (state.mode === "normal") return original(input, init);
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let url: URL;
      try {
        url = new URL(raw, browser.location.href);
      } catch {
        return original(input, init);
      }
      // 别的站点、静态资源不带令牌，也不需要拦。
      if (url.origin !== browser.location.origin || !url.pathname.startsWith("/api/")) return original(input, init);
      if (state.mode !== "active" || state.expiresAt <= now() || !token) {
        finish();
        return Promise.reject(new Error(IMPERSONATION_ENDED_MESSAGE));
      }
      const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
      headers.set("Authorization", `Bearer ${token}`);
      // 不带 cookie：管理员的登录不会随这个标签页的任何请求发出去。
      return original(input, { ...(init ?? {}), headers, credentials: "omit" });
    };
  }

  return {
    initialize,
    wrapFetch,
    finish,
    getState: () => state,
    /** 这个标签页是不是代入窗口（进行中或已结束都算）。 */
    isEntry: () => state.mode !== "normal",
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const browserWindow: EntryWindow | null = typeof window === "undefined" ? null : window;

/** 全站一份。main.tsx 在建任何请求之前调 initialize() 并包上 fetch。 */
export const userImpersonation = createImpersonationWindow(
  browserWindow ?? {
    location: { hash: "", pathname: "/", search: "", href: "http://localhost/", origin: "http://localhost" },
    history: { state: null, replaceState: () => undefined },
    name: "",
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  },
);

/**
 * 用户管理里点「进入后台」：必须在点击的同一个调用栈里先开窗口（浏览器只放行用户手势里的弹窗），
 * 拿到令牌后再把它导到面板首页。拿不到就把空窗口关掉。
 * 新窗口断开 opener：它不该能反过来操纵管理员这个标签页。
 */
export async function openUserBackend(issue: () => Promise<{ token: string; expiresAt: number }>) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error("浏览器拦下了新窗口，请允许本站弹出窗口后重试");
  try {
    popup.opener = null;
    popup.name = WINDOW_NAME;
    const result = await issue();
    const hash = new URLSearchParams({ [IMPERSONATION_HASH_PARAM]: result.token, exp: String(result.expiresAt) });
    if (!popup.closed) popup.location.replace(`${window.location.origin}/#${hash.toString()}`);
  } catch (error) {
    popup.close();
    throw error;
  }
}
