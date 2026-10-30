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
import { formatCpuPercent, hostGeoTooltip, hostRegionText } from "./hostDisplay";
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
import HostSpeedTestSection from "./HostSpeedTestSection";
import HostLineSection from "./HostLineSection";

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

/**
 * 详情里的一节：一张浅底的小卡，头上是标题（右边可以放这一节的主按钮或一句摘要），
 * 下面是键值行。概览 / 更多两页、第五套主题那几节（features/ops/slots/HostDetailExtraSections）
 * 都用它，所以整个弹窗的分节看起来是一副样子。
 */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="fx-hd-sec">
      <div className="fx-hd-sec-head">
        <h3>{title}</h3>
        {action ? <div className="fx-hd-sec-action">{action}</div> : null}
      </div>
      <div className="fx-hd-sec-body">{children}</div>
    </section>
  );
}

/** 默认折叠的一节：标题行点一下展开 / 收起；summary 在折叠时显示在标题右边（比如当前状态）。 */
export function CollapsibleSection({ title, summary, defaultOpen = false, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="fx-hd-sec" data-open={open ? "" : undefined}>
      <button type="button" className="fx-hd-sec-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <h3>{title}</h3>
        <span className="fx-hd-sec-action">
          {!open && summary ? <span className="min-w-0 truncate text-meta text-muted-foreground">{summary}</span> : null}
          <span className="fx-hd-sec-toggle">
            {open ? "收起" : "展开"}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </span>
        </span>
      </button>
      {open ? <div className="fx-hd-sec-body">{children}</div> : null}
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
            {/* 地址：v4、v6 各一行，都没上报就写登记的 IP。出口 IP 和登记的不符只在不符时提一句。 */}
            {host.ipv4 || host.ipv6 ? (
              <>
                {host.ipv4 ? <Row label="IPv4" value={<span className="font-mono">{host.ipv4}</span>} /> : null}
                {host.ipv6 ? <Row label="IPv6" value={<span className="font-mono break-all">{host.ipv6}</span>} /> : null}
              </>
            ) : (
              <Row label="地址" value={host.ip && host.ip !== "unknown" ? <span className="font-mono">{host.ip}</span> : "—"} />
            )}
            {host.observedIp && host.exitIpMismatch ? (
              <Row
                label="出口 IP"
                value={<span className="text-[var(--fx-warn-text)]" title="和登记的地址不是同一个：地址被换过、机器前面多了一层代理，或者手填的地址已经不是这台机器。">{host.observedIp} · 和登记的不符</span>}
              />
            ) : null}
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
          {/* 出口检测：站点连通 + 流媒体 / AI 解锁，能用这台主机的人都能看，只有管理员能发起检测 */}
          <HostUnlockSection hostId={Number(host.id)} />

          {/* 网速测试：这台机器对 Cloudflare 测速（Agent 2.2.241 起），点开是曲线和结果 */}
          <HostSpeedTestSection host={host} />

          {/* 线路：维护开关、节点熔断、经过它的线路（2.3.496） */}
          <HostLineSection hostId={Number(host.id)} />

          {/* 网络画像：双栈出站、运营商、25 端口、DNSBL（Agent 2.2.226 起在主机上测） */}
          <HostNetProfileSection host={host} canManage={user?.role === "admin"} />

          {user?.role === "admin" ? <HostTlsInboundSection hostId={Number(host.id)} /> : null}

          {/* mimic UDP 混淆环境：装没装、能不能用，管理员在这里一键安装 / 修复（2.3.439） */}
          <Section title="mimic UDP 混淆">
            <MimicInstallPanel host={host} canManage={user?.role === "admin"} />
          </Section>

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
          七八个分区竖着叠一个 max-w-md 的框太长，分成「概览」（系统 / 资源 / 流量）和
          「更多」（网络画像、mimic、解锁、TLS 入站、换 IP）两页（标准布局重构工作包五，两种布局都分页）。
        */}
        <Tabs defaultValue="overview" className="flex min-w-0 flex-col gap-3">
          <TabsList aria-label="主机详情" className="w-full">
            <TabsTrigger value="overview" className="flex-1">概览</TabsTrigger>
            <TabsTrigger value="more" className="flex-1">更多</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="m-0 flex min-w-0 flex-col gap-2.5">{overviewSections}</TabsContent>
          <TabsContent value="more" className="m-0 flex min-w-0 flex-col gap-2.5">{moreSections}</TabsContent>
        </Tabs>

        <div className="flex items-center justify-end border-t border-[var(--fx-stroke-weak)] pt-3">
          <EntityActions primary={primary} menu={menu} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
