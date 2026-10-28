import { normalizeRouteEventKind } from "./routeGroup";

/*
  线路组最近切得多不多：卡片上那枚「24h 切换 ×N」。

  切换记录本来只在面板的「最近切换」列表里，一条条看得到、合起来看不到。可「切得频不频」
  恰恰是一眼要知道的：半小时切了四次，不管每一次的理由多正当，这条线路组都在来回漂 ——
  honk 把它叫 switchFlap（八次之内又切回上一条的那种）。数出来写在卡片上，人看一眼就知道
  该去调切换保护，而不是翻完二十条记录再自己数。
*/

export type RouteSwitchEventLike = {
  kind: string;
  /** Unix 毫秒 */
  at: number;
  reason?: string | null;
  fromKey?: string | null;
  toKey?: string | null;
  fromLabel?: string | null;
  toLabel?: string | null;
};

export type RouteSwitchSummary = {
  /** 最近 24 小时切了几次（只数 switch，预热、预检没过不算）。 */
  count24h: number;
  count1h: number;
  /** 其中由人工指定（pin）引起的。 */
  manual24h: number;
  /**
   * 在来回漂：一小时内切了 3 次以上，或者十分钟内 A → B → A 又切回去了。
   * 一次正常的故障切换不算；切出去又切回来才算。
   */
  flapping: boolean;
  lastAt: number | null;
  lastFromLabel: string | null;
  lastToLabel: string | null;
  lastReason: string | null;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FLAP_WINDOW_MS = 10 * 60_000;
const FLAP_PER_HOUR = 3;

function manualReason(reason: unknown) {
  const lower = String(reason ?? "").trim().toLowerCase();
  return lower === "pin" || lower === "unpin" || lower === "pin expired";
}

export function summarizeRouteSwitches(events: readonly RouteSwitchEventLike[], nowMs = Date.now()): RouteSwitchSummary {
  const switches = events
    .filter((event) => normalizeRouteEventKind(event.kind) === "switch" && Number.isFinite(event.at) && event.at <= nowMs + 60_000)
    .sort((left, right) => right.at - left.at);
  const recent24h = switches.filter((event) => nowMs - event.at <= DAY_MS);
  const recent1h = recent24h.filter((event) => nowMs - event.at <= HOUR_MS);
  let bounced = false;
  for (let index = 0; index + 1 < recent1h.length && !bounced; index += 1) {
    const later = recent1h[index];
    const earlier = recent1h[index + 1];
    if (!later.toKey || !earlier.fromKey) continue;
    if (later.toKey === earlier.fromKey && later.at - earlier.at <= FLAP_WINDOW_MS) bounced = true;
  }
  const last = switches[0] || null;
  return {
    count24h: recent24h.length,
    count1h: recent1h.length,
    manual24h: recent24h.filter((event) => manualReason(event.reason)).length,
    flapping: recent1h.length > FLAP_PER_HOUR || bounced,
    lastAt: last ? last.at : null,
    lastFromLabel: last?.fromLabel ?? null,
    lastToLabel: last?.toLabel ?? null,
    lastReason: last?.reason ?? null,
  };
}
