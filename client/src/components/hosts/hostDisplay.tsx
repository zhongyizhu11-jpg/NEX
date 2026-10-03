import { formatBytes } from "@shared/formatBytes";

// 这里原来自带一份实现（全站共 7 份各不相同）。改成转发共享的那一份，
// 现有的调用方（MyHostsSection 等）不用改导入。
export { formatBytes };

const AGENT_UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
const HOST_METRICS_CACHE_PREFIX = "forwardx.hosts.metrics.";

function readJsonCache<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonCache(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cached UI data is optional; ignore storage failures.
  }
}

export function readCachedHostMetrics(hostId: number | string) {
  const metrics = readJsonCache<any[]>(`${HOST_METRICS_CACHE_PREFIX}${hostId}`, []);
  return Array.isArray(metrics) ? metrics : [];
}

export function writeCachedHostMetrics(hostId: number | string, metrics: any[]) {
  writeJsonCache(`${HOST_METRICS_CACHE_PREFIX}${hostId}`, metrics.slice(0, 2));
}

export function metricUsageProgressClass(value: unknown, isOnline: boolean) {
  if (!isOnline) return "h-1.5 bg-muted [&>div]:bg-muted-foreground/40";
  const usage = Number(value || 0);
  if (usage >= 80) return "h-1.5 bg-muted [&>div]:bg-[var(--fx-down)]";
  if (usage >= 50) return "h-1.5 bg-muted [&>div]:bg-[var(--fx-warn)]";
  return "h-1.5 bg-muted [&>div]:bg-[var(--fx-healthy)]";
}

/**
 * CPU 占用的文字。
 *
 * Agent 拿两次上报之间 /proc/stat 的差算平均占用，再四舍五入成整数上报，数据库也按整数存。
 * 空闲的转发机常年只有零点几个百分点，四舍五入就是 0 —— 在线的机器写「0%」读起来像
 * 「没在统计」，其实是「不到 0.5%」，所以写成「<1%」。离线或拿不到数据写「—」。
 */
export function formatCpuPercent(value: unknown, online = true): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const rounded = Math.round(Math.min(100, Math.max(0, number)));
  if (online && rounded < 1) return "<1%";
  return `${rounded}%`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

export { compareVersions, isAgentVersionBehind, normalizeVersion } from "@shared/version";

export function isAgentUpgradeTimedOut(host: any) {
  if (!host?.agentUpgradeRequested || !host.agentUpgradeRequestedAt) return false;
  const requestedAt = new Date(host.agentUpgradeRequestedAt).getTime();
  return Number.isFinite(requestedAt) && Date.now() - requestedAt > AGENT_UPGRADE_TIMEOUT_MS;
}

function isPrimaryAddressFallbackVisible(value: unknown) {
  const text = String(value || "").trim();
  return !!text && text !== "unknown" && !text.includes(":");
}

export function hostPrimaryAddressLines(host: any) {
  const rows: Array<{ label: string; value: string }> = [];
  if (host.ipv4) rows.push({ label: "IPv4", value: host.ipv4 });
  if (rows.length === 0 && isPrimaryAddressFallbackVisible(host.ip)) rows.push({ label: "IP", value: host.ip });
  if (rows.length === 0) rows.push({ label: "IP", value: "-" });
  return rows;
}

export function agentDetectedIpText(host: any) {
  return hostAddressText(host);
}

/** 编辑框里「Agent 检测 IP」那一栏的可改写法：「1.2.3.4, 2001:db8::1」（shared/hostManualAddress 能原样读回去） */
export function editableDetectedAddress(host: any) {
  const parts = [host?.ipv4, host?.ipv6].map((value) => String(value || "").trim()).filter(Boolean);
  if (parts.length === 0 && host?.ip && host.ip !== "unknown") parts.push(String(host.ip).trim());
  return parts.join(", ");
}

export function hostAddressText(host: any) {
  const parts: string[] = [];
  if (host.ipv4) parts.push(`IPv4 ${host.ipv4}`);
  if (host.ipv6) parts.push(`IPv6 ${host.ipv6}`);
  if (parts.length === 0 && host.ip && host.ip !== "unknown") parts.push(`IP ${host.ip}`);
  return parts.join("  /  ") || "-";
}

export function hostPrimaryAddressText(host: any) {
  const rows = hostPrimaryAddressLines(host);
  return rows.map((row) => `${row.label} ${row.value}`).join("  /  ") || "-";
}

export function hostRegionText(host: any) {
  const parts = [host.geoCountryName || host.geoCountryCode, host.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.join(" / ");
}

export function HostRegionBadge({ host, compact = false }: { host: any; compact?: boolean }) {
  const countryCode = String(host.geoCountryCode || "").trim().toLowerCase();
  const flagUrl = /^[a-z]{2}$/.test(countryCode) ? `https://flagcdn.com/24x18/${countryCode}.png` : "";
  const fallbackCode = countryCode.toUpperCase();
  const regionText = hostRegionText(host);
  const hasGeo = !!(flagUrl || regionText);
  const title = hasGeo ? [fallbackCode, regionText].filter(Boolean).join(" ") : "地区获取中";
  return (
    <span
      className={`inline-flex min-w-0 max-w-full shrink items-center gap-1 text-muted-foreground ${hasGeo ? "" : "opacity-70"} ${compact ? "text-[10px]" : "text-xs"}`}
      title={title}
    >
      {flagUrl && (
        <>
          <img
            src={flagUrl}
            alt={fallbackCode}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={`${compact ? "h-3 w-4" : "h-3.5 w-5"} shrink-0 rounded-[2px] object-cover`}
            onError={(event) => {
              event.currentTarget.style.display = "none";
              const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = "inline";
            }}
          />
          <span className="hidden shrink-0 font-mono leading-none">{fallbackCode}</span>
        </>
      )}
      <span className="min-w-0 truncate">{regionText || "地区获取中"}</span>
    </span>
  );
}
