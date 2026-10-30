import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SpeedTestDialog } from "@/components/proxy/SpeedTestDialog";
import { trpc } from "@/lib/trpc";
import { formatMbps } from "@shared/nodeCheck";
import { Row, Section } from "./HostDetailDialog";

/*
  主机详情里的「网速测试」一节：最近一次的下载 / 上传 / 延迟写在这儿，点「测速」打开曲线弹窗
  （SpeedTestDialog）。测速要吃这台机器几百 MB 流量，所以只手动跑。Agent 2.2.241 起。
*/
export default function HostSpeedTestSection({ host }: { host: any }) {
  const hostId = Number(host?.id || 0);
  const [open, setOpen] = useState(false);
  const status = trpc.hosts.speedTestStatus.useQuery({ hostId }, { enabled: hostId > 0, staleTime: 15_000, refetchOnWindowFocus: false });
  if (!(hostId > 0)) return null;
  const data = status.data;
  const speed = data?.latest?.speed ?? null;
  return (
    <Section
      title="网速测试"
      action={(
        <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setOpen(true)} disabled={!data || !data.supported} title={data && !data.supported ? "需要升级 Agent" : undefined}>
          {data?.pending ? "测速中…" : speed ? "再测一次" : "测速"}
        </Button>
      )}
    >
      {data && !data.supported ? (
        <Row label="测速" value={<span className="text-[var(--fx-warn-text)]">需要升级 Agent（{data.minAgentVersion} 起）</span>} />
      ) : speed ? (
        <>
          <Row label="下载 / 上传" value={`${formatMbps(speed.downloadMbps)} / ${formatMbps(speed.uploadMbps)}`} />
          <Row label="延迟 / 抖动" value={`${Math.round(speed.latencyMs)} ms / ${Math.round(speed.jitterMs)} ms`} />
          <Row label="机房 · 出口" value={[speed.colo, speed.clientIp].filter(Boolean).join(" · ") || "—"} />
          <Row label="测于" value={data?.latest?.checkedAt ? new Date(data.latest.checkedAt * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"} />
        </>
      ) : (
        <Row label="最近一次" value={status.isLoading ? "读取中…" : data?.latest?.error ? <span className="text-[var(--fx-down-text)]">上次失败</span> : "还没测过"} />
      )}
      <SpeedTestDialog subject={open ? { hostId } : null} name={String(host?.name || "")} onOpenChange={(value) => { if (!value) setOpen(false); }} />
    </Section>
  );
}
