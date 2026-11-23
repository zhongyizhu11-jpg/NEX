import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type HostLike = {
  isOnline?: boolean | null;
};

function HostStatusDot({ host, className }: { host?: HostLike | null; className?: string }) {
  const online = !!host?.isOnline;
  return (
    <span
      className={cn(
        "h-2.5 w-2.5 shrink-0 rounded-full",
        online
          ? "bg-[var(--fx-healthy)] shadow-[0_0_0_3px_var(--fx-healthy-soft)]"
          : "bg-[var(--fx-down)] shadow-[0_0_0_3px_var(--fx-down-soft)]",
        className,
      )}
      aria-hidden="true"
    />
  );
}

export default function HostStatusLabel({
  host,
  label,
  className,
  labelClassName,
}: {
  host?: HostLike | null;
  label: ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <HostStatusDot host={host} />
      <span className={cn("min-w-0 truncate", labelClassName)}>{label}</span>
    </span>
  );
}
