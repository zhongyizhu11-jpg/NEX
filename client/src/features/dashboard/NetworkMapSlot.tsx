import { lazy, Suspense, useEffect, useState } from "react";

import { NetworkMapCardPlaceholder } from "@/components/network/NetworkMapPlaceholder";
import { useNetworkMapData } from "@/features/network/networkMapData";

/**
 * 首页里「概览」那一格。首屏包里只有这个小壳：发请求、占位置；卡片本身（地图模型、中文地名表、
 * 连线图）lazy 进来。
 *
 * 主机 / 隧道 / 转发连线 / 协议开关几条请求页面一挂上就发，和 health 并行，不等它回来再排队。
 * 卡片的代码也在这时开始取（挂载之后、首屏画完才开始），数据回来时多半已经到了。
 *
 * 主机列表回来之前不知道这张图该不该出现：上次这里有图（localStorage 记一个 0 / 1）就先占着
 * 同样大小的一块，图到了直接盖上，页面不跳；上次没有就先不占，免得没主机的账号每次都闪一下。
 */
const loadCard = () => import("./NetworkMapSection");
const NetworkMapCard = lazy(loadCard);

const HINT_KEY = "forwardx.home.netmap";

function readHint(scope: string): boolean {
  try {
    return window.localStorage.getItem(`${HINT_KEY}.${scope}`) === "1";
  } catch {
    return false;
  }
}

function writeHint(scope: string, shown: boolean) {
  try {
    window.localStorage.setItem(`${HINT_KEY}.${scope}`, shown ? "1" : "0");
  } catch {
    // 无痕模式 / 存储被禁：只是少一个占位提示
  }
}

export function NetworkMapSlot({ enabled = true, cacheScope = "current", onOpen }: {
  /** health 说一台主机都没有时为 false（health 还没回来时照常取，不等它） */
  enabled?: boolean;
  /** 占位提示按账号分开记 */
  cacheScope?: string;
  onOpen: (href: string) => void;
}) {
  const data = useNetworkMapData(enabled);
  const [expected] = useState(() => readHint(cacheScope));
  /** 有没有主机：null = 还不知道 */
  const hasHosts = !enabled ? false : data.hostsSettled ? data.hosts.length > 0 : null;

  useEffect(() => {
    if (hasHosts !== null) writeHint(cacheScope, hasHosts);
  }, [cacheScope, hasHosts]);

  // 有图（或上次有图）时，卡片代码跟数据一起取，不等数据回来再排队；
  // 第一次来、还不知道有没有主机时不预取，没主机的账号一个字节都不多下
  const prefetch = hasHosts === true || (hasHosts === null && expected);
  useEffect(() => {
    if (!prefetch) return;
    loadCard().catch(() => { /* 取不到时 lazy 渲染那一下会再取、再报错 */ });
  }, [prefetch]);

  if (hasHosts === false) return null;
  if (hasHosts === null) return expected ? <NetworkMapCardPlaceholder /> : null;
  return (
    <Suspense fallback={<NetworkMapCardPlaceholder />}>
      <NetworkMapCard data={data} onOpen={onOpen} />
    </Suspense>
  );
}
