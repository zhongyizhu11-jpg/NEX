/*
  上次诊断画的是不是现在这条路线（2.3.547，用户：「隧道换了出口，转发的不实时变过来？」）。

  诊断快照（forward_tests）是一行死数据：规则改了隧道、隧道换了出口 / 入口 / 中转、目标换了，弹窗照旧画旧路线
  （用户面板：13:57 把「华南-香港」的出口组换成单出口 jinx(39.9y)，规则「广港hkt/2」的弹窗还是入口 → hep ix → 目标）。
  排诊断时写在 requestMessage 里的 tunnelId / entryHostId / exitHostId / targetIp / targetPort 和现在的配置对一遍，
  再看诊断是不是早于链路最近一次换拓扑的时间，两条任一成立就是旧路线的：弹窗按现在的配置画、自动重测。
*/

export type DiagnosisRouteRequest = {
  kind?: string | null;
  tunnelId?: number | null;
  entryHostId?: number | null;
  exitHostId?: number | null;
  targetIp?: string | null;
  targetPort?: number | null;
};

export type DiagnosisRouteNow = {
  /** 规则现在的隧道（没有 = 直连） */
  tunnelId: number | null;
  /** 规则现在的入口主机（直连规则时是测的那台） */
  hostId: number | null;
  targetIp: string | null;
  targetPort: number | null;
  /** 隧道现在的入口 */
  tunnelEntryHostId?: number | null;
  /** 隧道现在的所有出口（主出口 + 负载均衡的额外出口 + 出口组成员） */
  tunnelExitHostIds?: readonly number[] | null;
  /** 隧道最近一次换拓扑的时间 */
  topologyChangedAt?: Date | string | number | null;
};

function epochMs(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function same(left: unknown, right: unknown) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

/** requestMessage 是排诊断时写的 JSON；不是 JSON（直连规则是 null）返回 null。 */
export function parseDiagnosisRouteRequest(raw: unknown): DiagnosisRouteRequest | null {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      kind: typeof parsed.kind === "string" ? parsed.kind : null,
      tunnelId: Number(parsed.tunnelId) || null,
      entryHostId: Number(parsed.entryHostId) || null,
      exitHostId: Number(parsed.exitHostId) || null,
      targetIp: typeof parsed.targetIp === "string" ? parsed.targetIp : null,
      targetPort: Number(parsed.targetPort) || null,
    };
  } catch {
    return null;
  }
}

/**
 * 上次诊断是不是旧路线的。
 * test：那行诊断（测的主机、排诊断时的请求、完成时间）；now：规则和隧道现在的样子。
 */
export function diagnosisRouteOutdated(
  test: { hostId?: number | null; requestMessage?: string | null; updatedAt?: Date | string | number | null },
  now: DiagnosisRouteNow,
): boolean {
  const request = parseDiagnosisRouteRequest(test.requestMessage);
  const testedAt = epochMs(test.updatedAt);
  // 链路换过拓扑、诊断在那之前：旧路线（库里时间只到秒，同一秒的算新的）
  const changedAt = epochMs(now.topologyChangedAt);
  if (Number(now.tunnelId || 0) > 0 && changedAt > 0 && testedAt > 0 && testedAt + 999 < changedAt) return true;
  if (request?.kind === "forward-via-tunnel") {
    if (Number(now.tunnelId || 0) <= 0) return true;
    if (Number(request.tunnelId || 0) !== Number(now.tunnelId)) return true;
    if (Number(now.tunnelEntryHostId || 0) > 0 && Number(request.entryHostId || 0) > 0 && Number(request.entryHostId) !== Number(now.tunnelEntryHostId)) return true;
    const exits = (now.tunnelExitHostIds || []).map(Number).filter((id) => id > 0);
    if (exits.length > 0 && Number(request.exitHostId || 0) > 0 && !exits.includes(Number(request.exitHostId))) return true;
    if (request.targetIp && now.targetIp && !same(request.targetIp, now.targetIp)) return true;
    if (Number(request.targetPort || 0) > 0 && Number(now.targetPort || 0) > 0 && Number(request.targetPort) !== Number(now.targetPort)) return true;
    return false;
  }
  if (request?.kind === "forward-group" || request?.kind === "forward-chain" || request?.kind === "line-segment") return false;
  // 直连规则：当时从哪台测的就是入口；规则改成走隧道、换了入口都算旧的
  if (Number(now.tunnelId || 0) > 0 && !request) return true;
  if (!request && Number(test.hostId || 0) > 0 && Number(now.hostId || 0) > 0 && Number(test.hostId) !== Number(now.hostId)) return true;
  return false;
}
