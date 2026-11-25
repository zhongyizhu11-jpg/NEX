import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DiagnoseDialog, type DiagnoseExtraTab } from "@/components/DiagnoseDialog";
import { LinkTestProbeView, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { addHostNodeMeta, addNodeMetaAliases, hostDisplayName, type LinkTestNodeMeta } from "@/lib/linkTestNodeMeta";
import { handoffManualTestResult } from "@/lib/manualTestCache";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";

/*
  转发链的「诊断」框。和规则页的 SelfTestDialog、链路页的 TunnelSelfTestDialog 一样，
  从页面里抽成单独模块、由页面 lazy 引入：它连着 DiagnoseDialog 和整套探测结果视图，
  只有点了「诊断」才用得上，不该跟着转发组页面一起下载。
*/
/** 只取这里真正看的几个字段；转发组 / 入口组本身是 any 的列表项，不往下传。 */
type GroupMember = {
  hostId?: number | string | null;
  priority?: number | string | null;
  isEnabled?: boolean | null;
  memberType?: string | null;
  entryAddress?: string | null;
};
type GroupLike = { members?: GroupMember[] | null; remark?: string | null } | null;

export default function ForwardGroupSelfTestDialog({
  groupId,
  groupName,
  group,
  entryGroup,
  hostById,
  open,
  onOpenChange,
  extraTabs,
  actions,
}: {
  groupId: number;
  groupName: string;
  group?: GroupLike;
  entryGroup?: GroupLike;
  hostById?: Map<number, unknown>;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 并进来的页（延迟记录）和底部动作（故障包、拓扑），和规则、隧道的诊断框一样（DiagnoseDialog）。 */
  extraTabs?: DiagnoseExtraTab[];
  actions?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [baselineTestId, setBaselineTestId] = useState(0);
  const manualTestRef = useRef(false);
  const { data: latest } = trpc.forwardGroups.latestTest.useQuery(
    { groupId, includeActive: optimisticTesting },
    { enabled: open, refetchInterval: pollingInterval("interactive", open), refetchOnWindowFocus: false }
  );
  const lastFailureToastKey = useRef("");
  const testMutation = trpc.forwardGroups.test.useMutation({
    onSuccess: async () => {
      await utils.forwardGroups.latestTest.invalidate({ groupId });
    },
    onError: (e) => {
      setOptimisticTesting(false);
      manualTestRef.current = false;
      toast.error(e.message || "诊断没发出去");
    },
  });
  const status = latest?.status as string | undefined;
  const isServerTesting = status === "pending" || status === "running";
  const isTesting = testMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isFailed = !!latest && !isTesting && !isSuccess;
  const parsedMessage = useMemo(() => parseLinkTestMessage(latest?.message), [latest?.message]);
  const latestTestId = Number(latest?.id) || 0;
  const hasFreshResult = latestTestId > baselineTestId;
  const linkTestNodeData = useMemo(() => {
    const meta: Record<string, LinkTestNodeMeta | undefined> = {};
    const members = [...(group?.members || [])]
      .filter((member) => member.isEnabled !== false)
      .sort((a, b) => Number(a.priority) - Number(b.priority));
    const entryMembers = entryGroup
      ? [...(entryGroup.members || [])]
        .filter((member) => member.memberType === "host" && member.isEnabled !== false)
        .sort((a, b) => Number(a.priority) - Number(b.priority))
      : [];
    [...entryMembers, ...members].forEach((member) => {
      const hostId = Number(member.hostId || 0);
      const host = hostById?.get(hostId);
      addHostNodeMeta(meta, host, [
        member.entryAddress,
        hostId ? `主机${hostId}` : "",
        hostId ? `主机 #${hostId}` : "",
      ]);
    });
    const firstEntryHost = hostById?.get(Number(entryMembers[0]?.hostId || 0));
    const firstHost = hostById?.get(Number(members[0]?.hostId || 0));
    const lastHost = hostById?.get(Number(members[members.length - 1]?.hostId || 0));
    const targetRemark = String(group?.remark || "").trim();
    const targetLabel = targetRemark || hostDisplayName(lastHost) || groupName;
    const targetMeta = targetLabel ? { label: targetLabel } : undefined;
    if (targetMeta) addNodeMetaAliases(meta, [targetLabel, "目标", "目的节点"], targetMeta);
    const plannedSegments: LinkTestPlannedSegment[] = [];
    const hopCount = (entryMembers.length > 0 ? 1 : 0) + Math.max(0, members.length - 1);
    if (entryMembers.length > 0 && members[0]) {
      const firstChainHost = hostById?.get(Number(members[0].hostId || 0));
      entryMembers.forEach((entryMember) => {
        const entryHostId = Number(entryMember.hostId || 0);
        const firstChainHostId = Number(members[0].hostId || 0);
        const entryHost = hostById?.get(Number(entryMember.hostId || 0));
        plannedSegments.push({
          from: hostDisplayName(entryHost) || `入口主机 #${entryMember.hostId || "-"}`,
          to: hostDisplayName(firstChainHost) || `主机 #${members[0].hostId || "-"}`,
          fromHostId: entryHostId || null,
          toHostId: firstChainHostId || null,
          hopIndex: 0,
          hopCount,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(entryMember.hostId || "")],
          toMeta: meta[hostDisplayName(firstChainHost)] || meta[String(members[0].hostId || "")],
        });
      });
    }
    members.slice(0, -1).forEach((member, index) => {
      const fromHostId = Number(member.hostId || 0);
      const toHostId = Number(members[index + 1]?.hostId || 0);
      const fromHost = hostById?.get(Number(member.hostId || 0));
      const toHost = hostById?.get(Number(members[index + 1]?.hostId || 0));
      plannedSegments.push({
        from: hostDisplayName(fromHost) || `主机 #${member.hostId || "-"}`,
        to: hostDisplayName(toHost) || `主机 #${members[index + 1]?.hostId || "-"}`,
        fromHostId: fromHostId || null,
        toHostId: toHostId || null,
        hopIndex: index + (entryMembers.length > 0 ? 1 : 0),
        hopCount,
        fromMeta: meta[hostDisplayName(fromHost)] || meta[String(member.hostId || "")],
        toMeta: meta[hostDisplayName(toHost)] || meta[String(members[index + 1]?.hostId || "")],
      });
    });
    return {
      nodeMeta: meta,
      sourceLabel: hostDisplayName(firstEntryHost) || hostDisplayName(firstHost) || groupName,
      targetLabel,
      plannedSegments: plannedSegments.filter((segment) => segment.from && segment.to && segment.from.trim().toLowerCase() !== segment.to.trim().toLowerCase()),
    };
  }, [entryGroup, group?.members, group?.remark, groupName, hostById]);

  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setBaselineTestId(0);
      manualTestRef.current = false;
      lastFailureToastKey.current = "";
    }
  }, [open]);

  useEffect(() => {
    if (optimisticTesting && hasFreshResult && !isServerTesting && latest) {
      handoffManualTestResult(
        latest,
        (result) => utils.forwardGroups.latestTest.setData(
          { groupId, includeActive: false },
          result,
        ),
        () => setOptimisticTesting(false),
      );
    }
  }, [groupId, hasFreshResult, isServerTesting, latest, optimisticTesting, utils]);

  useEffect(() => {
    const message = parsedMessage.message.trim();
    if (!open || isTesting || !isFailed || !message || !manualTestRef.current || !hasFreshResult) return;
    const key = `${groupId}:${status}:${latest?.updatedAt || ""}:${message}`;
    if (lastFailureToastKey.current !== key) {
      lastFailureToastKey.current = key;
      manualTestRef.current = false;
      toast.error("诊断没通过", { description: message });
    }
  }, [groupId, hasFreshResult, isFailed, isTesting, latest?.updatedAt, open, parsedMessage.message, status]);

  useEffect(() => {
    if (!isTesting && isSuccess) manualTestRef.current = false;
  }, [isSuccess, isTesting]);

  const plannedSegmentCount = linkTestNodeData.plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";

  return (
    <DiagnoseDialog
      open={open}
      onOpenChange={onOpenChange}
      subjectName={groupName}
      scope="沿着链一段段测到出口"
      sizeClassName={probeDialogSizeClass}
      testing={isTesting}
      lastRunAt={latest?.updatedAt ?? null}
      outcome={isSuccess ? "success" : status === "timeout" ? "timeout" : isFailed ? "failed" : null}
      failureReason={parsedMessage.message}
      checklist={{ kind: "forwardGroup", id: groupId }}
      extraTabs={extraTabs}
      actions={actions}
      onRun={() => {
        manualTestRef.current = true;
        setBaselineTestId(latestTestId);
        setOptimisticTesting(true);
        testMutation.mutate({ groupId });
      }}
    >
      <LinkTestProbeView
        parsed={parsedMessage}
        fallbackLatencyMs={latest?.latencyMs}
        isSuccess={isSuccess}
        isTesting={isTesting}
        sourceLabel={linkTestNodeData.sourceLabel}
        targetLabel={linkTestNodeData.targetLabel}
        nodeMeta={linkTestNodeData.nodeMeta}
        plannedSegments={linkTestNodeData.plannedSegments}
      />
    </DiagnoseDialog>
  );
}
