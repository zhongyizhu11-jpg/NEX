/* 从 client/src/pages/Tunnels.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { loadReactGlobe } from "@/lib/reactGlobeLoader";
import { escapeTooltipHtml, hostGeoCoordinate } from "@/lib/hostGeo";
import { Card, CardContent } from "@/components/ui/card";
import { countryFeatureHasCode, normalizeCountryCode, type CountryFeatureLike } from "@/lib/countryFeatures";
import { type LinkAvailabilityResult } from "@shared/linkAvailability";
import { getTunnelHopIds, getTunnelRouteText } from "@/lib/tunnelDisplay";
import { Loader2 } from "lucide-react";
import type { GlobeMethods } from "react-globe.gl";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { tunnelDisplayLatencyMs, tunnelLatencyIsTimeout } from "@/pages/Tunnels";

const ReactGlobe = lazy(loadReactGlobe) as typeof import("react-globe.gl").default;

type TunnelGlobeHostPoint = {
  pointKind?: "host";
  host: any;
  id: number;
  name: string;
  lat: number;
  lng: number;
  regionText: string;
};

type TunnelGlobeLink = {
  id: string;
  kind: "tunnel" | "chain";
  item: any;
  name: string;
  routeText: string;
  routeHosts: TunnelGlobeHostPoint[];
  statusText: string;
  latencyText: string;
  color: string;
  trackColor: string;
  glowColor: string;
};

type TunnelGlobePath = {
  link: TunnelGlobeLink;
  segmentIndex: number;
  layerIndex: number;
  layerCount: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  altitude: number;
  coords: Array<{ lat: number; lng: number; alt: number }>;
};

type TunnelGlobeCountryFeature = CountryFeatureLike & {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
};

const TUNNEL_GLOBE_EARTH_IMAGE_URL = "/globe/earth-dark.jpg";

const TUNNEL_GLOBE_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";

const TUNNEL_GLOBE_PATH_SURFACE_ALTITUDE = 0.026;

const TUNNEL_GLOBE_PATH_MIN_ALTITUDE = 0.038;

const TUNNEL_GLOBE_PATH_MAX_ALTITUDE = 0.082;

const TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_STEP = 0.005;

const TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_MAX = 0.014;

function hostRegionText(host: any) {
  return [host?.geoCountryName || host?.geoCountryCode, host?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}

function hostCountryCode(host: any) {
  return normalizeCountryCode(host?.geoCountryCode);
}

function createTunnelGlobeHostPoint(host: any): TunnelGlobeHostPoint | null {
  const coord = hostGeoCoordinate(host);
  if (!coord) return null;
  const name = String(host?.name || host?.ip || `主机 #${host?.id || "-"}`).trim();
  return {
    host,
    id: Number(host.id),
    name,
    lat: coord.lat,
    lng: coord.lng,
    regionText: hostRegionText(host),
  };
}

function formatGlobeLatency(value: unknown, timeout?: unknown) {
  if (timeout) return "超时";
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? `${Math.round(latency)} ms` : "未测试";
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

function globeDistanceDegrees(start: Pick<TunnelGlobePath, "startLat" | "startLng" | "endLat" | "endLng">) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRad(start.startLat);
  const lat2 = toRad(start.endLat);
  const lng1 = toRad(start.startLng);
  const lng2 = toRad(start.endLng);
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1))));
  return (angle * 180) / Math.PI;
}

function tunnelGlobeArcLayerKey(start: TunnelGlobeHostPoint, end: TunnelGlobeHostPoint) {
  const a = `${start.id}:${start.lat.toFixed(3)}:${start.lng.toFixed(3)}`;
  const b = `${end.id}:${end.lat.toFixed(3)}:${end.lng.toFixed(3)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function createTunnelGlobePathCoords(path: Pick<TunnelGlobePath, "startLat" | "startLng" | "endLat" | "endLng" | "altitude" | "layerIndex" | "layerCount">) {
  const dLat = path.endLat - path.startLat;
  const dLng = longitudeDeltaDegrees(path.startLng, path.endLng);
  const midLat = (path.startLat + path.endLat) / 2;
  const midLng = normalizeLongitude(path.startLng + dLng / 2);
  const lngScale = Math.max(0.35, Math.cos((midLat * Math.PI) / 180));
  const projectedLng = dLng * lngScale;
  const distance = Math.sqrt(dLat * dLat + projectedLng * projectedLng);
  const layerOffset = path.layerIndex - (path.layerCount - 1) / 2;
  const sideSpacing = path.layerCount > 1 ? Math.min(7.5, Math.max(1.8, globeDistanceDegrees(path) / 24)) : 0;
  const offset = layerOffset * sideSpacing;
  const offsetLat = distance > 0 ? (projectedLng / distance) * offset : 0;
  const offsetLng = distance > 0 ? (-dLat / (distance * lngScale)) * offset : 0;

  return [
    { lat: path.startLat, lng: path.startLng, alt: TUNNEL_GLOBE_PATH_SURFACE_ALTITUDE },
    { lat: Math.max(-85, Math.min(85, midLat + offsetLat)), lng: normalizeLongitude(midLng + offsetLng), alt: path.altitude },
    { lat: path.endLat, lng: path.endLng, alt: TUNNEL_GLOBE_PATH_SURFACE_ALTITUDE },
  ];
}

function renderTunnelGlobeLinkTooltip(link: TunnelGlobeLink) {
  const routeNodes = link.routeHosts.map((host, index) => `${index + 1}. ${host.name}`).join(" -> ");
  const rows = [
    { label: "类型", value: link.kind === "tunnel" ? "隧道链路" : "转发链" },
    { label: "状态", value: link.statusText },
    { label: "延迟", value: link.latencyText },
    { label: "链路", value: link.routeText },
    { label: "节点", value: routeNodes },
  ];
  return `
    <div style="min-width:280px;max-width:360px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(link.name)}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${link.color};box-shadow:0 0 14px ${link.glowColor};"></span>
          ${escapeTooltipHtml(link.kind === "tunnel" ? "隧道" : "转发链")}
        </div>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;">${escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
      <div style="margin-top:10px;color:#93c5fd;font-size:12px;">点击编辑</div>
    </div>
  `;
}

function renderTunnelGlobeHostTooltip(point: TunnelGlobeHostPoint) {
  return `
    <div style="min-width:220px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);color:#f8fafc;padding:10px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="font-size:13px;font-weight:700;">${escapeTooltipHtml(point.name)}</div>
      <div style="margin-top:6px;color:#cbd5e1;font-size:12px;">${escapeTooltipHtml(point.regionText || "地区获取中")}</div>
    </div>
  `;
}

function buildTunnelGlobeDataKey(
  tunnels: any[],
  chainGroups: any[],
  hosts: any[],
  isTunnelSupported: (tunnel: any) => boolean,
  tunnelAvailabilityById: Map<number, LinkAvailabilityResult>,
  groupAvailabilityById: Map<number, LinkAvailabilityResult>,
) {
  const hostParts = (hosts || [])
    .map((host: any) => [
      Number(host?.id || 0),
      host?.name || "",
      host?.ip || "",
      host?.geoLatitudeMicro ?? "",
      host?.geoLongitudeMicro ?? "",
      host?.geoCountryCode || "",
      host?.geoCountryName || "",
      host?.geoRegion || "",
    ].join(":"))
    .sort();
  const tunnelParts = (tunnels || [])
    .map((tunnel: any) => [
      Number(tunnel?.id || 0),
      tunnel?.name || "",
      tunnel?.mode || "",
      Number(!!isTunnelSupported(tunnel)),
      tunnelAvailabilityById.get(Number(tunnel?.id || 0))?.status || "",
      Number(!!tunnel?.isEnabled),
      getTunnelHopIds(tunnel).join(">"),
    ].join(":"))
    .sort();
  const chainParts = (chainGroups || [])
    .map((group: any) => [
      Number(group?.id || 0),
      group?.name || "",
      groupAvailabilityById.get(Number(group?.id || 0))?.status || "",
      Number(!!group?.isEnabled),
      [...(group?.members || [])]
        .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0))
        .map((member: any) => `${Number(member?.hostId || 0)}:${Number(member?.priority || 0)}`)
        .join(">"),
    ].join(":"))
    .sort();
  return [hostParts.join("|"), tunnelParts.join("|"), chainParts.join("|")].join("\n");
}

export default function TunnelWorldGlobe({
  tunnels,
  chainGroups,
  hosts,
  isTunnelSupported,
  tunnelAvailabilityById,
  groupAvailabilityById,
  onEditTunnel,
  onEditChain,
}: {
  tunnels: any[];
  chainGroups: any[];
  hosts: any[];
  isTunnelSupported: (tunnel: any) => boolean;
  tunnelAvailabilityById: Map<number, LinkAvailabilityResult>;
  groupAvailabilityById: Map<number, LinkAvailabilityResult>;
  onEditTunnel: (tunnel: any) => void;
  onEditChain: (group: any) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [globeReady, setGlobeReady] = useState(false);
  const [size, setSize] = useState({ width: 1400, height: 780 });
  const [hoveredLink, setHoveredLink] = useState<TunnelGlobeLink | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<TunnelGlobeHostPoint | null>(null);
  const [countries, setCountries] = useState<TunnelGlobeCountryFeature[]>([]);
  const globeDataKey = useMemo(
    () => buildTunnelGlobeDataKey(tunnels, chainGroups, hosts, isTunnelSupported, tunnelAvailabilityById, groupAvailabilityById),
    [chainGroups, groupAvailabilityById, hosts, isTunnelSupported, tunnelAvailabilityById, tunnels]
  );

  const globeAvailabilityStyle = (state: LinkAvailabilityResult | undefined, enabled: boolean) => {
    if (!enabled || state?.status === "disabled") {
      return { statusText: "已停用", color: "#94a3b8", trackColor: "#475569", glowColor: "rgba(148,163,184,.6)" };
    }
    if (state?.status === "available") {
      return { statusText: "可用", color: "#4ade80", trackColor: "#15803d", glowColor: "rgba(74,222,128,.85)" };
    }
    if (state?.status === "degraded" || state?.status === "pending") {
      return { statusText: state.status === "degraded" ? "部分可用" : "检测中", color: "#fbbf24", trackColor: "#92400e", glowColor: "rgba(251,191,36,.78)" };
    }
    return { statusText: "不可用", color: "#fb7185", trackColor: "#9f1239", glowColor: "rgba(251,113,133,.76)" };
  };

  const globeData = useMemo(() => {
    const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const hostPointById = new Map<number, TunnelGlobeHostPoint>();
    const pointForHostId = (hostId: number) => {
      if (hostPointById.has(hostId)) return hostPointById.get(hostId) || null;
      const point = createTunnelGlobeHostPoint(hostById.get(hostId));
      if (point) hostPointById.set(hostId, point);
      return point;
    };

    const links: TunnelGlobeLink[] = [];
    let skipped = 0;

    (tunnels || []).forEach((tunnel: any) => {
      const routeHosts = getTunnelHopIds(tunnel)
        .map((hostId: number) => pointForHostId(Number(hostId)))
        .filter(Boolean) as TunnelGlobeHostPoint[];
      if (routeHosts.length < 2) {
        skipped += 1;
        return;
      }
      const supported = isTunnelSupported(tunnel);
      const enabled = supported && !!tunnel.isEnabled;
      const style = globeAvailabilityStyle(tunnelAvailabilityById.get(Number(tunnel.id)), enabled);
      links.push({
        id: `tunnel:${tunnel.id}`,
        kind: "tunnel",
        item: tunnel,
        name: String(tunnel.name || `隧道 #${tunnel.id}`),
        routeText: getTunnelRouteText(tunnel, hosts),
        routeHosts,
        statusText: !supported ? "协议未启用" : style.statusText,
        latencyText: formatGlobeLatency(tunnelDisplayLatencyMs(tunnel), tunnelLatencyIsTimeout(tunnel)),
        color: style.color,
        trackColor: style.trackColor,
        glowColor: style.glowColor,
      });
    });

    (chainGroups || []).forEach((group: any) => {
      const members = [...(group.members || [])].sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
      const routeHosts = members
        .map((member: any) => pointForHostId(Number(member.hostId || 0)))
        .filter(Boolean) as TunnelGlobeHostPoint[];
      if (routeHosts.length < 2) {
        skipped += 1;
        return;
      }
      const enabled = !!group.isEnabled;
      const style = globeAvailabilityStyle(groupAvailabilityById.get(Number(group.id)), enabled);
      links.push({
        id: `chain:${group.id}`,
        kind: "chain",
        item: group,
        name: String(group.name || `转发链 #${group.id}`),
        routeText: routeHosts.map((host) => host.name).join(" -> "),
        routeHosts,
        statusText: style.statusText,
        latencyText: formatGlobeLatency(group.latestLatencyMs, group.latestLatencyIsTimeout),
        color: style.color,
        trackColor: style.trackColor,
        glowColor: style.glowColor,
      });
    });

    const rawSegments = links.flatMap((link) => link.routeHosts.slice(0, -1).map((start, index) => ({
      link,
      segmentIndex: index,
      start,
      end: link.routeHosts[index + 1],
      layerKey: tunnelGlobeArcLayerKey(start, link.routeHosts[index + 1]),
    })));
    const totalLayersByKey = rawSegments.reduce((acc, segment) => {
      acc.set(segment.layerKey, (acc.get(segment.layerKey) || 0) + 1);
      return acc;
    }, new Map<string, number>());
    const usedLayersByKey = new Map<string, number>();
    const routePaths = rawSegments.map((segment) => {
      const { link, start, end, segmentIndex, layerKey } = segment;
      const layerIndex = usedLayersByKey.get(layerKey) || 0;
      usedLayersByKey.set(layerKey, layerIndex + 1);
      const layerCount = totalLayersByKey.get(layerKey) || 1;
      const path: TunnelGlobePath = {
        link,
        segmentIndex,
        layerIndex,
        layerCount,
        startLat: start.lat,
        startLng: start.lng,
        endLat: end.lat,
        endLng: end.lng,
        altitude: TUNNEL_GLOBE_PATH_MIN_ALTITUDE,
        coords: [],
      };
      const distance = globeDistanceDegrees(path);
      const baseAltitude = Math.max(TUNNEL_GLOBE_PATH_MIN_ALTITUDE, Math.min(TUNNEL_GLOBE_PATH_MAX_ALTITUDE, 0.032 + distance / 2300));
      path.altitude = baseAltitude + Math.min(TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_MAX, Math.abs(layerIndex - (layerCount - 1) / 2) * TUNNEL_GLOBE_PATH_LAYER_ALTITUDE_STEP);
      path.coords = createTunnelGlobePathCoords(path);
      return path;
    });

    return {
      links,
      paths: routePaths,
      hostPoints: Array.from(hostPointById.values()),
      skipped,
    };
  }, [globeDataKey]);

  const hostCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    globeData.hostPoints.forEach((point) => {
      const code = hostCountryCode(point.host);
      if (code) codes.add(code);
    });
    return codes;
  }, [globeData.hostPoints]);
  const latestLinkById = useMemo(() => {
    const tunnelById = new Map<number, any>((tunnels || []).map((tunnel: any) => [Number(tunnel.id), tunnel]));
    const chainById = new Map<number, any>((chainGroups || []).map((group: any) => [Number(group.id), group]));
    const map = new Map<string, TunnelGlobeLink>();
    globeData.links.forEach((link) => {
      if (link.kind === "tunnel") {
        const id = Number(link.item?.id || String(link.id).split(":")[1] || 0);
        const tunnel = tunnelById.get(id);
        if (!tunnel) {
          map.set(link.id, link);
          return;
        }
        const supported = isTunnelSupported(tunnel);
        const enabled = supported && !!tunnel.isEnabled;
        const style = globeAvailabilityStyle(tunnelAvailabilityById.get(Number(tunnel.id)), enabled);
        map.set(link.id, {
          ...link,
          item: tunnel,
          name: String(tunnel.name || `隧道 #${tunnel.id}`),
          routeText: getTunnelRouteText(tunnel, hosts),
          statusText: !supported ? "协议未启用" : style.statusText,
          latencyText: formatGlobeLatency(tunnelDisplayLatencyMs(tunnel), tunnelLatencyIsTimeout(tunnel)),
          color: style.color,
          trackColor: style.trackColor,
          glowColor: style.glowColor,
        });
        return;
      }
      const id = Number(link.item?.id || String(link.id).split(":")[1] || 0);
      const group = chainById.get(id);
      if (!group) {
        map.set(link.id, link);
        return;
      }
      const enabled = !!group.isEnabled;
      const style = globeAvailabilityStyle(groupAvailabilityById.get(Number(group.id)), enabled);
      map.set(link.id, {
        ...link,
        item: group,
        name: String(group.name || `转发链 #${group.id}`),
        statusText: style.statusText,
        latencyText: formatGlobeLatency(group.latestLatencyMs, group.latestLatencyIsTimeout),
        color: style.color,
        trackColor: style.trackColor,
        glowColor: style.glowColor,
      });
    });
    return map;
  }, [chainGroups, globeData.links, groupAvailabilityById, isTunnelSupported, tunnelAvailabilityById, tunnels]);
  const latestGlobeLink = (link: TunnelGlobeLink) => latestLinkById.get(link.id) || link;

  useEffect(() => {
    if (!globeReady) return;
    let cancelled = false;
    fetch(TUNNEL_GLOBE_COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.features)) return;
        setCountries(data.features as TunnelGlobeCountryFeature[]);
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
    controls.autoRotateSpeed = 0.36;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 105;
    controls.maxDistance = 500;
    globe.pointOfView({ lat: 18, lng: 108, altitude: 1.24 }, 0);
  }, [globeReady]);

  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !(hoveredLink || hoveredPoint);
  }, [hoveredLink, hoveredPoint]);

  const handleLinkEdit = (link: TunnelGlobeLink) => {
    if (link.kind === "tunnel") onEditTunnel(link.item);
    else onEditChain(link.item);
  };

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
                正在加载链路地球
              </div>
            }
          >
            <ReactGlobe
              ref={globeRef}
              width={size.width}
              height={size.height}
              backgroundColor="rgba(3,7,18,1)"
              globeImageUrl={TUNNEL_GLOBE_EARTH_IMAGE_URL}
              showAtmosphere
              atmosphereColor="#64748b"
              atmosphereAltitude={0.22}
              showGraticules={false}
              globeCurvatureResolution={4}
              polygonsData={countries}
              polygonGeoJsonGeometry="geometry"
              polygonAltitude={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? 0.014 : 0.004}
              polygonCapColor={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? "rgba(20,184,166,.36)" : "rgba(15,23,42,.05)"}
              polygonSideColor={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? "rgba(20,184,166,.22)" : "rgba(2,6,23,.14)"}
              polygonStrokeColor={(country) => countryFeatureHasCode(country as TunnelGlobeCountryFeature, hostCountryCodes) ? "rgba(94,234,212,.86)" : "rgba(148,163,184,.22)"}
              polygonCapCurvatureResolution={4}
              polygonsTransitionDuration={0}
              pointsData={globeData.hostPoints}
              pointLat="lat"
              pointLng="lng"
              pointAltitude={0.035}
              pointRadius={0.28}
              pointResolution={24}
              pointColor={() => "#e0f2fe"}
              pointLabel={(point) => renderTunnelGlobeHostTooltip(point as TunnelGlobeHostPoint)}
              onPointHover={(point) => {
                setHoveredPoint(point as TunnelGlobeHostPoint | null);
                if (!point) setHoveredLink(null);
              }}
              pathsData={globeData.paths}
              pathPoints="coords"
              pathPointLat="lat"
              pathPointLng="lng"
              pathPointAlt="alt"
              pathResolution={4}
              pathColor={(path: object) => {
                const item = path as TunnelGlobePath;
                const link = latestGlobeLink(item.link);
                return hoveredLink?.id === link.id ? link.color : link.trackColor;
              }}
              pathStroke={(path: object) => {
                const item = path as TunnelGlobePath;
                const hovered = hoveredLink?.id === item.link.id;
                return hovered ? 3.05 : 2.1;
              }}
              pathTransitionDuration={0}
              pathLabel={(path) => renderTunnelGlobeLinkTooltip(latestGlobeLink((path as TunnelGlobePath).link))}
              onPathHover={(path) => setHoveredLink(path ? latestGlobeLink((path as TunnelGlobePath).link) : null)}
              onPathClick={(path) => {
                const link = path ? latestGlobeLink((path as TunnelGlobePath).link) : null;
                if (link) handleLinkEdit(link);
              }}
              showPointerCursor={(objectType) => objectType === "path" || objectType === "point"}
              enablePointerInteraction
              onGlobeReady={() => setGlobeReady(true)}
            />
          </Suspense>
          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
            <div className="font-medium">全球链路地球</div>
            <div className="mt-1 text-white/70">
              隧道 {tunnels.length} 条 · 转发链 {chainGroups.length} 条 · 已定位 {globeData.links.length} 条
            </div>
            {globeData.skipped > 0 && (
              <div className="mt-1 text-[color-mix(in_srgb,var(--fx-warn)_85%,transparent)]">待定位 {globeData.skipped} 条</div>
            )}
          </div>
          <div className="pointer-events-none absolute right-4 top-4 flex flex-col gap-2 text-xs text-white">
            <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/35 px-3 py-2 shadow-lg backdrop-blur-md">
              <span className="h-2 w-6 rounded-full bg-[#4ade80]" />
              运行中隧道
            </div>
            <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/35 px-3 py-2 shadow-lg backdrop-blur-md">
              <span className="h-2 w-6 rounded-full bg-[#14b8a6]" />
              转发链
            </div>
          </div>
          {globeData.links.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
              <div className="rounded-md border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/80 shadow-lg backdrop-blur-md">
                暂无可定位链路
              </div>
            </div>
          )}
        </div>
      </div>
      <Card className="border-border/40 bg-card/60 md:hidden">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          3D 地球视图仅支持桌面端。
        </CardContent>
      </Card>
    </>
  );
}
