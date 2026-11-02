import { useCallback } from "react";
import { useLocation, useSearch } from "wouter";

/*
  线路详情的深链（2.3.506）。

  看线路的地方有四处：链路管理 › 线路概览（管理员）、网络拓扑（拓扑图 / 我的线路）、订阅管理的订阅内容、
  首页概览图。原来各自用各自的办法跳：有的打开规则编辑框（/rules?edit=），有的按名字搜（/rules?q=），
  有的就地开详情 —— 同一条线路点进去看到的不一样，也没法把「这条线路」发给别人。

  现在统一成一个地址：/rules?line=<规则 id>。转发规则页认这个参数，打开的是线路详情（和线路概览里
  点一张卡打开的是同一个面板）；打开时地址栏里一直带着它，复制下来发给别人就是这条线路，关掉就去掉。
  线路概览自己也认 ?line=（/tunnels?line=<id>），在那一页里点开的就留在那一页。
*/

export const LINE_PARAM = "line";

/** 一条线路（开了线路组的转发规则）的详情地址：谁都能打开（转发规则页人人都有）。 */
export function lineDetailHref(ruleId: number) {
  return `/rules?${LINE_PARAM}=${Math.trunc(Number(ruleId))}`;
}

/** 地址栏查询串里取一个正整数参数；没有、不是正整数都是 null。 */
export function readPositiveParam(search: string, key: string): number | null {
  const raw = String(search || "");
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  if (!query) return null;
  try {
    const value = Number(new URLSearchParams(query).get(key) || "");
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 换掉（或去掉）查询串里的一个参数，别的参数原样留着。返回带 ? 的串，空了就是 ""。 */
export function searchWithParam(search: string, key: string, value: number | string | null): string {
  const raw = String(search || "");
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  if (value === null || value === "") params.delete(key);
  else params.set(key, String(value));
  const next = params.toString();
  return next ? `?${next}` : "";
}

/**
 * 把一个「打开的是哪一个」的状态放进地址栏：读的是 ?key=，写的时候换掉地址（不新增历史，
 * 免得关一个弹窗要按两次后退）。
 */
export function useSearchIdParam(key: string): [number | null, (next: number | null) => void] {
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const value = readPositiveParam(search, key);
  const setValue = useCallback((next: number | null) => {
    const current = typeof window === "undefined" ? "" : window.location.search;
    const nextSearch = searchWithParam(current, key, next && next > 0 ? next : null);
    if (nextSearch === (current === "?" ? "" : current)) return;
    setLocation(`${location.split("?")[0] || "/"}${nextSearch}`, { replace: true });
  }, [key, location, setLocation]);
  return [value, setValue];
}
