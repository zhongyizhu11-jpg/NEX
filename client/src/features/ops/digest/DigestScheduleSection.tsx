import { useEffect, useState } from "react";
import { Newspaper } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { DEFAULT_DIGEST_HOUR, DIGEST_BLOCKS, formatDigestHour, type DigestBlockKey } from "@shared/opsDigest";

/*
  设置 › Telegram 底部「每日简报」：几点发（北京时间），管理员那份简报末尾多带哪几块。

  原有内容（主机在线数、规则异常、近 24 小时流量、7 天内到期）不动；这里勾的接在后面，
  默认一块不勾、9 点发，跟以前一样。谁收简报还是在机器人里各自开关（/start → 通知设置）。
*/

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function DigestScheduleSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.digest.get.useQuery(undefined, { staleTime: 30_000 });
  const settings = query.data;
  const [hour, setHour] = useState(DEFAULT_DIGEST_HOUR);
  const [blocks, setBlocks] = useState<DigestBlockKey[]>([]);

  const reset = () => {
    if (!settings) return;
    setHour(settings.hour);
    setBlocks(settings.blocks as DigestBlockKey[]);
  };
  useEffect(reset, [settings]);

  const saveMutation = trpc.ops.digest.save.useMutation({
    onSuccess: (next) => {
      utils.ops.digest.get.setData(undefined, (current) => (current ? { ...current, ...next } : current));
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const sendTestMutation = trpc.ops.digest.sendTest.useMutation({
    onSuccess: (result) => {
      if (result.failed > 0) toast.warning(`已发给 ${result.sent} 位管理员，${result.failed} 位没发出去：${result.failures[0] || ""}`);
      else toast.success(`已发给 ${result.sent} 位管理员，去 Telegram 看看`);
    },
    onError: (error) => toast.error(error.message || "发送失败"),
  });

  const dirty = !!settings && (hour !== settings.hour || !sameList(blocks, settings.blocks));

  const save = (): Promise<boolean> => saveMutation.mutateAsync({ hour, blocks }).then(
    () => {
      toast.success("每日简报设置已保存");
      return true;
    },
    () => false,
  );

  useSaveDockItem({
    id: "ops.digest",
    label: "每日简报",
    dirty,
    pending: saveMutation.isPending,
    save,
    reset,
  });

  // 试发的是保存后的设置：有改动就先存，不然人看到的简报和刚勾的对不上
  const sendNow = async () => {
    if (dirty && !(await save())) return;
    sendTestMutation.mutate();
  };

  const toggleBlock = (key: DigestBlockKey, checked: boolean) => {
    setBlocks((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return DIGEST_BLOCKS.map((block) => block.key).filter((value) => next.has(value));
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Newspaper className="h-4 w-4 text-primary" />
          每日简报
        </CardTitle>
        <CardDescription className="mt-1">
          每天定时发到 Telegram。原有内容照旧，下面勾选的几块只加在管理员那份末尾。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <DataSectionLoading label="正在读取简报设置" minHeight="min-h-[120px]" />
        ) : query.isError || !settings ? (
          <DataSectionError label="简报设置" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
        ) : (
          <>
            <SettingList>
              <SettingRow
                label="发送时间"
                description="北京时间，每天一次。"
                control={(
                  <Select value={String(hour)} onValueChange={(value) => setHour(Number(value))}>
                    <SelectTrigger className="h-8 w-28 tabular-nums" aria-label="发送时间">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {HOURS.map((value) => (
                        <SelectItem key={value} value={String(value)} className="tabular-nums">{formatDigestHour(value)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {DIGEST_BLOCKS.map((block) => (
                <SettingRow
                  key={block.key}
                  asLabel
                  label={block.label}
                  description={block.description}
                  control={(
                    <Checkbox
                      aria-label={block.label}
                      checked={blocks.includes(block.key)}
                      onCheckedChange={(checked) => toggleBlock(block.key, checked)}
                    />
                  )}
                />
              ))}
            </SettingList>
            {!settings.telegramReady ? (
              <p className="text-xs text-muted-foreground">Telegram 机器人还没启用，启用后才会发简报。</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button data-dock-save onClick={() => { void save(); }} disabled={saveMutation.isPending}>
                保存
              </Button>
              <Button
                variant="outline"
                onClick={() => { void sendNow(); }}
                disabled={!settings.telegramReady || sendTestMutation.isPending || saveMutation.isPending}
              >
                {sendTestMutation.isPending ? "发送中…" : "现在发一条试试"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
