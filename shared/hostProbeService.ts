/*
  主机探测服务（「服务管理」里的 Ping / TCPing / URL 连接检测）前后端共用的常量和校验。

  URL 连接检测（method = "http"，Agent 2.2.255 起）：由主机上的 Agent 对一个 http:// 或 https:// 地址
  发一次 GET，每次都新建连接、不跟随跳转、不读响应体，延迟 = 开始建连 → 收到响应的第一个字节。
  拿到的状态码落在「预期状态码」里才算通；证书不对默认算失败，除非这条服务勾了「忽略证书错误」。

  老 Agent 不认 method = "http"：真发给它，它会把这条当 TCPing（没端口就直接丢掉），图上要么没有数据、
  要么是一条和 HTTP 没关系的 TCP 延迟。所以面板只把 http 服务下发给够版本的 Agent，不够的在界面上
  写「需要升级 Agent」。门槛只此一份，面板下发、界面提示都读这里。
*/
import { PROBE_FAILURE_LABELS, PROBE_FAILURE_SHORT_LABELS, normalizeProbeFailure } from "./probeFailure";
import { isAgentVersionAtLeast } from "./version";

export const HOST_PROBE_METHODS = ["tcping", "ping", "http"] as const;
export type HostProbeMethod = (typeof HOST_PROBE_METHODS)[number];

export const HOST_PROBE_METHOD_LABELS: Record<HostProbeMethod, string> = {
  tcping: "TCPing",
  ping: "Ping",
  http: "URL 连接检测",
};

/** 卡片角标、表格里用的短写法。 */
export const HOST_PROBE_METHOD_SHORT_LABELS: Record<HostProbeMethod, string> = {
  tcping: "TCPING",
  ping: "PING",
  http: "HTTP",
};

/** 认不出来的当 TCPing —— 这张表最早只有 tcping / ping 两种，库里的老行就是这么读的。 */
export function normalizeHostProbeMethod(value: unknown): HostProbeMethod {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "ping") return "ping";
  if (text === "http" || text === "https" || text === "url") return "http";
  return "tcping";
}

/** 第一个认识 URL 连接检测的 Agent 版本。 */
export const HOST_PROBE_HTTP_AGENT_VERSION = "2.2.255";

export function hostAgentSupportsHttpProbe(agentVersion: string | null | undefined) {
  return isAgentVersionAtLeast(agentVersion, HOST_PROBE_HTTP_AGENT_VERSION);
}

export const HOST_PROBE_HTTP_URL_MAX_LENGTH = 2048;
export const HOST_PROBE_HTTP_TIMEOUT_MIN_SECONDS = 1;
export const HOST_PROBE_HTTP_TIMEOUT_MAX_SECONDS = 30;
export const HOST_PROBE_HTTP_TIMEOUT_DEFAULT_SECONDS = 5;
/** 默认 2xx / 3xx 都算通：不跟随跳转，301 / 302 本身就是「对端在正常回应」。 */
export const HOST_PROBE_HTTP_DEFAULT_EXPECTED_STATUS = "200-399";
export const HOST_PROBE_HTTP_EXPECTED_STATUS_MAX_LENGTH = 128;
const HOST_PROBE_HTTP_EXPECTED_STATUS_MAX_RANGES = 16;

export function normalizeHostProbeHttpTimeout(value: unknown) {
  const seconds = Math.floor(Number(value));
  if (!Number.isFinite(seconds) || seconds < HOST_PROBE_HTTP_TIMEOUT_MIN_SECONDS) return HOST_PROBE_HTTP_TIMEOUT_DEFAULT_SECONDS;
  return Math.min(HOST_PROBE_HTTP_TIMEOUT_MAX_SECONDS, seconds);
}

function hasControlCharacter(text: string) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type HostProbeHttpUrlCheck =
  | { ok: true; url: string; hostname: string; secure: boolean }
  | { ok: false; error: string };

/**
 * 校验 URL 连接检测的地址。只收 http / https；不收内嵌账号密码（会跟着任务下发到 Agent、写进库）
 * 和 #片段（不会发给服务器，写了也没用）。返回的 url 是去掉首尾空白的原文 —— 不用 URL.href 改写，
 * 面板存的、Agent 请求的是同一个字符串。
 */
export function checkHostProbeHttpUrl(value: unknown): HostProbeHttpUrlCheck {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, error: "请填写要检测的 URL" };
  if (text.length > HOST_PROBE_HTTP_URL_MAX_LENGTH) return { ok: false, error: `URL 不能超过 ${HOST_PROBE_HTTP_URL_MAX_LENGTH} 个字符` };
  if (/[\s\\]/.test(text) || hasControlCharacter(text)) return { ok: false, error: "URL 里不能有空白、反斜杠或控制字符" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "URL 格式不正确，要以 http:// 或 https:// 开头" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "只支持 http:// 和 https:// 地址" };
  if (!parsed.hostname) return { ok: false, error: "URL 里缺少主机名" };
  if (parsed.username || parsed.password) return { ok: false, error: "URL 里不能带账号密码" };
  if (parsed.hash) return { ok: false, error: "URL 里不要带 # 片段" };
  return { ok: true, url: text, hostname: parsed.hostname.replace(/^\[|\]$/g, ""), secure: parsed.protocol === "https:" };
}

/** URL 的主机名（去掉 IPv6 的方括号）；不是合法 URL 时回空串。地址族那个选项按它判断是不是 IP。 */
export function hostProbeHttpUrlHostname(value: unknown) {
  const checked = checkHostProbeHttpUrl(value);
  return checked.ok ? checked.hostname : "";
}

export type HttpStatusRange = { from: number; to: number };

export type HostProbeHttpExpectedStatusCheck =
  | { ok: true; ranges: HttpStatusRange[]; normalized: string }
  | { ok: false; error: string };

/**
 * 解析「预期状态码」：逗号 / 空格分开的单个状态码或区间，例如 `200`、`200-399`、`200,204,301-302`，
 * 也收 `2xx` 这种写法。留空 = 默认的 200-399。normalized 是存库、下发给 Agent 的规范写法
 * （Agent 那头的解析见 agent/url_probe.go，只认数字和区间）。
 */
export function parseHostProbeHttpExpectedStatus(value: unknown): HostProbeHttpExpectedStatusCheck {
  const text = String(value ?? "").trim();
  if (!text) {
    return { ok: true, ranges: [{ from: 200, to: 399 }], normalized: HOST_PROBE_HTTP_DEFAULT_EXPECTED_STATUS };
  }
  if (text.length > HOST_PROBE_HTTP_EXPECTED_STATUS_MAX_LENGTH) return { ok: false, error: "预期状态码写得太长了" };
  const tokens = text.split(/[\s,，、;；]+/).filter(Boolean);
  if (tokens.length > HOST_PROBE_HTTP_EXPECTED_STATUS_MAX_RANGES) {
    return { ok: false, error: `预期状态码最多写 ${HOST_PROBE_HTTP_EXPECTED_STATUS_MAX_RANGES} 段` };
  }
  const ranges: HttpStatusRange[] = [];
  for (const token of tokens) {
    const wildcard = /^([1-5])xx$/i.exec(token);
    const single = /^(\d{3})$/.exec(token);
    const span = /^(\d{3})\s*[-~]\s*(\d{3})$/.exec(token);
    let from: number;
    let to: number;
    if (wildcard) {
      from = Number(wildcard[1]) * 100;
      to = from + 99;
    } else if (single) {
      from = Number(single[1]);
      to = from;
    } else if (span) {
      from = Number(span[1]);
      to = Number(span[2]);
    } else {
      return { ok: false, error: `预期状态码「${token}」看不懂，写成 200、200-399 或 200,204 这样` };
    }
    if (from < 100 || to > 599 || from > to) {
      return { ok: false, error: `预期状态码「${token}」不在 100-599 之内，或区间写反了` };
    }
    ranges.push({ from, to });
  }
  if (ranges.length === 0) return { ok: false, error: "请填写预期状态码" };
  return {
    ok: true,
    ranges,
    normalized: ranges.map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`)).join(","),
  };
}

/** 读库时用：库里的写法坏了（手改过）就退回默认，不让一条坏配置把整份下发弄没。 */
export function normalizeHostProbeHttpExpectedStatus(value: unknown) {
  const parsed = parseHostProbeHttpExpectedStatus(value);
  return parsed.ok ? parsed.normalized : HOST_PROBE_HTTP_DEFAULT_EXPECTED_STATUS;
}

export function hostProbeHttpStatusMatches(status: unknown, expected: unknown) {
  const code = Number(status);
  if (!Number.isInteger(code)) return false;
  const parsed = parseHostProbeHttpExpectedStatus(expected);
  if (!parsed.ok) return false;
  return parsed.ranges.some((range) => code >= range.from && code <= range.to);
}

/** Agent 回报里的 HTTP 状态码：100-599 的整数，别的一律当没报。 */
export function normalizeHostProbeHttpStatus(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const code = Number(value);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

/*
  URL 连接检测多出来的两种失败（Agent 随结果带 failure）：
    http_status  连上了、也拿到了响应，但状态码不在预期里 —— 对端的事，不是链路的事；
    tls          HTTPS 握手或证书校验没过（证书过期、域名对不上、自签名）。
  其余沿用 shared/probeFailure 的那几种（dns / refused / unreachable / timeout / resource / error）。
*/
export const HOST_PROBE_HTTP_FAILURE_KINDS = ["http_status", "tls"] as const;
export type HostProbeHttpFailureKind = (typeof HOST_PROBE_HTTP_FAILURE_KINDS)[number];

/** 存库前归一：认识的失败种类原样留下，不认识的（含老 Agent 没报）是 null。 */
export function normalizeHostProbeFailure(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  if ((HOST_PROBE_HTTP_FAILURE_KINDS as readonly string[]).includes(text)) return text;
  return normalizeProbeFailure(text);
}

type HostProbeFailureInput = { failure?: unknown; httpStatus?: unknown } | null | undefined;

/**
 * 探不通时界面上写什么。
 *
 * Ping / TCPing 照旧写「超时」。URL 连接检测要分开说：状态码不符是对端应用的事（服务在、回的不对），
 * 连接失败 / 超时才是链路的事 —— 两种都叫「超时」的话，看的人会去查一条其实没坏的线路。
 */
export function describeHostProbeFailure(method: unknown, latest: HostProbeFailureInput): string {
  if (normalizeHostProbeMethod(method) !== "http") return "超时";
  const failure = normalizeHostProbeFailure(latest?.failure);
  const status = normalizeHostProbeHttpStatus(latest?.httpStatus);
  if (failure === "http_status") return status ? `HTTP 状态码不符（返回 ${status}）` : "HTTP 状态码不符";
  if (failure === "tls") return "证书校验失败";
  if (failure === "timeout") return "连接超时";
  const base = normalizeProbeFailure(failure);
  if (base) return PROBE_FAILURE_LABELS[base];
  return "连接失败 / 超时";
}

/** 短写法，给表格、图表提示用。 */
export function describeHostProbeFailureShort(method: unknown, latest: HostProbeFailureInput): string {
  if (normalizeHostProbeMethod(method) !== "http") return "超时";
  const failure = normalizeHostProbeFailure(latest?.failure);
  const status = normalizeHostProbeHttpStatus(latest?.httpStatus);
  if (failure === "http_status") return status ? `状态码不符 ${status}` : "状态码不符";
  if (failure === "tls") return "证书错误";
  const base = normalizeProbeFailure(failure);
  if (base) return PROBE_FAILURE_SHORT_LABELS[base];
  return "失败";
}

/**
 * 图表里一个时间桶全都没通时写什么。桶是聚合出来的，不知道具体是哪一种失败：
 * Ping / TCPing 照旧叫「超时」，URL 连接检测叫「失败」（它的失败不一定是超时）。
 */
export function hostProbeBucketFailureLabel(method: unknown) {
  return normalizeHostProbeMethod(method) === "http" ? "失败" : "超时";
}

/** 部分没通的那一栏叫什么：Ping / TCPing 是「丢包」，URL 连接检测是请求「失败」。 */
export function hostProbeLossLabel(method: unknown) {
  return normalizeHostProbeMethod(method) === "http" ? "失败" : "丢包";
}
