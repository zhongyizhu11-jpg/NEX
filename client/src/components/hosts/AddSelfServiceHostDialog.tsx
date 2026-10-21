import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

/**
 * 租户自己加一台机器。
 *
 * 抽出来是因为有两个入口：「订阅管理 → 我的机器」和「主机管理」那一页。
 * 主机管理那边原来的「添加主机」按钮是走 Token 管理那个组件的信号 —— 那是
 * 管理员专属的组件，租户那边根本没挂上，于是按钮点了没反应。
 *
 * 两处各写一份表单也不行：加机器的额度、字段、提示语都得一致，分两份迟早对不上。
 */
export default function AddSelfServiceHostDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 建好之后调用方自己去刷新它关心的那几个查询。 */
  onCreated?: (hostId: number) => void;
}) {
  const [form, setForm] = useState({ name: "", ip: "" });
  const createHost = trpc.hosts.create.useMutation({
    onSuccess: (created: any) => {
      toast.success("机器已添加，接下来把安装命令粘到那台机器上执行");
      setForm({ name: "", ip: "" });
      onOpenChange(false);
      onCreated?.(Number(created?.id || 0));
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
