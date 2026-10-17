import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

/*
  规则 › 端口限速：这条规则自己的上行 / 下行上限。和用户、隧道、转发组、整台主机的限速叠加，
  每个方向取最严的那一级（shared/forwardRateLimit.ts），所以只会更慢、不会更快，规则的主人也能改。
*/

type Props = {
  rule: { id: number; name: string; rateLimitInMbps?: number | null; rateLimitOutMbps?: number | null } | null;
  onClose: () => void;
};

function toMbps(value: string) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(1_000_000, n) : 0;
}

export default function RuleRateLimitDialog({ rule, onClose }: Props) {
  const utils = trpc.useUtils();
  const [inValue, setInValue] = useState("");
  const [outValue, setOutValue] = useState("");

  useEffect(() => {
    if (!rule) return;
    setInValue(Number(rule.rateLimitInMbps) > 0 ? String(rule.rateLimitInMbps) : "");
    setOutValue(Number(rule.rateLimitOutMbps) > 0 ? String(rule.rateLimitOutMbps) : "");
  }, [rule]);

  const mutation = trpc.rules.setRateLimit.useMutation({
    onSuccess: () => {
      void utils.rules.listPage.invalidate();
      toast.success("端口限速已保存，Agent 刷新配置后生效");
      onClose();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  return (
    <Dialog open={!!rule} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>端口限速</DialogTitle>
          <DialogDescription>
            {rule ? `「${rule.name}」` : ""}这个端口上所有连接共用这个速度。和用户、隧道、整台主机的限速同时生效，取最严的那个。留空或 0 表示不限。
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {([
            ["上行（客户端 → 目标）", inValue, setInValue],
            ["下行（目标 → 客户端）", outValue, setOutValue],
          ] as const).map(([label, value, setValue]) => (
            <div key={label} className="space-y-2">
              <Label className="text-xs">{label}</Label>
              <div className="flex items-center gap-2">
                <Input
                  aria-label={label}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={1000000}
                  placeholder="不限"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
                <span className="whitespace-nowrap text-xs text-muted-foreground">Mbps</span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">需要 Agent 2.2.229 以上；gost 转发和隧道入口按上下行分别限速。</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={!rule || mutation.isPending}
            onClick={() => rule && mutation.mutate({ id: rule.id, inMbps: toMbps(inValue), outMbps: toMbps(outValue) })}
          >
            {mutation.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
