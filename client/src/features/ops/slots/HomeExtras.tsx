import { useOpsFeatures } from "../useOpsFeatures";
import RecentEventsCard from "../events/RecentEventsCard";

/** 首页（管理员）在「需要关注」之后多出来的「最近动态」。 */
export default function OpsHomeExtras({ isAdmin }: { isAdmin: boolean }) {
  if (!useOpsFeatures() || !isAdmin) return null;
  return <RecentEventsCard />;
}
