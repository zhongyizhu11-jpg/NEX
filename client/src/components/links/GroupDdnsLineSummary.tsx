import { DDNS_LINE_SOURCE_LABELS, parseDdnsLineState, type DdnsLineStateEntry } from "@shared/ddnsLines";
import { cn } from "@/lib/utils";

/*
  组的分线路解析现在是什么样（组上的 ddnsLineState，服务端每轮同步后写）：每条非默认线路此刻
  解析到哪个成员、哪些地址，以及是线路成员自己、回落到默认线路，还是在保留上一次的记录。
  默认线路还是看原来的 lastDdnsValue。
*/

type SummaryMember = { id?: unknown };

type Props = {
  group: { ddnsLineState?: unknown; members?: SummaryMember[] | null; lastDdnsValue?: unknown };
  memberLabel: (member: SummaryMember) => string;
  /** 表格里一行字；编辑框里是逐条线路的列表。 */
  compact?: boolean;
  className?: string;
};

function entriesOf(group: Props["group"]): DdnsLineStateEntry[] {
  const state = parseDdnsLineState(group.ddnsLineState);
  return state ? Object.values(state.lines) : [];
}

function targetText(entry: DdnsLineStateEntry, group: Props["group"], memberLabel: Props["memberLabel"]) {
  const labels = entry.memberIds
    .map((id) => (group.members || []).find((member) => Number(member.id) === id))
    .filter((member): member is SummaryMember => !!member)
    .map((member) => memberLabel(member));
  return labels.length > 0 ? labels.join("、") : entry.values.join("、");
}

export function groupHasDdnsLineSummary(group: Props["group"]) {
  return entriesOf(group).length > 0;
}

export function GroupDdnsLineSummary({ group, memberLabel, compact, className }: Props) {
  const entries = entriesOf(group);
  if (entries.length === 0) return null;
  const lines = entries.map((entry) => ({
    entry,
    target: targetText(entry, group, memberLabel),
    note: entry.source === "members" ? "" : DDNS_LINE_SOURCE_LABELS[entry.source],
  }));
  const defaultValue = String(group.lastDdnsValue || "").trim();
  const fullText = [
    `默认 → ${defaultValue || "未解析"}`,
    ...lines.map(({ entry, target, note }) => `${entry.name} → ${target}（${entry.values.join(", ")}）${note ? `：${note}` : ""}`),
  ].join("\n");

  if (compact) {
    return (
      <div className={cn("line-clamp-1 text-meta text-muted-foreground", className)} title={fullText}>
        分线路：{lines.map(({ entry, target, note }) => (
          <span key={entry.id} className={cn("mr-2", note && "text-[var(--fx-warn)]")}>{entry.name} → {target}</span>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5 rounded-md border border-border/60 p-3", className)}>
      <div className="text-sm font-medium">当前各线路解析</div>
      <div className="grid gap-1 text-xs">
        <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
          <span className="text-muted-foreground">默认</span>
          <span className="truncate" title={defaultValue}>{defaultValue || "未解析"}</span>
        </div>
        {lines.map(({ entry, target, note }) => (
          <div key={entry.id} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <span className="truncate text-muted-foreground" title={entry.name}>{entry.name}</span>
            <span className="min-w-0">
              <span className="block truncate" title={entry.values.join(", ")}>{target}<span className="ml-1 text-muted-foreground">{entry.values.join(", ")}</span></span>
              {note ? <span className="block text-[var(--fx-warn)]">{note}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
