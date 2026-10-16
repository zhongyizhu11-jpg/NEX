import type { ReactNode } from "react";
import { toast } from "sonner";

import { formatAgo } from "@shared/dashboardAttention";
import {
  dnsblCodeLabel,
  dnsblListName,
  dualStackState,
  DUAL_STACK_LABELS,
  NETPROFILE_MIN_AGENT_VERSION,
  SMTP25_LABELS,
  summarizeDnsbl,
  type NetProfileReport,
  type Smtp25Status,
} from "@shared/netProfile";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Row, Section } from "./HostDetailDialog";
import { hostGeoTooltip, hostNetworkText, hostRegionText } from "./hostDisplay";

/*
  主机详情里的「网络画像」：这台机器从外面看是什么样 —— 公网地址和双栈、运营商 / ASN、
  地区、25 端口能不能出站、IP 在不在邮件黑名单上。

  主机侧检测（双栈、25 端口、DNSBL）要 Agent 2.2.226：每 6 小时测一次，管理员可以点「重新检测」。
  更旧的 Agent 只能从面板服务器查 DNSBL —— 那是面板的解析器在查，不是主机的。
  运营商 / ASN 跟地区一起由定位服务给（主机行上的 geoAsn / geoIsp / geoOrg），不需要 Agent。
*/

type Tone = "good" | "warn" | "bad" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  good: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]",
  warn: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]",
  bad: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]",
  muted: "border border-[var(--fx-stroke-base)] text-muted-foreground",
};

export function StatusChip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4", TONE_CLASS[tone])}
      title={title}
    >
      {children}
    </span>
  );
}

/** 值可能很长（地址 + 徽标、黑名单列表）时用这一行：值换行而不是截断。 */
function WrapRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <span className="shrink-0 pt-0.5 text-meta text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right text-secondary-type tabular-nums text-foreground">{children}</span>
    </div>
  );
}

const SMTP_TONE: Record<Smtp25Status, Tone> = { open: "good", blocked: "warn", timeout: "warn" };

function formatChecked(sec: number | null | undefined) {
  if (!sec) return "—";
  const date = new Date(sec * 1000);
  return `${formatAgo(Date.now() - date.getTime())} · ${date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

function FamilyValue({ check, fallback }: { check: NetProfileReport["ipv4"] | null | undefined; fallback: string }) {
  if (!check) return <span className="text-muted-foreground">{fallback || "—"}</span>;
  return (
    <>
      <span className="min-w-0 break-all font-mono text-xs">{check.address || fallback || "—"}</span>
      {check.ok ? (
        <StatusChip tone="good">{check.latencyMs != null ? `通 · ${check.latencyMs} ms` : "通"}</StatusChip>
      ) : (
        <StatusChip tone="bad" title={check.error || undefined}>不通</StatusChip>
      )}
    </>
  );
}

function DnsblSummaryValue({ profile }: { profile: NetProfileReport | null }) {
  const summary = summarizeDnsbl(profile?.dnsbl);
  if (summary.state === "none") return <span className="text-muted-foreground">{profile?.ipv4 && !profile.ipv4.ok ? "没有公网 IPv4，未查" : "未检测"}</span>;
  if (summary.state === "listed") {
    return (
      <>
        <StatusChip tone="bad">列入 {summary.listed.length} 个列表</StatusChip>
        <span className="min-w-0 break-words">{summary.listed.map(dnsblListName).join("、")}</span>
      </>
    );
  }
  if (summary.state === "unknown") return <StatusChip tone="muted">全部无法查询</StatusChip>;
  return (
    <>
      <StatusChip tone="good">未列入</StatusChip>
      <span className="text-meta text-muted-foreground">
        查了 {summary.checked} 个{summary.failed.length > 0 ? `，${summary.failed.length} 个无法查询` : ""}
      </span>
    </>
  );
}

function RawDetails({ profile }: { profile: NetProfileReport }) {
  return (
    <details className="group min-w-0 rounded-md border border-[var(--fx-stroke-weak)] px-2.5 py-1.5">
      <summary className="cursor-pointer select-none text-meta text-muted-foreground">详细结果</summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2 text-meta">
        {profile.ipv4?.error ? <p className="break-words text-muted-foreground">IPv4：{profile.ipv4.error}</p> : null}
        {profile.ipv6?.error ? <p className="break-words text-muted-foreground">IPv6：{profile.ipv6.error}</p> : null}
        {profile.ipv6 ? (
          <p className="text-muted-foreground">本机网卡{profile.ipv6.configured === true ? "配置了" : profile.ipv6.configured === false ? "没有配置" : "未知是否配置"}全局 IPv6 地址</p>
        ) : null}
        {profile.smtp25 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-foreground">25 端口</p>
            {profile.smtp25.detail ? <p className="break-words text-muted-foreground">{profile.smtp25.detail}</p> : null}
            {profile.smtp25.targets.map((item) => (
              <p key={item.target} className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
                {item.target} — {item.status}{item.detail ? `：${item.detail}` : ""}
              </p>
            ))}
          </div>
        ) : null}
        {profile.dnsbl.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-foreground">
              DNSBL（{profile.dnsblAddress || "—"}，{profile.dnsblSource === "panel" ? "面板服务器查询" : "主机系统解析器查询"}）
            </p>
            {profile.dnsbl.map((item) => {
              const label = dnsblCodeLabel(item.list, item.code);
              return (
                <div key={item.list} className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className="min-w-0 break-all font-mono text-[11px]">{item.list}</span>
                  {item.error ? (
                    <StatusChip tone="muted" title={item.error}>{item.error}</StatusChip>
                  ) : item.listed ? (
                    <StatusChip tone="bad">列入 {item.code}{label ? ` · ${label}` : ""}</StatusChip>
                  ) : (
                    <StatusChip tone="good">未列入</StatusChip>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default function HostNetProfileSection({ host, canManage }: { host: any; canManage: boolean }) {
  const hostId = Number(host?.id);
  const utils = trpc.useUtils();
  const query = trpc.netProfile.get.useQuery(
    { hostId },
    {
      enabled: hostId > 0,
      staleTime: 15_000,
      retry: false,
      refetchOnWindowFocus: false,
      // 等 Agent 交结果时 3 秒刷一次；没在等就不轮询
      refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
    },
  );
  const recheck = trpc.netProfile.recheck.useMutation({
    onSuccess: (result) => {
      toast.success(result.mode === "agent" ? "已通知 Agent 重新检测，通常半分钟内出结果" : "已从面板查过 DNSBL");
      void utils.netProfile.get.invalidate({ hostId });
    },
    onError: (error) => toast.error(error.message),
  });
  if (!(hostId > 0)) return null;

  const data = query.data;
  const profile = data?.profile ?? null;
  const supported = !!data?.supported;
  const stack = dualStackState(profile);
  const network = hostNetworkText(host);
  const busy = recheck.isPending || !!data?.pending;

  return (
    <Section title="网络画像">
      <WrapRow label="公网 IPv4">
        <FamilyValue check={profile?.ipv4} fallback={String(host?.ipv4 || "")} />
      </WrapRow>
      <WrapRow label="公网 IPv6">
        <FamilyValue check={profile?.ipv6} fallback={String(host?.ipv6 || "")} />
      </WrapRow>
      <WrapRow label="双栈">
        <StatusChip tone={stack === "dual" ? "good" : stack === "unknown" ? "muted" : stack === "none" ? "bad" : "warn"}>{DUAL_STACK_LABELS[stack]}</StatusChip>
        {profile?.ipv6 && profile.ipv6.configured === false ? <span className="text-meta text-muted-foreground">网卡没有 IPv6</span> : null}
      </WrapRow>
      <Row label="运营商 / ASN" value={<span title={hostGeoTooltip(host) || undefined}>{network || (host?.geoAsn === "" ? "定位服务没给" : "—")}</span>} />
      {host?.geoOrg && String(host.geoOrg).toLowerCase() !== String(host?.geoIsp || "").toLowerCase() ? (
        <Row label="组织" value={String(host.geoOrg)} />
      ) : null}
      <Row label="地区" value={hostRegionText(host) || "—"} />
      <WrapRow label="25 端口出站">
        {profile?.smtp25 ? (
          <StatusChip tone={SMTP_TONE[profile.smtp25.status]} title={profile.smtp25.detail || undefined}>{SMTP25_LABELS[profile.smtp25.status]}</StatusChip>
        ) : (
          <span className="text-muted-foreground">未检测</span>
        )}
      </WrapRow>
      <WrapRow label="DNSBL 黑名单">
        <DnsblSummaryValue profile={profile} />
      </WrapRow>
      <Row
        label="最近检测"
        value={data?.pending ? (data.running ? "Agent 正在检测…" : "等 Agent 来取…") : formatChecked(profile?.checkedAt)}
      />
      {!data && query.isLoading ? <p className="text-meta text-muted-foreground">读取中…</p> : null}
      {data && !supported ? (
        <p className="text-meta text-[var(--fx-warn-text)]">
          需要升级 Agent：双栈和 25 端口要在主机上测，需要 Agent {data.minAgentVersion || NETPROFILE_MIN_AGENT_VERSION} 以上（当前 {host?.agentVersion ? `v${host.agentVersion}` : "未知"}）。
          {canManage ? "现在只能从面板服务器查 DNSBL。" : ""}
        </p>
      ) : null}
      {data?.timedOut ? <p className="text-meta text-[var(--fx-warn-text)]">上次「重新检测」Agent 一直没回结果，可能离线了。</p> : null}
      {profile ? <RawDetails profile={profile} /> : null}
      {canManage ? (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {data && !supported ? (
            <Button size="sm" variant="ghost" disabled={recheck.isPending} onClick={() => recheck.mutate({ hostId, mode: "panelDnsbl" })}>
              从面板查 DNSBL
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || busy}
            title={data && !supported ? `需要升级 Agent 到 ${NETPROFILE_MIN_AGENT_VERSION}` : undefined}
            onClick={() => recheck.mutate({ hostId, mode: "agent" })}
          >
            {busy ? "检测中…" : "重新检测"}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
