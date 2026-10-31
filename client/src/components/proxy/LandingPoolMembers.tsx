import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/*
  落地池那一行（2.3.500）：订阅里整个池就一条，「我的节点」里也只占一行；点「3 台」展开看每台开在哪个
  端口（换了端口的、没开出来的标出来）。改要到节点池里改。
*/

export type LandingPoolMemberLine = { hostId: number; name: string; port: number; portFallback: boolean; error: string | null };

export function LandingPoolMembersToggle({ ready, total, expanded, onToggle }: { ready: number; total: number; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted", ready < total && "text-[var(--fx-warn-text)]")}
      onClick={onToggle}
      aria-expanded={expanded}
      title="池里每台开在哪个端口"
      data-testid="landing-pool-members-toggle"
    >
      {ready}/{total} 台
      <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
    </button>
  );
}

export function LandingPoolMembersDetail({ members, directDomain, onOpenPool }: { members: LandingPoolMemberLine[]; directDomain: string | null; onOpenPool: () => void }) {
  return (
    <div className="flex flex-col gap-1 text-[12px]" data-testid="landing-pool-members">
      {members.map((member) => (
        <div key={member.hostId} className="flex min-w-0 items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", member.error ? "bg-[var(--fx-down-text)]" : "bg-[var(--fx-healthy-text)]")} aria-hidden="true" />
            <span className="truncate">{member.name}</span>
          </span>
          <span className={cn("shrink-0 font-mono text-[11.5px]", member.error ? "text-[var(--fx-down-text)]" : "text-muted-foreground")} title={member.error || undefined}>
            {member.error ? "没开" : `${member.port}${member.portFallback ? "（换了端口）" : ""}`}
          </span>
        </div>
      ))}
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-3 text-[11.5px] text-muted-foreground">
        <span className="min-w-0 truncate">{directDomain ? `直连 ${directDomain}` : "只走中转"}</span>
        <button type="button" className="shrink-0 text-[var(--fx-accent)] underline-offset-2 hover:underline" onClick={onOpenPool}>到节点池里改</button>
      </div>
    </div>
  );
}
