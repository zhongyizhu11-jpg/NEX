import * as db from "./db";
import { listRecentConfigAuditEvents } from "./configAudit";
import { buildPanelOnlyDiagnostics } from "./linkDiagnostics";
import { listPanelEvents } from "./ops/panelEvents";
import { redactConfigAuditEventForSupport, redactSupportValue } from "./supportBundle";
import { APP_VERSION } from "../shared/versions";

/*
  一键故障包（按规则 / 隧道 / 转发组打包，AI 只读诊断接口也用它）。

  主机那份「支持包」（server/supportBundle.ts）是整台机器的诊断输出；用户报障时说的往往是
  「这条规则不通」，排查要的是这条规则（或隧道、转发组）沿线的东西。这里一次收齐：
  - 面板侧的诊断结论（和网页上「诊断」同一套检查，不给主机派任务，所以随时能导、不会打扰主机）；
  - 资源本身的配置（脱敏：密钥、令牌、私钥一律抹掉）；
  - 沿线主机此刻的状态（在线、心跳、Agent / FXP / 运行时版本）；
  - 最近一次自测、近 24 小时的探测统计；
  - 管理员还能拿到：沿线主机最近 24 小时的事件，和这个资源最近的配置变更。

  权限和网页一样：普通用户只能打包自己的资源，看不到别人主机的细节。
  每一块单独取，某一块失败只在那一块写上原因，不让整个包导不出来。
*/

export type FaultBundleKind = "rule" | "tunnel" | "forwardGroup";

type Ctx = { user: { id: number; role: string } };

const EVENT_WINDOW_SECONDS = 24 * 3600;
const PROBE_WINDOW_MS = 24 * 3600 * 1000;

async function section<T>(load: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await load();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function hostSnapshot(host: any, detailVisible: boolean) {
  if (!host) return null;
  const base = { id: Number(host.id), name: String(host.name || `主机 #${host.id}`) };
  if (!detailVisible) return { ...base, detail: "不是你的主机，不显示细节" };
  return {
    ...base,
    online: !!host.isOnline,
    lastHeartbeat: host.lastHeartbeat ? new Date(host.lastHeartbeat).toISOString() : null,
    agentVersion: host.agentVersion || null,
    fxpVersion: host.fxpVersion || null,
    runtimeVersion: host.runtimeVersion || null,
    osInfo: host.osInfo || null,
    geo: [host.geoCountryName, host.geoRegion].filter(Boolean).join(" ") || null,
  };
}

async function loadResource(kind: FaultBundleKind, id: number) {
  if (kind === "rule") return db.getForwardRuleById(id);
  if (kind === "tunnel") return db.getTunnelById(id);
  return db.getForwardGroupById(id);
}

const AUDIT_RESOURCE_TYPE: Record<FaultBundleKind, string> = { rule: "forward_rule", tunnel: "tunnel", forwardGroup: "forward_group" };

export async function buildFaultBundle(ctx: Ctx, subject: { kind: FaultBundleKind; id: number }) {
  const isAdmin = ctx.user.role === "admin";
  // 权限检查在这里面（和「诊断」按钮同一套）：没权限直接抛错，不往下取任何东西。
  const panel = await buildPanelOnlyDiagnostics(ctx, subject);
  const resource = await loadResource(subject.kind, subject.id) as any;

  const hosts = await section(async () => {
    const rows = await db.getHostsByIds(panel.hostIds) as any[];
    return rows.map((host) => hostSnapshot(host, isAdmin || Number(host.userId) === Number(ctx.user.id)));
  });

  const probes = await section(async () => {
    const since = new Date(Date.now() - PROBE_WINDOW_MS);
    if (subject.kind === "rule") return db.getTcpingProbeStatisticsByRule(subject.id, since);
    if (subject.kind === "tunnel") return db.getProbeCounterStatistics("tunnel", subject.id, since);
    if (String(resource?.groupMode || "") !== "chain") return { message: "只有转发链有链路探测统计" };
    return db.getProbeCounterStatistics("forwardGroup", subject.id, since);
  });

  const latestTest = subject.kind === "rule"
    ? await section(async () => (await db.getLatestForwardTest(subject.id, { includeActive: true })) ?? { message: "这条规则还没有自测过" })
    : undefined;

  // 组事件（成员切换、健康变化）在网页上也只给管理员看。
  const groupEvents = subject.kind === "forwardGroup" && isAdmin
    ? await section(async () => (await db.getForwardGroupEvents(subject.id, 30)) as any[])
    : undefined;

  const events = isAdmin
    ? await section(async () => {
      const sinceSeconds = Math.floor(Date.now() / 1000) - EVENT_WINDOW_SECONDS;
      const lists = await Promise.all(panel.hostIds.slice(0, 10).map((hostId) => listPanelEvents({ sinceSeconds, hostId, limit: 50 })));
      return lists.flat().sort((a: any, b: any) => Number(b.id) - Number(a.id)).slice(0, 100);
    })
    : undefined;

  const configHistory = isAdmin
    ? await section(async () => {
      const recent = await listRecentConfigAuditEvents(2000);
      return (recent as any[])
        .filter((event) => event.resourceType === AUDIT_RESOURCE_TYPE[subject.kind] && Number(event.resourceId) === subject.id)
        .slice(0, 20)
        .map(redactConfigAuditEventForSupport);
    })
    : undefined;

  return redactSupportValue({
    kind: "nex.fault-bundle",
    version: 1,
    generatedAt: new Date().toISOString(),
    panelVersion: APP_VERSION,
    subject: { kind: subject.kind, id: subject.id, name: panel.name },
    howToRead: "panelChecks 是面板侧的诊断结论（status: pass / warn / fail / skip）；需要主机实测的项没有跑，要实测请在面板上点「诊断」。hosts 是沿线主机此刻的状态。",
    panelChecks: panel.report,
    pendingAgentChecks: panel.pendingAgentChecks,
    resource,
    hosts,
    probes,
    ...(latestTest !== undefined ? { latestTest } : {}),
    ...(groupEvents !== undefined ? { groupEvents } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(configHistory !== undefined ? { configHistory } : {}),
  });
}

export function faultBundleFilename(subject: { kind: FaultBundleKind; id: number }, now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `nex-fault-${subject.kind}-${subject.id}-${stamp}.json`;
}
