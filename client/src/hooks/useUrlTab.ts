import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { pickTabValue, tabForSearchChange } from "@/lib/urlTab";

type UseUrlTabOptions<T extends string> = {
  values: readonly T[];
  defaultValue: T;
  storageKey?: string;
  queryKey?: string;
  clearDefaultFromUrl?: boolean;
  /**
   * 默认 false：不记上次停在哪个 tab —— 刷新、从别的页面点进来都回到默认（第一个）。
   * 别处带着 ?tab= 跳过来照样打开那一个，打开后把它从地址栏去掉；点 tab 也不往地址栏写，
   * 免得一刷新又回到那一页。用户要求所有页面的分类条都这样（2.3.464 先只改了链路管理）。
   * 传 true 才回到老行为：记在 localStorage + 地址栏。
   */
  remember?: boolean;
};

/**
 * 地址栏里的查询串。
 *
 * **不能**从 wouter 的 `useLocation()` 里取：它只给路径，不含 `?` 后面的部分，
 * 于是 `location.split("?")[1]` 永远是空 —— `?tab=xxx` 深链接一直是个死功能，
 * 而且不报错，只是默默回落到默认 tab。
 */
function currentSearch() {
  if (typeof window === "undefined") return "";
  return window.location.search || "";
}

/** 去掉查询串里的某个键，返回 "?a=1" 或 ""。 */
function searchWithout(search: string, key: string) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has(key)) return search;
  params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

function readStoredTab<T extends string>(storageKey: string | undefined, coerce: (value: unknown) => T | null) {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    return coerce(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function writeStoredTab(storageKey: string | undefined, value: string) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // URL state still works when localStorage is unavailable.
  }
}

export function useUrlTab<T extends string>({
  values,
  defaultValue,
  storageKey,
  queryKey = "tab",
  clearDefaultFromUrl = true,
  remember = false,
}: UseUrlTabOptions<T>) {
  if (!remember) storageKey = undefined;
  const [location, setLocation] = useLocation();
  const valuesKey = values.join("\0");
  const allowedValues = useMemo(() => new Set<T>(values), [valuesKey]);

  const coerce = useCallback((value: unknown): T | null => {
    const raw = String(value || "");
    return allowedValues.has(raw as T) ? (raw as T) : null;
  }, [allowedValues]);

  // useLocation() 只随路径变；浏览器后退/前进只改查询串时要靠 useSearch() 才能重新渲染。
  const search = useSearch();

  const resolveTab = useCallback(() => {
    return pickTabValue(currentSearch(), readStoredTab(storageKey, coerce), values, defaultValue, queryKey);
  }, [coerce, defaultValue, queryKey, storageKey, valuesKey]);

  const [tab, setTabState] = useState<T>(() => resolveTab());
  const lastSearchRef = useRef<string | null>(null);

  useEffect(() => {
    const nowSearch = currentSearch();
    const previousSearch = lastSearchRef.current;
    lastSearchRef.current = nowSearch;
    // 不记的时候，地址栏里的 ?tab= 用完就去掉，免得刷新又回到那一页。
    const stripTabFromUrl = () => {
      if (remember) return;
      const stripped = searchWithout(nowSearch, queryKey);
      if (stripped === nowSearch) return;
      // 先记下去掉之后的查询串，下面这次地址变化就不会被当成「tab 被去掉了」而换回默认。
      lastSearchRef.current = stripped;
      setLocation(`${location.split("?")[0] || "/"}${stripped}`, { replace: true });
    };
    let next: T | null;
    if (previousSearch === null) {
      // 第一次：地址栏 > 上次存的 > 默认
      next = resolveTab();
      stripTabFromUrl();
    } else {
      next = tabForSearchChange(previousSearch, nowSearch, values, defaultValue, {
        queryKey,
        clearDefaultFromUrl,
        storedValue: readStoredTab(storageKey, coerce),
      });
      if (next === null) return;
      // 已经在这一页时别处又带着 ?tab= 跳过来（比如设置页里点「去邮箱设置」）：一样用一次就去掉。
      stripTabFromUrl();
    }
    const resolved = next;
    setTabState((current) => (current === resolved ? current : resolved));
    writeStoredTab(storageKey, resolved);
  }, [clearDefaultFromUrl, coerce, defaultValue, location, queryKey, remember, resolveTab, search, setLocation, storageKey, valuesKey]);

  const setTab = useCallback((nextValue: T | string) => {
    const next = coerce(nextValue) || defaultValue;
    setTabState(next);
    writeStoredTab(storageKey, next);

    // 路径从 wouter 拿（它给的就是路径），查询串从地址栏拿。
    const path = location.split("?")[0];
    if (!remember) {
      const stripped = searchWithout(currentSearch(), queryKey);
      if (stripped !== currentSearch()) {
        lastSearchRef.current = stripped;
        setLocation(`${path || "/"}${stripped}`, { replace: true });
      }
      return;
    }
    const params = new URLSearchParams(currentSearch());
    if (clearDefaultFromUrl && next === defaultValue) {
      params.delete(queryKey);
    } else {
      params.set(queryKey, next);
    }
    const nextQuery = params.toString();
    const nextLocation = `${path || "/"}${nextQuery ? `?${nextQuery}` : ""}`;
    if (nextLocation !== `${path}${currentSearch()}`) setLocation(nextLocation);
  }, [clearDefaultFromUrl, coerce, defaultValue, location, queryKey, remember, setLocation, storageKey]);

  return [tab, setTab] as const;
}
