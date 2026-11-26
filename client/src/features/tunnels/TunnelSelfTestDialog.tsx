/* 从 client/src/pages/Tunnels.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { DiagnoseDialog, type DiagnoseExtraTab } from "@/components/DiagnoseDialog";
import { getLinkTestDetailEndpointIds, LinkTestProbeView, hasPendingLinkTestDetails, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { addHostNodeMeta, hostAddressCandidates, hostDisplayName } from "@/lib/linkTestNodeMeta";
import { pollingInterval } from "@/lib/polling";
import { hasQuerySnapshotAfter } from "@/lib/manualTestCache";
import { getTunnelHopIds, tunnelHopHostName } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { enabledHostGroupMembers } from "@/pages/Tunnels";

export default function TunnelSelfTestDialog({
  tunnelId,
  tunnelName,
  hosts,
  entryGroups,
  open,
  onOpenChange,
  extraTabs,
  actions,
}: {
  tunnelId: number;
  tunnelName: string;
  hosts?: any[];
  entryGroups?: any[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 并进来的页（延迟记录、连接监控）和底部动作（故障包、拓扑），见 DiagnoseDialog。 */
  extraTabs?: DiagnoseExtraTab[];
  actions?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const tunnelQuery = trpc.tunnels.getById.useQuery({ id: tunnelId }, {
    enabled: open,
    refetchInterval: pollingInterval("interactive", open),
    refetchOnWindowFocus: false,
  });
  const { data: tunnel } = tunnelQuery;
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [startedLastTestAt, setStartedLastTestAt] = useState<string | null>(null);
  const [sawServerTesting, setSawServerTesting] = useState(false);
  const [postMutationQueryBaseline, setPostMutationQueryBaseline] = useState<number | null>(null);
  const manualTestRef = useRef(false);
  const manualTestBaselineAtRef = useRef("");
  const manualTestResultObservedRef = useRef(false);
  const tunnelQueryUpdatedAtRef = useRef(tunnelQuery.dataUpdatedAt);
  useEffect(() => {
    tunnelQueryUpdatedAtRef.current = tunnelQuery.dataUpdatedAt;
  }, [tunnelQuery.dataUpdatedAt]);
  const testMutation = trpc.tunnels.test.useMutation({
    onSuccess: async () => {
      setPostMutationQueryBaseline(tunnelQueryUpdatedAtRef.current);
      await utils.tunnels.getById.invalidate({ id: tunnelId });
      void Promise.all([
        utils.tunnels.list.invalidate(),
        utils.tunnels.options.invalidate(),
        utils.tunnels.listPage.invalidate(),
        utils.tunnels.mapItems.invalidate(),
      ]).catch(() => undefined);
    },
    onError: (e) => {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
      setPostMutationQueryBaseline(null);
      manualTestRef.current = false;
      manualTestBaselineAtRef.current = "";
      manualTestResultObservedRef.current = false;
      toast.error(e.message || "诊断没发出去");
    },
  });

  const status = tunnel?.lastTestStatus as string | undefined;
  const lastTestAt = tunnel?.lastTestAt ? String(tunnel.lastTestAt) : "";
  const isServerTesting = status === "pending" || status === "running";
  const isTesting = testMutation.isPending || optimisticTesting || (manualTestRef.current && isServerTesting);
  const isSuccess = status === "success";
  const isFailed = status === "failed";
  const latencyMs = tunnel?.lastLatencyMs;
  const displayingPreviousResult = isServerTesting && !manualTestRef.current;
  const waitingForManualResult = manualTestRef.current && !manualTestResultObservedRef.current;
  const displaySuccess = displayingPreviousResult
    ? typeof latencyMs === "number" && Number.isFinite(latencyMs)
    : isSuccess;
  const lastFailureToastKey = useRef("");
  const parsedMessage = useMemo(
    () => parseLinkTestMessage(displayingPreviousResult || waitingForManualResult ? null : tunnel?.lastTestMessage),
    [displayingPreviousResult, tunnel?.lastTestMessage, waitingForManualResult],
  );
  const hasPendingDetails = hasPendingLinkTestDetails(parsedMessage);
  const displayTesting = isTesting || hasPendingDetails;
  const linkTestNodeData = useMemo(() => {
    const meta: Record<string, any> = {};
    const nodeTooltips: Record<string, ReactNode> = {};
    const fullHostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const tunnelHostById = new Map<number, any>();
    [
      ...(tunnel?.hopHosts || []),
      tunnel?.entryHost,
      tunnel?.exitHost,
      ...(tunnel?.loadBalanceExitHosts || []),
      ...(Array.isArray(tunnel?.loadBalanceExits) ? tunnel.loadBalanceExits.map((exit: any) => exit?.host) : []),
    ].forEach((host: any) => {
      const id = Number(host?.id || 0);
      if (id > 0) tunnelHostById.set(id, host);
    });
    const hopIds = getTunnelHopIds(tunnel);
    const hostForId = (hostId: number) => fullHostById.get(Number(hostId)) || tunnelHostById.get(Number(hostId));
    const entryGroup = (entryGroups || []).find((group: any) => Number(group?.id || 0) === Number(tunnel?.entryGroupId || 0));
    const entryGroupMembers = enabledHostGroupMembers(entryGroup);
    const entryGroupMemberByHostId = new Map<number, any>();
    entryGroupMembers.forEach((member: any) => {
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0) entryGroupMemberByHostId.set(hostId, member);
    });
    const labelForHostId = (hostId: number) => {
      const host = hostForId(hostId);
      const member = entryGroupMemberByHostId.get(Number(hostId));
      return hostDisplayName(host)
        || String(member?.name || member?.remark || "").trim()
        || tunnelHopHostName(tunnel, hostId, hosts)
        || `主机 #${hostId}`;
    };
    const exitDisplayAddressFor = (hostId: number, connectHost?: string | null) => {
      const configured = String(connectHost || "").trim();
      if (configured) return configured;
      return hostAddressCandidates(hostForId(hostId)).join(" / ");
    };
    const putNodeMetaAlias = (key: unknown, nodeMeta: any) => {
      const text = String(key || "").trim();
      if (!text) return;
      meta[text] = nodeMeta;
      meta[text.toLowerCase()] = nodeMeta;
    };
    const addExitNodeMetaForHostId = (hostId: number, connectHost?: string | null, aliases: Array<unknown> = []) => {
      const host = hostForId(hostId);
      const label = labelForHostId(hostId);
      const configuredAddress = String(connectHost || "").trim();
      addHostNodeMeta(meta, host, [label, configuredAddress, ...aliases]);
      const baseMeta = meta[hostDisplayName(host)] || meta[String(hostId)] || undefined;
      if (!baseMeta) return;
      const addressParts = [
        configuredAddress,
        ...String(baseMeta.address || "").split(" / "),
        ...hostAddressCandidates(host),
      ].map((value) => String(value || "").trim()).filter(Boolean);
      const nextMeta = {
        ...baseMeta,
        label: label || baseMeta.label,
        address: Array.from(new Set(addressParts)).join(" / ") || baseMeta.address || null,
      };
      [
        label,
        hostDisplayName(host),
        hostId,
        `主机${hostId}`,
        `主机 #${hostId}`,
        configuredAddress,
        ...hostAddressCandidates(host),
        ...aliases,
      ].forEach((alias) => putNodeMetaAlias(alias, nextMeta));
    };
    const addNodeMetaForHostId = (hostId: number) => {
      const host = hostForId(hostId);
      addHostNodeMeta(meta, host, [
        labelForHostId(hostId),
        String(entryGroupMemberByHostId.get(Number(hostId))?.entryAddress || "").trim(),
        `主机${hostId}`,
        `主机 #${hostId}`,
        tunnelHopHostName(tunnel, hostId, hosts),
        hostDisplayName(host),
        `主机${hostId}`,
        `主机 #${hostId}`,
      ]);
    };
    hopIds.forEach((hostId: number) => addNodeMetaForHostId(hostId));
    entryGroupMembers.forEach((member: any) => {
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0) addNodeMetaForHostId(hostId);
    });
    const firstHostId = Number(hopIds[0] || 0);
    const lastHostId = Number(hopIds[hopIds.length - 1] || 0);
    const hopCount = Math.max(0, hopIds.length - 1);
    const nodeMetaFor = (host: any, hostId: number) => meta[hostDisplayName(host)] || meta[String(hostId)] || undefined;
    let plannedSegments: LinkTestPlannedSegment[] = hopIds.slice(0, -1).map((hostId: number, index: number) => {
      const nextHostId = Number(hopIds[index + 1] || 0);
      const fromHost = hostForId(Number(hostId));
      const toHost = hostForId(nextHostId);
      return {
        from: labelForHostId(Number(hostId)),
        to: labelForHostId(nextHostId),
        fromHostId: Number(hostId) || null,
        toHostId: nextHostId || null,
        hopIndex: index,
        hopCount,
        fromMeta: nodeMetaFor(fromHost, Number(hostId)),
        toMeta: nodeMetaFor(toHost, nextHostId),
      };
    }).filter((segment: LinkTestPlannedSegment) => segment.from && segment.to);
    const entryHostIds = Array.from(new Set<number>((
      entryGroupMembers.length > 0
        ? entryGroupMembers.map((member: any) => Number(member?.hostId || 0))
        : [firstHostId]
    ).filter((hostId: number) => Number.isFinite(hostId) && hostId > 0)));
    if (entryHostIds.length > 1) {
      const restHopIds = hopIds.slice(1).filter((hostId: number) => Number.isFinite(Number(hostId)) && Number(hostId) > 0);
      const nextHostId = Number(restHopIds[0] || lastHostId || tunnel?.exitHostId || 0);
      const nextHost = hostForId(nextHostId);
      const nextLabel = labelForHostId(nextHostId);
      const entrySegments: LinkTestPlannedSegment[] = entryHostIds.map((entryHostId: number) => {
        const entryHost = hostForId(entryHostId);
        return {
          from: labelForHostId(entryHostId),
          to: nextLabel,
          fromHostId: entryHostId || null,
          toHostId: nextHostId || null,
          hopIndex: 0,
          hopCount,
          fromMeta: nodeMetaFor(entryHost, entryHostId),
          toMeta: nodeMetaFor(nextHost, nextHostId),
        };
      });
      const restSegments: LinkTestPlannedSegment[] = restHopIds.slice(0, -1).map((hostId: number, index: number) => {
        const nextRestHostId = Number(restHopIds[index + 1] || 0);
        const fromHost = hostForId(Number(hostId));
        const toHost = hostForId(nextRestHostId);
        return {
          from: labelForHostId(Number(hostId)),
          to: labelForHostId(nextRestHostId),
          fromHostId: Number(hostId) || null,
          toHostId: nextRestHostId || null,
          hopIndex: index + 1,
          hopCount,
          fromMeta: nodeMetaFor(fromHost, Number(hostId)),
          toMeta: nodeMetaFor(toHost, nextRestHostId),
        };
      });
      plannedSegments = [...entrySegments, ...restSegments].filter((segment: LinkTestPlannedSegment) => segment.from && segment.to);
    }
    const extraExits = Array.isArray(tunnel?.loadBalanceExits)
      ? tunnel.loadBalanceExits
        .filter((exit: any) => Number(exit?.hostId || 0) > 0)
        .sort((a: any, b: any) => Number(a?.seq || 0) - Number(b?.seq || 0))
      : [];
    const primaryExitLabel = lastHostId ? labelForHostId(lastHostId) : "";
    if (primaryExitLabel && extraExits.length > 0) {
      const entryReferenceLabel = entryHostIds.length > 1
        ? "入口组"
        : firstHostId
          ? labelForHostId(firstHostId)
          : "入口";
      const exitRows = [
        {
          hostId: lastHostId,
          label: primaryExitLabel,
          role: "主出口",
          connectHost: String(tunnel?.connectHost || "").trim(),
          listenPort: Number(tunnel?.listenPort || 0) || null,
        },
        ...extraExits.map((exit: any, index: number) => {
          const hostId = Number(exit?.hostId || 0);
          return {
            hostId,
            label: labelForHostId(hostId),
            role: `备用出口 ${index + 1}`,
            connectHost: String(exit?.connectHost || "").trim(),
            listenPort: Number(exit?.listenPort || 0) || null,
          };
        }),
      ].filter((row) => row.hostId > 0);
      exitRows.forEach((row) => addExitNodeMetaForHostId(row.hostId, row.connectHost, [row.label, row.role]));
      const exitRowByLabel = new Map(exitRows.map((row) => [row.label, row]));
      plannedSegments = plannedSegments.map((segment) => {
        const fromRow = exitRowByLabel.get(segment.from);
        const toRow = exitRowByLabel.get(segment.to);
        if (!fromRow && !toRow) return segment;
        return {
          ...segment,
          fromMeta: fromRow ? (meta[fromRow.label] || segment.fromMeta) : segment.fromMeta,
          toMeta: toRow ? (meta[toRow.label] || segment.toMeta) : segment.toMeta,
        };
      });
      const detailByTarget = new Map<string, any>();
      const detailByHostId = new Map<number, any>();
      (parsedMessage.details || []).forEach((detail: any, index: number) => {
        const route = String(detail?.routeLabel || detail?.hopLabel || "").trim();
        const match = route.match(/->\s*(.+)$/);
        const target = String(match?.[1] || "").trim();
        if (target) detailByTarget.set(target.toLowerCase(), { detail, index });
        const targetHostId = Number(getLinkTestDetailEndpointIds(detail).toHostId || 0);
        if (targetHostId > 0) detailByHostId.set(targetHostId, { detail, index });
      });
      const latestSeries = Array.isArray(tunnel?.latestLatencySeries) ? tunnel.latestLatencySeries : [];
      const latestSeriesByKey = new Map<string, any>();
      latestSeries.forEach((item: any) => {
        const key = String(item?.seriesKey || "").trim().toLowerCase();
        if (key) latestSeriesByKey.set(key, item);
      });
      const detailForExitRow = (row: { hostId: number; label: string }) => (
        detailByHostId.get(row.hostId)
        || detailByTarget.get(row.label.toLowerCase())
        || null
      );
      const latestForExitRow = (index: number) => (
        latestSeriesByKey.get(index === 0 ? "primary" : `exit-${index + 1}`)
        || null
      );
      const tooltip = (
        <div className="min-w-[240px] space-y-2">
          <div>
            <div className="text-sm font-semibold">出口组</div>
            <div className="text-[11px] text-muted-foreground">主图仅展示主出口，备用出口在此查看。相对入口：{entryReferenceLabel}</div>
          </div>
          <div className="space-y-1.5">
            {exitRows.map((row, index) => {
              const detailRecord = detailForExitRow(row);
              const detail = detailRecord?.detail;
              const latest = latestForExitRow(index);
              const latestLatency = typeof latest?.latencyMs === "number" && Number.isFinite(latest.latencyMs) ? Number(latest.latencyMs) : null;
              const latestTimeout = latest?.isTimeout === true;
              const pending = detail?.pending === true || displayTesting;
              const failed = !pending && (detail ? detail.success === false : latestTimeout);
              const success = pending || !failed;
              const latency = typeof detail?.latencyMs === "number" && Number.isFinite(detail.latencyMs)
                ? `${detail.latencyMs} ms`
                : pending
                  ? "诊断中"
                  : detail
                    ? "失败"
                    : latestLatency !== null
                      ? `${latestLatency}ms`
                      : latestTimeout
                        ? "失败"
                        : "--";
              const displayAddress = exitDisplayAddressFor(row.hostId, row.connectHost);
              const addressText = [displayAddress, row.listenPort ? `:${row.listenPort}` : ""].filter(Boolean).join("") || "默认连接地址";
              return (
                <div key={`${row.role}-${row.hostId}`} className="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{row.label}</span>
                    <span className={success ? "shrink-0 text-[var(--fx-healthy-text)]" : "shrink-0 text-destructive"}>{latency}</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span>{row.role}</span>
                    <span className="min-w-0 truncate" title={addressText}>{addressText}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
      [
        primaryExitLabel,
        primaryExitLabel.toLowerCase(),
        meta[primaryExitLabel]?.label,
        meta[primaryExitLabel]?.label?.toLowerCase(),
      ].filter(Boolean).forEach((key: any) => {
        nodeTooltips[String(key)] = tooltip;
      });
    }
    if (entryHostIds.length <= 1 && hopIds.length === 2 && tunnel?.loadBalanceEnabled && extraExits.length > 0) {
      const entryHost = hostForId(firstHostId);
      const entryLabel = hostDisplayName(entryHost) || (firstHostId ? tunnelHopHostName(tunnel, firstHostId, hosts) : tunnelName);
      const branchGroupKey = `tunnel-${tunnel?.id || tunnelName}-load-balance`;
      const primaryExitHost = hostForId(lastHostId);
      const branchSegments: LinkTestPlannedSegment[] = [{
        from: entryLabel,
        to: hostDisplayName(primaryExitHost) || (lastHostId ? tunnelHopHostName(tunnel, lastHostId, hosts) : tunnelName),
        fromHostId: firstHostId || null,
        toHostId: lastHostId || null,
        hopIndex: 0,
        hopCount: 1,
        fromMeta: meta[hostDisplayName(entryHost)] || meta[String(firstHostId)] || undefined,
        toMeta: meta[hostDisplayName(primaryExitHost)] || meta[String(lastHostId)] || undefined,
        groupKey: branchGroupKey,
        groupLabel: "多出口负载均衡",
      }];
      for (const exit of extraExits) {
        const exitHostId = Number(exit?.hostId || 0);
        const exitHost = hostForId(exitHostId);
        addExitNodeMetaForHostId(exitHostId, String(exit?.connectHost || "").trim(), [hostDisplayName(exitHost), `主机${exitHostId}`, `主机 #${exitHostId}`]);
        branchSegments.push({
          from: entryLabel,
          to: hostDisplayName(exitHost) || `主机${exitHostId}`,
          fromHostId: firstHostId || null,
          toHostId: exitHostId || null,
          hopIndex: 0,
          hopCount: 1,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(firstHostId)] || undefined,
          toMeta: meta[hostDisplayName(exitHost)] || meta[String(exitHostId)] || undefined,
          groupKey: branchGroupKey,
          groupLabel: "多出口负载均衡",
        });
      }
      /*
        多出口负载均衡：每台出口一条分支（入口 → 出口 N），各写各的延迟，下面是「最大延迟」（LinkTestLatencySummary 的分支视图）。
        服务端的隧道测试本来就逐台测（tunnel-load-balance-summary，每台一条 detail）；以前这里只留主出口那一条，
        别的出口测了也不显示（用户 2026-11-26：「隧道负载均衡多出口时，诊断是不是应该显示到每个出口的延迟」）。
      */
      plannedSegments = branchSegments.filter((segment: LinkTestPlannedSegment) => segment.from && segment.to);
    }
    return {
      nodeMeta: meta,
      nodeTooltips,
      sourceLabel: firstHostId ? labelForHostId(firstHostId) : tunnelName,
      targetLabel: lastHostId ? labelForHostId(lastHostId) : tunnelName,
      plannedSegments,
    };
  }, [displayTesting, entryGroups, hosts, parsedMessage.details, tunnel, tunnelName]);

  useEffect(() => {
    setOptimisticTesting(false);
    setStartedLastTestAt(null);
    setSawServerTesting(false);
    setPostMutationQueryBaseline(null);
    manualTestRef.current = false;
    manualTestBaselineAtRef.current = "";
    manualTestResultObservedRef.current = false;
  }, [open, tunnelId]);

  useEffect(() => {
    if (isServerTesting && manualTestRef.current) {
      manualTestResultObservedRef.current = true;
      setSawServerTesting(true);
    }
  }, [isServerTesting]);

  useEffect(() => {
    const hasNewTestTimestamp = startedLastTestAt === "__none__"
      ? !!lastTestAt
      : !!lastTestAt && lastTestAt !== startedLastTestAt;
    const hasPostMutationQuerySnapshot = hasQuerySnapshotAfter(
      postMutationQueryBaseline,
      tunnelQuery.dataUpdatedAt,
    );
    if (manualTestRef.current && (isServerTesting || hasNewTestTimestamp || hasPostMutationQuerySnapshot)) {
      manualTestResultObservedRef.current = true;
    }
    if (!optimisticTesting || isServerTesting) return;
    if (sawServerTesting || hasNewTestTimestamp || hasPostMutationQuerySnapshot) {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
      setPostMutationQueryBaseline(null);
    }
  }, [
    isServerTesting,
    lastTestAt,
    optimisticTesting,
    postMutationQueryBaseline,
    sawServerTesting,
    startedLastTestAt,
    tunnelQuery.dataUpdatedAt,
  ]);

  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = parsedMessage.message.trim();
    const messageLooksSuccessful = /测试成功|检测成功/.test(message) && !/失败|超时|不可达|异常/.test(message);
    const baselineAt = manualTestBaselineAtRef.current;
    const hasFreshResult = manualTestResultObservedRef.current
      || !baselineAt
      || (tunnel?.lastTestAt && String(tunnel.lastTestAt) !== baselineAt);
    if (!displayTesting && isFailed && message && !messageLooksSuccessful && manualTestRef.current && hasFreshResult) {
      const key = `${tunnelId}:${status}:${tunnel?.lastTestAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        manualTestRef.current = false;
        toast.error("诊断没通过", {
          description: message,
        });
      }
    }
    if (!displayTesting && isSuccess) {
      manualTestRef.current = false;
    }
  }, [open, displayTesting, isFailed, isSuccess, status, tunnel?.lastTestAt, parsedMessage.message, tunnelId]);

  const plannedSegmentCount = linkTestNodeData.plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";

  return (
    <DiagnoseDialog
      open={open}
      onOpenChange={onOpenChange}
      subjectName={tunnelName}
      scope="从入口测到出口"
      sizeClassName={probeDialogSizeClass}
      testing={displayTesting}
      lastRunAt={lastTestAt || null}
      outcome={displaySuccess ? "success" : status === "timeout" ? "timeout" : isFailed ? "failed" : null}
      failureReason={parsedMessage.message}
      checklist={{ kind: "tunnel", id: tunnelId }}
      extraTabs={extraTabs}
      actions={actions}
      onRun={() => {
        lastFailureToastKey.current = "";
        manualTestRef.current = true;
        manualTestBaselineAtRef.current = lastTestAt || "";
        manualTestResultObservedRef.current = false;
        setStartedLastTestAt(lastTestAt || "__none__");
        setSawServerTesting(false);
        setPostMutationQueryBaseline(null);
        setOptimisticTesting(true);
        testMutation.mutate({ id: tunnelId });
      }}
    >
      <LinkTestProbeView
        parsed={parsedMessage}
        fallbackLatencyMs={latencyMs}
        isSuccess={displaySuccess}
        isTesting={displayTesting}
        sourceLabel={linkTestNodeData.sourceLabel}
        targetLabel={linkTestNodeData.targetLabel}
        nodeMeta={linkTestNodeData.nodeMeta}
        nodeTooltips={linkTestNodeData.nodeTooltips}
        plannedSegments={linkTestNodeData.plannedSegments}
      />
    </DiagnoseDialog>
  );
}
