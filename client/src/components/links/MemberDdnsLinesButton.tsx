import { useState } from "react";
import { RadioTower } from "lucide-react";
import { MAX_MEMBER_DDNS_LINES, ddnsLineKey, type DdnsLineRef } from "@shared/ddnsLines";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** 组编辑框拿到的「能不能分线路、有哪些线路」（trpc.forwardGroups.ddnsLines）。 */
export type DdnsLineOptions = {
  /** 还在读、读失败、服务商不支持时为 false；按钮置灰，悬停看 reason。 */
  available: boolean;
  reason: string | null;
  /** 线路带着所属服务商（DNSPod 不带）；别家的线路即使 ID 一样也不是同一条。 */
  lines: DdnsLineRef[];
  defaultLine: DdnsLineRef | null;
};

function sameLine(a: DdnsLineRef, b: DdnsLineRef | null) {
  if (!b) return false;
  return a.id && b.id ? ddnsLineKey(a) === ddnsLineKey(b) : a.name === b.name;
}

/** 「电信、联通」/「只在默认线路」。 */
export function describeMemberDdnsLines(value: DdnsLineRef[] | null | undefined) {
  return value && value.length > 0 ? value.map((line) => line.name).join("、") : "只在默认线路";
}

/**
 * 成员的「运营商线路」（分线路解析，shared/ddnsLines.ts）。
 *
 * 行里只占一个图标：没分线路是灰的（和以前一样只在默认线路），分了是主色，悬停看分到哪几条。
 * 点开是一个小对话框，勾这个成员要出现在哪些线路的解析里。服务商不支持线路时按钮置灰、悬停说原因。
 */
export function MemberDdnsLinesButton({ value, onChange, memberLabel, options }: {
  value: DdnsLineRef[] | undefined;
  onChange: (value: DdnsLineRef[]) => void;
  memberLabel: string;
  options: DdnsLineOptions;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DdnsLineRef[]>([]);
  const current = value || [];
  const active = current.length > 0;
  const summary = describeMemberDdnsLines(current);
  // 服务商那边已经没有的线路（换了服务商、套餐或域名）也列出来，让人能取消勾选。
  const knownKeys = new Set(options.lines.map((line) => ddnsLineKey(line)));
  const listed = [...options.lines, ...current.filter((line) => !knownKeys.has(ddnsLineKey(line)))];

  const toggle = (line: DdnsLineRef, checked: boolean) => {
    const key = ddnsLineKey(line);
    setDraft((items) => (checked
      ? items.some((item) => ddnsLineKey(item) === key) ? items : [...items, line]
      : items.filter((item) => ddnsLineKey(item) !== key)));
  };

  const title = !options.available
    ? options.reason || "暂时不能按运营商线路解析"
    : active ? `解析到这些线路：${summary}` : "只在默认线路（点开给这个成员分配运营商线路）";

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", active ? "text-primary" : "text-muted-foreground")}
        aria-label={`${memberLabel} 的运营商线路：${summary}`}
        title={title}
        disabled={!options.available}
        onClick={() => {
          setDraft(current.map((line) => ({ ...line })));
          setOpen(true);
        }}
      >
        <RadioTower className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>运营商线路 · {memberLabel}</DialogTitle>
            <DialogDescription>
              勾上的线路会解析到这个成员，例如只勾「电信」，就只有电信用户拿到它的地址。一条都不勾 = 和以前一样只在默认线路。
              勾了别的线路又想让其余用户也能用到它，就把「默认」也勾上。
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[50svh] grid-cols-2 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-3">
            {listed.map((line) => {
              const key = ddnsLineKey(line);
              const checked = draft.some((item) => ddnsLineKey(item) === key);
              const isDefault = sameLine(line, options.defaultLine);
              const stale = !knownKeys.has(key);
              const full = !checked && draft.length >= MAX_MEMBER_DDNS_LINES;
              return (
                <label
                  key={key}
                  className={cn(
                    "flex min-h-9 items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                    checked ? "border-primary/50 bg-primary/5" : "border-border/60",
                    full && "opacity-50",
                  )}
                  title={stale ? "DNS 服务商现在的线路列表里没有这条（可能换了服务商、套餐或域名），建议取消勾选" : isDefault ? "组原来那条记录所在的线路" : undefined}
                >
                  <Checkbox checked={checked} disabled={full} onCheckedChange={(next) => toggle(line, next)} aria-label={line.name} />
                  <span className="min-w-0 truncate">
                    {line.name}
                    {isDefault ? <span className="ml-1 text-meta text-muted-foreground">（默认）</span> : null}
                    {stale ? <span className="ml-1 text-meta text-destructive">（已不可用）</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
          {listed.length === 0 ? <p className="text-sm text-muted-foreground">没有读到可选的线路。</p> : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => { onChange([]); setOpen(false); }}>只在默认线路</Button>
            <Button type="button" onClick={() => { onChange(draft); setOpen(false); }}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
