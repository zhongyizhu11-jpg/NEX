import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Plus, Radio } from "lucide-react";
import { toast } from "sonner";

import DataSectionError from "@/components/DataSectionError";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OptimisticSwitch } from "@/components/ui/switch";
import { docsUrl } from "@/lib/docsLinks";
import { trpc } from "@/lib/trpc";
import {
  EVENT_WEBHOOK_CATEGORIES,
  EVENT_WEBHOOK_DEFAULT_CATEGORIES,
  EVENT_WEBHOOK_SECRET_MIN_LENGTH,
  eventWebhookCategoriesLabel,
  type EventWebhookCategory,
} from "@shared/eventWebhook";
import type { AppRouter } from "../../../../../server/routers";
import { relativeTimeLabel } from "../account/timeLabel";

/*
  设置 › 进阶 › 事件推送：面板里发生的事，一件一条带签名的 JSON 推给自己的程序
  （n8n、Home Assistant、脚本）。要推到聊天频道给人看的，是「Webhook」页那个。

  一张卡片：总开关 + 地址列表；新建、修改、看最近投递结果都在同一个弹层里，不另开页面。
  总开关是立即生效的开关；弹层里的是要点保存才生效的复选框。
  密钥保存后界面再也拿不到明文：修改时输入框留空 = 不换。
*/

type View = inferRouterOutputs<AppRouter>["ops"]["eventWebhooks"]["list"];
type Endpoint = View["endpoints"][number];
type Delivery = Endpoint["recent"][number];

type Draft = {
  id: string | null;
  url: string;
  secret: string;
  categories: EventWebhookCategory[];
  enabled: boolean;
};

/** 随机密钥：whsec_ 加 24 个随机字节的十六进制（192 位）。 */
function generateSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function deliveryLabel(delivery: Delivery) {
  const status = delivery.status ? `HTTP ${delivery.status}` : "没有响应";
  return `${delivery.ok ? "成功" : delivery.willRetry ? "失败，稍后重试" : "失败"} · ${status} · ${delivery.durationMs} ms`;
}

function lastDeliverySummary(endpoint: Endpoint) {
  const last = endpoint.recent[0];
  if (!last) return "还没有投递过";
  return `上次${deliveryLabel(last)} · ${relativeTimeLabel(last.at)}`;
}

export default function EventWebhooksSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const query = trpc.ops.eventWebhooks.list.useQuery(undefined, {
    // 开着并且有地址时才定时刷新（看投递结果）；关着的面板不为这张卡片多发请求
    refetchInterval: (current) => (current.state.data?.enabled && current.state.data.endpoints.length > 0 ? 30_000 : false),
  });
  const view = query.data;
  const apply = (next: View) => utils.ops.eventWebhooks.list.setData(undefined, next);
  const setEnabledMutation = trpc.ops.eventWebhooks.setEnabled.useMutation({ onSuccess: apply });
  const saveMutation = trpc.ops.eventWebhooks.save.useMutation({ onSuccess: apply });
  const removeMutation = trpc.ops.eventWebhooks.remove.useMutation({ onSuccess: apply });
  const testMutation = trpc.ops.eventWebhooks.test.useMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const editing = draft?.id ? view?.endpoints.find((endpoint) => endpoint.id === draft.id) ?? null : null;
  const full = !!view && view.endpoints.length >= view.maxEndpoints;

  const openCreate = () => setDraft({ id: null, url: "", secret: "", categories: [...EVENT_WEBHOOK_DEFAULT_CATEGORIES], enabled: true });
  const openEdit = (endpoint: Endpoint) => setDraft({ id: endpoint.id, url: endpoint.url, secret: "", categories: [...endpoint.categories], enabled: endpoint.enabled });

  const toggleCategory = (key: EventWebhookCategory, checked: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const next = new Set(current.categories);
      if (checked) next.add(key);
      else next.delete(key);
      return { ...current, categories: EVENT_WEBHOOK_CATEGORIES.map((category) => category.key).filter((value) => next.has(value)) };
    });
  };

  const handleSave = async () => {
    if (!draft) return;
    const url = draft.url.trim();
    const secret = draft.secret.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast.error("接收地址要以 http:// 或 https:// 开头");
      return;
    }
    if ((!draft.id || secret) && secret.length < EVENT_WEBHOOK_SECRET_MIN_LENGTH) {
      toast.error(`签名密钥至少 ${EVENT_WEBHOOK_SECRET_MIN_LENGTH} 个字符，可以点「随机生成」`);
      return;
    }
    if (draft.categories.length === 0) {
      toast.error("至少订阅一类事件");
      return;
    }
    try {
      await saveMutation.mutateAsync({
        id: draft.id ?? undefined,
        url,
        secret: secret || undefined,
        categories: draft.categories,
        enabled: draft.enabled,
      });
      toast.success(draft.id ? "已保存" : view?.enabled ? "已添加" : "已添加，打开上面的开关后开始推送");
      setDraft(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleRemove = async () => {
    if (!draft?.id) return;
    const ok = await confirm({
      title: "删除接收地址",
      description: "删除后不再往这个地址推送，排队等重试的也一并作废。",
      confirmText: "删除",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await removeMutation.mutateAsync({ id: draft.id });
      toast.success("已删除");
      setDraft(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  const handleTest = async (endpoint: Endpoint) => {
    setTestingId(endpoint.id);
    try {
      const result = await testMutation.mutateAsync({ id: endpoint.id });
      if (result.ok) toast.success(`测试事件已送达（HTTP ${result.status}，${result.durationMs} ms）`);
      else toast.error(`没送到${result.status ? `（HTTP ${result.status}）` : ""}：${result.error || "未知错误"}`);
      await utils.ops.eventWebhooks.list.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发送失败");
    } finally {
      setTestingId(null);
    }
  };

  return (
    <>
      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Radio className="h-4 w-4 text-primary" />
              事件推送
            </CardTitle>
            <CardDescription>
              主机上下线、线路切换、规则出错这类事发生时，推一条带签名的 JSON 给你的程序（n8n、Home Assistant、脚本）。
              <a className="ml-1 underline underline-offset-2 hover:text-foreground" href={docsUrl("/guide/event-webhooks")} target="_blank" rel="noreferrer">
                事件清单和验签方法
              </a>
            </CardDescription>
          </div>
          <Button className="w-full gap-2 sm:w-auto" onClick={openCreate} disabled={!view || full}>
            <Plus className="h-4 w-4" />
            添加地址
          </Button>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <DataSectionLoading label="正在加载事件推送" minHeight="min-h-[72px]" />
          ) : query.error || !view ? (
            <DataSectionError label="事件推送" error={query.error} onRetry={() => { void query.refetch(); }} retrying={query.isFetching} minHeight="min-h-[96px]" />
          ) : (
            <SettingList>
              <SettingRow
                asLabel
                label="开启推送"
                description={view.endpoints.length === 0 ? "默认关闭。先添加一个接收地址。" : "关掉后事件照常记录，只是不再往外推。"}
                control={(
                  <OptimisticSwitch
                    aria-label="开启事件推送"
                    checked={view.enabled}
                    onCheckedChangeAsync={(next) => setEnabledMutation.mutateAsync({ enabled: next })}
                    onToggleSuccess={(next) => toast.success(next ? "事件推送已开启" : "事件推送已关闭")}
                    onToggleError={(error) => toast.error(error instanceof Error ? error.message : "切换失败")}
                  />
                )}
              />
              {view.endpoints.map((endpoint) => (
                <SettingRow
                  key={endpoint.id}
                  keepDescription
                  label={(
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-xs">{endpoint.urlLabel}</span>
                      {!endpoint.enabled ? <Badge variant="outline">已停用</Badge> : null}
                    </span>
                  )}
                  description={(
                    <>
                      {eventWebhookCategoriesLabel(endpoint.categories)}
                      {` · ${lastDeliverySummary(endpoint)}`}
                      {endpoint.pending > 0 ? ` · ${endpoint.pending} 条在排队` : ""}
                      {endpoint.dropped > 0 ? ` · 队列满时丢了 ${endpoint.dropped} 条` : ""}
                    </>
                  )}
                  control={(
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => handleTest(endpoint)} disabled={testingId !== null}>
                        {testingId === endpoint.id ? "发送中…" : "测试"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(endpoint)}>
                        编辑
                      </Button>
                    </span>
                  )}
                />
              ))}
            </SettingList>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!draft} onOpenChange={(open) => { if (!open) setDraft(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "编辑接收地址" : "添加接收地址"}</DialogTitle>
            <DialogDescription>
              每件事 POST 一条 JSON 到这个地址，请求头里带时间戳和签名。5 秒没响应或返回 5xx 时，最多再重试 4 次。
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-4">
              <FormField className="space-y-2">
                <Label>接收地址</Label>
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="https://n8n.example.com/webhook/nex"
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
                <p className="text-meta text-muted-foreground">
                  可以填内网地址。面板会从它所在的机器直接发请求，只填你自己掌控的服务；不跟随跳转。
                </p>
              </FormField>
              <FormField className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>签名密钥</Label>
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setDraft({ ...draft, secret: generateSecret() })}>
                    随机生成
                  </Button>
                </div>
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder={editing ? `${editing.secretHint}（留空就是不换）` : `至少 ${EVENT_WEBHOOK_SECRET_MIN_LENGTH} 个字符`}
                  value={draft.secret}
                  onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                />
                <p className="text-meta text-muted-foreground">
                  接收方用它验证请求确实来自面板。保存后这里不再显示，请先把它填到接收方。
                </p>
              </FormField>
              <div className="space-y-2">
                <span className="text-sm font-medium">订阅的事件</span>
                <div className="flex flex-col">
                  {EVENT_WEBHOOK_CATEGORIES.map((category) => (
                    <label key={category.key} className="flex cursor-pointer items-start gap-3 py-1.5">
                      <Checkbox
                        className="mt-0.5"
                        checked={draft.categories.includes(category.key)}
                        onCheckedChange={(checked) => toggleCategory(category.key, checked)}
                      />
                      <span className="min-w-0 text-sm">
                        {category.label}
                        <span className="text-meta text-muted-foreground"> · {category.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-3">
                <Checkbox checked={draft.enabled} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })} />
                <span className="text-sm">启用这个地址</span>
              </label>
              {editing ? (
                <div className="space-y-2 border-t border-border pt-4">
                  <span className="text-sm font-medium">最近投递</span>
                  {editing.recent.length === 0 ? (
                    <p className="text-meta text-muted-foreground">还没有投递过。面板重启后这里会清空。</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {editing.recent.map((delivery, index) => (
                        <li key={`${delivery.eventId}-${delivery.attempt}-${index}`} className="text-meta">
                          <span className={delivery.ok ? "text-foreground" : "text-destructive"}>{deliveryLabel(delivery)}</span>
                          <span className="text-muted-foreground">
                            {` · ${delivery.type}${delivery.attempt > 1 ? ` · 第 ${delivery.attempt} 次` : ""} · ${relativeTimeLabel(delivery.at)}`}
                          </span>
                          {/* 只有状态码的错误（「HTTP 503」）前面已经写了，不再重复一行 */}
                          {delivery.error && delivery.error !== `HTTP ${delivery.status}` ? <span className="block break-all text-muted-foreground">{delivery.error}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            {draft?.id ? (
              <Button variant="ghost" className="text-destructive hover:text-destructive sm:mr-auto" onClick={handleRemove} disabled={removeMutation.isPending}>
                删除
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setDraft(null)}>取消</Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>{saveMutation.isPending ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
