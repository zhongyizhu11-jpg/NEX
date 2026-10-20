import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";
import { HOST_TRAFFIC_MEASURE_MODE_LABELS, normalizeHostTrafficMeasureMode } from "@shared/hostTrafficQuota";
import { hostPolicyBool, hostTrafficExcluded, normalizeHostTrafficFailoverPercent } from "@shared/hostTrafficPolicy";
import { EntityActions } from "@/components/entity/EntityActions";
import { Metric, MetricGroup, ResourceMeter } from "@/components/entity/Metric";
import { HealthBadge } from "@/components/network/StatusDot";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCompactLayout } from "@/hooks/useCompactLayout";
import { formatCpuPercent, hostAddressText, hostGeoTooltip, hostRegionText } from "./hostDisplay";
import HostNetProfileSection from "./HostNetProfileSection";
import { HostOsAvatar, HostOsGlyph, hostOsOf } from "./HostOsBadge";
import { fxpRuntimeBadgeTitle, fxpRuntimeDetailText } from "./FxpRuntimeBadge";
import { buildHostActions, hostTrafficFailoverTitle, type HostSummaryCardProps } from "./HostSummaryCard";
import { useHostVitals } from "./useHostVitals";
import { useAuth } from "@/_core/hooks/useAuth";
import OpsHostDetailExtraSections from "@/features/ops/slots/HostDetailExtraSections";
import MimicInstallPanel from "./MimicInstallPanel";
import HostIpChangeSection from "./HostIpChangeSection";
import { HostTlsInboundSection } from "./HostTlsInboundManager";
import HostUnlockSection from "./HostUnlockSection";

/**
 * 主机详情 —— Detail 态。
 *
 * 列表那张卡只回答「要不要点进去」，这里回答「它到底怎么样」。上一版没有这一
 * 层，所有字段都挤在列表里，于是列表既看不清也翻不完。
 *
 * 分段按「问的是什么」来，不是按数据来源：
 *
 *   概览    它是谁、在哪、什么系统、什么版本、跑了多久
 *   资源    CPU / 内存 / 磁盘，带绝对值不只是百分比
 *   流量    瞬时速率、系统累计、计费口径的用量与配额
 *
 * 每一段之间只有一条细线和一个小标题，**不套卡片** —— 详情页里再画三个圆角
 * 矩形，就又回到「Card 里面又 Card」了。
 *
 * 移动端用的还是现有的 Dialog（它已经做过窄屏适配）。真正的 Bottom Sheet 归
 * PR 4「操作系统」那一轮 —— 在这里临时造一个，就等于多了一套浮层。
 */

/** 详情里的一节（第五套主题那几节也用它，见 features/ops/slots/HostDetailExtraSections）。 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 border-t border-[var(--fx-stroke-weak)] pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-meta font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** 默认折叠的一节：标题行点一下展开 / 收起；summary 在折叠时显示在标题右边（比如当前状态）。 */
export function CollapsibleSection({ title, summary, children }: { title: string; summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-2 border-t border-[var(--fx-stroke-weak)] pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        className="flex min-w-0 items-center justify-between gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <h3 className="shrink-0 text-meta font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        <span className="inline-flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          {!open && summary ? <span className="min-w-0 truncate">{summary}</span> : null}
          <span className="inline-flex shrink-0 items-center gap-1">
            {open ? "收起" : "展开"}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </span>
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

/** 一行「标签 …… 值」。详情里大量这种键值对，值靠右并且等宽，一列能扫下来。 */
export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-secondary-type tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** 「TCP 1,284 · UDP 96」；两个都没有就是一个「—」，只有一个时另一个单独画「—」。 */
export function connectionsText(tcp: number | null, udp: number | null) {
  if (tcp === null && udp === null) return "—";
  const n = (value: number | null) => (value === null ? "—" : value.toLocaleString("zh-CN"));
  return `TCP ${n(tcp)} · UDP ${n(udp)}`;
}

export type HostDetailDialogProps = Omit<HostSummaryCardProps, "onOpenDetail"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshInterval?: number | false;
};

export default function HostDetailDialog(props: HostDetailDialogProps) {
  const { host, open, onOpenChange } = props;
  const confirmDialog = useConfirmDialog();
  const { user } = useAuth();
  // hooks 都在上面这几行；下面有 host 为空的提前 return
  const compactLayout = useCompactLayout();
  const vitals = useHostVitals(host, {
    metrics: props.metrics,
    traffic: props.traffic,
    refreshInterval: open ? props.refreshInterval : false,
  });

  if (!host) return null;

  const name = String(host.name || "-").trim() || "-";
  const os = hostOsOf(host);
  const measureMode = normalizeHostTrafficMeasureMode(host.trafficMeasureMode);

  const confirmDelete = async () => {
    if (
      await confirmDialog({
        title: "删除主机",
        description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
        confirmText: "删除",
        tone: "destructive",
      })
    ) {
      onOpenChange(false);
      props.onDelete(host.id);
    }
  };

  const { primary, menu } = buildHostActions({ ...props, onConfirmDelete: () => void confirmDelete() });

  const orDash = (value: number | null) => (value === null ? "—" : formatBytes(value));
  const sizePair = (used: number | null, total: number | null) =>
    used === null && total === null ? "—" : `${orDash(used)} / ${orDash(total)}`;

  const overviewSections = (
    <>
          <Section title="概览">
            <Row
              label="系统"
              value={
                os.full ? (
                  <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle" title={os.full}>
                    <HostOsGlyph os={os} className="h-3.5 w-3.5" />
                    <span className="min-w-0 truncate">{os.full}</span>
                  </span>
                ) : (
                  "未上报"
                )
              }
            />
            <Row label="Agent" value={host.agentVersion ? `v${host.agentVersion}` : "—"} />
            <Row label="FXP" value={<span title={fxpRuntimeBadgeTitle(host)}>{fxpRuntimeDetailText(host)}</span>} />
            <Row label="地址" value={hostAddressText(host) || "—"} />
            {/* 运营商 / ASN 在下面「网络画像」那一节，这里悬停给 */}
            <Row label="地区" value={<span title={hostGeoTooltip(host) || undefined}>{hostRegionText(host) || "—"}</span>} />
            <Row label={vitals.uptimeLabel} value={vitals.uptimeText} />
            {/*
              此刻这台机器上的连接数。离线或旧 Agent 没报都是「—」：一台断了的机器
              写着「TCP 1284」会让人以为它还在跑（同 CPU 那条理由）。
            */}
            <Row label="连接数" value={connectionsText(vitals.tcpConnections, vitals.udpConnections)} />
          </Section>

          <Section title="资源">
            {/*
              百分比配绝对值。只给 25% 说不清是 2GB 里的 25% 还是 128GB 里的
              25%，而这两件事该做的处理完全不同。
            */}
            <ResourceMeter label="CPU" percent={vitals.cpuPercent} valueText={formatCpuPercent(vitals.cpuPercent, vitals.isOnline)} />
            <ResourceMeter label="内存" percent={vitals.memoryPercent} />
            <Row label="" value={sizePair(vitals.memoryUsed, vitals.memoryTotal)} />
            <ResourceMeter label="磁盘" percent={vitals.diskPercent} />
            <Row label="" value={sizePair(vitals.diskUsed, vitals.diskTotal)} />
          </Section>

          <Section title="流量">
            <MetricGroup columns={2}>
              <Metric
                label={`↓ ${vitals.speedLabel}`}
                value={orDash(vitals.speedIn)}
                unit={vitals.speedIn === null ? undefined : "/s"}
                size="inline"
              />
              <Metric
                label={`↑ ${vitals.speedLabel}`}
                value={orDash(vitals.speedOut)}
                unit={vitals.speedOut === null ? undefined : "/s"}
                size="inline"
              />
            </MetricGroup>
            <Row label="系统累计 ↓" value={orDash(vitals.systemIn)} />
            <Row label="系统累计 ↑" value={orDash(vitals.systemOut)} />
            <Row
              label={`计费用量（${HOST_TRAFFIC_MEASURE_MODE_LABELS[measureMode]}）`}
              value={vitals.trafficUsageLabel}
            />
            {hostPolicyBool(host?.trafficFailoverEnabled) && Number(host?.trafficLimit) > 0 ? (
              <Row
                label="流量故障转移"
                value={hostTrafficExcluded(host)
                  ? <span className="text-[var(--fx-warn-text)]" title={hostTrafficFailoverTitle(host)}>已暂停组调度（到 {normalizeHostTrafficFailoverPercent(host?.trafficFailoverThresholdPercent)}%）</span>
                  : `用到 ${normalizeHostTrafficFailoverPercent(host?.trafficFailoverThresholdPercent)}% 时暂停组调度`}
              />
            ) : null}
          </Section>
    </>
  );
  const moreSections = (
    <>
          {/* 网络画像：双栈出站、运营商、25 端口、DNSBL（Agent 2.2.226 起在主机上测） */}
          <HostNetProfileSection host={host} canManage={user?.role === "admin"} />

          {/* mimic UDP 混淆环境：装没装、能不能用，管理员在这里一键安装 / 修复（2.3.439） */}
          <Section title="mimic UDP 混淆">
            <MimicInstallPanel host={host} canManage={user?.role === "admin"} />
          </Section>

          {/* 流媒体 / AI 解锁检测：能用这台主机的人都能看结果，只有管理员能发起检测（Agent 2.2.226 起） */}
          <HostUnlockSection hostId={Number(host.id)} />

          {user?.role === "admin" && (
            <Section title="共享 TLS 入站">
              <HostTlsInboundSection hostId={Number(host.id)} />
            </Section>
          )}

          <OpsHostDetailExtraSections host={host} isAdmin={user?.role === "admin"} />
          {user?.role === "admin" ? <HostIpChangeSection hostId={Number(host.id)} /> : null}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          {/* 发行版图标顶替名字左边的状态点，和列表卡一样；状态点挂在图标右下角 */}
          <div className="flex min-w-0 items-center gap-3">
            <HostOsAvatar os={os} health={vitals.health} size="lg" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle className="min-w-0 truncate">{name}</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-2">
                <HealthBadge health={vitals.health} />
                {/*
                  上报时间只在离线时给。在线时它每隔几秒变一次，是噪音；
                  离线时它才是那个关键问题的答案 —— 「它是什么时候没的」。
                */}
                {!vitals.isOnline && vitals.lastReportedText ? (
                  <span className="text-meta text-muted-foreground">最后上报 {vitals.lastReportedText}</span>
                ) : null}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/*
          精简布局：七八个分区竖着叠一个 max-w-md 的框太长，分成「概览」（系统 / 资源 / 流量）和
          「更多」（网络画像、mimic、解锁、TLS 入站、换 IP）两页；标准布局照旧一页到底。
        */}
        {compactLayout ? (
          <Tabs defaultValue="overview" className="flex min-w-0 flex-col gap-3">
            <TabsList aria-label="主机详情" className="w-full">
              <TabsTrigger value="overview" className="flex-1">概览</TabsTrigger>
              <TabsTrigger value="more" className="flex-1">更多</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="m-0 flex min-w-0 flex-col gap-4">{overviewSections}</TabsContent>
            <TabsContent value="more" className="m-0 flex min-w-0 flex-col gap-4">{moreSections}</TabsContent>
          </Tabs>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {overviewSections}
            {moreSections}
          </div>
        )}

        <div className="flex items-center justify-end border-t border-[var(--fx-stroke-weak)] pt-3">
          <EntityActions primary={primary} menu={menu} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
