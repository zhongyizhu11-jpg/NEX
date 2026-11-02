/*
  轮询间隔只用这几档，新代码别再写裸数字。
  页面切到后台时 react-query 自己会停掉 refetchInterval（refetchIntervalInBackground 默认 false），
  不用每处再接 usePageVisible；只有明确写了 refetchIntervalInBackground: true 的才会在后台继续。
*/
export const POLLING_INTERVALS = {
  realtime: 1_000,
  interactive: 1_500,
  live: 2_000,
  active: 3_000,
  fast: 5_000,
  log: 10_000,
  normal: 15_000,
  slow: 30_000,
  minute: 60_000,
} as const;

export type PollingIntervalName = keyof typeof POLLING_INTERVALS;
export type QueryPollingInterval = number | false;

export function pollingInterval(name: PollingIntervalName, enabled = true): QueryPollingInterval {
  return enabled ? POLLING_INTERVALS[name] : false;
}

export function visiblePollingInterval(name: PollingIntervalName, visible = true): QueryPollingInterval {
  return pollingInterval(name, visible);
}
