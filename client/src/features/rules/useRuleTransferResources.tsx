/*
  从 client/src/pages/Rules.tsx 第 5648-5846 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { defaultForm, formatAddressWithPort, getForwardGroupKindLabel, type RuleTransferScopeType } from "../../pages/Rules";
import { RULE_TRANSFER_MAX_IMPORT_COUNT, type RuleTransferFileRule } from "@/lib/ruleTransfer";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { parseFailoverEndpoint } from "@shared/failoverTargets";
import { isValidForwardPort, isValidTargetHost } from "@shared/forwardRuleForm";
import { useCallback, useMemo } from "react";

export type UseRuleTransferResourcesContext = {
  hosts: Array<any> | undefined;
  importResources: Array<any>;
  importScopeType: RuleTransferScopeType;
  importResourceSearch: string;
  importResourceId: string;
  tunnelAvailabilityById: any /* 原类型 Map<number, LinkAvailabilityResult>… 引用了拿不到的 LinkAvailabilityResult，手动收拾 */;
  getForwardGroupConfigStatus: (group: any) => "available" | "degraded" | "pending" | "unavailable" | "disabled";
  importManualText: string;
};

export type UseRuleTransferResourcesResult = {
  selectedImportResource: any;
  manualImportValidation: { ok: boolean; message: string; rules: RuleTransferFileRule[]; };
  filteredImportResources: Array<any>;
  renderTransferResourceOption: any /* 原类型 (type: RuleTransferScopeType, resource: any, options?: { showStatus?: boolean; }… 引用了拿不到的 JSX，手动收拾 */;
};

export function useRuleTransferResources(ctx: UseRuleTransferResourcesContext): UseRuleTransferResourcesResult {
  const { hosts, importResources, importScopeType, importResourceSearch, importResourceId, tunnelAvailabilityById, getForwardGroupConfigStatus, importManualText } = ctx;
  const getTransferResourceSearchText = useCallback((type: RuleTransferScopeType, resource: any) => {
    const values: any[] = [resource?.id];
    if (type === "local") {
      values.push(
        resource?.name,
        resource?.description,
        resource?.displayRemark,
        resource?.domain,
        resource?.forwardType,
        resource?.groupMode,
        getForwardGroupKindLabel(resource),
      );
      (resource?.members || []).forEach((member: any) => {
        values.push(member?.hostId, member?.entryAddress, member?.connectHost, member?.name);
      });
    } else if (type === "tunnel") {
      values.push(
        resource?.name,
        getTunnelRouteText(resource, hosts || []),
        resource?.mode,
        resource?.type,
        resource?.listenPort,
        resource?.entryHostId,
        resource?.exitHostId,
      );
    } else {
      values.push(
        resource?.name,
        resource?.description,
        resource?.domain,
        resource?.groupType,
        resource?.type,
        resource?.mode,
      );
    }
    return values.filter((value) => value !== undefined && value !== null && String(value).trim()).join(" ");
  }, [hosts]);

  const filterTransferResources = useCallback((resources: any[], type: RuleTransferScopeType, search: string) => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return resources;
    return resources.filter((resource: any) => getTransferResourceSearchText(type, resource).toLowerCase().includes(keyword));
  }, [getTransferResourceSearchText]);
  const filteredImportResources = useMemo(
    () => filterTransferResources(importResources, importScopeType, importResourceSearch),
    [filterTransferResources, importResourceSearch, importResources, importScopeType]
  );
  const selectedImportResource = useMemo(
    () => importResources.find((resource: any) => String(resource.id) === importResourceId) || null,
    [importResourceId, importResources]
  );

  const getTransferResourceStatusMeta = (type: RuleTransferScopeType, resource: any) => {
    if (type === "tunnel") {
      const state = tunnelAvailabilityById.get(Number(resource?.id || 0));
      if (state?.status === "available") {
        return {
          label: "可用",
          dotClassName: "bg-[var(--fx-healthy)]",
          textClassName: "text-muted-foreground",
        };
      }
      if (state?.status === "degraded" || state?.status === "pending") {
        return {
          label: state.status === "degraded" ? "部分可用" : "检测中",
          dotClassName: "bg-[var(--fx-warn)]",
          textClassName: "text-muted-foreground",
        };
      }
      return {
        label: state?.status === "disabled" ? "停用" : "不可用",
        dotClassName: state?.status === "disabled" ? "bg-muted-foreground/60" : "bg-destructive",
        textClassName: "text-muted-foreground",
      };
    }

    const status = getForwardGroupConfigStatus(resource);
    if (status === "available") {
      return {
        label: "可用",
        dotClassName: "bg-[var(--fx-healthy)]",
        textClassName: "text-muted-foreground",
      };
    }
    if (status === "pending" || status === "degraded") {
      return {
        label: status === "degraded" ? "部分可用" : "检测中",
        dotClassName: "bg-[var(--fx-warn)]",
        textClassName: "text-muted-foreground",
      };
    }
    if (status === "disabled") {
      return {
        label: "停用",
        dotClassName: "bg-muted-foreground/60",
        textClassName: "text-muted-foreground",
      };
    }
    return {
      label: "离线",
      dotClassName: "bg-muted-foreground/60",
      textClassName: "text-muted-foreground",
    };
  };

  const renderTransferResourceOption = (type: RuleTransferScopeType, resource: any, options?: { showStatus?: boolean }) => {
    const statusMeta = options?.showStatus ? getTransferResourceStatusMeta(type, resource) : null;
    const statusBadge = statusMeta ? (
      <span className="inline-flex shrink-0 items-center" title={statusMeta.label}>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusMeta.dotClassName}`} aria-hidden="true" />
        <span className="sr-only">{statusMeta.label}</span>
      </span>
    ) : null;

    if (type === "local") {
      const members = (resource?.members || []).filter((member: any) => member?.isEnabled !== false);
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            {statusBadge}
            <span className="truncate">{resource.name || `端口转发 #${resource.id}`}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {members.length > 0 ? members.map((member: any) => member.entryAddress || member.connectHost || (member.hostId ? `主机 #${member.hostId}` : "所属主机")).join(" / ") : getForwardGroupKindLabel(resource)}
          </span>
        </div>
      );
    }
    if (type === "tunnel") {
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            {statusBadge}
            <span className="truncate">{resource.name || `#${resource.id}`}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{getTunnelRouteText(resource, hosts || [])}</span>
        </div>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-2">
        {statusBadge}
        <span className="truncate">{resource.name || `#${resource.id}`}</span>
      </span>
    );
  };
  const manualImportValidation = useMemo<{ ok: boolean; message: string; rules: RuleTransferFileRule[] }>(() => {
    const lines = String(importManualText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return { ok: false, message: "请输入目标地址，每行一个 地址:端口", rules: [] };
    }
    if (lines.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
      return { ok: false, message: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则`, rules: [] };
    }
    const rules: RuleTransferFileRule[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      // 这里每行只有一个地址（批量导入），所以用纯地址解析，
      // 不要用主备那条「出站 [探测目标]」的行语法 —— 一行两个地址在这儿是错的。
      const parsed = parseFailoverEndpoint(lines[index]);
      if (!parsed) continue;
      if ("error" in parsed) {
        return { ok: false, message: `第 ${index + 1} 行：${parsed.error}`, rules: [] };
      }
      const targetIp = String(parsed.host || "").trim();
      const targetPort = Number(parsed.port || 0);
      if (!isValidTargetHost(targetIp)) {
        return { ok: false, message: `第 ${index + 1} 行：地址格式不正确`, rules: [] };
      }
      if (!isValidForwardPort(targetPort)) {
        return { ok: false, message: `第 ${index + 1} 行：端口必须在 1-65535 之间`, rules: [] };
      }
      rules.push({
        name: formatAddressWithPort(targetIp, targetPort),
        forwardType: defaultForm.forwardType,
        protocol: defaultForm.protocol,
        sourcePort: 0,
        targetIp,
        targetPort,
        isEnabled: true,
        telegramErrorNotifyEnabled: false,
        proxyProtocolReceive: false,
        proxyProtocolSend: false,
        proxyProtocolExitReceive: false,
        proxyProtocolExitSend: false,
        proxyProtocolVersion: 1,
        tcpFastOpen: false,
        zeroCopy: false,
        udpOverTcp: false,
        udpOverTcpPort: 0,
        failoverEnabled: false,
        failoverStrategy: "fallback",
        failoverTargets: [],
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
      });
    }
    return { ok: true, message: `已识别 ${rules.length} 条手动输入规则`, rules };
  }, [defaultForm.forwardType, defaultForm.protocol, importManualText]);
  return { selectedImportResource, manualImportValidation, filteredImportResources, renderTransferResourceOption };
}
