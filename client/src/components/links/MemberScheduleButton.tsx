import { useState } from "react";
import { Clock, Plus, Trash2 } from "lucide-react";
import {
  describeMemberSchedule,
  MAX_MEMBER_SCHEDULE_WINDOWS,
  MEMBER_SCHEDULE_DEFAULT_TIMEZONE,
  parseMemberSchedule,
  type MemberActiveSchedule,
  type MemberScheduleWindow,
} from "@shared/memberSchedule";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const WEEKDAYS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
];

const EMPTY_WINDOW: MemberScheduleWindow = { days: [], from: "20:00", to: "02:00" };

/**
 * 成员的「可用时段」（线路按时间段启用，shared/memberSchedule.ts）。
 *
 * 行里只占一个时钟图标：没设时段是灰的，设了是主色，悬停看「每天 20:00-02:00」。
 * 点开是一个小对话框：几段时段，每段选星期（不选 = 每天）和起止时间，结束早于开始就是跨午夜。
 */
export function MemberScheduleButton({ value, onChange, memberLabel }: {
  value: MemberActiveSchedule | null;
  onChange: (value: MemberActiveSchedule | null) => void;
  memberLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [windows, setWindows] = useState<MemberScheduleWindow[]>([]);
  const [error, setError] = useState("");
  const active = !!value && value.windows.length > 0;
  const summary = describeMemberSchedule(value);

  const openEditor = () => {
    setWindows(value?.windows.length ? value.windows.map((window) => ({ ...window, days: [...window.days] })) : [{ ...EMPTY_WINDOW }]);
    setError("");
    setOpen(true);
  };
  const updateWindow = (index: number, patch: Partial<MemberScheduleWindow>) => {
    setWindows((current) => current.map((window, i) => (i === index ? { ...window, ...patch } : window)));
  };
  const toggleDay = (index: number, day: number) => {
    setWindows((current) => current.map((window, i) => {
      if (i !== index) return window;
      const days = window.days.includes(day) ? window.days.filter((item) => item !== day) : [...window.days, day];
      return { ...window, days };
    }));
  };
  const save = () => {
    const parsed = parseMemberSchedule({ timezone: value?.timezone || MEMBER_SCHEDULE_DEFAULT_TIMEZONE, windows });
    if (!parsed || parsed.windows.length !== windows.length) {
      setError("时间要写成 HH:MM，开始和结束不能相同");
      return;
    }
    onChange(parsed);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", active ? "text-primary" : "text-muted-foreground")}
        aria-label={`${memberLabel} 的可用时段：${summary}`}
        title={active ? `只在这些时段可用：${summary}` : "不限时段（点开设置只在某些时段使用这条线路）"}
        onClick={openEditor}
      >
        <Clock className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>可用时段 · {memberLabel}</DialogTitle>
            <DialogDescription>
              只在这些时段使用这条线路，时段外它不参与转发（连备用都不当），到点自动恢复。按北京时间；结束早于开始表示跨午夜。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {windows.map((window, index) => (
              <div key={index} className="space-y-2 rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <Input type="time" value={window.from} onChange={(event) => updateWindow(index, { from: event.target.value })} className="h-8 w-[7.5rem]" aria-label="开始时间" />
                  <span className="text-sm text-muted-foreground">到</span>
                  <Input type="time" value={window.to} onChange={(event) => updateWindow(index, { to: event.target.value })} className="h-8 w-[7.5rem]" aria-label="结束时间" />
                  <Button type="button" variant="ghost" size="icon" className="ml-auto h-8 w-8 text-muted-foreground" aria-label="删除这一段" onClick={() => setWindows((current) => current.filter((_, i) => i !== index))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="星期（不选 = 每天）">
                  {WEEKDAYS.map((day) => {
                    const selected = window.days.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleDay(index, day.value)}
                        className={cn(
                          "h-7 w-7 rounded-full border text-xs transition-colors",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                  <span className="ml-1 text-meta text-muted-foreground">{window.days.length === 0 ? "每天" : ""}</span>
                </div>
              </div>
            ))}
            {windows.length < MAX_MEMBER_SCHEDULE_WINDOWS ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setWindows((current) => [...current, { ...EMPTY_WINDOW }])}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />加一段
              </Button>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => { onChange(null); setOpen(false); }}>不限时段</Button>
            <Button type="button" onClick={save} disabled={windows.length === 0}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
