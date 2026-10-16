import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { formatMoneyCents as money } from "@shared/formatMoney";

/**
 * 用户详情里的「邀请」一块：谁邀请了他、他邀请了几个人、拿过多少返利。
 *
 * 用户自己改不了邀请人；管理员可以在这里改或清掉（服务端会拦住「设成自己」和循环邀请）。
 */
export default function AdminUserReferralPanel({ userId }: { userId: number }) {
  const utils = trpc.useUtils();
  const infoQuery = trpc.referral.adminUserInfo.useQuery({ userId }, { staleTime: 10_000 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const setInviter = trpc.referral.adminSetInviter.useMutation({
    onSuccess: async (_data, variables) => {
      toast.success(variables.inviterUsername ? "邀请人已更新" : "邀请人已清除");
      setEditing(false);
      await utils.referral.adminUserInfo.invalidate();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const info = infoQuery.data;
  const inviterText = info?.inviter
    ? (info.inviter.name && info.inviter.name !== info.inviter.username ? `${info.inviter.name}（${info.inviter.username}）` : info.inviter.username)
    : info?.inviterId ? `#${info.inviterId}（已删除）` : "无";

  return (
    <div className="rounded-md bg-muted/25 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-muted-foreground">邀请人</span>
        <span className="min-w-0 truncate text-right font-medium">{infoQuery.isLoading ? "加载中" : inviterText}</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="shrink-0 text-muted-foreground">已邀请 / 累计返利</span>
        <span className="min-w-0 truncate text-right tabular-nums">
          {info ? `${info.invitedCount} 人 · ${money(info.totalCommissionCents)}` : "-"}
        </span>
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border/40 pt-2 sm:flex-row">
          <Input
            aria-label="邀请人用户名"
            placeholder="邀请人用户名，留空表示清除"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex shrink-0 gap-2">
            <Button size="sm" className="h-8" disabled={setInviter.isPending} onClick={() => setInviter.mutate({ userId, inviterUsername: draft.trim() })}>
              保存
            </Button>
            <Button size="sm" variant="outline" className="h-8" disabled={setInviter.isPending} onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex justify-end border-t border-border/40 pt-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={!info}
            onClick={() => {
              setDraft(info?.inviter?.username || "");
              setEditing(true);
            }}
          >
            修改邀请人
          </Button>
        </div>
      )}
    </div>
  );
}
