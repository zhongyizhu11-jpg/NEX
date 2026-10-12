import { useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { OptimisticSwitch } from "@/components/ui/switch";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { trpc } from "@/lib/trpc";

const MESSAGE_MAX_LENGTH = 200;

/**
 * 设置 › 进阶 › 维护模式（#14）。
 *
 * 开着的时候普通用户登录不进来、已登录的也操作不了（看到「面板维护中」和这里写的说明），
 * 管理员照常用。转发、隧道、Agent 上报都不受影响 —— 维护的是面板，不是线路。
 */
export default function MaintenanceSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const stateQuery = trpc.ops.maintenance.get.useQuery();
  const setMutation = trpc.ops.maintenance.set.useMutation({
    onSuccess: (next) => {
      utils.ops.maintenance.get.setData(undefined, (current) => (current ? { ...current, ...next } : current));
      void utils.ops.maintenance.get.invalidate();
    },
  });
  const [message, setMessage] = useState("");
  const savedMessage = stateQuery.data?.message ?? "";
  useEffect(() => setMessage(savedMessage), [savedMessage]);
  const enabled = !!stateQuery.data?.enabled;
  const dirty = message.trim() !== savedMessage;

  const toggle = async (next: boolean) => {
    await setMutation.mutateAsync({ enabled: next, message: message.trim() });
    toast.success(next ? "维护模式已开启，普通用户暂时进不来" : "维护模式已关闭");
  };

  const saveMessage = async () => {
    try {
      await setMutation.mutateAsync({ enabled, message: message.trim() });
      toast.success("说明已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="h-4 w-4 text-primary" />
          维护模式
        </CardTitle>
        <CardDescription>升级或整理面板时先打开：普通用户暂时不能登录和操作，管理员不受影响。</CardDescription>
      </CardHeader>
      <CardContent>
        <SettingList>
          <SettingRow
            label="开启维护模式"
            description="转发、隧道和 Agent 照常工作，正在进行的连接不会断开。"
            asLabel
            control={(
              <OptimisticSwitch
                aria-label="开启维护模式"
                checked={enabled}
                disabled={stateQuery.isLoading}
                onCheckedChangeAsync={toggle}
                onToggleError={(error) => toast.error(error instanceof Error ? error.message : "切换失败")}
              />
            )}
          />
          <SettingRow label="给用户看的说明" description="显示在登录页和用户收到的提示里，可以留空。">
            <FormField className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Label className="sr-only">给用户看的说明</Label>
              <Input
                value={message}
                maxLength={MESSAGE_MAX_LENGTH}
                placeholder="例如：升级数据库，大约 10 分钟"
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && dirty) void saveMessage(); }}
              />
              <Button variant="outline" className="w-full sm:w-auto" onClick={saveMessage} disabled={!dirty || setMutation.isPending}>
                保存说明
              </Button>
            </FormField>
          </SettingRow>
        </SettingList>
      </CardContent>
    </Card>
  );
}
