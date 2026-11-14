import { useOpsFeatures } from "../useOpsFeatures";
import RecentEventsCard from "../events/RecentEventsCard";

/** 首页（管理员）多出来的「最近动态」，排在流量下面。 */
export default function OpsHomeExtras({ isAdmin }: { isAdmin: boolean }) {
  if (!useOpsFeatures() || !isAdmin) return null;
  return <RecentEventsCard />;
}
