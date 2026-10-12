import { useUiTheme } from "@/hooks/useUiTheme";

/**
 * 第五套主题「朱砂」的 id。
 *
 * 借鉴 Rosélune 的那批运维功能（监控页、状态可用率、地区规则、IP 封禁、在线 IP、安全巡检、
 * Agent 中转、全部重启、导入现有配置、API 与 MCP、通行密钥、登录设备、维护模式、异地备份、
 * Webhook、简报时间、流量用尽处理、入站兼容提示）的**界面入口**只在这套主题下出现 ——
 * 用户在 2026-10-12 的选择是「只在第五套」。功能本身不看主题：开着的设置换主题照常生效。
 */
export const OPS_THEME_ID = "cinnabar";

/** 现在是不是第五套主题：是才画那批功能的入口。 */
export function useOpsFeatures(): boolean {
  return useUiTheme() === OPS_THEME_ID;
}
