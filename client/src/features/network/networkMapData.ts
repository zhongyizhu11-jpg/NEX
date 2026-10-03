import { useMemo } from "react";

import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import type { ForwardMapLink } from "@shared/forwardMapLinks";

/**
 * 首页「概览」的原始数据：主机、隧道两条轻量列表（hosts.options / tunnels.options）、主机之间的
 * 转发连线（dashboard.forwardMap）和隧道协议开关。
 *
 * 单独一个文件、只引 trpc：它跟着首页首屏包走，页面一挂上就和别的请求一起发出去；
 * 把它们变成地图模型（中文地名表、线路状态……）的 networkMapModel 跟着地图卡片 lazy 进来。
 */

/** 协议开关一分钟内不重拉：它只在管理员改设置时变，过期了回到首页会在后台再取一次 */
const FORWARD_PROTOCOLS_STALE_MS = 60_000;
const EMPTY: any[] = [];
const EMPTY_LINKS: ForwardMapLink[] = [];

export type NetworkMapData = {
  hosts: any[];
  tunnels: any[];
  /** 主机之间的转发连线（规则 → 目标那台主机）；还没回来是空数组 */
  forwardLinks: ForwardMapLink[];
  /** system.forwardProtocols；还没回来是 undefined（按默认全开算） */
  forwardProtocols: unknown;
  /** 主机列表有结论了（取到了，或者取失败了）：在这之前不知道这张图该不该出现 */
  hostsSettled: boolean;
  loading: boolean;
};

export function useNetworkMapData(enabled: boolean): NetworkMapData {
  const hostsQuery = trpc.hosts.options.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  const forwardQuery = trpc.dashboard.forwardMap.useQuery(undefined, {
    enabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 5000,
    placeholderData: (previous) => previous,
  });
  // 协议开关和隧道页是同一份设置，但这里只取这一项，不拉整份 getSettings（证书、首页 HTML 都在里面）
  const protocolsQuery = trpc.system.forwardProtocols.useQuery(undefined, {
    enabled,
    staleTime: FORWARD_PROTOCOLS_STALE_MS,
    refetchOnWindowFocus: false,
  });
  const hosts = (hostsQuery.data as any[] | undefined) || EMPTY;
  const tunnels = (tunnelsQuery.data as any[] | undefined) || EMPTY;
  const forwardLinks = (forwardQuery.data as ForwardMapLink[] | undefined) || EMPTY_LINKS;
  const forwardProtocols = protocolsQuery.data;
  const hostsSettled = hostsQuery.data !== undefined || hostsQuery.isError;
  const loading = hostsQuery.isLoading || tunnelsQuery.isLoading;
  return useMemo(
    () => ({ hosts, tunnels, forwardLinks, forwardProtocols, hostsSettled, loading }),
    [hosts, tunnels, forwardLinks, forwardProtocols, hostsSettled, loading],
  );
}
