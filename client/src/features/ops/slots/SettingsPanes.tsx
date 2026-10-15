import { useOpsFeatures } from "../useOpsFeatures";
import QuotaModeSection from "../quota/QuotaModeSection";
import MaintenanceSection from "../maintenance/MaintenanceSection";
import ApiTokensSection from "../api/ApiTokensSection";
import WebhookSettings from "../webhook/WebhookSettings";
import OffsiteBackupSection from "../backup/OffsiteBackupSection";
import DigestScheduleSection from "../digest/DigestScheduleSection";

/** 设置 › 进阶：流量用尽处理、维护模式、API 令牌与 MCP。 */
export function OpsAdvancedSettingsPane() {
  if (!useOpsFeatures()) return null;
  return (
    <>
      <QuotaModeSection />
      <MaintenanceSection />
      <ApiTokensSection />
    </>
  );
}

/** 设置 › Webhook。 */
export function OpsWebhookSettingsPane() {
  if (!useOpsFeatures()) return null;
  return <WebhookSettings />;
}

/** 设置 › 备份恢复 底部多出的异地自动备份。 */
export function OpsBackupExtraSections() {
  if (!useOpsFeatures()) return null;
  return <OffsiteBackupSection />;
}

/** 设置 › Telegram 底部多出的每日简报时间与内容。 */
export function OpsTelegramExtraSections() {
  if (!useOpsFeatures()) return null;
  return <DigestScheduleSection />;
}
