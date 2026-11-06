import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";

import {
  CONFIG_ACTION_LABELS,
  CONFIG_RESOURCE_LABELS,
  RESULT_TONE,
  auditChannelLabel,
  auditOperationParts,
  auditResultLabel,
  formatAuditDuration,
  formatAuditTime,
  formatDiffValue,
  type AuditListItem,
} from "./auditFormat";

/*
  一条审计的全部内容：谁、何时、从哪儿、调了哪个过程、打过码的参数；
  同一次请求在规则 / 主机 / 隧道 / 转发组上留下的字段差异（配置审计）列在最下面。
*/

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fx-audit-field flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-meta text-muted-foreground sm:w-20">{label}</dt>
      <dd className="min-w-0 break-words text-secondary-type text-foreground">{children}</dd>
    </div>
  );
}

export default function AuditDetailDialog({ item, onOpenChange }: { item: AuditListItem | null; onOpenChange: (open: boolean) => void }) {
  const detailQuery = trpc.ops.audit.detail.useQuery({ id: item?.id ?? 0 }, { enabled: !!item, staleTime: 60_000 });
  // 上半截（谁、何时、从哪儿）先用列表那一行画出来；参数和配置差异只有详情接口带
  const detailEvent = detailQuery.data?.event as AuditListItem | undefined;
  const event = detailEvent ?? item;
  const changes = detailQuery.data?.configChanges ?? [];
  const op = event ? auditOperationParts(event) : null;
  const inputText = detailEvent?.input === null || detailEvent?.input === undefined ? "" : JSON.stringify(detailEvent.input, null, 2);

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="fx-audit-detail max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {op ? <span>{op.module}</span> : null}
            {op ? <code className="fx-audit-code text-secondary-type font-normal text-muted-foreground">{op.procedure}</code> : null}
            {event ? <Badge tone={RESULT_TONE[event.result]} size="sm">{auditResultLabel(event.result)}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{event ? event.path : ""}</DialogDescription>
        </DialogHeader>
        {event ? (
          <div className="flex min-w-0 flex-col gap-5">
            <dl className="flex min-w-0 flex-col gap-2">
              <Field label="时间">{formatAuditTime(event.createdAt)}</Field>
              <Field label="操作人">{event.actorName || (event.actorUserId ? `#${event.actorUserId}` : "—")}{event.actorRole ? `（${event.actorRole === "admin" ? "管理员" : "用户"}）` : ""}</Field>
              <Field label="来源">{auditChannelLabel(event)}</Field>
              <Field label="IP">{event.ip || "—"}</Field>
              {event.userAgent ? <Field label="客户端"><span className="text-meta">{event.userAgent}</span></Field> : null}
              <Field label="耗时">{formatAuditDuration(event.durationMs)}</Field>
              {event.result !== "ok" ? <Field label="原因">{[event.errorCode, event.errorMessage].filter(Boolean).join(" · ") || "—"}</Field> : null}
              <Field label="请求编号"><code className="fx-audit-code text-meta">{event.requestId || "—"}</code></Field>
            </dl>

            {detailQuery.isPending ? (
              <DataSectionLoading label="正在读取参数和配置变更" />
            ) : detailQuery.isError ? (
              <DataSectionError label="审计详情" error={detailQuery.error} onRetry={() => { void detailQuery.refetch(); }} retrying={detailQuery.isFetching} />
            ) : (
              <section className="flex min-w-0 flex-col gap-2">
                <h3 className="text-meta font-medium text-muted-foreground">参数（密码、密钥、令牌已隐藏）</h3>
                {inputText ? (
                  <pre className="fx-audit-json max-h-72 overflow-auto rounded-[var(--fx-radius-control)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l2-group)] p-3 text-meta leading-relaxed">{inputText}</pre>
                ) : (
                  <p className="text-meta text-muted-foreground">这次调用没有参数。</p>
                )}
              </section>
            )}

            {!detailQuery.isPending && !detailQuery.isError && changes.length > 0 ? (
              <section className="flex min-w-0 flex-col gap-2">
                <h3 className="text-meta font-medium text-muted-foreground">改动的配置</h3>
                {changes.map((change) => {
                  const diff = change.diff && typeof change.diff === "object" ? Object.entries(change.diff as Record<string, { before?: unknown; after?: unknown }>) : [];
                  return (
                    <div key={change.id} className="fx-audit-change rounded-[var(--fx-radius-control)] border border-[var(--fx-stroke-weak)] p-3">
                      <div className="mb-2 text-secondary-type font-medium">
                        {CONFIG_ACTION_LABELS[change.action] || change.action} {CONFIG_RESOURCE_LABELS[change.resourceType] || change.resourceType} #{change.resourceId}
                      </div>
                      {diff.length === 0 ? (
                        <p className="text-meta text-muted-foreground">没有字段差异。</p>
                      ) : (
                        <ul className="flex min-w-0 flex-col gap-1">
                          {diff.slice(0, 40).map(([field, value]) => (
                            <li key={field} className="grid min-w-0 grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-2 text-meta">
                              <code className="fx-audit-code truncate text-muted-foreground" title={field}>{field}</code>
                              <span className="min-w-0 break-words">
                                <span className="text-[var(--fx-down-text)] line-through decoration-1">{formatDiffValue(value?.before)}</span>
                                <span className="px-1 text-muted-foreground">→</span>
                                <span className="text-[var(--fx-healthy-text)]">{formatDiffValue(value?.after)}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </section>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
