import { Link } from "wouter";

import { AUTO_IP_CHANGE_ROUTE, IP_CHANGE_STATE_LABELS, normalizeIpChangeState } from "@shared/ipChange";
import { trpc } from "@/lib/trpc";
import { Row, Section } from "./HostDetailDialog";

function formatTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 主机详情里「自动换 IP」那一节：只有管理员、插件开着、这台主机配置过时才出现。
 * 详细操作都在 /ip-change，这里只给状态和一个入口。
 */
export default function HostIpChangeSection({ hostId }: { hostId: number }) {
  const { data } = trpc.ipChange.hostStatus.useQuery({ hostId }, { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 });
  if (!data) return null;
  const state = normalizeIpChangeState(data.state);
  return (
    <Section title="自动换 IP">
      <Row label="状态" value={`${IP_CHANGE_STATE_LABELS[state]}${data.autoEnabled ? " · 自动" : data.enabled ? " · 仅检测" : ""}`} />
      <Row label="连续失败" value={`${data.consecutiveFailures} / ${data.failureThreshold} 轮`} />
      <Row label="上次更换" value={formatTime(data.lastChangeAt)} />
      {data.lastError ? <p className="break-words text-meta text-[var(--fx-down-text)]">{data.lastError}</p> : null}
      <Link href={AUTO_IP_CHANGE_ROUTE} className="text-meta text-primary underline-offset-2 hover:underline">打开自动换 IP 设置</Link>
    </Section>
  );
}
