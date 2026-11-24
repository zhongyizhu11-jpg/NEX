/*
  从 server/agentHeartbeatRoute.ts 第 3353-3402 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { appendPanelLog } from "../_core/panelLogger";
import { AGENT_VERSION } from "../_core/systemRouter";
import { NEX_AGENT_DISTRIBUTION } from "../../shared/agentDistribution";
import { heartbeatTimestampMs } from "../agentHeartbeatRecovery";
import { isAgentUpgradeCompleted } from "../agentRouteUtils";
import * as db from "../db";
import { markForwardxAgentMigrationQueued, shouldQueueForwardxAgentMigration } from "../forwardxAgentMigration";
import { resolveHostAgentAdvertisedPanelUrl } from "../hostAgentPanelUrl";
import { getAgentMigrationSwitchTarget, getPanelMigrationAgentDirective } from "../panelMigrationAgentState";

export type ResolveAgentUpgradeDirectiveContext = {
  forwardxAgentMigrationEnabled: boolean;
  host: any;
  responseIssuedAt: number;
  effectiveAgentVersion: string;
  agentVersion: any;
  nextFxpVersion: string;
};

export type ResolveAgentUpgradeDirectiveResult = {
  panelUrl: string;
  agentUpgrade: { targetVersion: any; panelUrl: string; releaseVersion: any; } | null;
  panelMigration: any /* 原类型 PanelMigrationAgentDirective | null… 引用了拿不到的 PanelMigrationAgentDirective，手动收拾 */;
};

export async function resolveAgentUpgradeDirective(ctx: ResolveAgentUpgradeDirectiveContext): Promise<ResolveAgentUpgradeDirectiveResult> {
  const { forwardxAgentMigrationEnabled, host, responseIssuedAt, effectiveAgentVersion, agentVersion, nextFxpVersion } = ctx;
  if (shouldQueueForwardxAgentMigration({
    enabled: forwardxAgentMigrationEnabled,
    hostId: Number(host.id),
    agentDistribution: host.agentDistribution,
    agentUpgradeRequested: host.agentUpgradeRequested,
  })) {
    await db.requestHostAgentUpgrade(host.id, AGENT_VERSION, null, new Date(responseIssuedAt), NEX_AGENT_DISTRIBUTION);
    markForwardxAgentMigrationQueued(Number(host.id));
    Object.assign(host, {
      agentUpgradeRequested: true,
      agentUpgradeTargetVersion: AGENT_VERSION,
      agentUpgradeReleaseVersion: null,
      agentUpgradeTargetDistribution: NEX_AGENT_DISTRIBUTION,
      agentUpgradeRequestedAt: new Date(responseIssuedAt),
    });
    appendPanelLog(
      "info",
      `[AgentMigration] queued host=${host.id} name=${String(host.name || "-")} version=${effectiveAgentVersion || "-"} distribution=forwardx target=${AGENT_VERSION}/nex`,
    );
  }
  const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
  const agentUpgradeCompleted = (host as any).agentUpgradeRequested
    && agentVersion
    && isAgentUpgradeCompleted(
      {
        agentVersion,
        fxpVersion: nextFxpVersion || host.fxpVersion,
        agentDistribution: host.agentDistribution,
        agentUpgradeTargetDistribution: host.agentUpgradeTargetDistribution,
      },
      requestedTargetVersion,
      AGENT_VERSION,
    );
  if (agentUpgradeCompleted) {
    await db.clearHostAgentUpgradeRequest(host.id);
  }
  const panelUrl = await resolveHostAgentAdvertisedPanelUrl(host);
  const agentMigrationTargetPanelUrl = await getAgentMigrationSwitchTarget();
  const panelMigration = await getPanelMigrationAgentDirective(Number(host.id));
  const staleMigrationUpgrade = (host as any).agentUpgradeRequested
    && requestedTargetVersion === "9999.0.0"
    && !agentMigrationTargetPanelUrl;
  if (staleMigrationUpgrade) await db.clearHostAgentUpgradeRequest(host.id);
  const agentUpgradeRequestedAt = heartbeatTimestampMs((host as any).agentUpgradeRequestedAt);
  const agentUpgradeDue = agentUpgradeRequestedAt <= 0 || agentUpgradeRequestedAt <= responseIssuedAt;
  const agentUpgrade = (host as any).agentUpgradeRequested && agentUpgradeDue && !agentUpgradeCompleted && !staleMigrationUpgrade ? {
    targetVersion: requestedTargetVersion,
    panelUrl: agentMigrationTargetPanelUrl || panelUrl,
    releaseVersion: (host as any).agentUpgradeReleaseVersion || null,
  } : null;
  return { panelUrl, agentUpgrade, panelMigration };
}
