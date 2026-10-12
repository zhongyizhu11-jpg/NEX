import { StatusDot } from "@/components/network/StatusDot";
import { cn } from "@/lib/utils";
import { eventRelativeTime, isRecoveryEventKind } from "@shared/opsEvents";
import type { NetworkHealth } from "@shared/networkHealth";

/*
  事件时间线的一行：状态点 + 一句话 + 时间和所属主机 / 用户。
  监控 › 事件、首页「最近动态」、主机详情「最近动态」三处共用，三处长得一样，人认得出是同一种东西。

  一句话不截断（那是事件本身），手机上折行；主机 / 用户做成小标签跟在时间后面。
*/

export type OpsEventItem = {
  id: number;
  kind: string;
  level: "info" | "warn" | "crit";
  message: string;
  hostId: number | null;
  hostName: string | null;
  userId: number | null;
  userName: string | null;
  createdAt: Date | string | number;
};

/** 严重 = 红，警告 = 橙，恢复 = 绿，其余普通消息 = 灰。和全站状态点同一套颜色。 */
export function eventHealth(event: Pick<OpsEventItem, "kind" | "level">): NetworkHealth {
  if (event.level === "crit") return "down";
  if (event.level === "warn") return "degraded";
  return isRecoveryEventKind(event.kind) ? "healthy" : "standby";
}

const LEVEL_LABEL: Record<OpsEventItem["level"], string> = { info: "消息", warn: "警告", crit: "严重" };

function Chip({ children, onClick, title }: { children: string; onClick?: () => void; title?: string }) {
  const className = "inline-flex max-w-[11rem] items-center truncate rounded-full bg-[var(--fx-l3-control-fill)] px-2 py-0.5 text-meta text-muted-foreground";
  if (!onClick) return <span className={className} title={title}>{children}</span>;
  return (
    <button type="button" onClick={onClick} title={title} style={{ minHeight: 0 }} className={cn(className, "transition-colors hover:text-foreground")}>
      {children}
    </button>
  );
}

export function EventRow({
  event,
  now,
  showHost = true,
  showUser = true,
  onHostClick,
  className,
}: {
  event: OpsEventItem;
  now: number;
  showHost?: boolean;
  showUser?: boolean;
  /** 点主机标签：在时间线里就是「只看这台」。不给就不可点。 */
  onHostClick?: (hostId: number) => void;
  className?: string;
}) {
  const at = new Date(event.createdAt);
  const hostLabel = event.hostId ? event.hostName || `主机 #${event.hostId}` : null;
  const userLabel = event.userId ? event.userName || `用户 #${event.userId}` : null;
  return (
    <div className={cn("fx-list-row flex min-w-0 items-start gap-3 px-4 py-3", className)}>
      <span className="flex h-5 shrink-0 items-center">
        <StatusDot health={eventHealth(event)} label={LEVEL_LABEL[event.level]} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-words text-secondary-type text-foreground">{event.message}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <time
            className="text-meta tabular-nums text-muted-foreground"
            dateTime={Number.isFinite(at.getTime()) ? at.toISOString() : undefined}
            title={Number.isFinite(at.getTime()) ? at.toLocaleString("zh-CN") : undefined}
          >
            {eventRelativeTime(at, now)}
          </time>
          {showHost && hostLabel ? (
            <Chip
              title={onHostClick ? `只看 ${hostLabel}` : hostLabel}
              onClick={onHostClick && event.hostId ? () => onHostClick(event.hostId!) : undefined}
            >
              {hostLabel}
            </Chip>
          ) : null}
          {showUser && userLabel ? <Chip title={userLabel}>{userLabel}</Chip> : null}
        </span>
      </span>
    </div>
  );
}
