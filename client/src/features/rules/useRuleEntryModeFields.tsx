/*
  从 client/src/pages/Rules.tsx 第 4681-4835 行抽出（scripts/extract-block.mjs），行为不变。
*/
import { getForwardGroupRuleForwardType, type RuleFormData, type RuleResourceRow, type RuleRouteMode } from "../../pages/Rules";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TLS_INBOUND_MAX_SNI_PER_RULE, sniInboundChoiceKey, type SniInboundChoice, type SniRuleRouteKind } from "@shared/tlsInbound";
import { type Dispatch, type ReactElement, type RefObject, type SetStateAction } from "react";

export type UseRuleEntryModeFieldsContext = {
  editingId: number | null;
  form: RuleFormData;
  latestPortCheckRef: RefObject<number>;
  setPortStatus: Dispatch<SetStateAction<"idle" | "checking" | "available" | "used">>;
  setPortRangeError: Dispatch<SetStateAction<string | null>>;
  setForm: Dispatch<SetStateAction<RuleFormData>>;
  /** 共享 TLS 入站行在页面里还是宽类型（tlsInbounds.listForUser 的行），所以选项的 inbound 用 RuleResourceRow */
  sniChoices: Array<SniInboundChoice<RuleResourceRow>>;
  usableForwardTypes: Array<"iptables" | "nftables" | "realm" | "socat" | "gost" | "nginx">;
  canUseSavedLocalForward: boolean;
  availablePortForwardGroups: Array<RuleResourceRow>;
  canUseBillingHostLocalForward: boolean;
  availableTrafficBillingHosts: Array<RuleResourceRow>;
  sniAvailableForTab: (mode: RuleRouteMode) => boolean;
  tlsInboundById: Map<number, RuleResourceRow>;
  sniRouteKind: SniRuleRouteKind;
  forwardGroupById: Map<number, RuleResourceRow>;
  submitBlocker: string | null;
  selectedTlsInbound: RuleResourceRow | null;
};

export type UseRuleEntryModeFieldsResult = {
  renderEntryModeSwitch: () => ReactElement;
  renderSniEntryFields: () => ReactElement;
};

export function useRuleEntryModeFields(ctx: UseRuleEntryModeFieldsContext): UseRuleEntryModeFieldsResult {
  const { editingId, form, latestPortCheckRef, setPortStatus, setPortRangeError, setForm, sniChoices, usableForwardTypes, canUseSavedLocalForward, availablePortForwardGroups, canUseBillingHostLocalForward, availableTrafficBillingHosts, sniAvailableForTab, tlsInboundById, sniRouteKind, forwardGroupById, submitBlocker, selectedTlsInbound } = ctx;
  const renderEntryModeSwitch = () => {
    const pick = (mode: "port" | "sni") => {
      if (editingId || mode === form.entryMode) return;
      latestPortCheckRef.current += 1;
      setPortStatus("idle");
      setPortRangeError(null);
      if (form.routeMode !== "local") {
        // 隧道 / 转发链 / 转发组页签：资源照旧在上面选，这里只换入口方式；入站在下面按所选资源列。
        if (mode === "port") {
          setForm({ ...form, entryMode: "port", tlsInboundId: null, sourcePort: 0 });
          return;
        }
        const first = sniChoices[0];
        setForm({
          ...form,
          entryMode: "sni",
          tlsInboundId: first ? Number(first.inbound.id) : null,
          sourcePort: 0,
          protocol: "tcp",
          failoverEnabled: false,
        });
        return;
      }
      if (mode === "sni") {
        const first = sniChoices[0];
        if (!first) return;
        const inbound = first.inbound;
        setForm({
          ...form,
          entryMode: "sni",
          tlsInboundId: Number(inbound.id),
          hostId: first.forwardGroupId ? null : Number(inbound.hostId),
          forwardGroupId: first.forwardGroupId,
          tunnelId: null,
          sourcePort: 0,
          protocol: "tcp",
          failoverEnabled: false,
          forwardType: usableForwardTypes.includes(form.forwardType) ? form.forwardType : usableForwardTypes[0],
        });
        return;
      }
      const firstPortGroup = canUseSavedLocalForward ? availablePortForwardGroups[0] : null;
      const firstBillingHost = !firstPortGroup && canUseBillingHostLocalForward ? availableTrafficBillingHosts[0] : null;
      setForm({
        ...form,
        entryMode: "port",
        tlsInboundId: null,
        hostId: firstBillingHost ? Number(firstBillingHost.id) : null,
        forwardGroupId: firstPortGroup ? Number(firstPortGroup.id) : null,
        forwardType: firstPortGroup ? getForwardGroupRuleForwardType(firstPortGroup, form.forwardType) : form.forwardType,
        sourcePort: 0,
      });
    };
    const portAvailable = form.routeMode !== "local" || canUseSavedLocalForward || canUseBillingHostLocalForward;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label="入口方式">
        <span className="text-meta text-muted-foreground">入口方式</span>
        <Button
          type="button"
          size="sm"
          variant={form.entryMode === "port" ? "default" : "outline"}
          disabled={!!editingId || !portAvailable}
          aria-pressed={form.entryMode === "port"}
          onClick={() => pick("port")}
        >
          独立端口
        </Button>
        <Button
          type="button"
          size="sm"
          variant={form.entryMode === "sni" ? "default" : "outline"}
          disabled={!!editingId || !sniAvailableForTab(form.routeMode)}
          aria-pressed={form.entryMode === "sni"}
          onClick={() => pick("sni")}
        >
          共享 TLS 入站
        </Button>
        {editingId ? <span className="text-meta text-muted-foreground">入口方式保存后不能更改，需要的话请新建规则</span> : null}
      </div>
    );
  };

  /** 共享 TLS 入站：选入站 + 填 SNI。和服务端用同一份规整 / 校验（shared/tlsInbound.ts）。 */
  const renderSniEntryFields = () => {
    // 编辑时只能换同一台主机（转发资源上：同端口）的入站。
    const editingInbound = editingId && form.tlsInboundId ? tlsInboundById.get(Number(form.tlsInboundId)) : null;
    const options = sniChoices.filter((choice) => !editingInbound || (sniRouteKind === "group"
      ? Number(choice.inbound.port) === Number(editingInbound.port) && Number(choice.forwardGroupId || 0) === Number(form.forwardGroupId || 0)
      : Number(choice.inbound.hostId) === Number(editingInbound.hostId)));
    const groupNameOf = (groupId: number | null) => (groupId ? String(forwardGroupById.get(Number(groupId))?.name || `#${groupId}`) : "");
    const blocker = submitBlocker;
    const sniError = blocker && blocker !== "还缺目标地址" && blocker !== "还缺目标端口" && blocker !== "目标端口必须在 1-65535 之间" ? blocker : null;
    return (
      <div className="space-y-2">
        <FormField className="space-y-1.5">
          <Label>共享 TLS 入站</Label>
          <Select
            value={form.tlsInboundId ? sniInboundChoiceKey(form.tlsInboundId, form.routeMode === "local" ? form.forwardGroupId : sniRouteKind === "group" ? form.forwardGroupId : null) : undefined}
            onValueChange={(value) => {
              const choice = sniChoices.find((item) => item.key === value);
              if (!choice) return;
              const inbound = choice.inbound;
              if (form.routeMode === "local") {
                // 端口转发页签：选的是「直连」还是「经某个端口转发资源」，跟着入站一起定。
                setForm({ ...form, tlsInboundId: Number(inbound.id), hostId: choice.forwardGroupId ? null : Number(inbound.hostId), forwardGroupId: choice.forwardGroupId });
                return;
              }
              setForm({ ...form, tlsInboundId: Number(inbound.id), ...(form.routeMode === "tunnel" ? { hostId: Number(inbound.hostId) } : {}) });
            }}
          >
            <SelectTrigger><SelectValue placeholder={sniRouteKind === "direct" ? "选择主机上的共享 TLS 入站" : "选择入口主机上的共享 TLS 入站"} /></SelectTrigger>
            <SelectContent>
              {options.map((choice) => {
                const inbound = choice.inbound;
                const routed = sniRouteKind !== "direct" || !!choice.forwardGroupId;
                return (
                  <SelectItem key={choice.key} value={choice.key} textValue={`${groupNameOf(choice.forwardGroupId)} ${inbound.hostName} ${inbound.name} ${inbound.port}`}>
                    {form.routeMode === "local" && choice.forwardGroupId ? `端口转发「${groupNameOf(choice.forwardGroupId)}」· ` : ""}
                    {inbound.hostName || "主机"} · {inbound.name} :{inbound.port}
                    {!inbound.agentSupported || (routed && inbound.routedAgentSupported === false) ? "（需要升级 Agent）" : !inbound.isEnabled ? "（已停用）" : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </FormField>
        {selectedTlsInbound && (
          <p className="text-meta text-muted-foreground">
            允许的域名：{(selectedTlsInbound.allowedSni || []).length > 0 ? selectedTlsInbound.allowedSni.join("、") : "不限"}
          </p>
        )}
        <FormField className="space-y-1.5">
          <Label className="flex items-baseline gap-1.5">
            SNI 域名 <span className="text-destructive">*</span>
            <span data-fx-help="" className="text-xs font-normal text-muted-foreground">一行一个，最多 {TLS_INBOUND_MAX_SNI_PER_RULE} 个，精确匹配</span>
          </Label>
          <Textarea
            rows={3}
            placeholder={"www.example.com\nexample.com"}
            value={form.sniNamesText}
            onChange={(e) => setForm({ ...form, sniNamesText: e.target.value })}
            className={sniError && form.sniNamesText.trim() ? "border-destructive" : undefined}
          />
        </FormField>
        {sniError && form.sniNamesText.trim() ? <p className="text-xs text-destructive">{sniError}</p> : null}
        <p data-fx-help="" className="text-meta leading-5 text-muted-foreground">
          {sniRouteKind === "group"
            ? `客户端用这些域名连接入口主机的 ${selectedTlsInbound ? selectedTlsInbound.port : "入站"} 端口，按 SNI 分到这条规则，再经所选转发资源转到目标，原样透传、节点不解密。每台入口主机都要有同端口的共享 TLS 入站（没有的那台不下发，DDNS 也不会切过去）；域名的 DNS 解析到入口（转发组的入口域名或入口主机）。协议固定 TCP。`
            : sniRouteKind === "tunnel"
            ? `客户端用这些域名连接 ${selectedTlsInbound ? `${selectedTlsInbound.hostName || "主机"}:${selectedTlsInbound.port}` : "隧道入口机的入站端口"}，按 SNI 分到这条规则，再经隧道到出口、由出口连目标，原样透传、节点不解密。每个域名的 DNS 都要解析到隧道的入口主机。协议固定 TCP，不带 PROXY 头。`
            : `客户端用这些域名连接 ${selectedTlsInbound ? `${selectedTlsInbound.hostName || "主机"}:${selectedTlsInbound.port}` : "入站端口"}，按 TLS 握手里的 SNI 分到这条规则，原样透传、节点不解密。每个域名的 DNS 都要解析到这台主机。适用于 HTTPS 网站、Trojan / VLESS-TLS 等任何 TLS 服务；协议固定 TCP。`}
        </p>
      </div>
    );
  };
  return { renderEntryModeSwitch, renderSniEntryFields };
}
