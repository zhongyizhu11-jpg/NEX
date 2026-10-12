import { LogOut, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { relativeTimeLabel } from "./timeLabel";

/**
 * 个人资料 › 已登录设备（#13）。
 *
 * 列出这个账号所有还有效的登录（浏览器、NEX App、Telegram 里打开的面板），能逐个退出，
 * 或者一键退出除当前这台以外的全部 —— 手机丢了、在网吧登过，点一下就干净了。
 */
export default function SessionsSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const listQuery = trpc.ops.sessions.list.useQuery(undefined, { refetchInterval: pollingInterval("slow") });
  const revokeMutation = trpc.ops.sessions.revoke.useMutation();
  const revokeOthersMutation = trpc.ops.sessions.revokeOthers.useMutation();
  const items = listQuery.data ?? [];
  const others = items.filter((item) => !item.current);

  const handleRevoke = async (item: (typeof items)[number]) => {
    const ok = await confirm({
      title: "退出这台设备",
      description: `「${item.device}」会立刻退出登录，下次要重新输入密码。`,
      confirmText: "退出",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await revokeMutation.mutateAsync({ sid: item.sid });
      await utils.ops.sessions.list.invalidate();
      toast.success("已退出这台设备");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退出失败");
    }
  };

  const handleRevokeOthers = async () => {
    const ok = await confirm({
      title: "退出其他所有设备",
      description: `除了你现在用的这台，其余 ${others.length} 台设备都会立刻退出登录。`,
      confirmText: "全部退出",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      const result = await revokeOthersMutation.mutateAsync();
      await utils.ops.sessions.list.invalidate();
      toast.success(result.revoked > 0 ? `已退出 ${result.revoked} 台设备` : "没有其他设备");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退出失败");
    }
  };

  return (
    <Card className="border-border/50 bg-card/70">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone className="h-4 w-4 text-primary" />
            已登录设备
          </CardTitle>
          <CardDescription>这个账号现在在哪些地方登录着。不认识的设备直接退出，再改一次密码。</CardDescription>
        </div>
        {others.length > 0 ? (
          <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={handleRevokeOthers} disabled={revokeOthersMutation.isPending}>
            <LogOut className="h-4 w-4" />
            退出其他所有设备
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {listQuery.isLoading ? (
          <DataSectionLoading label="正在加载登录设备" minHeight="min-h-[96px]" />
        ) : listQuery.error ? (
          <DataSectionError label="登录设备" error={listQuery.error} onRetry={() => listQuery.refetch()} retrying={listQuery.isFetching} minHeight="min-h-[96px]" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有读到登录记录。</p>
        ) : (
          <SettingList>
            {items.map((item) => (
              <SettingRow
                key={item.sid}
                label={(
                  <span className="flex flex-wrap items-center gap-2">
                    {item.device}
                    {item.current ? <Badge variant="secondary">当前设备</Badge> : null}
                  </span>
                )}
                description={[
                  item.ip || "IP 未知",
                  item.current ? "正在使用" : `最近活动 ${relativeTimeLabel(item.lastSeenAt, "未知")}`,
                  `登录于 ${relativeTimeLabel(item.createdAt, "未知")}`,
                ].join(" · ")}
                control={item.current ? null : (
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => handleRevoke(item)} disabled={revokeMutation.isPending}>
                    退出
                  </Button>
                )}
              />
            ))}
          </SettingList>
        )}
      </CardContent>
    </Card>
  );
}
