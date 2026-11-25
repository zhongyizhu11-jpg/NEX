/*
  从 client/src/pages/Rules.tsx 第 3549-3674 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { trpc } from "@/lib/trpc";
import type { PortPolicy } from "@shared/portPolicy";
import { getForwardGroupRuleForwardType, type RuleFormData, type RuleResourceRow } from "../../pages/Rules";
import { isValidForwardPort } from "@shared/forwardRuleForm";
import { forwardGroupModeOf } from "@shared/forwardTypes";
import { useCallback, useEffect } from "react";
import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";

export type UseRulePortCheckContext = {
  latestPortCheckRef: RefObject<number>;
  form: RuleFormData;
  isForwardGroupRouteMode: boolean;
  setPortRangeError: Dispatch<SetStateAction<string | null>>;
  setPortStatus: Dispatch<SetStateAction<"idle" | "checking" | "available" | "used">>;
  utils: ReturnType<typeof trpc.useUtils>;
  editingId: number | null;
  createOwnerUserId: number | undefined;
  formSourcePortEnd: number;
  selectedEntryPortPolicy: PortPolicy;
  usableForwardTypes: Array<"iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx">;
  setForm: Dispatch<SetStateAction<RuleFormData>>;
  availablePortForwardGroups: Array<RuleResourceRow>;
  availableForwardChainGroups: Array<RuleResourceRow>;
  availableFailoverForwardGroups: Array<RuleResourceRow>;
  selectedForwardGroup: RuleResourceRow;
  isLegacyLocalRuleEdit: boolean;
  canUseMainBackup: boolean;
  systemSettingsFetched: boolean;
  telegramBotReady: boolean;
};

export type UseRulePortCheckResult = {
  handleRandomPort: () => Promise<void>;
};

export function useRulePortCheck(ctx: UseRulePortCheckContext): UseRulePortCheckResult {
  const { latestPortCheckRef, form, isForwardGroupRouteMode, setPortRangeError, setPortStatus, utils, editingId, createOwnerUserId, formSourcePortEnd, selectedEntryPortPolicy, usableForwardTypes, setForm, availablePortForwardGroups, availableForwardChainGroups, availableFailoverForwardGroups, selectedForwardGroup, isLegacyLocalRuleEdit, canUseMainBackup, systemSettingsFetched, telegramBotReady } = ctx;
  const checkPort = useCallback(async () => {
    const checkId = latestPortCheckRef.current + 1;
    latestPortCheckRef.current = checkId;
    const routeMode = form.routeMode;
    const hostId = form.hostId;
    const forwardGroupId = form.forwardGroupId;
    const tunnelId = form.tunnelId;
    const sourcePort = form.sourcePort;
    // 共享 TLS 入站上的规则没有自己的对外端口，不查。
    if (form.entryMode === "sni") return;
    if (!sourcePort || sourcePort < 1) return;
    if (isForwardGroupRouteMode ? !forwardGroupId : !hostId) return;
    if (!isValidForwardPort(sourcePort)) {
      setPortRangeError("端口必须在 1-65535 之间");
      setPortStatus("used");
      return;
    }
    // 超不超范围交给 checkPort 判 —— 它返回的 reason 就是服务端的原话。
    // 以前这里会先用界面自己算的那份策略拦一道，拦下了就**直接返回**，
    // 连请求都不发；而那份策略和服务端并不一致。
    setPortRangeError(null);
    setPortStatus("checking");
    try {
      const result = await utils.rules.checkPort.fetch({
        userId: editingId ? undefined : createOwnerUserId,
        ...(isForwardGroupRouteMode
          ? { forwardGroupId: Number(forwardGroupId) }
          : { hostId: Number(hostId), tunnelId: routeMode === "tunnel" ? tunnelId : null }),
        sourcePort,
        // 端口段整段查（隧道 / 转发组上服务端直接回「不支持」的原因）。
        ...(formSourcePortEnd > sourcePort ? { sourcePortEnd: formSourcePortEnd } : {}),
        excludeRuleId: editingId || undefined,
        protocol: form.protocol,
      });
      if (latestPortCheckRef.current !== checkId) return;
      setPortRangeError(result.used ? result.reason ?? null : null);
      setPortStatus(result.used ? "used" : "available");
    } catch {
      if (latestPortCheckRef.current !== checkId) return;
      setPortStatus("idle");
    }
  // 入口端口策略本身不在函数体里读，但策略一换就要重查端口：靠 checkPort 换引用触发下面那个 useEffect，所以留在依赖里
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.forwardGroupId, form.hostId, form.protocol, form.routeMode, form.sourcePort, formSourcePortEnd, form.tunnelId, form.entryMode, editingId, createOwnerUserId, utils, selectedEntryPortPolicy, isForwardGroupRouteMode]);

  // A response started for the previous route must not mark the new route occupied.
  useEffect(() => {
    latestPortCheckRef.current += 1;
    setPortStatus("idle");
  }, [editingId, form.forwardGroupId, form.hostId, form.protocol, form.routeMode, form.sourcePort, formSourcePortEnd, form.tunnelId, isForwardGroupRouteMode, latestPortCheckRef, setPortStatus]);

  // 源端口变化时自动检测
  useEffect(() => {
    const hasTarget = isForwardGroupRouteMode ? !!form.forwardGroupId : !!form.hostId;
    if (form.sourcePort > 0 && hasTarget) {
      const timer = setTimeout(checkPort, 500);
      return () => clearTimeout(timer);
    } else {
      setPortStatus("idle");
    }
  }, [form.sourcePort, formSourcePortEnd, form.forwardGroupId, form.hostId, form.protocol, form.routeMode, form.tunnelId, checkPort, isForwardGroupRouteMode, setPortStatus]);

  useEffect(() => {
    if (form.routeMode !== "local") return;
    if (editingId) return;
    if (usableForwardTypes.length === 0) return;
    if (!usableForwardTypes.includes(form.forwardType)) {
      setForm((prev) => ({ ...prev, forwardType: usableForwardTypes[0], tunnelId: null }));
    }
  }, [editingId, form.forwardType, form.routeMode, setForm, usableForwardTypes]);

  useEffect(() => {
    if (!isForwardGroupRouteMode) return;
    const candidates = form.routeMode === "local" ? availablePortForwardGroups : form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups;
    if (!selectedForwardGroup && candidates.length > 0) {
      if (isLegacyLocalRuleEdit && form.routeMode === "local" && !form.forwardGroupId) return;
      setForm((prev) => ({ ...prev, forwardGroupId: Number(candidates[0].id) }));
      return;
    }
    const expectedGroupMode = form.routeMode === "local" ? "port" : form.routeMode === "chain" ? "chain" : "failover";
    if (selectedForwardGroup && forwardGroupModeOf(selectedForwardGroup) !== expectedGroupMode) {
      setForm((prev) => ({
        ...prev,
        forwardGroupId: candidates[0] ? Number(candidates[0].id) : null,
        failoverEnabled: form.routeMode === "chain" ? false : prev.failoverEnabled,
      }));
      return;
    }
    const groupForwardType = getForwardGroupRuleForwardType(selectedForwardGroup, form.forwardType);
    if (selectedForwardGroup && form.forwardType !== groupForwardType) {
      setForm((prev) => ({ ...prev, forwardType: groupForwardType }));
    }
  }, [availablePortForwardGroups, availableFailoverForwardGroups, availableForwardChainGroups, form.forwardGroupId, form.forwardType, form.routeMode, isForwardGroupRouteMode, isLegacyLocalRuleEdit, selectedForwardGroup, setForm]);

  useEffect(() => {
    if (!form.failoverEnabled || canUseMainBackup) return;
    setForm((prev) => ({ ...prev, failoverEnabled: false }));
  }, [canUseMainBackup, form.failoverEnabled, setForm]);

  useEffect(() => {
    if (!systemSettingsFetched) return;
    if (telegramBotReady || !form.telegramErrorNotifyEnabled) return;
    setForm((prev) => prev.telegramErrorNotifyEnabled ? { ...prev, telegramErrorNotifyEnabled: false } : prev);
  }, [form.telegramErrorNotifyEnabled, setForm, systemSettingsFetched, telegramBotReady]);

  // 随机分配端口
  const handleRandomPort = async () => {
    if (isForwardGroupRouteMode) {
      if (!form.forwardGroupId) {
        toast.error(form.routeMode === "local" ? "请先选择端口转发" : form.routeMode === "chain" ? "请先选择转发链" : "请先选择转发组");
        return;
      }
    } else if (!form.hostId) {
      toast.error("请先选择主机");
      return;
    }
    try {
      const randomPortInput = isForwardGroupRouteMode
        ? { forwardGroupId: Number(form.forwardGroupId), excludeRuleId: editingId || undefined, protocol: form.protocol }
        : { hostId: Number(form.hostId), tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null, excludeRuleId: editingId || undefined, protocol: form.protocol };
      const result = await utils.rules.randomPort.fetch({ ...randomPortInput, userId: editingId ? undefined : createOwnerUserId });
      setForm({ ...form, sourcePort: result.port, sourcePortText: null });
      setPortStatus("available");
      toast.success(`已分配随机端口: ${result.port}`);
    } catch (err) {
      toast.error((err as { message?: string } | null)?.message || "无法获取随机端口");
    }
  };
  return { handleRandomPort };
}
