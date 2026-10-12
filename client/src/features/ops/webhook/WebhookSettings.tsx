import { useEffect, useState } from "react";
import { Webhook } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { WEBHOOK_CATEGORIES, WEBHOOK_LEVEL_OPTIONS, type WebhookCategoryKey } from "@shared/opsWebhook";
import type { OpsEventLevel } from "@shared/opsEvents";

/*
  设置 › Webhook：把事件时间线里的事推到 Discord / Slack / Mattermost / 自己的接口。

  地址本身就是密钥：保存后只显示打码后的样子，输入框留空 = 不改地址；要换就直接填新的。
  「发送测试」先测输入框里的新地址（还没保存也行），没填就测已保存的那个。
  格式看地址自动认，不用选。
*/

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function WebhookSettings(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const query = trpc.ops.webhooks.get.useQuery(undefined, { staleTime: 30_000 });
  const settings = query.data;
  const [enabled, setEnabled] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [categories, setCategories] = useState<WebhookCategoryKey[]>([]);
  const [minLevel, setMinLevel] = useState<OpsEventLevel>("info");

  const reset = () => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setUrlInput("");
    setCategories(settings.categories as WebhookCategoryKey[]);
    setMinLevel(settings.minLevel as OpsEventLevel);
  };
  useEffect(reset, [settings]);

  const saveMutation = trpc.ops.webhooks.save.useMutation({
    onSuccess: (next) => {
      utils.ops.webhooks.get.setData(undefined, next);
      setUrlInput("");
      toast.success("Webhook 设置已保存");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const testMutation = trpc.ops.webhooks.test.useMutation({
    onSuccess: (result) => {
      if (result.ok) toast.success(`测试消息已发出（HTTP ${result.status}），去看看收到没有`);
      else toast.error(`发送失败${result.status ? `（HTTP ${result.status}）` : ""}：${result.error || "未知错误"}`);
    },
    onError: (error) => toast.error(error.message || "发送失败"),
  });

  const trimmedUrl = urlInput.trim();
  const hasUrl = !!settings?.configured || !!trimmedUrl;

  const save = (): Promise<boolean> | boolean => {
    if (enabled && !hasUrl) {
      toast.error("请先填写 Webhook 地址");
      return false;
    }
    if (trimmedUrl && !/^https:\/\//i.test(trimmedUrl)) {
      toast.error("Webhook 地址必须以 https:// 开头");
      return false;
    }
    return saveMutation.mutateAsync({
      enabled,
      url: trimmedUrl || undefined,
      categories,
      minLevel,
    }).then(() => true, () => false);
  };

  const clearUrl = async () => {
    const confirmed = await confirmDialog({
      title: "清除 Webhook 地址",
      description: "清除后推送随之关闭，之后要用得重新填地址。",
      confirmText: "清除",
      tone: "destructive",
    });
    if (confirmed) saveMutation.mutate({ enabled: false, url: "", categories, minLevel });
  };

  const dirty = !!settings && (
    enabled !== settings.enabled
    || !!trimmedUrl
    || !sameList(categories, settings.categories)
    || minLevel !== settings.minLevel
  );
  useSaveDockItem({
    id: "ops.webhook",
    label: "Webhook 通知",
    dirty,
    pending: saveMutation.isPending,
    save,
    reset,
  });

  const toggleCategory = (key: WebhookCategoryKey, checked: boolean) => {
    setCategories((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      // 保持固定顺序，和保存后的值比较时不会因为勾选顺序不同就算「有改动」
      return WEBHOOK_CATEGORIES.map((category) => category.key).filter((value) => next.has(value));
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Webhook className="h-4 w-4 text-primary" />
              Webhook 通知
            </CardTitle>
            <CardDescription className="mt-1">
              主机断线、规则出错、用户到期这类事发生时，推一条消息到你的频道。
            </CardDescription>
          </div>
          {settings ? (
            <Badge variant={settings.enabled ? "default" : "outline"} className="w-fit">
              {settings.enabled ? "推送中" : settings.configured ? "已关闭" : "未配置"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <DataSectionLoading label="正在读取 Webhook 设置" minHeight="min-h-[120px]" />
        ) : query.isError || !settings ? (
          <DataSectionError label="Webhook 设置" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} />
        ) : (
          <>
            <FormField className="space-y-2">
              <Label htmlFor="ops-webhook-url">地址</Label>
              <Input
                id="ops-webhook-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={settings.urlMasked || "https://discord.com/api/webhooks/…"}
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                className="font-mono"
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {settings.configured
                    ? `已保存${settings.formatLabel ? `，按 ${settings.formatLabel} 格式发送` : ""}。留空就是不改，填新的会替换。`
                    : "支持 Discord、Slack、Mattermost，其它地址收到的是通用 JSON。只接受 https。"}
                </span>
                {settings.configured ? (
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                    onClick={() => { void clearUrl(); }}
                    disabled={saveMutation.isPending}
                  >
                    清除地址
                  </button>
                ) : null}
              </div>
            </FormField>

            <SettingList>
              <SettingRow
                asLabel
                label="启用推送"
                description={hasUrl ? "关掉后事件照常记录，只是不再推送。" : "先填好地址。"}
                control={(
                  <Checkbox
                    aria-label="启用推送"
                    checked={enabled}
                    onCheckedChange={(checked) => {
                      if (checked && !hasUrl) {
                        toast.error("请先填写 Webhook 地址");
                        return;
                      }
                      setEnabled(checked === true);
                    }}
                  />
                )}
              />
              {WEBHOOK_CATEGORIES.map((category) => (
                <SettingRow
                  key={category.key}
                  asLabel
                  label={category.label}
                  description={category.description}
                  control={(
                    <Checkbox
                      aria-label={category.label}
                      checked={categories.includes(category.key)}
                      onCheckedChange={(checked) => toggleCategory(category.key, checked)}
                    />
                  )}
                />
              ))}
              <SettingRow
                label="最低级别"
                description={WEBHOOK_LEVEL_OPTIONS.find((option) => option.value === minLevel)?.description}
                control={(
                  <Select value={minLevel} onValueChange={(value) => setMinLevel(value as OpsEventLevel)}>
                    <SelectTrigger className="h-8 w-32" aria-label="最低级别">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEBHOOK_LEVEL_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </SettingList>

            <p className="text-xs text-muted-foreground">
              几秒内接连发生的事会合成一条发出（一条最多 20 件），一大批机器同时断线也不会刷屏。发送失败会写进面板日志。
            </p>

            <div className="flex flex-wrap gap-2">
              <Button data-dock-save onClick={() => { void save(); }} disabled={saveMutation.isPending}>
                保存
              </Button>
              <Button
                variant="outline"
                onClick={() => testMutation.mutate(trimmedUrl ? { url: trimmedUrl } : undefined)}
                disabled={testMutation.isPending || !hasUrl}
              >
                {testMutation.isPending ? "发送中…" : "发送测试"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
