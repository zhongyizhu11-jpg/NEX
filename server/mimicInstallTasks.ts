import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { appendPanelLog } from "./_core/panelLogger";
import { isAgentVersionAtLeast } from "../shared/version";

/*
  「安装 / 修复 mimic」任务（面板 2.3.439 / Agent 2.2.223 起）。

  以前 mimic 只在装 Agent 时那个默认为 N 的提示里装，面板遇到缺环境只会说「请手动安装」。
  现在管理员在主机详情 / 隧道编辑里点一下，这里给那台主机排一个任务，下一次心跳带下去
  （连 scripts/install-mimic.sh 正文一起，Agent 不用再去 GitHub 拿脚本；拿不到正文时 Agent
  按 installerUrl 经镜像下载）。Agent 跑的时候每几秒把输出尾巴报回来，跑完报结果和重新检测
  的 mimic 环境。全部在内存里，一台主机同一时刻只有一个任务，做完留 30 分钟给页面看。
*/

export const AGENT_MIMIC_INSTALL_VERSION = "2.2.223";
/** 面板这一版装的 mimic（hack3ric/mimic）版本，装 Agent 的脚本和面板一键安装都用它。 */
export const MIMIC_TARGET_VERSION = "0.7.1";
export const MIMIC_INSTALLER_URL = "https://raw.githubusercontent.com/zhongyizhu11-jpg/NEX/main/scripts/install-mimic.sh";

export type MimicInstallMode = "install" | "repair";
export type MimicInstallStatus = "queued" | "running" | "success" | "error" | "timeout";

export type MimicInstallTaskPayload = {
  taskId: string;
  mode: MimicInstallMode;
  version: string;
  installerUrl: string;
  script?: string;
  acceleratorEnabled: boolean;
  acceleratorUrl: string;
  mirrors: string;
  timeoutSeconds: number;
};

export type MimicInstallTaskState = {
  taskId: string;
  hostId: number;
  hostName: string;
  mode: MimicInstallMode;
  version: string;
  status: MimicInstallStatus;
  output: string;
  error: string | null;
  exitCode: number | null;
  createdAt: string;
  dispatchedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  environment: { available: boolean; status: string; version: string | null; message: string | null } | null;
};

type MimicInstallTaskInternal = MimicInstallTaskState & {
  payload: MimicInstallTaskPayload;
  expiresAt: number;
  timeoutTimer?: NodeJS.Timeout;
};

const TASK_TIMEOUT_MS = 25 * 60 * 1000;
const DISPATCH_GRACE_MS = 3 * 60 * 1000;
const RETENTION_MS = 30 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024;

const tasks = new Map<number, MimicInstallTaskInternal>();

function nowIso() {
  return new Date().toISOString();
}

function tail(value: unknown, limit = OUTPUT_LIMIT) {
  const text = String(value || "");
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function publicTask(task: MimicInstallTaskInternal): MimicInstallTaskState {
  const { payload: _payload, expiresAt: _expiresAt, timeoutTimer: _timer, ...rest } = task;
  return { ...rest };
}

function isTerminal(status: MimicInstallStatus) {
  return status === "success" || status === "error" || status === "timeout";
}

function expireOverdue() {
  const now = Date.now();
  for (const [hostId, task] of tasks) {
    if (isTerminal(task.status) && now > task.expiresAt) {
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      tasks.delete(hostId);
    }
  }
}

function markTimedOut(hostId: number, taskId: string) {
  const task = tasks.get(hostId);
  if (!task || task.taskId !== taskId || isTerminal(task.status)) return;
  task.status = "timeout";
  task.error = task.dispatchedAt
    ? "Agent 没有在限定时间内报告结果；看 Agent 日志 /var/log/forwardx-agent/"
    : `Agent 一直没来取任务：请确认主机在线且 Agent 不低于 ${AGENT_MIMIC_INSTALL_VERSION}`;
  task.finishedAt = nowIso();
  task.updatedAt = task.finishedAt;
  task.expiresAt = Date.now() + RETENTION_MS;
  appendPanelLog("warn", `[MimicInstall] timeout host=${hostId} task=${taskId} dispatched=${!!task.dispatchedAt}`);
}

let installerScriptCache: { text: string; mtimeMs: number } | null = null;

/** 面板自带的安装脚本正文；发布包里没带时返回空串，Agent 退回按 URL 下载。 */
export function readMimicInstallerScript(): string {
  const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "scripts", "install-mimic.sh"),
    path.join(serverDir, "..", "scripts", "install-mimic.sh"),
  ];
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (installerScriptCache && installerScriptCache.mtimeMs === stat.mtimeMs) return installerScriptCache.text;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("MIMIC_REPO=")) {
        installerScriptCache = { text, mtimeMs: stat.mtimeMs };
        return text;
      }
    } catch {
      // 下一个候选
    }
  }
  return "";
}

export function enqueueMimicInstallTask(input: {
  host: { id: number; name?: string | null; isOnline?: boolean | null; agentVersion?: string | null };
  mode: MimicInstallMode;
  version: string;
  acceleratorEnabled?: boolean;
  acceleratorUrl?: string | null;
  mirrors?: string | null;
  script?: string;
}): MimicInstallTaskState {
  expireOverdue();
  const hostId = Math.floor(Number(input.host?.id));
  if (!Number.isInteger(hostId) || hostId <= 0) throw new Error("主机不存在");
  if (!input.host.isOnline) throw new Error("主机离线，等 Agent 在线后再装");
  if (!isAgentVersionAtLeast(input.host.agentVersion, AGENT_MIMIC_INSTALL_VERSION)) {
    throw new Error(`这台主机的 Agent ${String(input.host.agentVersion || "版本未知")} 还不支持面板安装 mimic，请先升级 Agent 到 ${AGENT_MIMIC_INSTALL_VERSION} 以上`);
  }
  const existing = tasks.get(hostId);
  if (existing && !isTerminal(existing.status)) {
    return publicTask(existing);
  }
  if (existing?.timeoutTimer) clearTimeout(existing.timeoutTimer);
  const createdAt = nowIso();
  const taskId = crypto.randomUUID();
  const mode: MimicInstallMode = input.mode === "repair" ? "repair" : "install";
  const task: MimicInstallTaskInternal = {
    taskId,
    hostId,
    hostName: String(input.host.name || `主机 ${hostId}`),
    mode,
    version: String(input.version || "").replace(/^v/, ""),
    status: "queued",
    output: "任务已创建，等待 Agent 下一次心跳取走…",
    error: null,
    exitCode: null,
    createdAt,
    dispatchedAt: null,
    updatedAt: createdAt,
    finishedAt: null,
    environment: null,
    payload: {
      taskId,
      mode,
      version: String(input.version || "").replace(/^v/, ""),
      installerUrl: MIMIC_INSTALLER_URL,
      script: input.script || undefined,
      acceleratorEnabled: input.acceleratorEnabled === true,
      acceleratorUrl: String(input.acceleratorUrl || ""),
      mirrors: String(input.mirrors || ""),
      timeoutSeconds: Math.floor(TASK_TIMEOUT_MS / 1000),
    },
    expiresAt: Date.now() + TASK_TIMEOUT_MS + DISPATCH_GRACE_MS + RETENTION_MS,
  };
  task.timeoutTimer = setTimeout(() => markTimedOut(hostId, taskId), TASK_TIMEOUT_MS + DISPATCH_GRACE_MS);
  task.timeoutTimer.unref?.();
  tasks.set(hostId, task);
  appendPanelLog("info", `[MimicInstall] queued host=${hostId} mode=${mode} version=${task.version} task=${taskId}`);
  return publicTask(task);
}

/** 心跳里取走排队中的任务（只取一次：取走就算 running）。 */
export function takeMimicInstallTask(hostId: number): MimicInstallTaskPayload | null {
  expireOverdue();
  const task = tasks.get(Math.floor(Number(hostId)));
  if (!task || task.status !== "queued") return null;
  task.status = "running";
  task.dispatchedAt = nowIso();
  task.updatedAt = task.dispatchedAt;
  task.output = "Agent 已取走任务，正在安装…";
  appendPanelLog("info", `[MimicInstall] dispatched host=${task.hostId} task=${task.taskId}`);
  return task.payload;
}

export function hasPendingMimicInstallTask(hostId: number) {
  expireOverdue();
  const task = tasks.get(Math.floor(Number(hostId)));
  return !!task && !isTerminal(task.status);
}

export function reportMimicInstallResult(hostId: number, input: {
  taskId: string;
  status: string;
  output?: string;
  error?: string;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string;
  mimicEnvironment?: { available?: boolean; status?: string; version?: string; message?: string } | null;
}) {
  expireOverdue();
  const task = tasks.get(Math.floor(Number(hostId)));
  if (!task || task.taskId !== String(input.taskId || "")) return false;
  if (isTerminal(task.status)) return true;
  const status = String(input.status || "");
  task.updatedAt = nowIso();
  if (input.output) task.output = tail(input.output);
  if (status === "running") {
    task.status = "running";
    if (!task.dispatchedAt) task.dispatchedAt = task.updatedAt;
    return true;
  }
  if (status !== "success" && status !== "error" && status !== "timeout") return false;
  task.status = status;
  task.error = status === "success" ? null : String(input.error || "").slice(0, 2000) || "安装失败";
  task.exitCode = input.exitCode === undefined || input.exitCode === null ? null : Number(input.exitCode);
  task.finishedAt = String(input.finishedAt || "") || task.updatedAt;
  if (input.mimicEnvironment && typeof input.mimicEnvironment === "object") {
    task.environment = {
      available: input.mimicEnvironment.available === true,
      status: String(input.mimicEnvironment.status || "unknown"),
      version: input.mimicEnvironment.version ? String(input.mimicEnvironment.version).slice(0, 64) : null,
      message: input.mimicEnvironment.message ? String(input.mimicEnvironment.message).slice(0, 512) : null,
    };
  }
  task.expiresAt = Date.now() + RETENTION_MS;
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
  appendPanelLog(
    status === "success" ? "info" : "warn",
    `[MimicInstall] ${status} host=${task.hostId} task=${task.taskId} mode=${task.mode} exit=${task.exitCode ?? "-"}${task.error ? ` error=${task.error.slice(0, 200)}` : ""}`,
  );
  return true;
}

export function getMimicInstallTask(hostId: number): MimicInstallTaskState | null {
  expireOverdue();
  const task = tasks.get(Math.floor(Number(hostId)));
  return task ? publicTask(task) : null;
}

export function getMimicInstallTasks(hostIds: number[]): MimicInstallTaskState[] {
  return hostIds.map((id) => getMimicInstallTask(id)).filter((task): task is MimicInstallTaskState => !!task);
}

export function clearMimicInstallTasksForTest() {
  for (const task of tasks.values()) {
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
  }
  tasks.clear();
}
