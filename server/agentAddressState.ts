import { isIP } from "node:net";
import { isPrivateOrReservedAddress } from "../shared/ipAddress";
import { normalizeAgentAddress } from "./agentInputValidation";

export type AgentReportedAddress = {
  ip: string;
  ipv4: string | null;
  ipv6: string | null;
};

/**
 * 面板这一侧看到的 Agent 连接源地址（公网才要）。
 *
 * Agent 自己查公网 IP 靠 ipify / icanhazip / ident.me，有些机器（国内、出口
 * 受限的）一个都连不上，上报里就什么地址都没有，「Agent 检测 IP」一栏是空的、
 * 地区也查不了。但它连得上面板 —— 面板看到的对端地址就是它的出口 IP，跟
 * ipify 看到的是同一个。
 *
 * 面板前面有反代/CDN 而又没配 trust proxy 时，对端是代理的地址，不能用：请求带了
 * 转发头、req.ip 却还是直连对端（没被 trust proxy 解析过），或者带了 Cloudflare
 * 的头，一律不认。
 */
export function observedAgentAddress(req: any): string {
  const headers = req?.headers || {};
  if (headers["cf-ray"] || headers["cf-connecting-ip"]) return "";
  const socketAddress = unmapIpv4(String(req?.socket?.remoteAddress || ""));
  const requestAddress = unmapIpv4(String(req?.ip || ""));
  const forwarded = !!(headers["x-forwarded-for"] || headers["x-real-ip"] || headers["forwarded"]);
  if (forwarded && requestAddress === socketAddress) return "";
  const address = requestAddress || socketAddress;
  if (!isIP(address) || isPrivateOrReservedAddress(address)) return "";
  return address;
}

function unmapIpv4(value: string) {
  const text = value.trim();
  if (text.toLowerCase().startsWith("::ffff:") && isIP(text.slice(7)) === 4) return text.slice(7);
  return text;
}

export function mergeAgentReportedAddress(body: any, existingHost?: any, observedAddress = ""): AgentReportedAddress {
  // 用户在编辑框里手改过检测 IP（shared/hostManualAddress）：地址由他说了算，上报的一律不认
  const manual = existingHost?.addressManual;
  if (manual === true || manual === 1 || manual === "1") {
    const ipv4 = normalizeAgentAddress(existingHost?.ipv4) || null;
    const ipv6 = normalizeAgentAddress(existingHost?.ipv6) || null;
    return { ip: normalizeAgentAddress(existingHost?.ip) || ipv4 || ipv6 || "unknown", ipv4, ipv6 };
  }
  const safeIpv4 = normalizeAgentAddress(body?.ipv4);
  const safeIpv6 = normalizeAgentAddress(body?.ipv6);
  const safeIp = normalizeAgentAddress(body?.ip);
  const previousIpv4 = normalizeAgentAddress(existingHost?.ipv4);
  const previousIpv6 = normalizeAgentAddress(existingHost?.ipv6);
  const previousIp = normalizeAgentAddress(existingHost?.ip);
  // Agent 报的、库里已有的优先；都没有才用面板看到的连接地址补上（见 observedAgentAddress）
  const observed = normalizeAgentAddress(observedAddress);
  const observedIpv4 = observed && isIP(observed) === 4 ? observed : "";
  const observedIpv6 = observed && isIP(observed) === 6 ? observed : "";
  const ipv4 = safeIpv4 || previousIpv4 || observedIpv4 || null;
  const ipv6 = safeIpv6 || previousIpv6 || observedIpv6 || null;
  return {
    ip: safeIpv4 || safeIp || previousIp || ipv4 || safeIpv6 || ipv6 || "unknown",
    ipv4,
    ipv6,
  };
}
