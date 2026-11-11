import { lazy, Suspense } from "react";
import { useTrackedRuleBatchJobs } from "@/lib/ruleBatchJobStore";

const RuleBatchJobWidget = lazy(() => import("./RuleBatchJobWidget"));

/**
 * 后台布局上的挂载点：没有在盯的批量任务时什么都不渲染，也不加载进度小窗那块代码，
 * 每个页面都不为它多一次轮询。
 */
export default function RuleBatchJobDock() {
  const ids = useTrackedRuleBatchJobs();
  if (ids.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <RuleBatchJobWidget />
    </Suspense>
  );
}
