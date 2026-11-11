import { useOpsFeatures } from "../useOpsFeatures";
import QuotaModeSection from "../quota/QuotaModeSection";
import MaintenanceSection from "../maintenance/MaintenanceSection";
import ApiTokensSection from "../api/ApiTokensSection";
import ApiRateLimitSection from "../api/ApiRateLimitSection";
import SlowQuerySection from "../db/SlowQuerySection";
import MetricsExportSection from "../metrics/MetricsExportSection";
import WebhookSettings from "../webhook/WebhookSettings";
import EventWebhooksSection from "../webhook/EventWebhooksSection";
import ResourceAlertSettings from "../resource/ResourceAlertSettings";
import TrafficAnomalySettings from "../traffic/TrafficAnomalySettings";
import OffsiteBackupSection from "../backup/OffsiteBackupSection";
import DigestScheduleSection from "../digest/DigestScheduleSection";
import ShopSyncSection from "../../shopSync/ShopSyncSection";

/** 设置 › 进阶：流量用尽处理、维护模式、API 令牌与 MCP、事件推送、商城对接、接口限流、指标导出、慢查询。 */
export function OpsAdvancedSettingsPane() {
  if (!useOpsFeatures()) return null;
  return (
    <>
      <QuotaModeSection />
      <MaintenanceSection />
      <ApiTokensSection />
      <EventWebhooksSection />
      <ShopSyncSection />
      <ApiRateLimitSection />
      <MetricsExportSection />
      <SlowQuerySection />
    </>
  );
}

/** 设置 › Webhook：Webhook 推送、资源告警和流量异常。 */
export function OpsWebhookSettingsPane() {
  if (!useOpsFeatures()) return null;
  return (
    <>
      <WebhookSettings />
      <ResourceAlertSettings />
      <TrafficAnomalySettings />
    </>
  );
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
