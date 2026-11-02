import DataSectionLoading from "@/components/DataSectionLoading";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clipboardNeedsManualCopy, copyTextFromElement } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 租户自己加一台机器 —— 加机器只有这一份实现（2.3.506）。
 *
 * 两个入口都开这个框：「主机管理」那一页的「添加主机」，和「订阅管理 → 我的机器」里的「加一台」。
 * 主机管理那边原来的「添加主机」按钮是走 Token 管理那个组件的信号 —— 那是管理员专属的组件，租户那边
 * 根本没挂上，于是按钮点了没反应。两处各写一份表单也不行：加机器的额度、字段、提示语都得一致。
 *
 * 加完不关框，直接换成第二步「Agent 安装命令」：不装 Agent 这台机器什么也干不了。这一步原来只在
 * 「我的机器」里有（MyHostsSection 自己画了一个命令框），从主机管理加的拿不到命令。commandHostId
 * 给了就直接打开第二步（「我的机器」每台机器的「安装命令」）。
 */
export default function AddSelfServiceHostDialog({
  open,
  onOpenChange,
  onCreated,
  commandHostId = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 建好之后调用方自己去刷新它关心的那几个查询。 */
  onCreated?: (hostId: number) => void;
  /** 只看这台机器的安装命令（跳过第一步）。 */
  commandHostId?: number;
}) {
  const [form, setForm] = useState({ name: "", ip: "" });
  const [createdHostId, setCreatedHostId] = useState(0);
  const commandRef = useRef<HTMLParagraphElement | null>(null);
  // 关掉再打开从第一步开始
  useEffect(() => {
    if (!open) setCreatedHostId(0);
  }, [open]);
  const shownCommandHostId = commandHostId > 0 ? commandHostId : createdHostId;
  const commandQuery = trpc.hosts.agentInstallCommand.useQuery(
    { hostId: shownCommandHostId },
    { enabled: open && shownCommandHostId > 0 },
  );
  const createHost = trpc.hosts.create.useMutation({
    onSuccess: (created: any) => {
      const hostId = Number(created?.id || 0);
      toast.success("机器已添加，接下来把安装命令粘到那台机器上执行");
      setForm({ name: "", ip: "" });
      onCreated?.(hostId);
      if (hostId > 0) setCreatedHostId(hostId);
      else onOpenChange(false);
    },
    // 额度用满、地址重复这类都由服务端说清楚，原样透出来即可。
    onError: (error) => toast.error(error.message || "添加失败"),
  });

  const save = () => {
    const name = form.name.trim();
    const ip = form.ip.trim();
    if (!name) return toast.error("给这台机器起个名字");
    if (!ip) return toast.error("填一下 IP 或域名");
    createHost.mutate({ name, ip } as any);
  };

  if (shownCommandHostId > 0) {
    const commandText = commandQuery.data?.command || "";
    const panelUrlMissing = !!commandQuery.data && !commandQuery.data.panelUrl;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Agent 安装命令</DialogTitle>
            <DialogDescription>
              用 root 连上那台机器，把下面这条整行粘进去执行。装好后机器会显示在线。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {commandQuery.isLoading ? (
              <DataSectionLoading />
            ) : panelUrlMissing ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                面板还没配公开地址，装上的 Agent 不知道该回连到哪里。请联系管理员在「系统设置」里配好面板地址，再回来取命令。
              </p>
            ) : (
              <>
                {/* select-all + break-all：一键复制失败时要能一下选中整条。 */}
                <p
                  ref={commandRef}
                  className="select-all break-all rounded-md border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed"
                >
                  {commandText}
                </p>
                {clipboardNeedsManualCopy() ? (
                  <p className="pt-2 text-xs text-muted-foreground">
                    当前是 http 访问，没有剪贴板 API，只能走旧办法，有些浏览器（iOS 尤其）会拒绝。
                    一键复制不成时，长按上面这段选中即可。
                  </p>
                ) : null}
                <p className="pt-2 text-xs text-[var(--fx-warn-text)]">
                  命令里带着这台机器的 Agent 令牌，谁拿到谁就能把机器接进面板，别转发给别人。
                </p>
              </>
            )}
          </div>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
            <Button
              disabled={!commandText}
              onClick={async () => {
                const ok = await copyTextFromElement(commandRef.current, commandText);
                if (ok) toast.success("命令已复制");
                // 失败时选区还留着，直接用系统菜单复制就行。
                else toast.error("浏览器拒绝了复制，命令已选中，用系统菜单复制即可");
              }}
            >
              复制命令
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>加一台机器</DialogTitle>
          <DialogDescription data-fx-help="">
            填个名字和地址就行。加完会给你一条安装命令，在那台机器上执行，它才会连上面板。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">名称</Label>
            <Input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="我的 HK 小鸡"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">IP 或域名</Label>
            <Input
              value={form.ip}
              onChange={(event) => setForm((prev) => ({ ...prev, ip: event.target.value }))}
              placeholder="1.2.3.4"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={save} disabled={createHost.isPending}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
