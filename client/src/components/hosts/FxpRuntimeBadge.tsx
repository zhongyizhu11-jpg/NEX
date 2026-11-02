import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fxpRuntimeIssueMessage, fxpRuntimeStatus } from "@shared/fxpRuntime";
import { FXP_RUNTIME_VERSION } from "@shared/versions";

/**
 * 主机上 forwardx-fxp 的状态角标。
 *
 * Agent 版本是新的、FXP 却还是旧的（升级时 FXP 没下载成功）的机器，以前在列表里和正常
 * 机器长得一模一样，NEX 隧道却握不上手。这里单独标出来：握不上的标红，只是旧了的标黄，
 * 两种都能一键升级（升级会重新安装 FXP）。
 */

type HostLike = { name?: string | null; agentVersion?: string | null; fxpVersion?: string | null };

export function fxpRuntimeBadgeTitle(host: HostLike | null | undefined) {
  const status = fxpRuntimeStatus(host);
  if (!status.needsUpgrade) return "";
  if (status.wireCompatible === false) return fxpRuntimeIssueMessage(host?.name, host);
  if (status.state === "unreported") return "Agent 没有上报 FXP 版本；升级 Agent 会重新安装 FXP";
  return `FXP ${status.label}，面板随附 ${FXP_RUNTIME_VERSION}；升级 Agent 会一起升级 FXP`;
}

/** 详情里「FXP」那一行。 */
export function fxpRuntimeDetailText(host: HostLike | null | undefined) {
  const status = fxpRuntimeStatus(host);
  const label = /^\d+\.\d+\.\d+$/.test(status.label) ? `v${status.label}` : status.label;
  if (status.wireCompatible === false) return `${label}（过旧，需升级）`;
  if (status.needsUpgrade) return `${label}（可升级）`;
  return label;
}

export function FxpRuntimeBadge({ host, className }: { host: HostLike | null | undefined; className?: string }) {
  const status = fxpRuntimeStatus(host);
  if (!status.needsUpgrade) return null;
  const incompatible = status.wireCompatible === false;
  const text = status.state === "missing" ? "缺 FXP" : incompatible ? "FXP 过旧" : "FXP 可升级";
  return (
    <Badge
      variant="outline"
      title={fxpRuntimeBadgeTitle(host)}
      data-fxp-state={status.state}
      className={cn(
        "shrink-0 px-1.5 py-0 text-[11px]",
        incompatible
          ? "border-destructive/30 text-destructive"
          : "border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] text-[var(--fx-warn-text)]",
        className,
      )}
    >
      {text}
    </Badge>
  );
}
