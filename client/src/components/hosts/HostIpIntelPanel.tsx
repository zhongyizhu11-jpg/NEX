import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  IP_INTEL_PROVIDER_LABELS,
  IP_RISK_LABELS,
  IP_TYPE_LABELS,
  ipRiskLevel,
  NATIVE_IP_LABELS,
  NETPROFILE_INTEL_AGENT_VERSION,
  type IpIntelFamilyView,
  type IpIntelKeyProvider,
  type IpIntelProviderResult,
  type IpRiskLevel,
  type NativeIpVerdict,
} from "@shared/ipIntel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { countryFlagLabel } from "@/lib/flagEmojiSupport";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  网络画像里的「IP 信息」（Agent 2.2.253 起，数据怎么来见 server/ops/ipIntel.ts）：
  基础信息（IP / ASN / 组织 / 位置）、原生 IP 还是广播 IP（列出证据）、各家数据库认的 IP 类型、各家的风险分。

  只读面板的缓存，打开详情从不等第三方；面板在后台查的时候每 5 秒刷一下。
  哪一家没查到就写「暂不可用（原因）」—— 不拿别家的数顶上，也不把查不到当成结论。
*/

type Tone = "good" | "warn" | "bad" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  good: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  warn: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  bad: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
  muted: "border border-[var(--fx-stroke-base)] text-muted-foreground",
};

function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4", TONE_CLASS[tone])} title={title}>
      {children}
    </span>
  );
}

const NATIVE_TONE: Record<NativeIpVerdict, Tone> = { native: "good", broadcast: "warn", unknown: "muted" };
const RISK_TONE: Record<IpRiskLevel, Tone> = { low: "good", medium: "warn", high: "bad" };

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <span className="shrink-0 pt-0.5 text-meta text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right text-secondary-type tabular-nums text-foreground">{children}</span>
    </div>
  );
}

function Unavailable({ reason }: { reason: string | null }) {
  return <span className="min-w-0 break-words text-meta text-muted-foreground">暂不可用（{reason || "没有结果"}）</span>;
}

function countryText(code: string | null | undefined) {
  if (!code) return null;
  return countryFlagLabel(code) || code;
}

function viaText(result: IpIntelProviderResult) {
  return result.via === "agent" ? "从主机出口查询" : "面板查询";
}

function FamilyBody({ view }: { view: IpIntelFamilyView }) {
  const { basic, native } = view;
  const location = [countryText(basic.countryCode), basic.region, basic.city].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).join(" · ");
  const typeRows = view.providers.filter((item) => item.provider !== "ripestat");
  const riskRows = view.providers.filter((item) => item.provider === "proxycheck" || item.provider === "abuseipdb" || item.provider === "ipapi_is");
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`ip-intel-v${view.family}`}>
      <Line label="IP">
        <span className="min-w-0 break-all font-mono text-xs">{basic.ip || view.address || "—"}</span>
      </Line>
      <Line label="ASN / 组织">
        {basic.asn || basic.org ? <span className="min-w-0 break-words">{[basic.asn, basic.org].filter(Boolean).join(" · ")}</span> : <span className="text-muted-foreground">—</span>}
      </Line>
      <Line label="位置">{location ? <span className="min-w-0 break-words">{location}</span> : <span className="text-muted-foreground">—</span>}</Line>
      <Line label="原生 / 广播">
        <Chip tone={NATIVE_TONE[native.verdict]} title={native.reason}>{NATIVE_IP_LABELS[native.verdict]}</Chip>
        <span className="min-w-0 break-words text-meta text-muted-foreground">{native.reason}</span>
      </Line>
      {native.evidence.length > 0 ? (
        <p className="min-w-0 break-words text-right text-[11px] text-muted-foreground">
          证据：{native.evidence.map((item) => `${item.kind === "usage" ? "使用地" : item.level === "asn" ? "ASN 注册地" : "注册地"} ${item.countryCode}（${IP_INTEL_PROVIDER_LABELS[item.provider]}）`).join("、")}
        </p>
      ) : null}

      <p className="pt-1 text-meta font-medium text-foreground">IP 类型（各家口径不同）</p>
      {typeRows.length === 0 ? <p className="text-meta text-muted-foreground">还没有结果</p> : null}
      {typeRows.map((item) => (
        <Line key={`type-${item.provider}`} label={IP_INTEL_PROVIDER_LABELS[item.provider]}>
          {!item.ok ? (
            <Unavailable reason={item.reason} />
          ) : item.info?.ipType ? (
            <Chip tone="muted" title={[item.info.ipTypeRaw, viaText(item)].filter(Boolean).join(" · ")}>{IP_TYPE_LABELS[item.info.ipType]}</Chip>
          ) : (
            <span className="text-meta text-muted-foreground" title={viaText(item)}>没给类型</span>
          )}
        </Line>
      ))}

      <p className="pt-1 text-meta font-medium text-foreground">风险（各家分别打分，不取平均）</p>
      {riskRows.length === 0 ? <p className="text-meta text-muted-foreground">还没有结果</p> : null}
      {riskRows.map((item) => {
        const level = ipRiskLevel(item.info?.riskScore ?? null);
        const flags = item.info
          ? ([["proxy", "代理"], ["vpn", "VPN"], ["tor", "Tor"], ["hosting", "机房"], ["abuser", "滥用"]] as const)
            .filter(([key]) => item.info?.flags[key] === true)
            .map(([, label]) => label)
          : [];
        return (
          <Line key={`risk-${item.provider}`} label={IP_INTEL_PROVIDER_LABELS[item.provider]}>
            {!item.ok ? (
              <Unavailable reason={item.reason} />
            ) : level && item.info?.riskScore !== null && item.info?.riskScore !== undefined ? (
              <>
                <Chip tone={RISK_TONE[level]} title={[item.info.riskRaw, viaText(item)].filter(Boolean).join(" · ")}>{item.info.riskScore} · {IP_RISK_LABELS[level]}</Chip>
                {flags.length > 0 ? <span className="text-meta text-muted-foreground">{flags.join(" / ")}</span> : null}
              </>
            ) : (
              <span className="text-meta text-muted-foreground">{flags.length > 0 ? flags.join(" / ") : "没给分数"}</span>
            )}
          </Line>
        );
      })}
    </div>
  );
}

const KEY_FIELDS: Array<{ provider: IpIntelKeyProvider; field: "ipapiIsKey" | "abuseIpdbKey" | "ipinfoToken"; label: string; hint: string }> = [
  { provider: "ipapi_is", field: "ipapiIsKey", label: "ipapi.is API Key", hint: "配了以后由面板带 Key 查，额度更高；不配由 Agent 免 Key 查" },
  { provider: "abuseipdb", field: "abuseIpdbKey", label: "AbuseIPDB API Key", hint: "只有配了才查（滥用置信度、使用类型）" },
  { provider: "ipinfo", field: "ipinfoToken", label: "IPinfo Token", hint: "配了以后由面板带 Token 查；不配由 Agent 免 Token 查基础信息" },
];

function IntelKeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const status = trpc.netProfile.intelKeys.useQuery(undefined, { enabled: open, staleTime: 0 });
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) {
      setValues({});
      setCleared(new Set());
    }
  }, [open]);
  const save = trpc.netProfile.setIntelKeys.useMutation({
    onSuccess: () => {
      toast.success("已保存，下次检测时生效");
      void utils.netProfile.intelKeys.invalidate();
      void utils.netProfile.intel.invalidate();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const byProvider = new Map((status.data?.keys || []).map((item) => [item.provider, item]));
  const submit = () => {
    const payload: Record<string, string | null> = {};
    for (const item of KEY_FIELDS) {
      if (cleared.has(item.field)) payload[item.field] = null;
      else if (values[item.field]?.trim()) payload[item.field] = values[item.field].trim();
    }
    save.mutate(payload);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>网络画像的可选 API Key</DialogTitle>
          <DialogDescription>都可以不填。Key 加密保存在面板里，只由面板服务器使用，不会下发给 Agent，也不会再显示出来。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {KEY_FIELDS.map((item) => {
            const current = byProvider.get(item.provider);
            const isCleared = cleared.has(item.field);
            return (
              <div key={item.field} className="flex flex-col gap-1">
                <Label htmlFor={`intel-key-${item.field}`}>{item.label}</Label>
                <div className="flex items-center gap-2">
                  <PasswordInput
                    id={`intel-key-${item.field}`}
                    autoComplete="off"
                    value={values[item.field] || ""}
                    placeholder={isCleared ? "保存后清除" : current?.configured ? `已配置 ${current.masked || ""}，留空不改` : "未配置"}
                    onChange={(event) => {
                      setValues((prev) => ({ ...prev, [item.field]: event.target.value }));
                      setCleared((prev) => { const next = new Set(prev); next.delete(item.field); return next; });
                    }}
                  />
                  {current?.configured ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setCleared((prev) => new Set(prev).add(item.field))}>清除</Button>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">{item.hint}</p>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function HostIpIntelPanel({ hostId, canManage }: { hostId: number; canManage: boolean }) {
  const query = trpc.netProfile.intel.useQuery(
    { hostId },
    {
      enabled: hostId > 0,
      staleTime: 15_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (q) => (q.state.data?.refreshing ? 5000 : false),
    },
  );
  const [family, setFamily] = useState<4 | 6>(4);
  const [keysOpen, setKeysOpen] = useState(false);
  const families = useMemo(() => query.data?.families || [], [query.data]);
  const active = families.find((item) => item.family === family) || families[0] || null;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--fx-stroke-weak)] px-2.5 py-2" data-testid="host-ip-intel">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-meta font-medium text-foreground">IP 信息</span>
        <div className="flex items-center gap-1">
          {families.length > 1
            ? families.map((item) => (
              <button
                key={item.family}
                type="button"
                aria-pressed={active?.family === item.family}
                className={cn("fx-chip", active?.family === item.family && "fx-chip-on")}
                onClick={() => setFamily(item.family)}
              >
                IPv{item.family}
              </button>
            ))
            : null}
          {canManage ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setKeysOpen(true)}>API Key</Button>
          ) : null}
        </div>
      </div>
      {query.isLoading ? <p className="text-meta text-muted-foreground">读取中…</p> : null}
      {query.isError ? <p className="text-meta text-muted-foreground">暂不可用（{query.error.message}）</p> : null}
      {query.data && !active ? (
        <p className="text-meta text-muted-foreground">
          {query.data.refreshing ? "正在后台查询…" : "还没有结果：这台主机没有已知的公网地址，或者还没检测过。"}
        </p>
      ) : null}
      {active ? <FamilyBody view={active} /> : null}
      {query.data ? (
        <p className="text-[11px] text-muted-foreground">
          {query.data.refreshing ? "正在后台补查… " : ""}
          数据来自 ipapi.is、IPinfo、proxycheck.io、RIPEstat{query.data.configuredKeys.includes("abuseipdb") ? "、AbuseIPDB" : ""} 等公开数据库，各家口径不同，仅供参考；每天最多查一次。
          {!query.data.agentSupported ? ` Agent 低于 ${NETPROFILE_INTEL_AGENT_VERSION}，由面板代查（查的是面板记录的地址）。` : ""}
        </p>
      ) : null}
      {canManage ? <IntelKeysDialog open={keysOpen} onOpenChange={setKeysOpen} /> : null}
    </div>
  );
}
