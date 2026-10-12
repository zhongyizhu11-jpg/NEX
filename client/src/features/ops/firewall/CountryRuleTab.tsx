import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingRow } from "@/components/SettingRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { cn } from "@/lib/utils";
import type { FirewallHostPolicy, FirewallMode } from "@shared/firewallCountries";
import {
  CountryDataLine,
  CountryPicker,
  FIREWALL_MODE_LABELS,
  ModeSegmented,
  NumberedSection,
  describeCountries,
  sameList,
  type CountryDataItem,
} from "./firewallUi";

/*
  监控 › 地区规则（#4 + #4b），学 Rosélune 的 Access 页：两节，编号 01 / 02。
    01 主机的地区规则：全局模式 + 国家，下面每台主机一行（跟随 / 当前生效 / 今日拦截）。
    02 谁能打开面板：同样的控件，外加「你现在的 IP 是 …」—— 保存时服务端会拒绝把自己锁在外面的规则。
*/

const HOST_MODE_HINT: Record<FirewallMode, string> = {
  off: "不按国家拦截。IP 封禁照常生效。",
  block: "来自这些国家的新连接到不了规则入口和落地入站的端口，其他国家照常。",
  allow: "只有这些国家能连进来，其他国家的新连接一律挡掉。",
};

const PANEL_MODE_HINT: Record<FirewallMode, string> = {
  off: "谁都能打开面板网页（登录照常要密码）。",
  block: "来自这些国家的人打不开面板网页。",
  allow: "只有这些国家的人能打开面板网页。",
};

const POLICY_LABELS: Record<FirewallHostPolicy, string> = {
  follow: "跟随全局",
  custom: "本机单独规则",
  off: "本机不限制",
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

type RuleDraft = { mode: FirewallMode; countries: string[] };

function RuleEditor({ draft, onChange, hints, disabled, label }: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  hints: Record<FirewallMode, string>;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <ModeSegmented value={draft.mode} onChange={(mode) => onChange({ ...draft, mode })} ariaLabel={label} disabled={disabled} />
        <p className="text-[12.5px] text-muted-foreground">{hints[draft.mode]}</p>
      </div>
      {draft.mode !== "off" ? (
        <CountryPicker value={draft.countries} onChange={(countries) => onChange({ ...draft, countries })} disabled={disabled} />
      ) : null}
    </div>
  );
}

type HostRow = {
  id: number;
  name: string;
  isOnline: boolean;
  agentVersion: string | null;
  supported: boolean;
  policy: FirewallHostPolicy;
  customRule: RuleDraft;
  rule: RuleDraft;
  effectiveMode: FirewallMode;
  note: string | null;
  state: { active: boolean; backend: string; error: string | null; ports: number; reportedAt: Date | string | null } | null;
  today: { blocked: number; country: number; total: number };
};

function EffectiveText({ host, minAgentVersion }: { host: HostRow; minAgentVersion: string }) {
  if (!host.supported) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="destructive">需要升级 Agent</Badge>
        <span className="text-[12px] text-muted-foreground">升到 {minAgentVersion} 以上才会执行</span>
      </span>
    );
  }
  const ruleText = host.rule.mode === "off"
    ? "不限制"
    : `${host.rule.mode === "block" ? "拦截" : "只放行"} ${describeCountries(host.rule.countries)}`;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("min-w-0 break-words", host.rule.mode === "off" && "text-muted-foreground")}>{ruleText}</span>
      {host.note ? <span className="text-[12px] text-[var(--fx-warn-text)]">{host.note}</span> : null}
      {host.state?.error ? <span className="text-[12px] text-[var(--fx-down-text)]">{host.state.error}</span> : null}
      {!host.state && host.rule.mode !== "off" ? <span className="text-[12px] text-muted-foreground">等 Agent 来取（最多一分钟）</span> : null}
    </span>
  );
}

function HostCountryRows({ hosts, globalRule, minAgentVersion }: { hosts: HostRow[]; globalRule: RuleDraft; minAgentVersion: string }) {
  const utils = trpc.useUtils();
  const save = trpc.ops.firewall.saveCountryRule.useMutation({
    onSuccess: () => utils.ops.firewall.getCountryRule.invalidate(),
    onError: (error) => toast.error(errorMessage(error, "保存失败")),
  });
  const [editing, setEditing] = useState<HostRow | null>(null);
  const [draft, setDraft] = useState<RuleDraft>({ mode: "block", countries: [] });

  const openCustom = (host: HostRow) => {
    const base = host.policy === "custom" ? host.customRule : globalRule;
    setDraft({ mode: base.mode === "off" ? "block" : base.mode, countries: base.countries });
    setEditing(host);
  };

  const changePolicy = (host: HostRow, policy: FirewallHostPolicy) => {
    if (policy === "custom") {
      openCustom(host);
      return;
    }
    save.mutate({ hostId: host.id, policy, mode: "off", countries: [] }, {
      onSuccess: () => toast.success(`${host.name} 已改为${POLICY_LABELS[policy]}`),
    });
  };

  if (hosts.length === 0) {
    return <p className="text-[13px] text-muted-foreground">还没有主机。</p>;
  }

  return (
    <>
      <div className="min-w-0">
        <div className="hidden grid-cols-[minmax(0,1.1fr)_10.5rem_minmax(0,1.6fr)_6.5rem] gap-3 border-b border-[var(--fx-stroke-weak)] pb-2 text-[12px] text-muted-foreground sm:grid">
          <span>主机</span>
          <span>跟随</span>
          <span>当前生效</span>
          <span className="text-right">今日拦截</span>
        </div>
        <ul className="min-w-0">
          {hosts.map((host) => (
            <li
              key={host.id}
              className="fx-list-row grid min-w-0 grid-cols-1 gap-2 py-3 text-[13px] sm:grid-cols-[minmax(0,1.1fr)_10.5rem_minmax(0,1.6fr)_6.5rem] sm:items-center sm:gap-3"
            >
              <div className="flex min-w-0 items-center justify-between gap-2 sm:block">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", host.isOnline ? "bg-[var(--fx-healthy)]" : "bg-muted-foreground/40")}
                    aria-label={host.isOnline ? "在线" : "离线"}
                  />
                  <span className="truncate font-medium" title={host.name}>{host.name}</span>
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground sm:hidden">
                  今天拦截了 {host.today.total.toLocaleString()} 个连接
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Select
                  value={host.policy}
                  onValueChange={(value) => changePolicy(host, value as FirewallHostPolicy)}
                  disabled={save.isPending}
                >
                  <SelectTrigger className="h-8 w-full text-[13px] sm:w-[10.5rem]" aria-label={`${host.name} 的地区规则`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(POLICY_LABELS) as FirewallHostPolicy[]).map((policy) => (
                      <SelectItem key={policy} value={policy}>{POLICY_LABELS[policy]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {host.policy === "custom" ? (
                  <Button type="button" variant="ghost" size="sm" className="shrink-0 sm:hidden" onClick={() => openCustom(host)}>改规则</Button>
                ) : null}
              </div>
              <div className="min-w-0">
                <EffectiveText host={host} minAgentVersion={minAgentVersion} />
                {host.policy === "custom" ? (
                  <button type="button" className="mt-0.5 hidden text-[12px] text-[var(--fx-primary-text)] underline-offset-2 hover:underline sm:inline" onClick={() => openCustom(host)}>
                    改本机规则
                  </button>
                ) : null}
              </div>
              <div
                className="hidden text-right tabular-nums sm:block"
                title={`IP 封禁 ${host.today.blocked} 个，地区规则 ${host.today.country} 个`}
              >
                {host.today.total.toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        {editing ? (
          <DialogContent className="bg-[var(--fx-l0-page)] sm:max-w-md">
            <DialogHeader>
              <DialogTitle>本机单独规则</DialogTitle>
              <DialogDescription className="truncate">{editing.name}：不跟随全局，只按这里的设置</DialogDescription>
            </DialogHeader>
            <RuleEditor draft={draft} onChange={setDraft} hints={HOST_MODE_HINT} label={`${editing.name} 的地区规则`} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button
                type="button"
                disabled={save.isPending || (draft.mode !== "off" && draft.countries.length === 0)}
                onClick={() => {
                  const host = editing;
                  save.mutate({ hostId: host.id, policy: "custom", mode: draft.mode, countries: draft.countries }, {
                    onSuccess: () => {
                      toast.success(`${host.name} 的单独规则已保存`);
                      setEditing(null);
                    },
                  });
                }}
              >
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function HostRuleSection() {
  const utils = trpc.useUtils();
  const [fast, setFast] = useState(false);
  const query = trpc.ops.firewall.getCountryRule.useQuery(undefined, {
    refetchInterval: pollingInterval(fast ? "active" : "slow"),
  });
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const saved = query.data?.global;
  useEffect(() => {
    if (saved && !draft) setDraft({ mode: saved.mode, countries: saved.countries });
  }, [saved, draft]);
  const dataItems = (query.data?.data ?? []) as CountryDataItem[];
  const waiting = dataItems.some((item) => !item.fetchedAt && !item.lastError);
  useEffect(() => setFast(waiting), [waiting]);

  const save = trpc.ops.firewall.saveCountryRule.useMutation({
    onSuccess: (result) => {
      toast.success("已保存，各主机一分钟内生效");
      setDraft({ mode: result.rule.mode, countries: result.rule.countries });
      void utils.ops.firewall.getCountryRule.invalidate();
    },
    onError: (error) => toast.error(errorMessage(error, "保存失败")),
  });
  const refresh = trpc.ops.firewall.refreshCountryData.useMutation({
    onSuccess: () => {
      toast.success("正在重新下载国家数据");
      void utils.ops.firewall.getCountryRule.invalidate();
    },
  });

  if (query.isLoading) return <DataSectionLoading label="正在读取地区规则" />;
  if (query.error || !query.data || !draft) {
    return <DataSectionError label="地区规则" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  const dirty = draft.mode !== query.data.global.mode || !sameList(draft.countries, query.data.global.countries);
  const invalid = draft.mode !== "off" && draft.countries.length === 0;
  const hosts = query.data.hosts as HostRow[];
  const outdated = hosts.filter((host) => !host.supported).length;

  return (
    <NumberedSection
      index={1}
      title="主机的地区规则"
      description="管的是连到主机上转发规则、隧道入口和落地入站端口的新连接。SSH、内网地址、面板自己的主机、已经建立的连接都不受影响。"
    >
      <RuleEditor draft={draft} onChange={setDraft} hints={HOST_MODE_HINT} label="主机的地区规则模式" disabled={save.isPending} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CountryDataLine items={dataItems} onRetry={() => refresh.mutate()} retrying={refresh.isPending} />
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ mode: query.data!.global.mode, countries: query.data!.global.countries })}>
              还原
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!dirty || invalid || save.isPending}
            onClick={() => save.mutate({ mode: draft.mode, countries: draft.countries })}
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            保存
          </Button>
        </div>
      </div>
      {invalid ? <p className="text-[12.5px] text-[var(--fx-warn-text)]">至少选一个国家或地区。</p> : null}

      <div className="pt-1">
        <h3 className="mb-1 text-[13px] font-medium">各主机</h3>
        {outdated > 0 ? (
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            有 {outdated} 台主机的 Agent 太旧，需要把 Agent 升级到 {query.data.minAgentVersion} 才会执行地区规则和 IP 封禁。
          </p>
        ) : null}
        <HostCountryRows hosts={hosts} globalRule={query.data.global} minAgentVersion={query.data.minAgentVersion} />
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">{query.data.attribution}</p>
    </NumberedSection>
  );
}

function PanelAccessSection() {
  const utils = trpc.useUtils();
  const query = trpc.ops.firewall.getPanelAccessRule.useQuery(undefined, { refetchInterval: pollingInterval("slow") });
  const [draft, setDraft] = useState<(RuleDraft & { includeSubscription: boolean }) | null>(null);
  const saved = query.data?.rule;
  useEffect(() => {
    if (saved && !draft) setDraft({ mode: saved.mode, countries: saved.countries, includeSubscription: saved.includeSubscription });
  }, [saved, draft]);
  const save = trpc.ops.firewall.savePanelAccessRule.useMutation({
    onSuccess: (result) => {
      toast.success(result.rule.mode === "off" ? "已关闭面板访问限制" : "已保存，一分钟内生效");
      setDraft({ mode: result.rule.mode, countries: result.rule.countries, includeSubscription: result.rule.includeSubscription });
      void utils.ops.firewall.getPanelAccessRule.invalidate();
      void utils.ops.firewall.getCountryRule.invalidate();
    },
    // 服务端拒绝时（会把自己锁在外面、国家数据没下载好）给的是一句完整的解释，原样显示。
    onError: (error) => toast.error(errorMessage(error, "保存失败"), { duration: 8000 }),
  });

  const youText = useMemo(() => {
    const you = query.data?.you;
    if (!you?.ip) return "认不出你现在的 IP。";
    if (you.isPrivate) return `你现在的 IP 是 ${you.ip}（内网地址，永远放行）`;
    return `你现在的 IP 是 ${you.ip}（${you.label || "国家未知"}）`;
  }, [query.data?.you]);

  if (query.isLoading) return <DataSectionLoading label="正在读取面板访问限制" />;
  if (query.error || !query.data || !draft) {
    return <DataSectionError label="面板访问限制" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  const rule = query.data.rule;
  const dirty = draft.mode !== rule.mode || !sameList(draft.countries, rule.countries) || draft.includeSubscription !== rule.includeSubscription;
  const invalid = draft.mode !== "off" && draft.countries.length === 0;

  return (
    <NumberedSection
      index={2}
      title="谁能打开面板"
      description="按访问者所在国家决定能不能打开面板网页。Agent 和面板之间的通信、支付回调不受影响；本机和内网访问永远放行。"
    >
      <RuleEditor draft={draft} onChange={(next) => setDraft({ ...draft, ...next })} hints={PANEL_MODE_HINT} label="面板访问限制模式" disabled={save.isPending} />
      {draft.mode !== "off" ? (
        <SettingRow
          asLabel
          label="订阅链接也一起限制"
          description="关着时，订阅链接在哪里都能拉取。"
          control={(
            <Switch
              checked={draft.includeSubscription}
              onCheckedChange={(checked) => setDraft({ ...draft, includeSubscription: checked === true })}
              disabled={save.isPending}
            />
          )}
        />
      ) : null}
      <p className={cn("text-[13px]", query.data.you.allowedNow ? "text-foreground" : "text-[var(--fx-down-text)]")}>
        {youText}
        {!query.data.you.allowedNow ? "。按现在保存的规则，这个 IP 打不开面板。" : null}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CountryDataLine items={(query.data.data ?? []) as CountryDataItem[]} />
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ mode: rule.mode, countries: rule.countries, includeSubscription: rule.includeSubscription })}
            >
              还原
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!dirty || invalid || save.isPending}
            onClick={() => save.mutate({ mode: draft.mode, countries: draft.countries, includeSubscription: draft.includeSubscription })}
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {save.isPending && draft.mode !== "off" ? "检查中…" : "保存"}
          </Button>
        </div>
      </div>
      {invalid ? <p className="text-[12.5px] text-[var(--fx-warn-text)]">至少选一个国家或地区。</p> : null}
      {draft.mode !== "off" ? (
        <p className="text-[12px] text-muted-foreground">
          保存前会先确认你自己不会被挡在外面；当前是{FIREWALL_MODE_LABELS[rule.mode]}。
        </p>
      ) : null}
    </NumberedSection>
  );
}

/** 监控 › 地区规则（#4） */
export default function CountryRuleTab(_props: Record<string, never>) {
  return (
    <div className="space-y-4">
      <HostRuleSection />
      <PanelAccessSection />
    </div>
  );
}
