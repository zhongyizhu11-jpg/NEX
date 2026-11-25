/*
  从 client/src/pages/Rules.tsx 第 4585-4657 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { formatAddressWithPort, formatRuleEntryAddress, getForwardGroupRouteLabel, isForwardChainGroup, type EntryAddress, type RuleCardRule, type RuleResourceRow } from "../../pages/Rules";
import { copyTextToClipboard } from "@/lib/clipboard";
import { parseSniNameJson } from "@shared/tlsInbound";
import { useState } from "react";
import { toast } from "sonner";

export type UseRuleEntryExpansionContext = {
  tlsInboundById: Map<number, RuleResourceRow>;
  forwardGroupById: Map<number, RuleResourceRow>;
  getForwardChainEntryAddresses: (group: RuleResourceRow | null | undefined) => EntryAddress[];
  getForwardGroupEntryAddresses: (group: RuleResourceRow | null | undefined) => EntryAddress[];
  getRuleEntry: (rule: RuleCardRule) => string;
};

export type UseRuleEntryExpansionResult = {
  copyEntryAddress: (rule: RuleCardRule, entryValue?: string) => Promise<void>;
  copyTargetAddress: (text: string) => Promise<void>;
  toggleEntryAddresses: (ruleId: number) => void;
  toggleRuleLines: (ruleId: number) => void;
  expandedEntryRuleIds: Set<number>;
  expandedLineRuleIds: Set<number>;
};

export function useRuleEntryExpansion(ctx: UseRuleEntryExpansionContext): UseRuleEntryExpansionResult {
  const { tlsInboundById, forwardGroupById, getForwardChainEntryAddresses, getForwardGroupEntryAddresses, getRuleEntry } = ctx;
  const [expandedLineRuleIds, setExpandedLineRuleIds] = useState<Set<number>>(() => new Set());
  const toggleRuleLines = (ruleId: number) => {
    setExpandedLineRuleIds((previous) => {
      const next = new Set(previous);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };
  const [expandedEntryRuleIds, setExpandedEntryRuleIds] = useState<Set<number>>(() => new Set());
  const toggleEntryAddresses = (ruleId: number) => {
    setExpandedEntryRuleIds((previous) => {
      const next = new Set(previous);
      if (next.has(ruleId)) next.delete(ruleId); else next.add(ruleId);
      return next;
    });
  };

  /** 复制入口 IP:端口 到剪贴板 */
  const copyTargetAddress = async (text: string) => {
    if (await copyTextToClipboard(text)) toast.success(`已复制目标地址: ${text}`);
    else toast.error("复制失败，请手动复制");
  };

  const copyEntryAddress = async (rule: RuleCardRule, entryValue?: string) => {
    if (Number(rule?.tlsInboundId || 0) > 0) {
      const inbound = tlsInboundById.get(Number(rule.tlsInboundId));
      const name = String(entryValue || parseSniNameJson(rule.sniNames)[0] || "").trim();
      if (!name || !inbound?.port) {
        toast.error("未获取到共享 TLS 入站的地址");
        return;
      }
      const text = formatAddressWithPort(name, Number(inbound.port));
      if (await copyTextToClipboard(text)) toast.success(`已复制入口地址: ${text}`);
      else toast.error("复制失败，请手动复制");
      return;
    }
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      if (isForwardChainGroup(group)) {
        const entry = String(entryValue || getForwardChainEntryAddresses(group)[0]?.value || "").trim();
        if (!entry) {
          toast.error("该转发链未配置可用入口地址");
          return;
        }
        const text = formatAddressWithPort(entry, rule.sourcePort);
        if (await copyTextToClipboard(text)) toast.success(`已复制入口地址: ${text}`);
        else toast.error("复制失败，请手动复制");
        return;
      }
      const entry = String(entryValue || getForwardGroupEntryAddresses(group)[0]?.value || "").trim();
      if (!entry) {
        toast.error(`该${getForwardGroupRouteLabel(group)}未配置可用入口地址`);
        return;
      }
      const text = formatAddressWithPort(entry, rule.sourcePort);
      if (await copyTextToClipboard(text)) toast.success(`已复制入口地址: ${text}`);
      else toast.error("复制失败，请手动复制");
      return;
    }
    const entry = String(entryValue || getRuleEntry(rule)).trim();
    if (!entry) {
      toast.error("未获取到主机入口地址");
      return;
    }
    const text = formatRuleEntryAddress(entry, rule);
    /*
      原来这里的回退路径**不看 execCommand 的返回值**，所以无论复制成没成，
      都照样弹「已复制入口地址」—— 提示比没有提示更坏。共享实现会如实回 false。
    */
    if (await copyTextToClipboard(text)) toast.success(`已复制入口地址: ${text}`);
    else toast.error("复制失败，请手动复制");
  };
  return { copyEntryAddress, copyTargetAddress, toggleEntryAddresses, toggleRuleLines, expandedEntryRuleIds, expandedLineRuleIds };
}
