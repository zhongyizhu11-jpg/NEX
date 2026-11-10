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
import { unlockTables, unlockMigrationTables } from "./unlockTables";
import { connStatsTables, connStatsMigrationTables } from "./connStatsTables";
import { nodeCheckTables, nodeCheckMigrationTables } from "./nodeCheckTables";
import { nodePoolTables, nodePoolMigrationTables } from "./nodePoolTables";
import { ruleGroupsTables, ruleGroupsMigrationTables } from "./ruleGroupsTables";
import { loginDevicesTables, loginDevicesMigrationTables } from "./loginDevicesTables";
import { operationAuditTables, operationAuditMigrationTables } from "./operationAuditTables";
import { uiThemesTables, uiThemesMigrationTables } from "./uiThemesTables";
import { impersonationTables, impersonationMigrationTables } from "./impersonationTables";
import { passwordResetTables, passwordResetMigrationTables } from "./passwordResetTables";

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
  ...unlockTables,
  ...connStatsTables,
  ...nodeCheckTables,
  ...nodePoolTables,
  ...ruleGroupsTables,
  ...loginDevicesTables,
  ...operationAuditTables,
  ...uiThemesTables,
  ...impersonationTables,
  ...passwordResetTables,
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
  ...ruleGroupsMigrationTables,
  ...loginDevicesMigrationTables,
  ...operationAuditMigrationTables,
  ...uiThemesMigrationTables,
  ...impersonationMigrationTables,
  ...passwordResetMigrationTables,
];
