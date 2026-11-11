/**
 * 一台机器上的 Mieru 入站 → 给 Agent mita 扩展模块的指令，以及 Agent 上报回来的状态。
 *
 * 为什么不像 sing-box 那样拼 shell 命令走 actions：mita 要按用户读计数（流量按人记），要在
 * 配置变了时才重启、要确认端口真的听上了，还要分清「这个 mita 是不是 NEX 装的」—— 这些判断放在
 * Agent 的 Go 代码里（agent/ext_mita.go 等）才测得了，面板只给出「要什么」。指令走扩展通道
 * （server/ops/agentExt.ts），不碰心跳。
 *
 * 本文件只做纯计算和内存里的状态，不碰数据库；读库在 server/ops/mitaAgent.ts。
 */

import { createHash } from "node:crypto";

import { githubDownloadCandidates, type GithubAcceleratorConfig } from "../shared/githubAccelerator";
import {
  isMieruAgentSupported,
  mieruAgentUpgradeMessage,
  type MitaHostPlan,
  type MitaServerConfig,
} from "../shared/mieruInbound";
import {
  MITA_ARCHES,
  MITA_VERSION,
  mitaAgentAssetName,
  mitaBinarySha256,
  mitaTarballSha256,
  mitaTarballUrl,
  type MitaArch,
} from "../shared/mitaAssets";

export const MITA_SERVICE_NAME = "forwardx-mita";

export type MitaBinarySource = {
  /** 包里 mita 二进制的 SHA-256：不管从哪拿到的，对不上就不装。 */
  sha256: string;
  /**
   * 面板转发的现成二进制（/api/agent/assets/v<面板版本>/forwardx-mita-linux-<架构>），相对面板地址。
   * 排在最前：落地机多半在墙内，GitHub 未必下得动，而面板它一定连得上。
   */
  panelAssetPath: string;
  /** 面板拿不到时退回上游发布包（加速地址在前），包本身也按钉死的哈希校验。 */
  tarballUrls: string[];
  tarballSha256: string;
};

export type MitaDirective = {
  v: 1;
  /** false = 这台机器上一个 Mieru 入站都没有：Agent 只停、只清它自己装的 forwardx-mita。 */
  enabled: boolean;
  /** 配置 + 二进制的指纹。Agent 只在它变了时才重写配置、重启 mita。 */
  revision: string;
  version?: string;
  binaries?: Partial<Record<MitaArch, MitaBinarySource>>;
  config?: MitaServerConfig;
};

/** 下发什么取决于这几样；同样的输入逐字节一样的指令（Agent 拿 revision 判断要不要重启）。 */
export function buildMitaDirective(
  plan: Pick<MitaHostPlan, "config">,
  options: { appVersion: string; accelerator?: GithubAcceleratorConfig | null; version?: string },
): MitaDirective {
  if (!plan.config) return { v: 1, enabled: false, revision: "disabled" };
  const version = String(options.version || MITA_VERSION).replace(/^v/i, "");
  const binaries: Partial<Record<MitaArch, MitaBinarySource>> = {};
  for (const arch of MITA_ARCHES) {
    const sha256 = mitaBinarySha256(version, arch);
    const tarballSha256 = mitaTarballSha256(version, arch);
    // 没钉哈希的版本一律不给下载地址：宁可这个架构装不上，也不让 Agent 装一个没核对过的程序。
    if (!sha256 || !tarballSha256) continue;
    binaries[arch] = {
      sha256,
      panelAssetPath: `/api/agent/assets/v${String(options.appVersion).replace(/^v/i, "")}/${mitaAgentAssetName(arch)}`,
      tarballUrls: githubDownloadCandidates(mitaTarballUrl(version, arch), options.accelerator),
      tarballSha256,
    };
  }
  // revision 不含下载地址：加速地址换了不该让 mita 重启。
  const revision = createHash("sha256")
    .update(JSON.stringify({
      version,
      sha256: Object.fromEntries(Object.entries(binaries).map(([arch, item]) => [arch, item?.sha256 || ""])),
      config: plan.config,
    }))
    .digest("hex")
    .slice(0, 32);
  return { v: 1, enabled: true, revision, version, binaries, config: plan.config };
}

// ==================== Agent 上报 ====================

export type MitaListenerReport = { port: number; protocol: "TCP" | "UDP"; ready: boolean };

export type MitaRuntimeReport = {
  /** disabled / installing / running / error */
  state: string;
  error: string;
  /** Agent 上一次成功应用的 revision。和面板这次下发的对不上 = 还没生效。 */
  revision: string;
  version: string;
  active: boolean;
  listeners: MitaListenerReport[];
  at: number;
};

export type MitaTrafficReport = {
  /** 哪一个 mita 进程的计数（进程换了从 0 重来），Agent 给的不透明字符串。 */
  instance: string;
  users: Array<{ name: string; up: number; down: number }>;
};

const MAX_REPORTED_USERS = 4096;

function text(value: unknown, max = 300) {
  return String(value ?? "").slice(0, max);
}

function counter(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : 0;
}

export function parseMitaRuntimeReport(value: unknown, now = Date.now()): MitaRuntimeReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const listeners: Array<Record<string, unknown> | null> = Array.isArray(raw.listeners) ? raw.listeners.slice(0, 512) : [];
  return {
    state: text(raw.state, 32),
    error: text(raw.error, 500),
    revision: text(raw.revision, 64),
    version: text(raw.version, 32),
    active: raw.active === true,
    listeners: listeners
      .map((item) => ({
        port: Number(item?.port) || 0,
        protocol: String(item?.protocol || "").toUpperCase() === "UDP" ? "UDP" as const : "TCP" as const,
        ready: item?.ready === true,
      }))
      .filter((item: MitaListenerReport) => Number.isInteger(item.port) && item.port > 0 && item.port <= 65535),
    at: now,
  };
}

export function parseMitaTrafficReport(value: unknown): MitaTrafficReport | null {
  const raw = (value as { traffic?: { instance?: unknown; users?: unknown } } | null)?.traffic;
  if (!raw || typeof raw !== "object") return null;
  const instance = text(raw.instance, 128).trim();
  if (!instance || !Array.isArray(raw.users)) return null;
  const users: MitaTrafficReport["users"] = [];
  const seen = new Set<string>();
  for (const item of raw.users.slice(0, MAX_REPORTED_USERS)) {
    const name = text(item?.name, 64).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    users.push({ name, up: counter(item?.up), down: counter(item?.down) });
  }
  return { instance, users };
}

/** 超过这么久没上报，界面上当「等主机上报」，不把旧状态当实时的。扩展通道一分钟一轮。 */
export const MITA_REPORT_STALE_MS = 5 * 60_000;

const reports = new Map<number, MitaRuntimeReport>();
const plans = new Map<number, { plan: MitaHostPlan; revision: string; at: number }>();
const MAX_TRACKED_HOSTS = 20_000;

export function rememberMitaReport(hostId: number, report: MitaRuntimeReport) {
  if (reports.size >= MAX_TRACKED_HOSTS && !reports.has(hostId)) reports.clear();
  reports.set(Number(hostId), report);
}

export function rememberMitaPlan(hostId: number, plan: MitaHostPlan, revision: string, now = Date.now()) {
  if (plans.size >= MAX_TRACKED_HOSTS && !plans.has(hostId)) plans.clear();
  plans.set(Number(hostId), { plan, revision, at: now });
}

export function resetMitaRuntimeStateForTest() {
  reports.clear();
  plans.clear();
}

export type MieruInboundStatus = {
  /** upgrade 需要升级 Agent；pending 等主机上报 / 还没生效；ready 在跑；error 出错；skipped 没进配置 */
  state: "upgrade" | "pending" | "ready" | "error" | "skipped" | "disabled";
  message: string;
};

/**
 * 列表行上的那一格。按「为什么不生效」的先后排：Agent 太旧 → 没进配置 → Agent 报错 → 还没生效 → 端口没听上。
 */
export function mieruInboundStatusView(
  input: { inboundId: number; hostId: number; isEnabled: boolean; agentVersion: string | null | undefined; ports: number[] },
  now = Date.now(),
): MieruInboundStatus {
  if (!input.isEnabled) return { state: "disabled", message: "已停用" };
  if (!isMieruAgentSupported(input.agentVersion)) {
    return { state: "upgrade", message: mieruAgentUpgradeMessage(input.agentVersion) };
  }
  const planned = plans.get(Number(input.hostId));
  const skipped = planned?.plan.skipped.find((item) => item.inboundId === input.inboundId && !item.inboundUserId);
  if (skipped) return { state: "skipped", message: `没有下发：${skipped.reason}` };
  const report = reports.get(Number(input.hostId));
  if (!report || now - report.at > MITA_REPORT_STALE_MS) return { state: "pending", message: "等主机上报" };
  if (report.state === "error") return { state: "error", message: report.error || "mita 没有起来" };
  if (planned && report.revision !== planned.revision) return { state: "pending", message: report.state === "installing" ? "正在安装 mita" : "等主机应用新配置" };
  const mine = report.listeners.filter((item) => input.ports.includes(item.port));
  const notReady = mine.filter((item) => !item.ready);
  if (!report.active) return { state: "error", message: report.error || "forwardx-mita 服务没在运行" };
  if (mine.length > 0 && notReady.length > 0) {
    const sample = notReady.slice(0, 3).map((item) => `${item.protocol} ${item.port}`).join("、");
    return { state: "error", message: `端口没有听上：${sample}${notReady.length > 3 ? " 等" : ""}` };
  }
  return { state: "ready", message: "" };
}
