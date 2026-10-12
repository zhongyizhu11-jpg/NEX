import { useOpsFeatures } from "../useOpsFeatures";
import StatusAvailability from "../status/StatusAvailability";
import PublicMaintenanceBanner from "../maintenance/PublicMaintenanceBanner";

/** 公开监控页顶部，第五套主题多出来的可用率、每日条和最近事件。 */
export default function OpsPublicMonitorExtras({ path }: { path?: string }) {
  if (!useOpsFeatures()) return null;
  return (
    <>
      <PublicMaintenanceBanner />
      <StatusAvailability path={path} />
    </>
  );
}
