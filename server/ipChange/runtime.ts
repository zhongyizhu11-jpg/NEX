/*
  把 IpChangeService 接到真实环境上：SQL 仓库、云厂商列表、主机地址联动、DDNS、通知、面板日志。

  这个文件会被心跳 / 上报路由引用，所以重的模块（地址联动、DDNS、Telegram）一律在用到时才 import，
  心跳那条路上只多一次「插件开没开」的判断和一份 30 秒的探测任务缓存。
*/
import { AUTO_IP_CHANGE_PLUGIN_ID } from "../../shared/ipChange";
import { appendPanelLog } from "../_core/panelLogger";
import { ENV } from "../env";
import { isHostConsideredOnline } from "../hostHeartbeatPolicy";
import { IP_CHANGE_PROVIDERS, getIpChangeProvider } from "./providers";
import { createSqlIpChangeStore } from "./repository";
import { createCredentialCipher, type CredentialCipher } from "./secrets";
import { IpChangeService, type IpChangeHost, type ProbeReport } from "./service";
import { deliverIpChangeNotice } from "./notify";

export type AutoIpChangePluginStatus = {
  pluginsEnabled: boolean;
  installed: boolean;
  enabled: boolean;
  active: boolean;
};

let statusCache: { expiresAt: number; value: AutoIpChangePluginStatus } | null = null;

/** 插件功能总开关 + 插件已安装 + 插件已启用，三样都满足才算开。缓存 10 秒（心跳路上也会问）。 */
export async function getAutoIpChangePluginStatus(options: { fresh?: boolean } = {}): Promise<AutoIpChangePluginStatus> {
  if (!options.fresh && statusCache && statusCache.expiresAt > Date.now()) return statusCache.value;
  const { getAllSettings } = await import("../repositories/settingsRepository");
  const settings = await getAllSettings().catch(() => ({} as Record<string, string | null>));
  const pluginsEnabled = settings.pluginsEnabled === "true";
  let installed = false;
  let enabled = false;
  if (pluginsEnabled) {
    const { getPlugin } = await import("../repositories/pluginRepository");
    const plugin = await getPlugin(AUTO_IP_CHANGE_PLUGIN_ID).catch(() => undefined);
    installed = !!plugin;
    enabled = plugin?.status === "enabled";
  }
  const value = { pluginsEnabled, installed, enabled, active: pluginsEnabled && installed && enabled };
  statusCache = { expiresAt: Date.now() + 10_000, value };
  return value;
}

export function invalidateAutoIpChangePluginStatus() {
  statusCache = null;
  serviceInstance?.invalidateProbeCache();
}

let cipherInstance: CredentialCipher | null = null;

let serviceInstance: IpChangeService | null = null;

export function getIpChangeService() {
  if (serviceInstance) return serviceInstance;
  serviceInstance = new IpChangeService({
    store: createSqlIpChangeStore(),
    resolveProvider: getIpChangeProvider,
    listProviders: () => IP_CHANGE_PROVIDERS,
    cipher: () => (cipherInstance ||= createCredentialCipher(ENV.cookieSecret)),
    isActive: async () => (await getAutoIpChangePluginStatus()).active,
    hosts: {
      async get(id) {
        const { getHostById } = await import("../repositories/hostRepository");
        return (await getHostById(id)) as IpChangeHost | null ?? null;
      },
      async update(id, patch) {
        const { updateHost } = await import("../repositories/hostRepository");
        await updateHost(id, patch as any);
      },
      async list() {
        const { getHosts } = await import("../repositories/hostRepository");
        return (await getHosts()) as IpChangeHost[];
      },
    },
    isHostOnline: (host) => isHostOnlineSync(host),
    address: {
      async handleHostAddressChanged(hostId, current, previous, reason) {
        const runtime = await import("../hostAddressRuntime");
        await runtime.handleHostAddressChanged(hostId, current, previous, reason);
      },
      async refreshHostAddressRuntime(hostId, previous, reason) {
        const runtime = await import("../hostAddressRuntime");
        await runtime.refreshHostAddressRuntime(hostId, previous, reason);
      },
      scheduleHostDdnsUpdate(host, reason, options) {
        void import("../hostDdns").then(({ scheduleHostDdnsUpdate }) => scheduleHostDdnsUpdate(host, reason, options)).catch((error) => {
          appendPanelLog("warn", `[IpChange] DDNS 刷新失败 host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
      },
    },
    pushAgentRefresh: (hostId, reason) => {
      void import("../agentEvents").then(({ pushAgentRefresh }) => pushAgentRefresh(hostId, reason)).catch(() => undefined);
    },
    notify: (notice) => deliverIpChangeNotice(notice),
    log: (level, message) => appendPanelLog(level, message),
    fetch: (...args) => globalThis.fetch(...args),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  });
  return serviceInstance;
}

function isHostOnlineSync(host: IpChangeHost) {
  return isHostConsideredOnline(host as any);
}

/** 心跳里追加的探测任务。任何错误都吞掉返回空 —— 这是最热的一条路，不能因为这个功能出错。 */
export async function getIpChangeProbeTasksForHost(hostId: number) {
  try {
    return await getIpChangeService().getProbeTasksForHost(hostId);
  } catch (error) {
    appendPanelLog("warn", `[IpChange] probe tasks failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** 心跳稳定快路径用（同步、不打库）：这台主机的自动换 IP 探测任务有没有还没送到的变化。 */
export function hasPendingIpChangeProbeDelivery(hostId: number) {
  try {
    return serviceInstance ? serviceInstance.hasPendingProbeDelivery(hostId) : false;
  } catch {
    return false;
  }
}

export function ingestIpChangeProbeReports(hostId: number, reports: ProbeReport[]) {
  if (reports.length === 0) return;
  void getIpChangeService().ingestProbeReports(hostId, reports).catch((error) => {
    appendPanelLog("warn", `[IpChange] probe ingest failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 定时任务：启动后先把上次被重启打断的标成「结果不确定」，之后每 30 秒一轮。 */
export async function runIpChangeTick() {
  return getIpChangeService().tick();
}
