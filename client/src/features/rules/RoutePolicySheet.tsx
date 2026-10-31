import { useRef, useState, type ReactNode } from "react";

import { EntityTag } from "@/components/entity/EntityCard";
import { GroupedList, ListRow, ListSection } from "@/components/ios/GroupedList";
import { StatusDot } from "@/components/network/StatusDot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { describeRoutePolicyReport, type RoutePolicy, type RoutePolicyCondition } from "@shared/routePolicy";
import type { NetworkHealth } from "@shared/networkHealth";

/*
  主备策略面板：从规则卡上那个「主备 · 备用 1」点进来；转发组卡片上的「解析 · HK entry 01」
  点进来的也是它 —— 两套机器（Agent 切出站、面板切解析），一种说法。

  回答四件事，从上往下：
    现在走哪条 / 解析到哪个成员（以及这句话能信到什么程度）
    有哪几条（哪条是按规矩的首选，哪条在走）
    按什么选 —— 一层一行，此刻起作用的那一行高亮
    什么时候切
  最后是转发组手动那一块：「换一个首选 / 现在重新选」。规则（线路组）的手动切换在线路详情每条线路的状态
  胶囊上（2.3.499 起这里和线路详情的「异常明细」都不再有「强制走一条」）。

  判断全在 shared/routePolicy，这里只管画。面板底是页面灰、里面是白块（iOS 设置页那种
  分组列表）：对话框本身是一块白，白块放在白底上就看不出分组了，所以这一个对话框把
  自己当成 L0 —— 仍然是「底灰、面白」那一次底色差，没有新添一种灰。
*/

const reportHealth: Record<ReturnType<typeof describeRoutePolicyReport>["tone"], NetworkHealth> = {
  normal: "healthy",
  deviated: "degraded",
  warn: "down",
  muted: "unknown",
};

/** 选择用的小块：选中是整块反白，和主机分组、分段控件同一套 —— 选择不是状态，不染状态色。 */
export function choiceClass(active: boolean) {
  return cn(
    "inline-flex h-9 min-w-0 items-center justify-center rounded-[var(--fx-radius-control)] px-3 text-sm transition-colors",
    active
      ? "bg-[var(--fx-text)] font-semibold text-[var(--fx-text-inverse)]"
      : "border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)] text-muted-foreground hover:text-foreground",
  );
}

export function ConditionRow({ condition }: { condition: RoutePolicyCondition }) {
  const deciding = condition.state === "deciding";
  return (
    <div
      className="fx-list-row relative flex w-full min-w-0 items-start gap-3 px-4 py-3"
      data-state={condition.state}
    >
      {/*
        高亮只用一根竖条 + 字重 + 「此刻」标记，不整行染色：整行染色在白块里就是
        又一块面，而「这一行在起作用」本来一根线就说得清。
      */}
      {deciding ? (
        <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-[var(--fx-path)]" />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-secondary-type", deciding ? "font-semibold text-foreground" : "text-foreground")}>
          {condition.when}
        </span>
        <span className={cn("text-meta", deciding ? "text-foreground" : "text-muted-foreground")}>{condition.then}</span>
        {condition.state === "overridden" ? (
          <span className="text-meta text-[var(--fx-warn-text)]">此刻本该轮到它，被上面那条压着</span>
        ) : null}
      </span>
      {deciding ? <EntityTag tone="path">此刻</EntityTag> : null}
    </div>
  );
}

/**
 * 整句话的一行：「什么时候切」、转发组的「现在按顺序重新选」。ListRow 的说明只给一行，
 * 转发组这几句在手机上会被截成「…」—— 规矩恰恰在后半句（「Agent 已判定失败的不等」）。
 */
export function SentenceRow({ label, detail, trailing }: { label: string; detail: string; trailing?: ReactNode }) {
  return (
    <div className="fx-list-row flex w-full min-w-0 items-center gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-secondary-type text-foreground">{label}</span>
        <span className="text-meta text-muted-foreground">{detail}</span>
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  );
}

export type RoutePolicyPanelProps = {
  policy: RoutePolicy;
  /** 能不能动手（转发组：换首选 / 重新选）。 */
  canEdit: boolean;
  pending?: boolean;
  /** 转发组：把这个成员挪到第一位（改成员顺序，一直有效）。 */
  onPrefer?: (index: number) => void;
  /** 转发组：不等观察时间，按顺序重选一次、重写一次解析。 */
  onReselect?: () => void;
  nowMs?: number;
  timeZone?: string;
};

const activeTagText: Partial<Record<RoutePolicy["report"]["kind"], string>> = {
  // 老 Agent 的记录是「最近一次切到哪条」，不能说成「在走」。
  lastSwitch: "最近切到",
  current: "在走",
  resolved: "在用",
  // 系统 DDNS 没开：面板挑出来了，但解析没改 —— 只是建议。
  suggested: "建议",
};

export function RoutePolicyPanel({ policy, canEdit, pending = false, onPrefer, onReselect, nowMs, timeZone }: RoutePolicyPanelProps) {
  const now = nowMs ?? Date.now();
  const report = describeRoutePolicyReport(policy, { nowMs: now, timeZone });
  const group = policy.subject === "group";
  const [picking, setPicking] = useState(false);
  const [pickIndex, setPickIndex] = useState<number | null>(null);
  const knowsActive = policy.lines.some((line) => line.active);
  const activeTag = activeTagText[policy.report.kind] || "在走";
  // 换首选只在启用的成员里挑，而且不列已经排在最前的那个。不看健康点：组停用时成员全是「待命」，顺序照样能改。
  const preferChoices = policy.lines.filter((line) => line.enabled !== false && !line.preferred);
  const closePicker = () => { setPicking(false); setPickIndex(null); };

  return (
    <div className="flex min-w-0 flex-col gap-[var(--fx-space-5)]">
      <div className="flex items-start gap-2.5 px-1">
        <StatusDot health={reportHealth[report.tone]} className="mt-1.5" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-secondary-type font-semibold text-foreground">{report.text}</p>
          {policy.divergence ? <p className="text-meta text-[var(--fx-warn-text)]">{policy.divergence}</p> : null}
          {report.note ? <p className="text-meta text-muted-foreground">{report.note}</p> : null}
        </div>
      </div>

      {policy.warnings.map((warning) => (
        <p key={warning} className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-meta text-[var(--fx-warn-text)]">
          {warning}
        </p>
      ))}

      <GroupedList>
        <ListSection header={group ? "成员" : "线路"}>
          {policy.lines.map((line) => (
            <ListRow
              key={line.index}
              /*
                转发组的成员有自己的健康（面板每轮检查写回来的）；规则的出站没有 —— 那是 Agent
                在本地探的，这里只知道在走哪条。
              */
              icon={<StatusDot health={line.health ?? (!knowsActive ? "unknown" : line.active ? "healthy" : "standby")} />}
              label={line.label}
              detail={(
                <>
                  {line.endpoint ? <span className="font-mono">{line.endpoint}</span> : null}
                  {line.endpoint && line.note ? " · " : null}
                  {line.note}
                </>
              )}
              trailing={line.active || line.preferred ? (
                <span className="flex items-center gap-1.5">
                  {line.preferred ? <EntityTag>首选</EntityTag> : null}
                  {line.active ? <EntityTag tone="path">{activeTag}</EntityTag> : null}
                </span>
              ) : undefined}
            />
          ))}
        </ListSection>

        <ListSection
          header="按什么选"
          footer={group
            ? "排在最前、而且健康的成员拿到解析；它不健康了就往下找。"
            : policy.mode !== "weighted"
              ? "从上往下，先对上的那一条说了算。它指的那条挂了，照样往下找。"
              : undefined}
        >
          {policy.conditions.map((condition) => <ConditionRow key={condition.key} condition={condition} />)}
        </ListSection>

        <ListSection header="什么时候切">
          {policy.guards.map((guard) => (
            <SentenceRow key={guard.key} label={guard.label} detail={guard.value} />
          ))}
        </ListSection>

        {group && canEdit && (onPrefer || onReselect) ? (
          <ListSection
            header="手动"
            footer="换首选改的是成员顺序，一直有效，编辑框里的顺序也跟着变。重新选不改顺序，只是不等观察时间。"
          >
            {onReselect && policy.deciding === "order" ? (
              <SentenceRow
                label="现在按顺序重新选"
                detail="不等观察时间，直接换到排在最前的健康成员，并重写一次解析"
                trailing={(
                  <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onReselect}>
                    重新选
                  </Button>
                )}
              />
            ) : null}
            {onPrefer && preferChoices.length > 0 ? (
              !picking ? (
                <ListRow label="换一个首选" detail="把一个成员挪到第一位" onSelect={() => setPicking(true)} />
              ) : (
                <div className="fx-list-row flex flex-col gap-3 px-4 py-3" data-testid="prefer-picker">
                  <div className="flex flex-wrap gap-2" role="group" aria-label="把哪个成员挪到第一位">
                    {preferChoices.map((line) => (
                      <button
                        key={line.index}
                        type="button"
                        aria-pressed={pickIndex === line.index}
                        className={choiceClass(pickIndex === line.index)}
                        onClick={() => setPickIndex(line.index)}
                      >
                        {line.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={closePicker}>
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={pickIndex === null || pending}
                      onClick={() => {
                        if (pickIndex === null) return;
                        onPrefer(pickIndex);
                        closePicker();
                      }}
                    >
                      {pickIndex === null ? "设为首选" : `把 ${policy.lines[pickIndex]?.label} 设为首选`}
                    </Button>
                  </div>
                </div>
              )
            ) : null}
          </ListSection>
        ) : null}
      </GroupedList>
    </div>
  );
}

export function RoutePolicySheet({
  open,
  onOpenChange,
  subjectName,
  onEdit,
  policy,
  ...panel
}: Omit<RoutePolicyPanelProps, "policy"> & {
  policy: RoutePolicy | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 规则名或转发组名，标题下面那一行。 */
  subjectName: string;
  onEdit?: () => void;
}) {
  /*
    关的那一下（130ms 的动画）调用方已经把规则清掉了，拿上一份接着画 —— 不然面板在
    动画里先塌成只剩标题再消失。上一次没点完的「换首选」选择不会留着：面板在动画结束
    后整个卸掉，下次打开是新的。
  */
  const last = useRef<{ subjectName: string; policy: RoutePolicy } | null>(null);
  if (open && policy) last.current = { subjectName, policy };
  const shown = last.current;
  const group = shown?.policy.subject === "group";
  return (
    <Dialog open={open && !!policy} onOpenChange={onOpenChange}>
      {shown ? (
        <DialogContent className="bg-[var(--fx-l0-page)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{group ? "故障转移策略" : "主备策略"}</DialogTitle>
            <DialogDescription className="truncate">{shown.subjectName}</DialogDescription>
          </DialogHeader>
          <RoutePolicyPanel {...panel} policy={shown.policy} />
          <DialogFooter>
            {onEdit ? (
              <Button type="button" variant="outline" onClick={onEdit}>
                {group ? "编辑转发组" : "编辑主备设置"}
              </Button>
            ) : null}
            <Button type="button" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
