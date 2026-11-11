import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { trackRuleBatchJob } from "@/lib/ruleBatchJobStore";
import { RULE_BATCH_JOB_LIMITS, RULE_BATCH_JOB_OPERATION_LABELS, type StartRuleBatchJobInput } from "@shared/ruleBatchJobs";

/**
 * 把一批规则操作交给服务端任务（rules.batchJobStart），交上去就返回：进度看右下角的小窗。
 * 同样的一批还在跑时再点，服务端返回那个已有的任务，这里只提示一句，不会做第二遍。
 */
export function useRuleBatchJobSubmit() {
  const start = trpc.rules.batchJobStart.useMutation();
  const submit = async (input: StartRuleBatchJobInput) => {
    const count = input.operation === "copy" ? input.copyItems?.length || 0 : input.ruleIds?.length || 0;
    if (count === 0) {
      toast.error("请先选择规则");
      return false;
    }
    if (count > RULE_BATCH_JOB_LIMITS.maxItems) {
      toast.error(`一次最多处理 ${RULE_BATCH_JOB_LIMITS.maxItems} 项，这次有 ${count} 项，请分开提交`);
      return false;
    }
    try {
      const { snapshot, duplicate } = await start.mutateAsync(input);
      trackRuleBatchJob(snapshot.id);
      if (duplicate) toast.info("这批规则已经在处理中，进度见右下角");
      else toast.success(`已提交${RULE_BATCH_JOB_OPERATION_LABELS[input.operation]}：${count} 项，进度见右下角`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "提交批量任务失败");
      return false;
    }
  };
  return { submit, isPending: start.isPending };
}
