/**
 * 新建订阅链接：只填一个「用途」。格式与预设都在「一键订阅」面板里就地调整，创建时走服务端默认。
 *
 * 输入框的状态在这里而不在页面上：页面重画一次要重排整张节点列表，不值得为一个输入框付这个钱。
 * 状态挂在 DialogContent 里面的子组件上，关掉再开就是空的（Radix 关闭时卸掉 Content）。
 */

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功之后（弹窗已经关了）。 */
  onSaved?: () => void;
};

export function ProxySubTokenCreateDialog({ open, onOpenChange, onSaved }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建订阅链接</DialogTitle>
          <DialogDescription className="text-xs">
            建议一台设备一条。
          </DialogDescription>
        </DialogHeader>
        <TokenCreateForm onOpenChange={onOpenChange} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

function TokenCreateForm({ onOpenChange, onSaved }: Omit<Props, "open">) {
  const [name, setName] = useState("");
  const utils = trpc.useUtils();
  const createToken = trpc.proxySubscriptions.createToken.useMutation({
    onSuccess: () => {
      toast.success("订阅链接已创建");
      // 只有令牌列表变了：节点和订阅内容都不受影响，不用跟着重取。
      void utils.proxySubscriptions.listTokens.invalidate();
      onOpenChange(false);
      onSaved?.();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("请填写用途，方便以后分清是哪台设备");
      return;
    }
    // 格式与预设都在「一键订阅」面板里就地调整，创建时走服务端默认。
    createToken.mutate({ name: trimmed });
  };
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="proxy-token-name">用途</Label>
        <Input
          id="proxy-token-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 我的手机"
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button onClick={submit} disabled={createToken.isPending}>
          创建
        </Button>
      </DialogFooter>
    </>
  );
}
