/**
 * REALITY 伪装目标检查 / 扫描（面板 2.3.524，Agent 2.2.253 起）—— 面板、界面、测试共用。
 *
 * 开 VLESS + REALITY 落地入站时要选一个「偷」的握手目标。REALITY 把探测流量转给这个目标、把它的证书原样
 * 递给探测者，所以目标得是一个从这台落地机连得上的正常大站：TLS 1.3、支持 X25519、能协商 h2、证书对得上
 * 握手域名。差一样，要么客户端连不上，要么一眼就能看出这台机器不是它冒充的那个站。
 *
 * 检查必须从落地机自己发起（面板那台机器的线路、DNS、封锁情况都和落地不一样），走 Agent 扩展通道的
 * "realitycheck" 模块（agent/ext_realitycheck.go，面板侧 server/ops/realityCheck.ts）。
 *
 * 候选清单 v2 和 Forwardplus 2.3.283 的「Reality 公网目标检查」同一批：去掉了已知握手失败的 Microsoft 系目标，
 * 都是 TLS 1.3 + X25519 + h2、证书链正常、本身流量就大的站点。清单一改就升版本号，界面上写着扫的是哪一版。
 */

import { isAgentVersionAtLeast } from "./version";

/** 落地机的 Agent 从这一版起有 realitycheck 扩展模块。 */
export const REALITY_DEST_CHECK_AGENT_VERSION = "2.2.253";

export const REALITY_DEST_CANDIDATE_LIST_VERSION = "v2";

export const REALITY_DEST_CANDIDATES: readonly string[] = Object.freeze([
  "www.cloudflare.com",
  "www.amazon.com",
  "aws.amazon.com",
  "www.samsung.com",
  "www.nvidia.com",
  "www.amd.com",
  "www.intel.com",
  "www.sony.com",
  "dl.google.com",
]);

/** 一次最多检查几个目标（和 Agent 的上限一致）。 */
export const REALITY_DEST_CHECK_MAX_TARGETS = 16;

export type RealityDestCheckTarget = { dest: string; serverName: string };

export type RealityDestCheckResult = {
  dest: string;
  serverName: string;
  resolvedIp: string;
  reachable: boolean;
  tls13: boolean;
  x25519: boolean;
  h2: boolean;
  certValid: boolean;
  feasible: boolean;
  latencyMs: number;
  error: "" | "invalid" | "blocked" | "resolve" | "dial" | "handshake" | "timeout";
};

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function text(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

/** 是不是能当握手域名的域名（REALITY 要拿它当 SNI，不收 IP）。 */
export function isRealityServerName(value: unknown): boolean {
  const name = text(value);
  return HOSTNAME_PATTERN.test(name) && /[a-z]/.test(name.slice(name.lastIndexOf(".") + 1));
}

/**
 * 入站表单里的「握手域名 + 握手目标（可选）」规整成一个检查目标。握手目标留空按握手域名的 443，
 * 和 shared/proxyInbound.ts 的 proxyInboundRealityDest 同一个推法。不合格回给人看的原因。
 */
export function realityDestCheckTargetOf(serverName: unknown, realityDest?: unknown): { ok: true; target: RealityDestCheckTarget } | { ok: false; error: string } {
  const name = text(serverName);
  if (!isRealityServerName(name)) return { ok: false, error: "握手域名要是一个域名（不能是 IP）" };
  const raw = text(realityDest) || `${name}:443`;
  const colon = raw.lastIndexOf(":");
  const host = (colon > 0 ? raw.slice(0, colon) : raw).replace(/^\[(.*)\]$/, "$1");
  const port = colon > 0 ? Number(raw.slice(colon + 1)) : 443;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "握手目标要写成 域名:端口" };
  if (!isRealityServerName(host) && !/^[0-9.]+$/.test(host) && !host.includes(":")) return { ok: false, error: "握手目标的地址不对" };
  const dest = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  return { ok: true, target: { dest, serverName: name } };
}

/** 候选清单里的目标（握手域名和目标同一个，443）。 */
export function realityDestCandidateTargets(): RealityDestCheckTarget[] {
  return REALITY_DEST_CANDIDATES.map((name) => ({ dest: `${name}:443`, serverName: name }));
}

const ERRORS = new Set(["invalid", "blocked", "resolve", "dial", "handshake", "timeout"]);

/** Agent 报上来的结果规整一遍（字段缺了按「没有」算，多余的丢掉）；不是数组回 null。 */
export function normalizeRealityDestCheckResults(raw: unknown): RealityDestCheckResult[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, REALITY_DEST_CHECK_MAX_TARGETS).filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item) => {
    const error = String(item.error || "");
    const result: RealityDestCheckResult = {
      dest: String(item.dest || "").slice(0, 260),
      serverName: String(item.serverName || "").slice(0, 253),
      resolvedIp: String(item.resolvedIp || "").slice(0, 64),
      reachable: item.reachable === true,
      tls13: item.tls13 === true,
      x25519: item.x25519 === true,
      h2: item.h2 === true,
      certValid: item.certValid === true,
      feasible: false,
      latencyMs: Math.max(0, Math.min(60_000, Math.floor(Number(item.latencyMs) || 0))),
      error: (ERRORS.has(error) ? error : "") as RealityDestCheckResult["error"],
    };
    // 可不可用面板自己再算一遍，不全信 Agent 报的那一个布尔。
    result.feasible = result.reachable && result.tls13 && result.x25519 && result.h2 && result.certValid && !result.error;
    return result;
  });
}

const ERROR_TEXT: Record<Exclude<RealityDestCheckResult["error"], "">, string> = {
  invalid: "目标格式不对",
  blocked: "解析到了内网 / 保留地址，不检查",
  resolve: "落地机上解析不出这个域名",
  dial: "落地机连不上这个目标",
  handshake: "TLS 握手失败",
  timeout: "检查超时",
};

/** 一条结果给人看的结论：可用，或者缺了哪几样。 */
export function realityDestCheckVerdict(result: RealityDestCheckResult): string {
  if (result.feasible) return "可用";
  if (result.error && result.error !== "handshake") return ERROR_TEXT[result.error];
  if (!result.reachable) return ERROR_TEXT.dial;
  if (result.error === "handshake") return ERROR_TEXT.handshake;
  const missing: string[] = [];
  if (!result.tls13) missing.push("不支持 TLS 1.3");
  if (result.tls13 && !result.x25519) missing.push("不支持 X25519");
  if (!result.h2) missing.push("不支持 h2");
  if (!result.certValid) missing.push("证书和握手域名对不上");
  return missing.join("、") || "不可用";
}

export function isRealityDestCheckAgentSupported(version: string | null | undefined) {
  return isAgentVersionAtLeast(version, REALITY_DEST_CHECK_AGENT_VERSION);
}
