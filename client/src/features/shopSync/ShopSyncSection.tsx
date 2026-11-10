import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, ShoppingCart, X } from "lucide-react";
import { toast } from "sonner";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { relativeTimeLabel } from "../ops/account/timeLabel";
import {
  SHOP_KINDS,
  SHOP_KIND_LABELS,
  SHOP_SYNC_ACTION_LABELS,
  SHOP_SYNC_KIND_LABELS,
  SHOP_SYNC_STATUS_LABELS,
  shopPlanIdLabel,
  type ShopKind,
  type ShopSyncAction,
  type ShopSyncKind,
  type ShopSyncRecordStatus,
} from "@shared/shopSync";

type MappingRow = { key: number; shopPlanId: string; planId: string };
type Form = { enabled: boolean; shop: ShopKind; linkExistingByEmail: boolean; plans: MappingRow[] };
type SavedConfig = { enabled: boolean; shop: ShopKind; linkExistingByEmail: boolean; plans: Array<{ shopPlanId: string; planId: number }> };

let rowKey = 0;
function toForm(config: SavedConfig): Form {
  return {
    enabled: config.enabled,
    shop: config.shop,
    linkExistingByEmail: config.linkExistingByEmail,
    plans: config.plans.map((item) => ({ key: ++rowKey, shopPlanId: item.shopPlanId, planId: String(item.planId) })),
  };
}

function sameForm(form: Form, saved: SavedConfig) {
  if (form.enabled !== saved.enabled || form.shop !== saved.shop || form.linkExistingByEmail !== saved.linkExistingByEmail) return false;
  if (form.plans.length !== saved.plans.length) return false;
  return form.plans.every((row, index) => row.shopPlanId.trim() === saved.plans[index].shopPlanId && Number(row.planId) === saved.plans[index].planId);
}

async function copy(text: string, what = "已复制") {
  if (await copyTextToClipboard(text)) {
    toast.success(what);
    return;
  }
  toast.error(clipboardNeedsManualCopy() ? "当前是 http 访问，浏览器限制了剪贴板，请长按选中内容复制" : "复制失败，请手动复制");
}

const STATUS_TONE: Record<ShopSyncRecordStatus, BadgeTone> = {
  processing: "info",
  applied: "up",
  ignored: "neutral",
  unmapped: "warn",
  failed: "down",
};

function statusLabel(status: string) {
  return SHOP_SYNC_STATUS_LABELS[status as ShopSyncRecordStatus] ?? status;
}

function whatLabel(kind: string | null, action: string) {
  if (kind && kind !== "noop") return SHOP_SYNC_KIND_LABELS[kind as ShopSyncKind] ?? kind;
  return SHOP_SYNC_ACTION_LABELS[action as ShopSyncAction] ?? action;
}

/**
 * 设置 › 进阶 › 商城对接。
 *
 * 一张卡片放完：开关、商城类型、认领老账号、套餐映射、对接地址和令牌、最近同步。
 * 不另开页面 —— 配好以后基本不用再来，来了也只是看一眼最近同步有没有红的。
 * 怎么在商城那边接，见文档「商城对接」（docs/guide/shop-sync.md）。
 */
export default function ShopSyncSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.shopSync.get.useQuery();
  const saveMutation = trpc.shopSync.save.useMutation();
  const tokenMutation = trpc.shopSync.createToken.useMutation();
  const [form, setForm] = useState<Form | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const saved = query.data?.config;
  useEffect(() => {
    if (saved) setForm(toForm(saved));
  }, [saved]);

  const dirty = useMemo(() => !!form && !!saved && !sameForm(form, saved), [form, saved]);
  const plans = query.data?.plans ?? [];
  const records = query.data?.records ?? [];
  const visibleRecords = showAllRecords ? records : records.slice(0, 5);
  const shopTokens = query.data?.shopTokens ?? [];
  const planName = (id: number | null) => (id ? plans.find((plan) => plan.id === id)?.name ?? `#${id}` : "");

  const updateRow = (key: number, patch: Partial<MappingRow>) => {
    if (!form) return;
    setForm({ ...form, plans: form.plans.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  };

  const save = async () => {
    if (!form) return;
    const rows = form.plans.filter((row) => row.shopPlanId.trim() || row.planId);
    const broken = rows.find((row) => !row.shopPlanId.trim() || !row.planId);
    if (broken) {
      toast.error("映射表每一行都要填商城那边的 ID、选一个 NEX 套餐");
      return;
    }
    const ids = rows.map((row) => row.shopPlanId.trim());
    if (new Set(ids).size !== ids.length) {
      toast.error("同一个商城套餐只能映射一次");
      return;
    }
    try {
      const result = await saveMutation.mutateAsync({
        enabled: form.enabled,
        shop: form.shop,
        linkExistingByEmail: form.linkExistingByEmail,
        plans: rows.map((row) => ({ shopPlanId: row.shopPlanId.trim(), planId: Number(row.planId) })),
      });
      utils.shopSync.get.setData(undefined, (current) => (current ? { ...current, config: result.config } : current));
      setForm(toForm(result.config));
      toast.success(result.config.enabled ? "商城对接已保存" : "商城对接已关闭");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const createToken = async () => {
    try {
      const result = await tokenMutation.mutateAsync();
      setCreatedToken(result.token);
      void utils.shopSync.get.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成失败");
    }
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShoppingCart className="h-4 w-4 text-primary" />
          商城对接
        </CardTitle>
        <CardDescription>
          用 Xboard / V2Board / SSPanel 卖套餐时，商城那边买、续、换、退，这里自动开通、续期、换套餐、停用。账以商城为准，这边只跟着走。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading || !form || !query.data ? (
          query.error ? (
            <DataSectionError label="商城对接" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} minHeight="min-h-[96px]" />
          ) : (
            <DataSectionLoading label="正在加载商城对接" minHeight="min-h-[96px]" />
          )
        ) : (
          <>
            <SettingList>
              <SettingRow
                asLabel
                label="开启商城对接"
                description={`关着时商城的回调一律拒收。已绑 ${query.data.stats.boundUsers} 人，在用 ${query.data.stats.activeUsers} 人`}
                keepDescription
                control={<Checkbox aria-label="开启商城对接" checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled: enabled === true })} />}
              />
              <SettingRow
                label="商城"
                description="只影响下面的叫法和文档里给的接法"
                control={(
                  <Select value={form.shop} onValueChange={(value) => setForm({ ...form, shop: value as ShopKind })}>
                    <SelectTrigger className="w-32" aria-label="商城类型"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SHOP_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{SHOP_KIND_LABELS[kind]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
              <SettingRow
                asLabel
                label="按邮箱认领已有账号"
                description="商城用户第一次来、这边已有同邮箱账号时直接接管。商城注册不验邮箱就别开；管理员账号永远不接管"
                control={<Checkbox aria-label="按邮箱认领已有账号" checked={form.linkExistingByEmail} onCheckedChange={(value) => setForm({ ...form, linkExistingByEmail: value === true })} />}
              />
            </SettingList>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">套餐映射</span>
                <span className="text-meta text-muted-foreground">没映射的商城套餐不开通，只记一条</span>
              </div>
              {form.plans.length === 0 ? (
                <p className="px-0.5 text-meta text-muted-foreground">还没有映射：商城的订单都会被忽略</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] gap-2 px-0.5 text-meta text-muted-foreground">
                    <span>{shopPlanIdLabel(form.shop)}</span>
                    <span>NEX 套餐</span>
                    <span className="sr-only">删除</span>
                  </div>
                  {form.plans.map((row) => (
                    <div key={row.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2">
                      <Input
                        aria-label={shopPlanIdLabel(form.shop)}
                        value={row.shopPlanId}
                        placeholder={form.shop === "sspanel" ? "如 1" : "如 3"}
                        maxLength={64}
                        onChange={(event) => updateRow(row.key, { shopPlanId: event.target.value })}
                      />
                      <Select value={row.planId} onValueChange={(value) => updateRow(row.key, { planId: value })}>
                        <SelectTrigger className="min-w-0" aria-label="NEX 套餐"><SelectValue placeholder="选套餐" /></SelectTrigger>
                        <SelectContent>
                          {plans.map((plan) => (
                            <SelectItem key={plan.id} value={String(plan.id)}>{plan.name}{plan.isActive ? "" : "（已停用）"}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="删掉这一行"
                        onClick={() => setForm({ ...form, plans: form.plans.filter((item) => item.key !== row.key) })}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={form.plans.length >= 100}
                onClick={() => setForm({ ...form, plans: [...form.plans, { key: ++rowKey, shopPlanId: "", planId: "" }] })}
              >
                <Plus className="h-3.5 w-3.5" />
                加一行
              </Button>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button onClick={save} disabled={!dirty || saveMutation.isPending}>{saveMutation.isPending ? "保存中…" : "保存"}</Button>
            </div>

            <div className="space-y-2 rounded-lg border border-[var(--fx-stroke-weak)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-meta text-muted-foreground">商城回调地址（POST）</span>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={() => copy(query.data.endpoint, "地址已复制")}>
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
              <code className="block whitespace-pre-wrap break-all rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5">{query.data.endpoint}</code>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="min-w-0 text-meta text-muted-foreground">
                  {shopTokens.length > 0
                    ? `对接令牌 ${shopTokens.length} 枚：${shopTokens.map((token) => `${token.prefix}…（${relativeTimeLabel(token.lastUsedAt, "没用过")}）`).join("、")}`
                    : "还没有对接令牌。令牌只能调这一个接口，在 API 令牌里可以撤销"}
                </span>
                <Button variant="outline" size="sm" onClick={createToken} disabled={tokenMutation.isPending}>
                  {tokenMutation.isPending ? "生成中…" : "生成对接令牌"}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">最近同步</span>
                {records.length > 5 ? (
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setShowAllRecords(!showAllRecords)}>
                    {showAllRecords ? "收起" : `全部 ${records.length} 条`}
                  </Button>
                ) : null}
              </div>
              {records.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--fx-stroke-weak)] px-3 py-3 text-meta text-muted-foreground">商城还没有来过回调</div>
              ) : (
                <ul className="divide-y divide-[var(--fx-stroke-weak)] rounded-lg border border-[var(--fx-stroke-weak)]">
                  {visibleRecords.map((record) => (
                    <li key={record.id} className="min-w-0 space-y-1 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge size="sm" tone={STATUS_TONE[record.status as ShopSyncRecordStatus] ?? "neutral"}>{statusLabel(record.status)}</Badge>
                        <span className="shrink-0 text-sm text-foreground">{whatLabel(record.kind, record.action)}</span>
                        <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">{record.email || `商城用户 ${record.externalUserId}`}</span>
                        <span className="shrink-0 text-meta text-muted-foreground">{relativeTimeLabel(record.updatedAt)}</span>
                      </div>
                      <div className="line-clamp-2 break-all text-meta text-muted-foreground">
                        {/* 说明里没提套餐名时（续期、停用）补一个「→ 套餐」，提过了就不重复 */}
                        {record.planId && !(record.message || "").includes(planName(record.planId)) ? `→ ${planName(record.planId)} · ` : ""}
                        {record.message || "—"}
                        {record.attempts > 1 ? ` · 第 ${record.attempts} 次` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={!!createdToken} onOpenChange={(open) => { if (!open) setCreatedToken(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>对接令牌已生成</DialogTitle>
            <DialogDescription>只显示这一次，请现在填进商城那边的插件或脚本。它只能调商城回调，一年后过期。</DialogDescription>
          </DialogHeader>
          {createdToken ? (
            <div className="space-y-3">
              <code className="block break-all rounded-md border bg-background px-3 py-2 font-mono text-sm">{createdToken}</code>
              <Button className="w-full gap-2" onClick={() => copy(createdToken, "令牌已复制")}>
                <Copy className="h-4 w-4" />
                复制令牌
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreatedToken(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
