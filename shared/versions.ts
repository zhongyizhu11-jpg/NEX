export const APP_VERSION = "2.3.413";
export const ANDROID_APP_VERSION = "2.3.100";
export const ANDROID_APK_RELEASE_VERSION = "2.3.413";
export const AGENT_VERSION = "2.2.210";
/**
 * 面板这一版随 Agent 一起发布的 forwardx-fxp 版本（forwardx-fxp/main.go 的
 * fxpRuntimeVersion）。主机上报的 FXP 比它旧就提示「可升级」。
 */
export const FXP_RUNTIME_VERSION = "2.2.126";
/**
 * 能和当前隧道协议握手的最旧 FXP（握手 v3 从 2.2.121 开始）。比它旧的 FXP 连不上
 * 已经升级的节点：Agent 会拒绝启动它，面板在隧道和规则上报警。
 * 和 agent/fxp_version.go 的 minWireCompatibleFXPVersion 保持一致。
 */
export const FXP_MIN_WIRE_VERSION = "2.2.121";

export const PANEL_AGENT_COMPATIBILITY_LIMIT = 5;
export const PANEL_AGENT_COMPATIBILITY = [
  { panelVersion: APP_VERSION, agentVersion: AGENT_VERSION },
] as const;
