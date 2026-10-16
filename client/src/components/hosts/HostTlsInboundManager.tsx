import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  TLS_INBOUND_AGENT_VERSION,
  TLS_INBOUND_DEFAULT_HANDSHAKE_TIMEOUT,
  TLS_INBOUND_DEFAULT_MAX_HANDSHAKES,
  TLS_INBOUND_MAX_HANDSHAKE_TIMEOUT,
  TLS_INBOUND_MAX_HANDSHAKES_LIMIT,
  TLS_INBOUND_MAX_PER_HOST,
} from "@shared/tlsInbound";

/**
 * 主机上的共享 TLS 入站（SNI 分流）—— 只有管理员看得到、改得了。
 *
 * 一个入站就是这台机器上一个 TCP 端口，多条规则按 SNI 分走。白名单决定用户能在这个
 * 入站上填哪些域名：面板不验证域名归属，管理员靠白名单把每个人限制在自己的域名里。
 */

type InboundForm = {
  id: number | null;
  name: string;
  port: string;
  isEnabled: boolean;
  allowedSni: string;
  rejectEmptySni: boolean;
  unknownSniAction: "reject" | "default_rule";
  defaultRuleId: number | null;
  proxyProtocol: "off" | "auto";
  maxHandshakes: string;
  handshakeTimeoutSeconds: string;
};

const emptyForm: InboundForm = {
  id: null,
  name: "",
  port: "443",
  isEnabled: true,
  allowedSni: "",
  rejectEmptySni: true,
  unknownSniAction: "reject",
  defaultRuleId: null,
  proxyProtocol: "off",
  maxHandshakes: String(TLS_INBOUND_DEFAULT_MAX_HANDSHAKES),
  handshakeTimeoutSeconds: String(TLS_INBOUND_DEFAULT_HANDSHAKE_TIMEOUT),
};

export function HostTlsInboundSection({ hostId }: { hostId: number }) {
  const [open, setOpen] = useState(false);
  const { data } = trpc.tlsInbounds.listByHost.useQuery({ hostId }, { enabled: hostId > 0, staleTime: 15_000 });
  const inbounds = data?.inbounds || [];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-secondary-type text-foreground">
          {inbounds.length > 0
            ? inbounds.map((inbound: any) => `${inbound.name} :${inbound.port}`).join("、")
            : "未开启"}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>管理</Button>
      </div>
      {data && !data.agentSupported && (
        <p className="text-meta text-[var(--fx-warn-text)]">需要升级 Agent：{TLS_INBOUND_AGENT_VERSION} 起支持共享 TLS 入站，当前 {data.agentVersion || "未知"}。</p>
      )}
      <HostTlsInboundManager hostId={hostId} open={open} onOpenChange={setOpen} />
    </div>
  );
}

export default function HostTlsInboundManager({ hostId, open, onOpenChange }: { hostId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const { data, isLoading } = trpc.tlsInbounds.listByHost.useQuery({ hostId }, { enabled: open && hostId > 0 });
  const [form, setForm] = useState<InboundForm | null>(null);
  const invalidate = () => {
    void utils.tlsInbounds.listByHost.invalidate({ hostId });
    void utils.tlsInbounds.listForUser.invalidate();
  };
  const createMutation = trpc.tlsInbounds.create.useMutation({
    onSuccess: () => { toast.success("共享 TLS 入站已创建"); setForm(null); invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  const updateMutation = trpc.tlsInbounds.update.useMutation({
    onSuccess: () => { toast.success("共享 TLS 入站已保存"); setForm(null); invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  const setEnabledMutation = trpc.tlsInbounds.setEnabled.useMutation({ onSuccess: invalidate });
  const deleteMutation = trpc.tlsInbounds.delete.useMutation({
    onSuccess: () => { toast.success("共享 TLS 入站已删除"); invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  const inbounds = data?.inbounds || [];
  const editing = form?.id ? inbounds.find((inbound: any) => inbound.id === form.id) : null;
  const adminRules = useMemo(() => (editing?.rules || []).filter((rule: any) => rule.ownerIsAdmin), [editing]);

  const submit = () => {
    if (!form) return;
    const payload = {
      name: form.name.trim(),
      port: Number(form.port),
      isEnabled: form.isEnabled,
      allowedSni: form.allowedSni,
      rejectEmptySni: form.rejectEmptySni,
      unknownSniAction: form.unknownSniAction,
      defaultRuleId: form.unknownSniAction === "default_rule" ? form.defaultRuleId : null,
      proxyProtocol: form.proxyProtocol,
      maxHandshakes: Number(form.maxHandshakes) || TLS_INBOUND_DEFAULT_MAX_HANDSHAKES,
      handshakeTimeoutSeconds: Number(form.handshakeTimeoutSeconds) || TLS_INBOUND_DEFAULT_HANDSHAKE_TIMEOUT,
    };
    if (!payload.name) { toast.error("请填写入站名称"); return; }
    if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) { toast.error("端口必须在 1-65535 之间"); return; }
    if (form.id) updateMutation.mutate({ id: form.id, ...payload });
    else createMutation.mutate({ hostId, ...payload });
  };

  const remove = async (inbound: any) => {
    if (inbound.rules.length > 0) {
      toast.error(`这个入站上还有 ${inbound.rules.length} 条规则，请先删除或迁走这些规则`);
      return;
    }
    if (await confirmDialog({ title: "删除共享 TLS 入站", description: `确定删除「${inbound.name}」（端口 ${inbound.port}）吗？`, confirmText: "删除", tone: "destructive" })) {
      deleteMutation.mutate({ id: inbound.id });
    }
  };

  const edit = (inbound: any) => setForm({
    id: inbound.id,
    name: inbound.name,
    port: String(inbound.port),
    isEnabled: inbound.isEnabled,
    allowedSni: (inbound.allowedSni || []).join("\n"),
    rejectEmptySni: inbound.rejectEmptySni,
    unknownSniAction: inbound.unknownSniAction,
    defaultRuleId: inbound.defaultRuleId,
    proxyProtocol: inbound.proxyProtocol,
    maxHandshakes: String(inbound.maxHandshakes),
    handshakeTimeoutSeconds: String(inbound.handshakeTimeoutSeconds),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setForm(null); onOpenChange(next); }}>
      <DialogContent className="flex max-h-[92svh] max-w-xl flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>共享 TLS 入站</DialogTitle>
          <DialogDescription>
            一个端口（通常 443）给多条规则共用，按 TLS 握手里的 SNI 分流，原样透传、不解密。适用于 HTTPS 网站、Trojan / VLESS-TLS 等任何 TLS 服务。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {data && !data.agentSupported && (
            <p className="rounded-md bg-[var(--fx-warn-soft)] px-3 py-2 text-sm text-[var(--fx-warn-text)]">
              需要升级 Agent：这台主机的 Agent（{data.agentVersion || "未知版本"}）低于 {TLS_INBOUND_AGENT_VERSION}，入站和挂在上面的规则暂不下发。
            </p>
          )}
          {!form && (
            <>
              {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
              {!isLoading && inbounds.length === 0 && <p className="text-sm text-muted-foreground">这台主机还没有共享 TLS 入站。</p>}
              {inbounds.map((inbound: any) => (
                <div key={inbound.id} className="space-y-1.5 rounded-md border border-[var(--fx-stroke-weak)] px-3 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate font-medium">{inbound.name}</span>
                      <Badge variant="secondary">TCP {inbound.port}</Badge>
                      {!inbound.isEnabled && <Badge variant="outline">已停用</Badge>}
                      {inbound.runtime && !inbound.runtime.listening && inbound.isEnabled && (
                        <Badge variant="destructive" title={inbound.runtime.error || undefined}>监听失败</Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <OptimisticSwitch
                        aria-label={`启用入站 ${inbound.name}`}
                        checked={inbound.isEnabled}
                        onCheckedChangeAsync={(checked: boolean) => setEnabledMutation.mutateAsync({ id: inbound.id, isEnabled: checked })}
                        onToggleError={(error: unknown) => toast.error(error instanceof Error ? error.message : "切换失败")}
                      />
                      <Button type="button" variant="ghost" size="icon" title="编辑" onClick={() => edit(inbound)}><Pencil className="h-4 w-4" /></Button>
                      <Button type="button" variant="ghost" size="icon" title="删除" onClick={() => void remove(inbound)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    白名单：{inbound.allowedSni.length > 0 ? inbound.allowedSni.join("、") : "不限（任何域名）"} · 无 SNI {inbound.rejectEmptySni ? "断开" : "交给默认规则"} · 未知 SNI {inbound.unknownSniAction === "default_rule" ? "交给默认规则" : "断开"}
                    {inbound.proxyProtocol === "auto" ? " · 接受 PROXY 头" : ""}
                  </p>
                  {inbound.runtime?.error && <p className="text-meta text-[var(--fx-down-text)]">{inbound.runtime.error}</p>}
                  <p className="text-meta text-muted-foreground">
                    {inbound.rules.length > 0
                      ? `${inbound.rules.length} 条规则：${inbound.rules.slice(0, 6).map((rule: any) => `${rule.name}（${rule.sniNames.join("、")}${rule.isEnabled ? "" : "，已暂停"}）`).join("；")}`
                      : "还没有规则挂在这个入站上"}
                  </p>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                disabled={inbounds.length >= TLS_INBOUND_MAX_PER_HOST}
                onClick={() => setForm({ ...emptyForm })}
              >
                <Plus className="h-4 w-4" />新建共享 TLS 入站
              </Button>
            </>
          )}
          {form && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField className="space-y-1.5">
                  <Label>名称</Label>
                  <Input value={form.name} maxLength={64} placeholder="例如 HTTPS 共享" onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </FormField>
                <FormField className="space-y-1.5">
                  <Label>端口（TCP）</Label>
                  <Input inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, "") })} />
                </FormField>
              </div>
              <FormField className="space-y-1.5">
                <Label>允许的 SNI（白名单，一行一个）</Label>
                <Textarea
                  rows={4}
                  value={form.allowedSni}
                  placeholder={"example.com（含所有子域名）\n.example.org（只放子域名）\n留空表示不限"}
                  onChange={(e) => setForm({ ...form, allowedSni: e.target.value })}
                />
                <p className="text-meta text-muted-foreground">面板不验证域名归属。共享给多个用户时，请用白名单把每个人限制在自己的域名里。</p>
              </FormField>
              <FormField className="flex items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
                <Label>没有 SNI 的连接直接断开</Label>
                <Checkbox checked={form.rejectEmptySni} onCheckedChange={(checked) => setForm({ ...form, rejectEmptySni: checked })} />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField className="space-y-1.5">
                  <Label>未知 SNI</Label>
                  <Select value={form.unknownSniAction} onValueChange={(value) => setForm({ ...form, unknownSniAction: value as InboundForm["unknownSniAction"] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reject">断开连接</SelectItem>
                      <SelectItem value="default_rule" disabled={!form.id}>交给默认规则</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField className="space-y-1.5">
                  <Label>默认规则</Label>
                  <Select
                    value={form.defaultRuleId ? String(form.defaultRuleId) : undefined}
                    disabled={form.unknownSniAction !== "default_rule"}
                    onValueChange={(value) => setForm({ ...form, defaultRuleId: Number(value) })}
                  >
                    <SelectTrigger><SelectValue placeholder={adminRules.length > 0 ? "选择管理员的规则" : "没有可选的规则"} /></SelectTrigger>
                    <SelectContent>
                      {adminRules.map((rule: any) => <SelectItem key={rule.id} value={String(rule.id)}>{rule.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
              <p className="-mt-1 text-meta text-muted-foreground">默认规则只能是挂在这个入站上的管理员规则。属于已暂停规则的 SNI 永远直接断开，不会落到默认规则。</p>
              <div className="grid grid-cols-3 gap-3">
                <FormField className="space-y-1.5">
                  <Label>PROXY 头</Label>
                  <Select value={form.proxyProtocol} onValueChange={(value) => setForm({ ...form, proxyProtocol: value as InboundForm["proxyProtocol"] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">不接受</SelectItem>
                      <SelectItem value="auto">自动识别</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField className="space-y-1.5">
                  <Label>并发握手上限</Label>
                  <Input inputMode="numeric" value={form.maxHandshakes} placeholder={`1-${TLS_INBOUND_MAX_HANDSHAKES_LIMIT}`} onChange={(e) => setForm({ ...form, maxHandshakes: e.target.value.replace(/\D/g, "") })} />
                </FormField>
                <FormField className="space-y-1.5">
                  <Label>握手超时（秒）</Label>
                  <Input inputMode="numeric" value={form.handshakeTimeoutSeconds} placeholder={`1-${TLS_INBOUND_MAX_HANDSHAKE_TIMEOUT}`} onChange={(e) => setForm({ ...form, handshakeTimeoutSeconds: e.target.value.replace(/\D/g, "") })} />
                </FormField>
              </div>
              {form.proxyProtocol === "auto" && (
                <p className="text-meta text-[var(--fx-warn-text)]">只在前面有你信任的负载均衡时开启：自动识别模式下任何人都能伪造 PROXY 头里的来源地址。</p>
              )}
              <FormField className="flex items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
                <Label>启用</Label>
                <Checkbox checked={form.isEnabled} onCheckedChange={(checked) => setForm({ ...form, isEnabled: checked })} />
              </FormField>
            </div>
          )}
        </div>
        {form && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setForm(null)}>取消</Button>
            <Button type="button" disabled={createMutation.isPending || updateMutation.isPending} onClick={submit}>保存</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
