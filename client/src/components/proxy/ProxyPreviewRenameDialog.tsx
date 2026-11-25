/**
 * 订阅内容里改名：转发派生的条目改规则上的显示名，直连条目改模板名。
 *
 * 输入框状态归弹窗自己（见 ProxyNodeEditDialog 顶上的说明）。
 */

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

export type ProxyPreviewRenameTarget = {
  kind: "relay" | "direct";
  ruleId: number;
  templateId: number;
  name: string;
};

type Props = {
  /** null = 关着。 */
  target: ProxyPreviewRenameTarget | null;
  onClose: () => void;
  /** 保存成功之后（弹窗已经关了）。 */
  onSaved?: () => void;
};

export function ProxyPreviewRenameDialog({ target, onClose, onSaved }: Props) {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>改节点名</DialogTitle>
          <DialogDescription className="text-xs">
            只影响这个节点在订阅里显示的名字，转发规则本身不受影响。
            {target?.kind === "direct" ? "这是直连条目，改的是节点模板的名字。" : ""}
          </DialogDescription>
        </DialogHeader>
        {target ? <RenameForm target={target} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ target, onClose, onSaved }: { target: ProxyPreviewRenameTarget; onClose: () => void; onSaved?: () => void }) {
  const [value, setValue] = useState(target.name);
  const utils = trpc.useUtils();
  const done = () => {
    toast.success("节点名已更新");
    onClose();
    onSaved?.();
  };
  const setRuleNodeName = trpc.proxySubscriptions.setRuleNodeName.useMutation({
    onSuccess: () => {
      // 规则上的显示名只出现在订阅内容里。
      void utils.proxySubscriptions.preview.invalidate();
      done();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({
    onSuccess: () => {
      // 模板名同时是节点列表里那一行的名字。
      void utils.proxySubscriptions.listNodes.invalidate();
      void utils.proxySubscriptions.preview.invalidate();
      done();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = () => {
    const name = value.trim();
    if (target.kind === "direct") {
      // 直连条目的名字就是模板名，落到模板上。
      if (!name) {
        toast.error("节点模板的名字不能为空");
        return;
      }
      updateNode.mutate({ id: target.templateId, name });
      return;
    }
    setRuleNodeName.mutate({ ruleId: target.ruleId, name });
  };
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="proxy-rename">节点名</Label>
        <Input
          id="proxy-rename"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          maxLength={64}
          autoFocus
        />
        {target.kind === "relay" && (
          <p data-fx-help="" className="text-xs text-muted-foreground">
            留空恢复默认名（由主机名和转发名自动拼出）。
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button disabled={setRuleNodeName.isPending || updateNode.isPending} onClick={submit}>
          保存
        </Button>
      </DialogFooter>
    </>
  );
}
