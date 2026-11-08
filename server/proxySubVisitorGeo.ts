/**
 * 订阅「按访客就近」：拉订阅的访客在哪。
 *
 * 只查面板自带的离线库（server/ipRegionOffline.ts）：拉订阅的是终端用户，它的 IP 一个都不能发给第三方
 * （server/ipGeoPrivacy.test.ts 钉着）。离线库缺了、IP 是内网、国家对不上城市表 → null，排序退回按地区。
 */

import { lookupOfflineIpRegion } from "./ipRegionOffline";
import { proxySubVisitorBucket, proxySubVisitorGeoFromRegion, type ProxySubVisitorGeo } from "../shared/proxySubGeo";
import type { ProxySubSortMode } from "../shared/proxySubTokenScope";

export async function resolveProxySubVisitorGeo(ip: string): Promise<ProxySubVisitorGeo | null> {
  const address = String(ip || "").trim();
  if (!address) return null;
  const region = await lookupOfflineIpRegion(address).catch(() => null);
  return proxySubVisitorGeoFromRegion(region);
}

/**
 * 订阅缓存键里多出来的那一格：只有「按访客就近」且查到了访客位置时才有（国家 + 取整到 1° 的经纬度）。
 * 别的排序返回空数组，键和以前逐字一样；查不到位置时也不加 —— 那时排的是按地区，和位置无关。
 */
export function proxySubVisitorCacheParts(sortMode: ProxySubSortMode | string, visitor: ProxySubVisitorGeo | null | undefined): unknown[] {
  if (sortMode !== "nearest" || !visitor) return [];
  return [proxySubVisitorBucket(visitor)];
}
