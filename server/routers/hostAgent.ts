import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { normalizePanelUrl, resolveAgentAdvertisedPanelUrl } from "../agentPanelUrl";
import { hostAgentPanelUrlOverride, resolveHostAgentAdvertisedPanelUrl } from "../hostAgentPanelUrl";
import { pushAgentRefresh } from "../agentEvents";
import { invalidateHostTrafficShutdownCache, readHostTrafficShutdownSnapshot, evaluateSnapshot, rearmHostTrafficShutdown } from "../hostTrafficShutdown";
import { getTrafficShutdownAgentReport } from "../ops/trafficShutdownAgent";
import { invalidateHostResourceAlertOverrides, readResourceAlertConfig } from "../resourceAlertNotifier";
import { getAgentInstallationState, resetAgentInstallation } from "../agentInstallation";
import { appendPanelLog } from "../_core/panelLogger";
import { isAgentVersionAtLeast } from "../../shared/version";
import { HOST_AGENT_PANEL_URL_AGENT_VERSION } from "../../shared/hostAgentPanelUrl";
import {
  HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION,
  normalizeTrafficShutdownPercent,
  trafficShutdownTriggeredThisCycle,
} from "../../shared/hostTrafficShutdown";
import {
  isHostInResourceAlertScope,
  normalizeHostResourceAlertOverride,
  resolveHostResourceAlertConfig,
} from "../../shared/resourceAlert";
import { shortAgentInstallationId } from "../../shared/agentInstallation";
import { hostPolicyBool } from "../../shared/hostTrafficPolicy";

/*
  trpc.hostAgent.* —— 主机编辑弹窗「其他配置」里那一块「Agent 连接与保护」，只有管理员能看能改：
  - Agent 面板连接地址（server/hostAgentPanelUrl.ts）
  - 流量阈值关机（server/hostTrafficShutdown.ts）
  - 本机的资源告警覆盖（server/resourceAlertNotifier.ts）
  - Agent 安装实例（同 Token 换机接管，server/agentInstallation.ts）

  单独一个路由、单独保存，不和主机编辑那一大张表单搅在一起：这几项改了要各自刷新缓存、叫醒 Agent。
*/

const hostIdInput = z.object({ hostId: z.number().int().positive() });
const thresholdSchema = z.number().int().min(0).max(100).nullable();

async function requireHost(hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new TRPCError({ code: "NOT_FOUND", message: "主机不存在" });
  return host;
}

export const hostAgentRouter = router({
  get: adminProcedure.input(hostIdInput).query(async ({ input }) => {
    const host = await requireHost(input.hostId);
    const agentVersion = String(host.agentVersion || "");
    const [globalPanelUrl, advertisedPanelUrl, snapshot, alertConfig, installation] = await Promise.all([
      resolveAgentAdvertisedPanelUrl(),
      resolveHostAgentAdvertisedPanelUrl(host),
      readHostTrafficShutdownSnapshot(input.hostId),
      readResourceAlertConfig(),
      getAgentInstallationState(input.hostId, { force: true }),
    ]);
    const report = getTrafficShutdownAgentReport(input.hostId);
    const override = normalizeHostResourceAlertOverride(host.resourceAlertOverride);
    const effectiveAlert = resolveHostResourceAlertConfig(alertConfig, input.hostId, override);
    const evaluation = snapshot ? evaluateSnapshot(snapshot, agentVersion, report?.supported) : null;
    return {
      hostId: input.hostId,
      agentVersion,
      panelUrl: {
        enabled: hostPolicyBool(host.agentPanelUrlEnabled),
        url: String(host.agentPanelUrl || ""),
        globalPanelUrl,
        advertisedPanelUrl,
        agentSupported: isAgentVersionAtLeast(agentVersion, HOST_AGENT_PANEL_URL_AGENT_VERSION),
        requiredAgentVersion: HOST_AGENT_PANEL_URL_AGENT_VERSION,
      },
      trafficShutdown: {
        enabled: !!snapshot?.enabled,
        thresholdPercent: snapshot?.thresholdPercent ?? 100,
        trafficLimit: snapshot?.trafficLimit ?? 0,
        usedBytes: snapshot?.usedBytes ?? 0,
        triggeredThisCycle: snapshot ? trafficShutdownTriggeredThisCycle({
          trafficShutdownTriggeredAt: snapshot.triggeredAt,
          trafficShutdownCycleMark: snapshot.triggeredCycleMark,
        }, snapshot.cycleMark) : false,
        triggeredAt: snapshot?.triggeredAt ? snapshot.triggeredAt * 1000 : null,
        agentVersionOk: isAgentVersionAtLeast(agentVersion, HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION),
        requiredAgentVersion: HOST_TRAFFIC_SHUTDOWN_AGENT_VERSION,
        agentSupported: report ? report.supported : null,
        agentLastError: report?.lastError || "",
        status: evaluation ? (evaluation.due ? "due" : evaluation.reason) : "disabled",
      },
      resourceAlert: {
        override,
        global: {
          enabled: alertConfig.enabled,
          cpuPercent: alertConfig.cpuPercent,
          memoryPercent: alertConfig.memoryPercent,
          diskPercent: alertConfig.diskPercent,
          scope: alertConfig.scope,
          notifyOwner: alertConfig.notifyOwner,
        },
        inScope: alertConfig.enabled && isHostInResourceAlertScope(alertConfig, input.hostId, override),
        effective: {
          cpuPercent: effectiveAlert.cpuPercent,
          memoryPercent: effectiveAlert.memoryPercent,
          diskPercent: effectiveAlert.diskPercent,
        },
      },
      installation: {
        current: shortAgentInstallationId(installation?.current),
        retiredCount: installation?.retired.length ?? 0,
        changedAt: host.agentInstallationChangedAt ? new Date(host.agentInstallationChangedAt).getTime() : null,
      },
    };
  }),

  save: adminProcedure
    .input(hostIdInput.extend({
      agentPanelUrlEnabled: z.boolean(),
      agentPanelUrl: z.string().trim().max(2048).nullable(),
      trafficShutdownEnabled: z.boolean(),
      trafficShutdownThresholdPercent: z.number().int().min(1).max(100),
      resourceAlertOverride: z.object({
        mode: z.enum(["inherit", "on", "off"]),
        cpuPercent: thresholdSchema,
        memoryPercent: thresholdSchema,
        diskPercent: thresholdSchema,
      }).nullable(),
    }))
    .mutation(async ({ input }) => {
      const host = await requireHost(input.hostId);
      const rawUrl = String(input.agentPanelUrl || "").trim();
      // 和全局「面板公开地址」同一个规整：只要 http(s)，不带账号密码、查询串和锚点。
      const panelUrl = rawUrl ? normalizePanelUrl(rawUrl) : "";
      if (rawUrl && !panelUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Agent 面板连接地址不合法：只支持 http:// 或 https:// 开头、不带账号密码和查询参数的地址" });
      if (input.agentPanelUrlEnabled && !panelUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "请填写 Agent 面板连接地址" });
      if (input.trafficShutdownEnabled && !(Number(host.trafficLimit) > 0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "开启流量阈值关机需要先给这台主机设置大于 0 的套餐流量" });
      }
      for (const value of [input.resourceAlertOverride?.cpuPercent, input.resourceAlertOverride?.memoryPercent, input.resourceAlertOverride?.diskPercent]) {
        if (value !== null && value !== undefined && value !== 0 && value < 50) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "告警阈值留空（跟随全局）、填 0（不报）或 50–100 之间的数" });
        }
      }
      const override = normalizeHostResourceAlertOverride(input.resourceAlertOverride);
      const previousOverrideUrl = hostAgentPanelUrlOverride(host);
      const wasShutdownEnabled = hostPolicyBool(host.trafficShutdownEnabled);
      await db.updateHost(input.hostId, {
        agentPanelUrlEnabled: input.agentPanelUrlEnabled,
        agentPanelUrl: panelUrl || null,
        trafficShutdownEnabled: input.trafficShutdownEnabled,
        trafficShutdownThresholdPercent: normalizeTrafficShutdownPercent(input.trafficShutdownThresholdPercent),
        resourceAlertOverride: override ? JSON.stringify(override) : null,
      });
      // 从关到开才重新布防：只改比例、普通保存不清「本周期已触发」，不然改一下比例就能在同一周期再关一次。
      if (input.trafficShutdownEnabled && !wasShutdownEnabled) await rearmHostTrafficShutdown(input.hostId);
      invalidateHostTrafficShutdownCache();
      invalidateHostResourceAlertOverrides();
      const nextOverrideUrl = input.agentPanelUrlEnabled ? panelUrl : "";
      if (nextOverrideUrl !== previousOverrideUrl) {
        appendPanelLog("info", `[HostAgentPanelUrl] host=${input.hostId} override ${previousOverrideUrl || "-"} -> ${nextOverrideUrl || "-"}`);
        // 叫醒 Agent 马上来一次完整心跳，拿到新地址后自己先探测再切。
        pushAgentRefresh(input.hostId, "agent-panel-url-changed", { urgent: true });
      }
      if (input.trafficShutdownEnabled !== wasShutdownEnabled) {
        appendPanelLog("warn", `[HostTrafficShutdown] host=${input.hostId} ${input.trafficShutdownEnabled ? "enabled" : "disabled"} threshold=${normalizeTrafficShutdownPercent(input.trafficShutdownThresholdPercent)}%`);
      }
      return { success: true };
    }),

  /** 解除实例绑定：之后第一个来上报的 Agent 重新登记（要把主机换回原来那台机器时用）。 */
  resetInstallation: adminProcedure.input(hostIdInput).mutation(async ({ input }) => {
    await requireHost(input.hostId);
    await resetAgentInstallation(input.hostId);
    appendPanelLog("warn", `[AgentInstallation] host=${input.hostId} installation binding reset by admin`);
    return { success: true };
  }),
});
