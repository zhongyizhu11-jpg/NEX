import type { TableDef } from "./tableDefs";
import { eventsTables, eventsMigrationTables } from "./eventsTables";
import { firewallTables, firewallMigrationTables } from "./firewallTables";
import { onlineIpsTables, onlineIpsMigrationTables } from "./onlineIpsTables";
import { hostSecurityTables, hostSecurityMigrationTables } from "./hostSecurityTables";
import { agentRelayTables, agentRelayMigrationTables } from "./agentRelayTables";
import { hostOpsTables, hostOpsMigrationTables } from "./hostOpsTables";
import { apiTokensTables, apiTokensMigrationTables } from "./apiTokensTables";
import { passkeysTables, passkeysMigrationTables } from "./passkeysTables";
import { offsiteBackupTables, offsiteBackupMigrationTables } from "./offsiteBackupTables";
import { webhooksTables, webhooksMigrationTables } from "./webhooksTables";
import { statusAvailabilityTables, statusAvailabilityMigrationTables } from "./statusAvailabilityTables";
import { netProfileTables, netProfileMigrationTables } from "./netProfileTables";
import { ipIntelTables } from "./ipIntelTables";
import { topologyManualTables, topologyManualMigrationTables } from "./topologyManualTables";
import { userTrafficDailyTables, userTrafficDailyMigrationTables } from "./userTrafficDailyTables";
import { unlockTables, unlockMigrationTables } from "./unlockTables";
import { connStatsTables, connStatsMigrationTables } from "./connStatsTables";
import { nodeCheckTables, nodeCheckMigrationTables } from "./nodeCheckTables";
import { nodePoolTables, nodePoolMigrationTables } from "./nodePoolTables";
import { loginDevicesTables, loginDevicesMigrationTables } from "./loginDevicesTables";
import { operationAuditTables, operationAuditMigrationTables } from "./operationAuditTables";

export const OPS_TABLE_DEFS: TableDef[] = [
  ...eventsTables,
  ...firewallTables,
  ...onlineIpsTables,
  ...hostSecurityTables,
  ...agentRelayTables,
  ...hostOpsTables,
  ...apiTokensTables,
  ...passkeysTables,
  ...offsiteBackupTables,
  ...webhooksTables,
  ...statusAvailabilityTables,
  ...netProfileTables,
  ...ipIntelTables,
  ...unlockTables,
  ...connStatsTables,
  ...nodeCheckTables,
  ...nodePoolTables,
  ...loginDevicesTables,
  ...operationAuditTables,
  ...topologyManualTables,
  ...userTrafficDailyTables,
];

export const OPS_MIGRATION_TABLES: string[] = [
  ...eventsMigrationTables,
  ...firewallMigrationTables,
  ...onlineIpsMigrationTables,
  ...hostSecurityMigrationTables,
  ...agentRelayMigrationTables,
  ...hostOpsMigrationTables,
  ...apiTokensMigrationTables,
  ...passkeysMigrationTables,
  ...offsiteBackupMigrationTables,
  ...webhooksMigrationTables,
  ...statusAvailabilityMigrationTables,
  ...netProfileMigrationTables,
  ...unlockMigrationTables,
  ...connStatsMigrationTables,
  ...nodeCheckMigrationTables,
  ...nodePoolMigrationTables,
  ...loginDevicesMigrationTables,
  ...operationAuditMigrationTables,
  ...topologyManualMigrationTables,
  ...userTrafficDailyMigrationTables,
];
