import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CollapsibleSection, Row } from "@/components/hosts/HostDetailDialog";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";

/**
 * 主机详情「与面板的连接」（#8）。
 *
 * 到面板路况差的机器（面板在国内、机器在海外）可以改成经由另一台主机连面板：
 * 那台主机上的 Agent 把连接原样转给面板。这里能看到现在走的是哪条路、改走法、
 * 开「自动切换」（掉线太多时自动改走中转，只切一次，不会自动切回）。
 *
 * 服务端：trpc.ops.agentRelay.get / save（server/routers/ops/agentRelay.ts）。
 */

const DIRECT = "direct";
const OFF = "off";

const toneClass = {
  ok: "text-[var(--fx-healthy-text)]",
  warn: "text-[var(--fx-warn-text)]",
  muted: "text-muted-foreground",
} as const;

function formatTime(seconds: number | null | undefined) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AgentRelaySection({ host }: { host: any }) {
  const hostId = Number(host?.id || 0);
  const confirm = useConfirmDialog();
  const utils = trpc.useUtils();
  const query = trpc.ops.agentRelay.get.useQuery(
    { hostId },
    { enabled: hostId > 0, refetchInterval: pollingInterval("normal"), retry: false },
  );
  const data = query.data;

  const [via, setVia] = useState(DIRECT);
  const [auto, setAuto] = useState(OFF);
  const [threshold, setThreshold] = useState("3");

  // 服务端的值变了（保存后、别处改了）就同步回表单；用户正在改的不被轮询冲掉。
  const serverVia = data?.viaHostId ? String(data.viaHostId) : DIRECT;
  const serverAuto = data?.autoViaHostId ? String(data.autoViaHostId) : OFF;
  const serverThreshold = String(data?.autoThresholdMinutes ?? 3);
  useEffect(() => { setVia(serverVia); }, [serverVia]);
  useEffect(() => { setAuto(serverAuto); }, [serverAuto]);
  useEffect(() => { setThreshold(serverThreshold); }, [serverThreshold]);

  const save = trpc.ops.agentRelay.save.useMutation({
    onSuccess: (next) => {
      utils.ops.agentRelay.get.setData({ hostId }, next);
      toast.success("已保存，Agent 会在一分钟内换线路");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const candidates = data?.candidates || [];
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of candidates) map.set(String(item.id), item.name);
    return (id: string) => map.get(id) || `#${id}`;
  }, [candidates]);

  if (!hostId || query.isLoading) return null;
  if (query.isError || !data) {
    return (
      <CollapsibleSection title="与面板的连接">
        <p className="text-meta text-muted-foreground">读不到连接设置：{query.error?.message || "未知错误"}</p>
      </CollapsibleSection>
    );
  }

  if (!data.supported) {
    return (
      <CollapsibleSection title="与面板的连接">
        <Row label="现在" value={<span className="text-muted-foreground">需要把 Agent 升级到 2.2.216</span>} />
      </CollapsibleSection>
    );
  }

  const changed = via !== serverVia || auto !== serverAuto || (auto !== OFF && threshold !== serverThreshold);
  const viaName = via === DIRECT ? null : nameOf(via);
  const thresholdChoices: number[] = data.autoThresholdChoices || [3, 10, 30];

  const onSave = async () => {
    const lines: string[] = [];
    if (via !== serverVia) {
      lines.push(via === DIRECT
        ? "这台机器的 Agent 会改回直接连面板，断开一下后自己重连。"
        : `这台机器的 Agent 会改为经由 ${viaName} 连面板：先试一下能不能通，通了才切，断开一下后自己重连。中转连不上时会自动退回直连。`);
      if (via !== DIRECT) lines.push(`需要在 ${viaName} 的防火墙上放行它分到的 TCP 端口（保存后显示）。`);
    }
    if (auto !== serverAuto) {
      lines.push(auto === OFF ? "关闭自动切换。" : `4 小时内累计离线超过 ${threshold} 分钟时，自动改为经由 ${nameOf(auto)}，只切一次，不会自动切回。`);
    }
    const ok = await confirm({
      title: "保存连面板方式",
      description: <div className="flex flex-col gap-1.5 text-left">{lines.map((line) => <p key={line}>{line}</p>)}</div>,
      confirmText: "保存",
    });
    if (!ok) return;
    save.mutate({
      hostId,
      viaHostId: via === DIRECT ? null : Number(via),
      autoViaHostId: auto === OFF ? null : Number(auto),
      autoThresholdMinutes: Number(threshold),
    });
  };

  const relay = data.relay;
  const viaPort = data.viaPort;

  return (
    <CollapsibleSection title="与面板的连接" summary={<span className={toneClass[data.status.tone]}>{data.status.text}</span>}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Row label="现在" value={<span className={toneClass[data.status.tone]}>{data.status.text}</span>} />
        {data.status.detail ? (
          <p className="break-words text-right text-meta text-muted-foreground">{data.status.detail}</p>
        ) : null}
      </div>

      <FormField className="flex min-w-0 flex-col gap-1.5">
        <Label className="text-meta text-muted-foreground">连面板方式</Label>
        <Select value={via} onValueChange={setVia}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={DIRECT}>直连</SelectItem>
            {candidates.map((item) => (
              <SelectItem
                key={item.id}
                value={String(item.id)}
                // 已经经由它的，就算它此刻离线也留着可选，免得一刷新表单就被清掉。
                disabled={!item.eligible && String(item.id) !== serverVia}
              >
                经由 {item.name}{!item.eligible && item.reason ? `（${item.reason}）` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {via !== DIRECT && via === serverVia && viaPort ? (
          <p className="text-meta text-muted-foreground">
            需要在 {viaName} 上放行 TCP 端口 {viaPort}（只对这台主机开放）
          </p>
        ) : via !== DIRECT && via !== serverVia ? (
          <p className="text-meta text-muted-foreground">保存后会在 {viaName} 上分一个端口，需要在它的防火墙上放行</p>
        ) : null}
      </FormField>

      <FormField className="flex min-w-0 flex-col gap-1.5">
        <Label className="text-meta text-muted-foreground">自动切换</Label>
        <Select value={auto} onValueChange={setAuto}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={OFF}>关闭</SelectItem>
            {candidates.map((item) => (
              <SelectItem key={item.id} value={String(item.id)} disabled={!item.eligible && String(item.id) !== serverAuto}>
                掉线多时改走 {item.name}{!item.eligible && item.reason ? `（${item.reason}）` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {auto !== OFF ? (
          <Select value={threshold} onValueChange={setThreshold}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {thresholdChoices.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  4 小时内累计离线超过 {minutes} 分钟{minutes === 3 ? "（约 1%）" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {data.autoSwitchedAt ? (
          <p className="text-meta text-muted-foreground">{formatTime(data.autoSwitchedAt)} 自动切换过，不会自动切回；想改回直连请在上面选「直连」</p>
        ) : data.autoStats && auto === serverAuto && auto !== OFF ? (
          <p className="text-meta text-muted-foreground">
            最近 {data.autoStats.samples} 分钟里离线 {data.autoStats.offlineMinutes} 分钟
          </p>
        ) : null}
      </FormField>

      {relay ? (
        <div className="flex min-w-0 flex-col gap-1">
          <Row
            label="给别人当中转"
            value={relay.dependents.length > 0 ? relay.dependents.map((item) => item.name).join("、") : "没有"}
          />
          {relay.listenPort ? (
            <Row
              label="中转端口"
              value={
                <span className={relay.error ? toneClass.warn : relay.listening ? toneClass.ok : toneClass.muted}>
                  TCP {relay.listenPort} · {relay.error ? "监听失败" : relay.listening ? "在听" : "等 Agent 开启"}
                </span>
              }
            />
          ) : null}
          {relay.error ? <p className="break-words text-meta text-[var(--fx-warn-text)]">{relay.error}</p> : null}
          {relay.listenPort && relay.dependents.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              需要放行 TCP 端口 {relay.listenPort}（只对这些主机开放）
            </p>
          ) : null}
        </div>
      ) : null}

      {!data.panelUrlConfigured && (via !== DIRECT || relay) ? (
        <p className="text-meta text-[var(--fx-warn-text)]">
          设置里没填「面板地址」：中转会按被中转主机报上来的面板地址转发，建议在设置里填好
        </p>
      ) : null}

      {changed ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setVia(serverVia); setAuto(serverAuto); setThreshold(serverThreshold); }}
            disabled={save.isPending}
          >
            还原
          </Button>
          <Button size="sm" onClick={() => void onSave()} disabled={save.isPending}>
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
