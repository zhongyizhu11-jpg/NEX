/*
  trpc.ops.* —— 借鉴 Rosélune 的那批运维功能（2.3.425 起）。界面入口 2.3.437 起所有主题都有（之前只在第五套主题「朱砂」下），
  接口本身不看主题：设置一旦开启（地区规则、异地备份……），换主题也照样生效。
*/
import { router } from "../../_core/trpc";
import { eventsRouter } from "./events";
import { webhooksRouter } from "./webhooks";
import { digestRouter } from "./digest";
import { firewallRouter } from "./firewall";
import { onlineIpsRouter } from "./onlineIps";
import { hostSecurityRouter } from "./hostSecurity";
import { agentRelayRouter } from "./agentRelay";
import { hostOpsRouter } from "./hostOps";
import { apiTokensRouter } from "./apiTokens";
import { passkeysRouter } from "./passkeys";
import { sessionsRouter } from "./sessions";
import { maintenanceRouter } from "./maintenance";
import { offsiteBackupRouter } from "./offsiteBackup";
import { statusAvailabilityRouter } from "./statusAvailability";
import { quotaPolicyRouter } from "./quotaPolicy";
import { resourceAlertRouter } from "./resourceAlert";
import { hostLogsRouter } from "./hostLogs";
import { faultBoardRouter } from "./faultBoard";
import { connStatsRouter } from "./connStats";

export const opsRouter = router({
  events: eventsRouter,
  webhooks: webhooksRouter,
  digest: digestRouter,
  firewall: firewallRouter,
  onlineIps: onlineIpsRouter,
  hostSecurity: hostSecurityRouter,
  agentRelay: agentRelayRouter,
  hostOps: hostOpsRouter,
  apiTokens: apiTokensRouter,
  passkeys: passkeysRouter,
  sessions: sessionsRouter,
  maintenance: maintenanceRouter,
  offsiteBackup: offsiteBackupRouter,
  statusAvailability: statusAvailabilityRouter,
  quotaPolicy: quotaPolicyRouter,
  resourceAlert: resourceAlertRouter,
  hostLogs: hostLogsRouter,
  faultBoard: faultBoardRouter,
  connStats: connStatsRouter,
});
