/* 从 client/src/pages/Rules.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { loadReactGlobe } from "@/lib/reactGlobeLoader";
import { escapeTooltipHtml, hostGeoCoordinate } from "@/lib/hostGeo";
import { formatBytes } from "@shared/formatBytes";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import type { GlobeMethods } from "react-globe.gl";
import { lazy, Suspense, useState, useMemo, useEffect, useRef } from "react";
import { countryFeatureHasCode, normalizeCountryCode, type CountryFeatureLike } from "@/lib/countryFeatures";
import { RuleTargetGeo, normalizeAddressKey, ruleGlobeRouteHostIds, formatAddressWithPort } from "@/pages/Rules";

const ReactGlobe = lazy(loadReactGlobe) as typeof import("react-globe.gl").default;

const RULE_GLOBE_EARTH_IMAGE_URL = "/globe/earth-dark.jpg";

const RULE_GLOBE_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";

const RULE_GLOBE_PATH_SURFACE_ALTITUDE = 0.028;

const RULE_GLOBE_PATH_MIN_ALTITUDE = 0.04;

const RULE_GLOBE_PATH_MAX_ALTITUDE = 0.11;

const RULE_GLOBE_PATH_LAYER_ALTITUDE_STEP = 0.006;

const RULE_GLOBE_PATH_LAYER_ALTITUDE_MAX = 0.018;

const RULE_GLOBE_TARGET_OFFSET_DEGREES = 5.8;

const RULE_GLOBE_COLORS = ["#334155", "#4ade80", "#f59e0b", "#fb7185", "#2dd4bf", "#f97316", "#84cc16", "#64748b", "#f472b6", "#14b8a6"];


type RuleTrafficSummary = {
  bytesIn: number;
  bytesOut: number;
  connections: number;
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  latestLatencyAt?: Date | string | null;
};


type RuleGlobePoint = {
  id: string;
  kind: "host" | "target";
  name: string;
  lat: number;
  lng: number;
  color: string;
  regionText: string;
  addressText: string;
  countryCode: string;
  targetText?: string;
  note?: string;
  rule?: any;
};


type RuleGlobePath = {
  id: string;
  variant: "track" | "flow";
  rule: any;
  color: string;
  trackColor: string;
  routeText: string;
  finalHopText: string;
  targetText: string;
  bytesIn: number;
  bytesOut: number;
  connections: number;
  totalBytes: number;
  stroke: number;
  dashInitialGap: number;
  dashAnimateTime: number;
  coords: Array<{ lat: number; lng: number; alt: number }>;
};


type RuleGlobeCountryFeature = CountryFeatureLike & {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
};


function hashText(value: unknown) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}


function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  if (![red, green, blue].every(Number.isFinite)) return `rgba(148,163,184,${alpha})`;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha))})`;
}


function ruleGlobeColor(rule: any) {
  return RULE_GLOBE_COLORS[hashText(`${rule?.id}:${rule?.name}`) % RULE_GLOBE_COLORS.length];
}


function hostAddressCandidates(host: any | null | undefined) {
  return [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip, host?.tunnelEntryIp]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}


function microGeoCoordinate(geo: Pick<RuleTargetGeo, "geoLatitudeMicro" | "geoLongitudeMicro"> | null | undefined) {
  if (geo?.geoLatitudeMicro == null || geo?.geoLongitudeMicro == null) return null;
  const lat = Number(geo.geoLatitudeMicro) / 1_000_000;
  const lng = Number(geo.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}


function hostRegionText(host: any | null | undefined) {
  return [host?.geoCountryName || host?.geoCountryCode, host?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}


function hostCountryCode(host: any | null | undefined) {
  return normalizeCountryCode(host?.geoCountryCode);
}


function targetGeoRegionText(geo: RuleTargetGeo | null | undefined) {
  return [geo?.geoCountryName || geo?.geoCountryCode, geo?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}


function targetGeoCountryCode(geo: RuleTargetGeo | null | undefined) {
  return normalizeCountryCode(geo?.geoCountryCode);
}


function normalizeLongitude(lng: number) {
  if (lng < -180) return lng + 360;
  if (lng > 180) return lng - 360;
  return lng;
}


function longitudeDeltaDegrees(from: number, to: number) {
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}


function globeDistanceDegrees(start: Pick<RuleGlobePoint, "lat" | "lng">, end: Pick<RuleGlobePoint, "lat" | "lng">) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const lng1 = toRad(start.lng);
  const lng2 = toRad(end.lng);
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1))));
  return (angle * 180) / Math.PI;
}


function createRuleGlobeSegmentCoords(
  start: Pick<RuleGlobePoint, "lat" | "lng">,
  end: Pick<RuleGlobePoint, "lat" | "lng">,
  altitude: number,
  layerIndex: number,
  layerCount: number,
) {
  const dLat = end.lat - start.lat;
  const dLng = longitudeDeltaDegrees(start.lng, end.lng);
  const midLat = (start.lat + end.lat) / 2;
  const lngScale = Math.max(0.35, Math.cos((midLat * Math.PI) / 180));
  const projectedLng = dLng * lngScale;
  const distance = Math.sqrt(dLat * dLat + projectedLng * projectedLng);
  const greatCircleDistance = globeDistanceDegrees(start, end);
  const layerOffset = layerIndex - (layerCount - 1) / 2;
  const sideSpacing = layerCount > 1 ? Math.min(8, Math.max(1.8, greatCircleDistance / 24)) : 0;
  const offset = layerOffset * sideSpacing;
  const offsetLat = distance > 0 ? (projectedLng / distance) * offset : 0;
  const offsetLng = distance > 0 ? (-dLat / (distance * lngScale)) * offset : 0;
  const controlLat = Math.max(-85, Math.min(85, midLat + offsetLat));
  const controlLng = start.lng + dLng / 2 + offsetLng;
  const shortHopLift = greatCircleDistance < 18 ? (1 - greatCircleDistance / 18) * 0.026 : 0;
  const controlAlt = Math.min(0.16, altitude + shortHopLift);
  const steps = Math.max(12, Math.min(32, Math.ceil(greatCircleDistance / 3.2)));
  const coords: Array<{ lat: number; lng: number; alt: number }> = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const inv = 1 - t;
    const lat = inv * inv * start.lat + 2 * inv * t * controlLat + t * t * end.lat;
    const lng = inv * inv * start.lng + 2 * inv * t * controlLng + t * t * (start.lng + dLng);
    const alt = inv * inv * RULE_GLOBE_PATH_SURFACE_ALTITUDE + 2 * inv * t * controlAlt + t * t * RULE_GLOBE_PATH_SURFACE_ALTITUDE;
    coords.push({ lat: Math.max(-85, Math.min(85, lat)), lng: normalizeLongitude(lng), alt });
  }
  return coords;
}


function createRuleGlobeRouteCoords(routePoints: RuleGlobePoint[], layerIndex: number, layerCount: number, totalBytes: number) {
  const maxDistance = Math.max(0, ...routePoints.slice(0, -1).map((point, index) => globeDistanceDegrees(point, routePoints[index + 1])));
  const trafficLift = totalBytes > 0 ? Math.min(0.018, Math.log10(totalBytes + 1) / 420) : 0;
  const baseAltitude = Math.max(RULE_GLOBE_PATH_MIN_ALTITUDE, Math.min(RULE_GLOBE_PATH_MAX_ALTITUDE, 0.034 + maxDistance / 2100 + trafficLift));
  const altitude = baseAltitude + Math.min(RULE_GLOBE_PATH_LAYER_ALTITUDE_MAX, Math.abs(layerIndex - (layerCount - 1) / 2) * RULE_GLOBE_PATH_LAYER_ALTITUDE_STEP);
  const coords: Array<{ lat: number; lng: number; alt: number }> = [];
  routePoints.slice(0, -1).forEach((point, index) => {
    const segment = createRuleGlobeSegmentCoords(point, routePoints[index + 1], altitude, layerIndex, layerCount);
    if (coords.length > 0) segment.shift();
    coords.push(...segment);
  });
  return coords;
}


function ruleGlobeTargetOffset(anchor: RuleGlobePoint, rule: any, targetText: string) {
  const hash = hashText(`${rule?.id}:${targetText}`);
  const angle = ((hash % 360) * Math.PI) / 180;
  const ring = Math.floor((hash / 360) % 3);
  const distance = RULE_GLOBE_TARGET_OFFSET_DEGREES + ring * 1.6;
  const lat = Math.max(-82, Math.min(82, anchor.lat + Math.sin(angle) * distance));
  const lngScale = Math.max(0.45, Math.cos((anchor.lat * Math.PI) / 180));
  const lng = normalizeLongitude(anchor.lng + (Math.cos(angle) * distance) / lngScale);
  return { lat, lng };
}


function renderRuleGlobePointTooltip(point: RuleGlobePoint) {
  const rows = [
    { label: "类型", value: point.kind === "target" ? "目标端口" : "转发节点" },
    { label: "地址", value: point.addressText || "-" },
    { label: "地区", value: point.regionText || "未定位" },
    ...(point.targetText ? [{ label: "目标", value: point.targetText }] : []),
    ...(point.note ? [{ label: "说明", value: point.note }] : []),
  ];
  return `
    <div style="min-width:250px;max-width:360px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(point.name)}</div>
        <span style="width:9px;height:9px;border-radius:999px;background:${point.color};box-shadow:0 0 16px ${hexToRgba(point.color, .75)};"></span>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;">${escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
    </div>
  `;
}


function renderRuleGlobePathTooltip(path: RuleGlobePath) {
  const rows = [
    { label: "规则", value: path.rule?.name || `规则 #${path.rule?.id}` },
    { label: "入口", value: `:${path.rule?.sourcePort || "-"}` },
    { label: "目标", value: path.targetText },
    { label: "路径", value: path.routeText },
    { label: "末跳", value: path.finalHopText },
    { label: "入向", value: formatBytes(path.bytesIn) },
    { label: "出向", value: formatBytes(path.bytesOut) },
    { label: "连接", value: String(path.connections || 0) },
  ];
  return `
    <div style="min-width:290px;max-width:390px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(path.rule?.name || `规则 #${path.rule?.id}`)}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${path.color};box-shadow:0 0 14px ${hexToRgba(path.color, .8)};"></span>
          ${escapeTooltipHtml(formatBytes(path.totalBytes))}
        </div>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;">${escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
      <div style="margin-top:10px;color:#93c5fd;font-size:12px;">点击编辑规则</div>
    </div>
  `;
}


function buildRuleGlobeData(
  rules: any[],
  hosts: any[],
  tunnels: any[],
  forwardGroups: any[],
  trafficByRule: Map<number, RuleTrafficSummary>,
  targetGeoByAddress: Map<string, RuleTargetGeo>,
  targetGeoLookupReady: boolean,
) {
  const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
  const tunnelById = new Map<number, any>((tunnels || []).map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const forwardGroupById = new Map<number, any>((forwardGroups || []).map((group: any) => [Number(group.id), group]));
  (forwardGroups || []).forEach((group: any) => {
    const entryGroup = group?.entryGroup;
    const entryGroupId = Number(entryGroup?.id || group?.entryGroupId || 0);
    if (entryGroupId > 0 && entryGroup && !forwardGroupById.has(entryGroupId)) {
      forwardGroupById.set(entryGroupId, entryGroup);
    }
  });
  const hostPointById = new Map<number, RuleGlobePoint>();
  const hostByAddress = new Map<string, RuleGlobePoint>();

  const pointForHostId = (hostId: number) => {
    if (hostPointById.has(hostId)) return hostPointById.get(hostId) || null;
    const host = hostById.get(hostId);
    const coord = hostGeoCoordinate(host);
    if (!host || !coord) return null;
    const point: RuleGlobePoint = {
      id: `host:${hostId}`,
      kind: "host",
      name: String(host.name || `主机 #${hostId}`),
      lat: coord.lat,
      lng: coord.lng,
      color: "#e0f2fe",
      regionText: hostRegionText(host),
      addressText: hostAddressCandidates(host).join(" / "),
      countryCode: hostCountryCode(host),
    };
    hostPointById.set(hostId, point);
    hostAddressCandidates(host).forEach((address) => {
      hostByAddress.set(normalizeAddressKey(address), point);
    });
    return point;
  };

  (hosts || []).forEach((host: any) => {
    const point = pointForHostId(Number(host.id));
    if (!point) return;
  });

  const rawRoutes: Array<{
    rule: any;
    color: string;
    routePoints: RuleGlobePoint[];
    targetPoint: RuleGlobePoint;
    targetText: string;
    routeText: string;
    finalHopText: string;
    bytesIn: number;
    bytesOut: number;
    connections: number;
    totalBytes: number;
  }> = [];
  let skipped = 0;

  (rules || []).forEach((rule: any) => {
    const routeHostIds = ruleGlobeRouteHostIds(rule, tunnelById, forwardGroupById);
    const routePoints = routeHostIds.map((hostId: number) => pointForHostId(hostId)).filter(Boolean) as RuleGlobePoint[];
    if (routePoints.length === 0) {
      skipped += 1;
      return;
    }
    const targetText = formatAddressWithPort(String(rule.targetIp || "-"), Number(rule.targetPort || 0) || "-");
    const color = ruleGlobeColor(rule);
    const targetHostPoint = hostByAddress.get(normalizeAddressKey(rule.targetIp));
    const lastRoutePoint = routePoints[routePoints.length - 1];
    const targetGeo = targetGeoByAddress.get(normalizeAddressKey(rule.targetIp));
    const targetGeoCoord = microGeoCoordinate(targetGeo);
    const shouldOffsetTargetHost = !!targetHostPoint && targetHostPoint.id === lastRoutePoint.id;
    if (!targetHostPoint && !targetGeoCoord && !targetGeoLookupReady) {
      skipped += 1;
      return;
    }
    const targetCoord = shouldOffsetTargetHost
      ? ruleGlobeTargetOffset(lastRoutePoint, rule, targetText)
      : targetHostPoint
      ? { lat: targetHostPoint.lat, lng: targetHostPoint.lng }
      : targetGeoCoord
      ? targetGeoCoord
      : ruleGlobeTargetOffset(lastRoutePoint, rule, targetText);
    const targetRegionText = shouldOffsetTargetHost
      ? lastRoutePoint.regionText
      : targetHostPoint
      ? targetHostPoint.regionText
      : targetGeoCoord
      ? targetGeoRegionText(targetGeo)
      : "";
    const targetCountryCode = shouldOffsetTargetHost
      ? lastRoutePoint.countryCode
      : targetHostPoint
      ? targetHostPoint.countryCode
      : targetGeoCoord
      ? targetGeoCountryCode(targetGeo)
      : "";
    const targetNote = shouldOffsetTargetHost
      ? "目标端口位于出口节点，已偏移显示末跳"
      : targetHostPoint
      ? "目标地址匹配已登记主机"
      : targetGeoCoord
      ? `目标地址已定位${targetGeo?.resolvedAddress && normalizeAddressKey(targetGeo.resolvedAddress) !== normalizeAddressKey(rule.targetIp) ? `，解析到 ${targetGeo.resolvedAddress}` : ""}`
      : "目标地址未定位，临时放置在出口附近";
    const targetPoint: RuleGlobePoint = {
      id: `target:${rule.id}`,
      kind: "target",
      name: `目标 ${targetText}`,
      lat: targetCoord.lat,
      lng: targetCoord.lng,
      color,
      regionText: targetRegionText,
      addressText: targetText,
      countryCode: targetCountryCode,
      targetText,
      note: targetNote,
      rule,
    };
    const traffic = trafficByRule.get(Number(rule.id));
    const bytesIn = Number(traffic?.bytesIn || 0);
    const bytesOut = Number(traffic?.bytesOut || 0);
    const routeWithTarget = [...routePoints, targetPoint];
    const exitPoint = routePoints[routePoints.length - 1];
    const finalHopText = `${exitPoint.name} → ${targetText}`;
    rawRoutes.push({
      rule,
      color,
      routePoints: routeWithTarget,
      targetPoint,
      targetText,
      routeText: routeWithTarget.map((point) => point.kind === "target" ? targetText : point.name).join(" -> "),
      finalHopText,
      bytesIn,
      bytesOut,
      connections: Number(traffic?.connections || 0),
      totalBytes: bytesIn + bytesOut,
    });
  });

  const layerCounts = new Map<string, number>();
  rawRoutes.forEach((route) => {
    const start = route.routePoints[0];
    const end = route.routePoints[route.routePoints.length - 1];
    const key = `${start.lat.toFixed(2)}:${start.lng.toFixed(2)}|${end.lat.toFixed(2)}:${end.lng.toFixed(2)}`;
    layerCounts.set(key, (layerCounts.get(key) || 0) + 1);
  });
  const usedLayers = new Map<string, number>();
  const paths: RuleGlobePath[] = [];
  rawRoutes.forEach((route) => {
    const start = route.routePoints[0];
    const end = route.routePoints[route.routePoints.length - 1];
    const layerKey = `${start.lat.toFixed(2)}:${start.lng.toFixed(2)}|${end.lat.toFixed(2)}:${end.lng.toFixed(2)}`;
    const layerIndex = usedLayers.get(layerKey) || 0;
    usedLayers.set(layerKey, layerIndex + 1);
    const layerCount = layerCounts.get(layerKey) || 1;
    const coords = createRuleGlobeRouteCoords(route.routePoints, layerIndex, layerCount, route.totalBytes);
    const trafficScale = route.totalBytes > 0 ? Math.log10(route.totalBytes + 1) : 0;
    const stroke = 1.25 + Math.min(2.3, trafficScale / 2.4);
    const dashAnimateTime = Math.max(900, 3200 - Math.min(1900, trafficScale * 190));
    const base: Omit<RuleGlobePath, "id" | "variant" | "trackColor" | "dashAnimateTime"> = {
      rule: route.rule,
      color: route.color,
      routeText: route.routeText,
      finalHopText: route.finalHopText,
      targetText: route.targetText,
      bytesIn: route.bytesIn,
      bytesOut: route.bytesOut,
      connections: route.connections,
      totalBytes: route.totalBytes,
      stroke,
      dashInitialGap: (hashText(route.rule.id) % 100) / 100,
      coords,
    };
    paths.push({
      ...base,
      id: `track:${route.rule.id}`,
      variant: "track",
      trackColor: hexToRgba(route.color, route.totalBytes > 0 ? 0.28 : 0.18),
      dashAnimateTime: 0,
    });
    if (route.totalBytes > 0) {
      paths.push({
        ...base,
        id: `flow:${route.rule.id}`,
        variant: "flow",
        trackColor: route.color,
        dashAnimateTime,
      });
    }
  });

  const sortedRoutes = rawRoutes
    .slice()
    .sort((a, b) => b.totalBytes - a.totalBytes || Number(a.rule.id || 0) - Number(b.rule.id || 0));

  return {
    paths,
    points: [
      ...Array.from(hostPointById.values()),
      ...rawRoutes.map((route) => route.targetPoint),
    ],
    summaries: sortedRoutes,
    skipped,
  };
}


export default function RuleTrafficGlobe({
  rules,
  hosts,
  tunnels,
  forwardGroups,
  trafficByRule,
  trafficRangeLabel = "24h",
  targetGeoByAddress,
  targetGeoLookupReady,
  onEditRule,
}: {
  rules: any[];
  hosts: any[];
  tunnels: any[];
  forwardGroups: any[];
  trafficByRule: Map<number, RuleTrafficSummary>;
  trafficRangeLabel?: string;
  targetGeoByAddress: Map<string, RuleTargetGeo>;
  targetGeoLookupReady: boolean;
  onEditRule: (rule: any) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [globeReady, setGlobeReady] = useState(false);
  const [size, setSize] = useState({ width: 1400, height: 780 });
  const [hoveredPath, setHoveredPath] = useState<RuleGlobePath | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<RuleGlobePoint | null>(null);
  const [countries, setCountries] = useState<RuleGlobeCountryFeature[]>([]);
  const globeData = useMemo(
    () => buildRuleGlobeData(rules, hosts, tunnels, forwardGroups, trafficByRule, targetGeoByAddress, targetGeoLookupReady),
    [forwardGroups, hosts, rules, targetGeoByAddress, targetGeoLookupReady, trafficByRule, tunnels],
  );
  const routeCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    globeData.points.forEach((point) => {
      const code = normalizeCountryCode(point.countryCode);
      if (code) codes.add(code);
    });
    return codes;
  }, [globeData.points]);

  useEffect(() => {
    if (!globeReady) return;
    let cancelled = false;
    fetch(RULE_GLOBE_COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.features)) return;
        setCountries(data.features as RuleGlobeCountryFeature[]);
      })
      .catch(() => {
        if (!cancelled) setCountries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [globeReady]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
      const width = Math.max(900, Math.round(rect.width));
      setSize({
        width,
        height: Math.max(720, Math.min(980, Math.round(Math.max(viewportHeight - 240, width * 0.52)))),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    if (!globeReady || !globeRef.current) return;
    const globe = globeRef.current;
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.32;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 105;
    controls.maxDistance = 500;
    globe.pointOfView({ lat: 18, lng: 108, altitude: 1.28 }, 0);
  }, [globeReady]);

  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !(hoveredPath || hoveredPoint);
  }, [hoveredPath, hoveredPoint]);

  return (
    <>
      <div className="hidden overflow-hidden rounded-md border border-border/40 bg-[#030712] shadow-sm md:block">
        <div
          ref={containerRef}
          className="relative min-h-[720px] w-full overflow-hidden"
          style={{ height: size.height }}
        >
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center bg-[#030712] text-sm text-white/70">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在加载流量转发图
              </div>
            }
          >
            <ReactGlobe
              ref={globeRef}
              width={size.width}
              height={size.height}
              backgroundColor="rgba(3,7,18,1)"
              globeImageUrl={RULE_GLOBE_EARTH_IMAGE_URL}
              showAtmosphere
              atmosphereColor="#64748b"
              atmosphereAltitude={0.22}
              showGraticules={false}
              globeCurvatureResolution={6}
              polygonsData={countries}
              polygonGeoJsonGeometry="geometry"
              polygonAltitude={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? 0.014 : 0.004}
              polygonCapColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? "rgba(20,184,166,.34)" : "rgba(15,23,42,.05)"}
              polygonSideColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? "rgba(20,184,166,.22)" : "rgba(2,6,23,.14)"}
              polygonStrokeColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? "rgba(94,234,212,.88)" : "rgba(148,163,184,.22)"}
              polygonCapCurvatureResolution={4}
              polygonsTransitionDuration={0}
              pointsData={globeData.points}
              pointLat="lat"
              pointLng="lng"
              pointAltitude={(point) => (point as RuleGlobePoint).kind === "target" ? 0.046 : 0.034}
              pointRadius={(point) => (point as RuleGlobePoint).kind === "target" ? 0.34 : 0.24}
              pointResolution={18}
              pointColor={(point) => (point as RuleGlobePoint).color}
              pointLabel={(point) => renderRuleGlobePointTooltip(point as RuleGlobePoint)}
              onPointHover={(point) => setHoveredPoint(point as RuleGlobePoint | null)}
              onPointClick={(point) => {
                const rule = (point as RuleGlobePoint | null)?.rule;
                if (rule) onEditRule(rule);
              }}
              pathsData={globeData.paths}
              pathPoints="coords"
              pathPointLat="lat"
              pathPointLng="lng"
              pathPointAlt="alt"
              pathResolution={12}
              pathColor={(path: object) => {
                const item = path as RuleGlobePath;
                if (item.variant === "track") return item.trackColor;
                return hoveredPath?.rule?.id === item.rule?.id ? item.color : hexToRgba(item.color, 0.88);
              }}
              pathStroke={(path: object) => {
                const item = path as RuleGlobePath;
                const hovered = hoveredPath?.rule?.id === item.rule?.id;
                return item.variant === "track" ? Math.max(1.1, item.stroke - 0.45) : item.stroke + (hovered ? 0.75 : 0);
              }}
              pathDashLength={(path: object) => (path as RuleGlobePath).variant === "flow" ? 0.16 : 1}
              pathDashGap={(path: object) => (path as RuleGlobePath).variant === "flow" ? 0.085 : 0}
              pathDashInitialGap={(path: object) => (path as RuleGlobePath).dashInitialGap}
              pathDashAnimateTime={(path: object) => (path as RuleGlobePath).variant === "flow" ? (path as RuleGlobePath).dashAnimateTime : 0}
              pathTransitionDuration={0}
              pathLabel={(path) => renderRuleGlobePathTooltip(path as RuleGlobePath)}
              onPathHover={(path) => setHoveredPath(path as RuleGlobePath | null)}
              onPathClick={(path) => {
                const rule = (path as RuleGlobePath | null)?.rule;
                if (rule) onEditRule(rule);
              }}
              showPointerCursor={(objectType) => objectType === "path" || objectType === "point"}
              enablePointerInteraction
              onGlobeReady={() => setGlobeReady(true)}
            />
          </Suspense>

          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
            <div className="font-medium">流量转发图</div>
            <div className="mt-1 text-white/70">
              规则 {rules.length} 条 · 已定位 {globeData.summaries.length} 条
            </div>
            {globeData.skipped > 0 && (
              <div className="mt-1 text-[color-mix(in_srgb,var(--fx-warn)_85%,transparent)]">待定位 {globeData.skipped} 条</div>
            )}
          </div>

          <div className="pointer-events-none absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-[min(360px,calc(100%-2rem))] flex-col gap-2 overflow-hidden rounded-md border border-white/10 bg-black/35 p-3 text-xs text-white shadow-lg backdrop-blur-md">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{trafficRangeLabel} 流量走向</span>
              <span className="text-white/60">{formatBytes(globeData.summaries.reduce((sum, item) => sum + item.totalBytes, 0))}</span>
            </div>
            <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
              {globeData.summaries.slice(0, 12).map((item) => (
                <div key={item.rule.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color, boxShadow: `0 0 12px ${hexToRgba(item.color, .75)}` }} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.rule.name || `规则 #${item.rule.id}`}</div>
                    <div className="truncate text-white/55">{item.targetText}</div>
                  </div>
                  <div className="text-right tabular-nums text-white/75">{formatBytes(item.totalBytes)}</div>
                </div>
              ))}
              {globeData.summaries.length === 0 && (
                <div className="py-2 text-white/60">暂无可定位流量路径</div>
              )}
            </div>
          </div>

          {globeData.summaries.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
              <div className="rounded-md border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/80 shadow-lg backdrop-blur-md">
                暂无可定位转发路径
              </div>
            </div>
          )}
        </div>
      </div>
      <Card className="border-border/40 bg-card/60 md:hidden">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          3D 流量转发图仅在 PC 端显示。
        </CardContent>
      </Card>
    </>
  );
}
