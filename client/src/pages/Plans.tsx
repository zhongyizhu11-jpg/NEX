import { FormField } from "@/components/ui/form-field";
import { readStoredViewMode, writeStoredViewMode } from "@/lib/viewModeStorage";
import { PlanDescriptionEditor } from "@/components/plans/PlanDescription";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import DataSectionError, { DataTableErrorRow } from "@/components/DataSectionError";
import { resourceStatusTone } from "@/lib/statusDot";
import { StatusDot } from "@/lib/statusDot";
import { forwardGroupModeOf, forwardGroupTypeText, type ForwardGroupMode } from "@shared/forwardTypes";
import MobileInfoRow from "@/components/MobileInfoRow";
import { formatQuotaBytes } from "@shared/formatBytes";
import { planDescriptionSummary } from "@shared/planDescription";
import { formatMoneyCents as money } from "@shared/formatMoney";
import DashboardLayout from "@/components/DashboardLayout";
import EmptyState from "@/components/EmptyState";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { ListRow, ListSection } from "@/components/ios/GroupedList";
import { EntityCard } from "@/components/entity/EntityCard";
import { EntityActions } from "@/components/entity/EntityActions";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { useUrlTab } from "@/hooks/useUrlTab";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import TrafficBillingSection from "@/components/TrafficBillingSection";
import { cn } from "@/lib/utils";
import { formatTrafficMultiplier } from "@shared/trafficMultiplier";
import {
  defaultPricingOption,
  planDurationLabel,
  planPricingOptions,
  PLAN_DURATION_PRESETS,
  PLAN_PRICE_TIER_LIMIT,
  planMonthlyEquivalentCents,
} from "@shared/planPricing";
import { formatRateBps, parseRatePercentToBps } from "@shared/referral";
import { Check, CheckCircle2, Coins, LayoutGrid, List, Package, Pencil, Plus, RefreshCw, Settings2, ShoppingBag, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

type PlanForm = {
  id?: number;
  name: string;
  description: string;
  price: string;
  currency: string;
  durationDays: string;
  portCount: string;
  trafficGB: string;
  rateLimitMbps: string;
  maxRules: string;
  maxProxyInbounds: string;
  maxProxySubTokens: string;
  /** 订阅设备数上限（0 = 不限）、指定模板（0 = 默认）、外部订阅、信息节点。 */
  maxProxyDevices: string;
  proxySubTemplateId: string;
  allowExternalSubSources: boolean;
  showSubInfoNodes: boolean;
  maxConnections: string;
  maxIPs: string;
  allowProxySubscription: boolean;
  isActive: boolean;
  isStoreVisible: boolean;
  syncExistingSubscribers: boolean;
  sortOrder: string;
  /** 邀请返利比例（%），字符串原样保存，提交时按字符串换成基点（shared/referral.ts）。 */
  referralRate: string;
  hostIds: number[];
  tunnelIds: number[];
  forwardGroupIds: number[];
  /** 套餐附带的落地节点：买了自动发一份独立凭据，到期自动收回。 */
  proxyNodeIds: number[];
  /** 附带节点怎么给：true = 每人单开一个端口（能按人计量）。 */
  dedicatedProxyPort: boolean;
  /**
   * 多周期定价。留空 = 只卖上面那一档（存量套餐全是这样）。
   *
   * 填了的话上面的「价格 / 有效期」退化成默认档，由后端按总价最低那一档回填 ——
   * 两处各填一遍再互相打架，是这种表最容易出的错。
   */
  priceTiers: PriceTierForm[];
  trafficAddons: TrafficAddonForm[];
};

type PriceTierForm = {
  durationDays: string;
  price: string;
};

type TrafficAddonForm = {
  trafficGB: string;
  price: string;
  isActive: boolean;
  sortOrder: string;
};

type PlanManageTab = "plans" | "billing";
type PlanDialogTab = "settings" | "resources";
type PlanListViewMode = "card" | "table";
type PlanResourceKey = "hostIds" | "tunnelIds" | "forwardGroupIds" | "proxyNodeIds";
type PlanResourcePart = { label: string; count: number };
const PLAN_MANAGE_TABS = ["plans", "billing"] as const;
/*
  套餐计费和流量计费是同一件事的两种卖法（包月吃额度 / 按 GB 扣余额），
  所以放在同一页的两个 tab 里，而不是侧边栏两个入口 —— 「我这个月怎么收钱」
  不该分两个地方问。
*/
const PLAN_MANAGE_TAB_ITEMS = [
  { value: "plans", label: "套餐计费", icon: Package },
  { value: "billing", label: "流量计费", icon: Coins },
] as const satisfies readonly SlidingTabItem<PlanManageTab>[];
const PLAN_MANAGE_TAB_STORAGE_KEY = "forwardx.plans.tab";
const PLAN_LIST_VIEW_MODE_STORAGE_KEY = "forwardx.plans.viewMode";

const emptyForm: PlanForm = {
  name: "",
  description: "",
  price: "0",
  currency: "CNY",
  durationDays: "30",
  portCount: "20",
  trafficGB: "0",
  rateLimitMbps: "0",
  maxRules: "20",
  maxProxyInbounds: "0",
  maxProxySubTokens: "0",
  maxProxyDevices: "0",
  proxySubTemplateId: "0",
  allowExternalSubSources: false,
  showSubInfoNodes: false,
  maxConnections: "2000",
  maxIPs: "10",
  allowProxySubscription: false,
  isActive: true,
  isStoreVisible: true,
  syncExistingSubscribers: true,
  sortOrder: "0",
  referralRate: "0",
  hostIds: [],
  tunnelIds: [],
  forwardGroupIds: [],
  proxyNodeIds: [],
  dedicatedProxyPort: false,
  priceTiers: [],
  trafficAddons: [],
};

function getStoredPlanListViewMode(): PlanListViewMode {
  return readStoredViewMode<PlanListViewMode>(PLAN_LIST_VIEW_MODE_STORAGE_KEY, ["table", "card"], "card");
}

function storePlanListViewMode(viewMode: PlanListViewMode) {
  writeStoredViewMode(PLAN_LIST_VIEW_MODE_STORAGE_KEY, viewMode);
}

function speed(value?: number | null) {
  const num = Number(value || 0);
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : "不限";
}

// 常用周期与中文名共用 shared/planPricing 那一份 —— 商店和这里各写一遍的话，
// 改了一边忘另一边就会出现「同一个 90 天，一处叫季付一处叫三个月」。
const durationOptions = PLAN_DURATION_PRESETS.map((item) => ({ value: String(item.days), label: item.label }));

function durationLabel(days?: number | null) {
  return planDurationLabel(days);
}

/** 这张表当前的档位预览（含每天单价和折扣），用来在每一行后面标「省 N%」。 */
function tierPreview(form: PlanForm) {
  return planPricingOptions({}, form.priceTiers.map((tier) => ({
    durationDays: Number(tier.durationDays || 0),
    priceCents: Math.round(Number(tier.price || 0) * 100),
  })));
}

/** 默认档（总价最低那一档）—— 上面那个只读的「价格」框显示的就是它。 */
function tierDefault(form: PlanForm) {
  const option = defaultPricingOption(tierPreview(form));
  return option ? { price: (option.priceCents / 100).toFixed(2), durationDays: String(option.durationDays) } : null;
}

/**
 * 「自定义」新加一行默认填哪个周期：按预设顺序挑第一个还没被占用的。
 *
 * 价格**留空**，不给默认值：给了默认值（比如照抄月付那档）的人多半不会去改，
 * 于是年付卖成月付价；留空则保存时会拦下来，让他必须自己填一个数。
 */
function nextTierDraft(form: PlanForm): PriceTierForm {
  const used = new Set(form.priceTiers.map((tier) => Number(tier.durationDays || 0)));
  const preset = PLAN_DURATION_PRESETS.find((item) => !used.has(item.days));
  return { durationDays: String(preset?.days ?? 30), price: "" };
}

/** 这一档是不是预设周期。是的话就不该让人再去填天数。 */
function isPresetTierDays(days: unknown) {
  return PLAN_DURATION_PRESETS.some((item) => item.days === Number(days || 0));
}

function sortTiersByDuration(tiers: PriceTierForm[]) {
  return [...tiers].sort((a, b) => Number(a.durationDays || 0) - Number(b.durationDays || 0));
}

/** 还没填价格的那些档。0 是合法价（送的、内部用的），空着才是「没填」。 */
function unpricedTierLabels(form: PlanForm): string[] {
  return form.priceTiers
    .filter((tier) => String(tier.price ?? "").trim() === "")
    .map((tier) => planDurationLabel(Number(tier.durationDays || 0)));
}

/*
  套餐的两个状态：启用、在商店展示。

  原来是两个胶囊按钮，写着「启用」「商店展示」—— 同一个东西既像状态标签又像按钮：黑底的
  「启用」是说它现在启用着，还是点它来启用？点一下就变成「停用」，要看过一次才知道。
  这两样点了立刻生效，按手册就是开关。
*/
function PlanStatusSwitches({
  plan,
  disabled,
  onToggleActive,
  onToggleStoreVisible,
  layout = "rows",
}: {
  plan: any;
  disabled?: boolean;
  onToggleActive: () => void;
  onToggleStoreVisible: () => void;
  /** rows：卡片里两行设置；inline：表格那一格里上下两个小开关。 */
  layout?: "rows" | "inline";
}) {
  const active = !!plan.isActive;
  const storeVisible = active && !!plan.isStoreVisible;
  const activeSwitch = (
    <Switch aria-label={`启用 ${plan.name}`} checked={active} disabled={disabled} onCheckedChange={() => onToggleActive()} />
  );
  const storeSwitch = (
    <Switch aria-label={`在商店展示 ${plan.name}`} checked={storeVisible} disabled={disabled || !active} onCheckedChange={() => onToggleStoreVisible()} />
  );
  if (layout === "inline") {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-meta text-muted-foreground">{activeSwitch}启用</label>
        <label className="flex items-center gap-2 text-meta text-muted-foreground">{storeSwitch}商店展示</label>
      </div>
    );
  }
  return (
    <SettingList>
      <SettingRow asLabel label="启用" description={active ? "可以分配、购买和续费。" : "不能再分配、购买和续费；已有订阅照常用到到期。"} control={activeSwitch} />
      <SettingRow
        asLabel
        label="在商店展示"
        description={active ? (storeVisible ? "用户可以在商店自助购买。" : "只能由管理员在后台分配。") : "套餐启用后才能开启。"}
        control={storeSwitch}
      />
    </SettingList>
  );
}

function PlanCard({
  plan,
  resourceParts,
  onEdit,
  onDelete,
  toggling,
  onToggleActive,
  onToggleStoreVisible,
}: {
  plan: any;
  resourceParts: PlanResourcePart[];
  onEdit: () => void;
  onDelete: () => void;
  toggling?: boolean;
  onToggleActive: () => void;
  onToggleStoreVisible: () => void;
}) {
  /*
    原来这张卡是一个描边小框，套在「套餐列表」那张大卡里（卡里套卡），右上角一个「编辑」
    一个红色垃圾桶 —— 垃圾桶点一下就删，没有确认。现在和别的实体卡一样：一块白，名字和价格
    在上，明细是一张两列的表，状态是两个开关，底部「编辑」+「···」，删除收进菜单最后、先确认。
  */
  return (
    <EntityCard className="h-full">
      <div className="px-[var(--fx-card-padding)] pt-[var(--fx-space-3)]">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 break-words text-primary-type font-semibold text-foreground">{plan.name}</h3>
          <EntityActions
            menuOnly
            className="-mr-1.5 -mt-1"
            primary={[{ key: "edit", label: "编辑", ariaLabel: `编辑套餐 ${plan.name}`, icon: <Pencil className="h-3.5 w-3.5" />, onSelect: onEdit }]}
            menu={[{ key: "delete", label: "删除", ariaLabel: `删除套餐 ${plan.name}`, destructive: true, onSelect: onDelete }]}
            menuLabel={`${plan.name} 的更多操作`}
          />
        </div>
        <div className="mt-0.5 line-clamp-2 break-words text-meta text-muted-foreground">{planDescriptionSummary(plan.description) || "无描述"}</div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-metric font-semibold tabular-nums text-foreground">{money(plan.priceCents, plan.currency)}</span>
          <span className="text-meta text-muted-foreground">/ {durationLabel(plan.durationDays)}</span>
        </div>
      </div>
      <dl className="mx-[var(--fx-card-padding)] mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-[var(--fx-stroke-weak)] pt-3 text-secondary-type">
        <dt className="text-muted-foreground">资源</dt>
        <dd className="min-w-0 break-words text-right text-foreground">
          {resourceParts.length > 0 ? resourceParts.map((item) => `${item.label} ${item.count}`).join(" · ") : "无"}
        </dd>
        <dt className="text-muted-foreground">端口</dt>
        <dd className="text-right tabular-nums text-foreground">{plan.portCount} 个</dd>
        <dt className="text-muted-foreground">规则 / 流量</dt>
        <dd className="text-right tabular-nums text-foreground">{plan.maxRules || "不限"} · {formatQuotaBytes(plan.trafficLimit)}</dd>
        <dt className="text-muted-foreground">连接 / 单 IP</dt>
        <dd className="text-right tabular-nums text-foreground">{plan.maxConnections || "不限"} · {plan.maxIPs || "不限"}</dd>
        <dt className="text-muted-foreground">限速</dt>
        <dd className="text-right tabular-nums text-foreground">{speed(plan.rateLimitMbps)}</dd>
        <dt className="text-muted-foreground">附加流量</dt>
        <dd className="text-right tabular-nums text-foreground">{plan.trafficAddons?.length || 0} 档</dd>
        <dt className="text-muted-foreground">邀请返利</dt>
        <dd className="text-right tabular-nums text-foreground">{referralRateText(plan.referralRateBps)}</dd>
      </dl>
      <div className="mx-[var(--fx-card-padding)] mt-3 border-t border-[var(--fx-stroke-weak)] py-3">
        <PlanStatusSwitches
          plan={plan}
          disabled={toggling}
          onToggleActive={onToggleActive}
          onToggleStoreVisible={onToggleStoreVisible}
        />
      </div>
    </EntityCard>
  );
}

function hostTitle(host: any) {
  return host?.name || host?.ip || host?.ipv4 || host?.ipv6 || `主机 #${host?.id || "-"}`;
}

function hostMeta(host: any) {
  return Array.from(new Set([host?.ip, host?.ipv4, host?.ipv6].filter(Boolean))).join(" / ");
}

function isPortForwardGroup(group: any) {
  return forwardGroupModeOf(group) === "port";
}

function isChainForwardGroup(group: any) {
  return forwardGroupModeOf(group) === "chain";
}

function isStandardForwardGroup(group: any) {
  return forwardGroupModeOf(group) === "failover";
}

function planResourcePartsForDisplay(plan: any, forwardGroupMap: Map<number, any>): PlanResourcePart[] {
  const counts = {
    legacyHosts: Number(plan?.hostIds?.length || 0),
    ports: 0,
    tunnels: Number(plan?.tunnelIds?.length || 0),
    chains: 0,
    groups: 0,
    otherForwardResources: 0,
  };
  const refs = Array.isArray(plan?.forwardGroupRefs) && plan.forwardGroupRefs.length > 0
    ? plan.forwardGroupRefs
    : (Array.isArray(plan?.forwardGroupIds) ? plan.forwardGroupIds : []).map((id: number) => ({ id }));

  for (const ref of refs) {
    const id = Number(typeof ref === "object" ? ref.id : ref);
    const group = forwardGroupMap.get(id) || ref;
    if (isPortForwardGroup(group)) {
      counts.ports += 1;
    } else if (isChainForwardGroup(group)) {
      counts.chains += 1;
    } else if (isStandardForwardGroup(group)) {
      counts.groups += 1;
    } else {
      counts.otherForwardResources += 1;
    }
  }

  return [
    { label: "端口转发", count: counts.ports },
    { label: "隧道", count: counts.tunnels },
    { label: "转发链", count: counts.chains },
    { label: "转发组", count: counts.groups },
    { label: "历史主机", count: counts.legacyHosts },
    { label: "转发资源", count: counts.otherForwardResources },
    // 附带节点跟转发资源一样是套餐的内容，列表上要看得见 —— 否则哪些套餐带
    // 节点、哪些不带，只能一个个点开弹窗看。
    { label: "落地节点", count: Number(plan?.proxyNodeIds?.length || 0) },
  ].filter((item) => item.count > 0);
}

function selectedResourceItems(ids: number[], items: any[], fallbackType: string) {
  return ids
    .map(Number)
    .filter(Boolean)
    .map((id) => items.find((item: any) => Number(item.id) === id) || { id, missing: true, name: `${fallbackType} #${id}` });
}

function missingResourceHint(item: any) {
  return item?.missing ? "资源不存在或已删除，可删除清理" : "";
}

function PlanResourceOption({
  type,
  item,
  hosts,
  title,
  kind,
  meta,
  showMultiplier = true,
}: {
  type: "host" | "tunnel" | "forward_group";
  item: any;
  hosts: any[];
  title: string;
  kind: string;
  meta?: string;
  showMultiplier?: boolean;
}) {
  const multiplier = type === "host" || !showMultiplier ? null : formatTrafficMultiplier(item?.trafficMultiplier ?? 100);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <StatusDot tone={resourceStatusTone(type, item)} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 rounded border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">{kind}</span>
          {multiplier ? (
            <span className="shrink-0 rounded border border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] bg-[var(--fx-healthy-soft)] px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--fx-healthy-text)]">
              {multiplier}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{missingResourceHint(item) || meta || (type === "tunnel" ? getTunnelRouteText(item, hosts) : kind)}</p>
      </div>
    </div>
  );
}

function PlanResourcePicker({
  title,
  countText,
  loading,
  loadingLabel,
  selectedItems,
  availableItems,
  addPlaceholder,
  emptyText,
  allAddedText,
  onAdd,
  onRemove,
  getId,
  renderOption,
  renderSelected,
}: {
  title: string;
  countText: string;
  loading: boolean;
  loadingLabel: string;
  selectedItems: any[];
  availableItems: any[];
  addPlaceholder: string;
  emptyText: string;
  allAddedText: string;
  onAdd: (id: string) => void;
  onRemove: (id: number) => void;
  getId: (item: any) => number;
  renderOption: (item: any) => ReactNode;
  renderSelected: (item: any) => ReactNode;
}) {
  return (
    <FormField className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm font-medium">{title}</Label>
        <Badge variant="outline" className="h-6 shrink-0 rounded-full px-2 text-xs">{countText}</Badge>
      </div>
      {loading ? (
        <DataSectionLoading label={loadingLabel} minHeight="min-h-[84px]" />
      ) : (
        <>
          {selectedItems.length > 0 ? (
            <div className="space-y-1.5">
              {selectedItems.map((item) => (
                <div key={getId(item)} className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
                  <div className="min-w-0 flex-1">{renderSelected(item)}</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-destructive"
                    title="删除"
                    onClick={() => onRemove(getId(item))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
              {emptyText}
            </div>
          )}
          <Select value="" onValueChange={onAdd} disabled={availableItems.length === 0}>
            <SelectTrigger>
              <SelectValue placeholder={availableItems.length > 0 ? addPlaceholder : allAddedText} />
            </SelectTrigger>
            <SelectContent>
              {availableItems.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">{allAddedText}</div>
              ) : availableItems.map((item) => (
                <SelectItem key={getId(item)} value={String(getId(item))}>
                  {renderOption(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </FormField>
  );
}

function PlanSelectedResourceList({
  title,
  countText,
  selectedItems,
  emptyText,
  note,
  onRemove,
  getId,
  renderSelected,
}: {
  title: string;
  countText: string;
  selectedItems: any[];
  emptyText: string;
  note?: string;
  onRemove: (id: number) => void;
  getId: (item: any) => number;
  renderSelected: (item: any) => ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm font-medium">{title}</Label>
        <Badge variant="outline" className="h-6 shrink-0 rounded-full px-2 text-xs">{countText}</Badge>
      </div>
      {selectedItems.length > 0 ? (
        <div className="space-y-1.5">
          {selectedItems.map((item) => (
            <div key={getId(item)} className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
              <div className="min-w-0 flex-1">{renderSelected(item)}</div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-destructive"
                title="删除"
                onClick={() => onRemove(getId(item))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {emptyText}
        </div>
      )}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function referralRateText(bps: unknown) {
  const value = Number(bps || 0);
  return value > 0 ? `${formatRateBps(value)}%` : "不返";
}

function toForm(plan: any): PlanForm {
  return {
    id: plan.id,
    name: plan.name || "",
    description: plan.description || "",
    price: String((Number(plan.priceCents || 0) / 100).toFixed(2)),
    currency: plan.currency || "CNY",
    durationDays: String(plan.durationDays ?? 30),
    portCount: String(plan.portCount ?? 20),
    trafficGB: String(Number(plan.trafficLimit || 0) / 1024 / 1024 / 1024 || 0),
    rateLimitMbps: String(Number(plan.rateLimitMbps || 0) || 0),
    maxRules: String(plan.maxRules ?? 20),
    maxProxyInbounds: String(plan.maxProxyInbounds ?? 0),
    maxProxySubTokens: String(plan.maxProxySubTokens ?? 0),
    maxProxyDevices: String(plan.maxProxyDevices ?? 0),
    proxySubTemplateId: String(plan.proxySubTemplateId ?? 0),
    allowExternalSubSources: !!plan.allowExternalSubSources,
    showSubInfoNodes: !!plan.showSubInfoNodes,
    maxConnections: String(plan.maxConnections ?? 2000),
    maxIPs: String(plan.maxIPs ?? 10),
    allowProxySubscription: !!plan.allowProxySubscription,
    isActive: !!plan.isActive,
    isStoreVisible: !!plan.isStoreVisible,
    syncExistingSubscribers: true,
    sortOrder: String(plan.sortOrder ?? 0),
    referralRate: formatRateBps(plan.referralRateBps),
    hostIds: plan.hostIds || [],
    tunnelIds: plan.tunnelIds || [],
    forwardGroupIds: plan.forwardGroupIds || [],
    proxyNodeIds: plan.proxyNodeIds || [],
    dedicatedProxyPort: !!plan.dedicatedProxyPort,
    priceTiers: (plan.priceTiers || []).map((tier: any) => ({
      durationDays: String(tier.durationDays ?? 30),
      price: String((Number(tier.priceCents || 0) / 100).toFixed(2)),
    })),
    trafficAddons: (plan.trafficAddons || []).map((addon: any, index: number) => ({
      trafficGB: String(Number(addon.trafficBytes || 0) / 1024 / 1024 / 1024 || 0),
      price: String((Number(addon.priceCents || 0) / 100).toFixed(2)),
      isActive: addon.isActive !== false,
      sortOrder: String(addon.sortOrder ?? index),
    })),
  };
}

function payload(form: PlanForm) {
  const durationDays = Number(form.durationDays || 30);
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    priceCents: Math.round(Number(form.price || 0) * 100),
    currency: (form.currency || "CNY").toUpperCase(),
    durationDays: Math.min(3650, Math.max(1, Math.floor(durationDays || 30))),
    portCount: Math.max(1, Math.floor(Number(form.portCount || 1))),
    trafficLimit: Math.max(0, Math.floor(Number(form.trafficGB || 0) * 1024 * 1024 * 1024)),
    rateLimitMbps: Math.max(0, Math.floor(Number(form.rateLimitMbps || 0))),
    maxRules: Math.max(0, Math.floor(Number(form.maxRules || 0))),
    maxProxyInbounds: Math.max(0, Math.floor(Number(form.maxProxyInbounds || 0))),
    maxProxySubTokens: Math.max(0, Math.floor(Number(form.maxProxySubTokens || 0))),
    maxProxyDevices: Math.max(0, Math.floor(Number(form.maxProxyDevices || 0))),
    proxySubTemplateId: Math.max(0, Math.floor(Number(form.proxySubTemplateId || 0))),
    allowExternalSubSources: form.allowExternalSubSources,
    showSubInfoNodes: form.showSubInfoNodes,
    maxConnections: Math.max(0, Math.floor(Number(form.maxConnections || 0))),
    maxIPs: Math.max(0, Math.floor(Number(form.maxIPs || 0))),
    allowProxySubscription: form.allowProxySubscription,
    isActive: form.isActive,
    isStoreVisible: form.isActive && form.isStoreVisible,
    sortOrder: Math.max(0, Math.floor(Number(form.sortOrder || 0))),
    // save() 已经校验过；这里解析不了时按 0（不返利）兜底，不会凭空返钱。
    referralRateBps: parseRatePercentToBps(form.referralRate) ?? 0,
    hostIds: form.hostIds,
    tunnelIds: form.tunnelIds,
    forwardGroupIds: form.forwardGroupIds,
    proxyNodeIds: form.proxyNodeIds,
    dedicatedProxyPort: form.dedicatedProxyPort,
    priceTiers: form.priceTiers
      .map((tier) => ({
        durationDays: Math.min(3650, Math.max(1, Math.floor(Number(tier.durationDays || 0)))),
        priceCents: Math.max(0, Math.round(Number(tier.price || 0) * 100)),
      }))
      .filter((tier) => Number.isFinite(tier.durationDays) && tier.durationDays > 0),
    trafficAddons: form.trafficAddons
      .map((addon, index) => ({
        trafficBytes: Math.max(0, Math.floor(Number(addon.trafficGB || 0) * 1024 * 1024 * 1024)),
        priceCents: Math.max(0, Math.round(Number(addon.price || 0) * 100)),
        isActive: addon.isActive,
        sortOrder: Math.max(0, Math.floor(Number(addon.sortOrder || index))),
      }))
      .filter((addon) => addon.trafficBytes > 0),
  };
}

export default function Plans() {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<PlanForm>(emptyForm);
  const subTemplatesQuery = trpc.proxySubscriptions.adminListTemplates.useQuery();
  const [editing, setEditing] = useState(false);
  const [planDialogTab, setPlanDialogTab] = useState<PlanDialogTab>("settings");
  const [assignOpen, setAssignOpen] = useState(false);
  // 页头的「新增计费资源」：每点一次 +1，TrafficBillingSection 转给计费资源列表开新建弹窗
  const [billingCreateKey, setBillingCreateKey] = useState(0);
  const [assignUserId, setAssignUserId] = useState("");
  const [assignPlanId, setAssignPlanId] = useState("");
  const [assignDurationDays, setAssignDurationDays] = useState("30");
  const [activeTab, setActiveTab] = useUrlTab<PlanManageTab>({
    values: PLAN_MANAGE_TABS,
    defaultValue: "plans",
    storageKey: PLAN_MANAGE_TAB_STORAGE_KEY,
  });
  const [, navigate] = useLocation();
  const [planViewMode, setPlanViewMode] = useState<PlanListViewMode>(() => getStoredPlanListViewMode());
  const [statusUpdatingPlanId, setStatusUpdatingPlanId] = useState<number | null>(null);

  const planPageRequest = usePersistentPageRequest("forwardx.plans.page");
  const planPageInput = { page: planPageRequest.page, pageSize: 12 } as const;
  const planPageQuery = trpc.plans.listPage.useQuery(planPageInput, {
    enabled: activeTab === "plans",
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  /*
    无条件发：这三张统计卡（套餐数量、套餐资源，以及「商店状态」那行「N 个套餐的
    购买入口不生效」）挂在**页头**，两个 tab 都看得见，而查询原来跟着
    `activeTab === "plans"` 走。点到「流量计费」那一侧，planSummary 变 undefined，
    卡片就一路回落到 0：面板上明明有 2 个套餐、12 份资源，同一个页面换个 tab 就说
    「套餐数量 0」。跟之前按量计费那张状态卡是同一个毛病 —— 页头的数字不归 tab 管。
  */
  const planSummaryQuery = trpc.plans.summary.useQuery(undefined, {
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const plans = (planPageQuery.data?.items || []) as any[];
  const isLoading = planPageQuery.isLoading;
  const planSummary = planSummaryQuery.data;
  const planSummaryLoading = planSummaryQuery.isLoading;
  const planPagination = useServerPagination(
    plans,
    Number(planPageQuery.data?.totalItems || 0),
    planPageRequest,
    { pageSize: 12, isReady: !isLoading && !!planPageQuery.data },
  );

  const { data: storeStatus, isLoading: storeStatusLoading } = trpc.plans.storeStatus.useQuery();
  const needsPlanResourceOptions = editing && planDialogTab === "resources";
  const { data: hosts = [], isLoading: hostsLoading } = trpc.hosts.options.useQuery(undefined, {
    enabled: needsPlanResourceOptions,
    staleTime: 30_000,
  });
  const { data: tunnels = [], isLoading: tunnelsLoading } = trpc.tunnels.options.useQuery(undefined, {
    enabled: needsPlanResourceOptions,
    staleTime: 30_000,
  });
  const { data: forwardGroups = [], isLoading: forwardGroupsLoading } = trpc.forwardGroups.options.useQuery(undefined, {
    enabled: needsPlanResourceOptions,
    staleTime: 30_000,
  });
  const { data: users = [] } = trpc.users.options.useQuery(undefined, {
    enabled: assignOpen,
    staleTime: 30_000,
  });
  const { data: planOptions = [] } = trpc.plans.options.useQuery(undefined, {
    enabled: assignOpen,
    staleTime: 30_000,
  });
  // 无条件发：这张卡片要说的是「按量计费现在开没开」，不能因为你没点开某个 tab
  // 就一律显示「已关闭」—— 那是在关于钱的事情上说假话。
  const { data: trafficBillingData, isLoading: trafficBillingLoading } = trpc.trafficBilling.configs.useQuery(undefined, {
    staleTime: 30_000,
  });

  const createPlan = trpc.plans.create.useMutation({
    onSuccess: () => {
      toast.success("套餐已创建");
      setEditing(false);
      setForm(emptyForm);
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
    },
    onError: (error) => toast.error(error.message || "创建失败"),
  });

  const updatePlan = trpc.plans.update.useMutation({
    onSuccess: () => {
      toast.success("套餐已保存");
      setEditing(false);
      setForm(emptyForm);
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
      utils.plans.storeList.invalidate();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const updatePlanStatus = trpc.plans.updateStatus.useMutation({
    onMutate: async (variables) => {
      setStatusUpdatingPlanId(variables.id);
      await utils.plans.list.cancel();
      const previous = utils.plans.list.getData();
      utils.plans.list.setData(
        undefined,
        (previous || []).map((plan: any) =>
          Number(plan.id) === Number(variables.id)
            ? { ...plan, isActive: variables.isActive, isStoreVisible: variables.isActive && variables.isStoreVisible }
            : plan,
        ) as any,
      );
      return { previous };
    },
    onSuccess: (_result, variables) => {
      toast.success(variables.isActive ? "套餐状态已更新" : "套餐已停用");
      utils.plans.storeList.invalidate();
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.plans.list.setData(undefined, context.previous as any);
      toast.error(error.message || "状态更新失败");
    },
    onSettled: () => {
      setStatusUpdatingPlanId(null);
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
      utils.plans.storeList.invalidate();
    },
  });

  const confirmDialog = useConfirmDialog();
  /*
    原来点垃圾桶就删，没有确认 —— 而删套餐的后果比看上去大：订阅的主机、隧道、转发组
    默认跟着套餐当前绑的走（只有改套餐时选了「不同步已有订阅者」的才冻进订阅），删掉套餐
    连绑定一起删，这些用户手里的资源跟着就没了。停用才是「不再卖」：只挡分配、购买和
    自动续费，已有订阅照常用到到期（billingRepository 里那几处 isActive 判断）。
  */
  const confirmDeletePlan = (plan: any) => {
    void confirmDialog({
      title: `删除套餐「${plan.name}」`,
      description: "已经买了它的用户，订阅里跟着这个套餐走的主机、隧道、转发组会一起没有（改套餐时冻结过内容的订阅除外）。只是不想再卖的话，关掉「启用」就行：已有订阅照常用到到期。有待支付或待发放的订单时删不掉。",
      confirmText: "删除",
      tone: "destructive",
    }).then((confirmed) => {
      if (confirmed) deletePlan.mutate({ id: plan.id });
    });
  };
  const deletePlan = trpc.plans.delete.useMutation({
    onSuccess: () => {
      toast.success("套餐已删除");
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const setStoreEnabled = trpc.plans.setStoreEnabled.useMutation({
    onMutate: async ({ enabled }) => {
      await utils.plans.storeStatus.cancel();
      const previous = utils.plans.storeStatus.getData();
      utils.plans.storeStatus.setData(undefined, { enabled });
      return { previous };
    },
    onSuccess: (_result, { enabled }) => {
      utils.plans.storeStatus.setData(undefined, { enabled });
      utils.plans.storeList.invalidate();
      toast.success(enabled ? "套餐商店已开启" : "套餐商店已关闭");
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.plans.storeStatus.setData(undefined, context.previous);
      toast.error(error.message || "更新失败");
    },
    onSettled: async () => {
      await utils.plans.storeStatus.invalidate();
    },
  });


  const assignPlan = trpc.plans.assign.useMutation({
    onSuccess: (result) => {
      toast.success(`套餐已分配，端口段 ${result.portRangeStart}-${result.portRangeEnd}`);
      setAssignOpen(false);
      setAssignUserId("");
      setAssignPlanId("");
      setAssignDurationDays("30");
      utils.plans.subscriptions.invalidate();
      utils.plans.subscriptionsPage.invalidate();
      utils.users.options.invalidate();
      utils.users.listPage.invalidate();
    },
    onError: (error) => toast.error(error.message || "分配失败"),
  });

  const activePlans = Number(planSummary?.activeItems ?? planPageQuery.data?.activeItems ?? 0);
  const storeEnabled = !!storeStatus?.enabled;
  /**
   * 套餐能挂的落地节点。跟「分享」用的是同一份清单 —— 挂上之后，用户一买
   * （或被分配）面板就在这些节点上给他发一份独立凭据，到期自动收回。
   */
  const { data: proxyNodeOptions = [], isLoading: proxyNodeOptionsLoading } = trpc.plans.proxyNodeOptions.useQuery(undefined, {
    staleTime: 30_000,
  });
  const storeVisiblePlans = Number(planSummary?.storeVisibleItems ?? 0);
  const trafficBillingEnabled = !!trafficBillingData?.enabled;
  const trafficBillingConfigs = trafficBillingData?.configs || [];
  const forwardGroupMap = useMemo<Map<number, any>>(() => {
    const map = new Map<number, any>();
    for (const plan of plans) {
      for (const ref of Array.isArray(plan?.forwardGroupRefs) ? plan.forwardGroupRefs : []) {
        const id = Number(ref?.id || 0);
        if (id > 0) map.set(id, ref);
      }
    }
    for (const group of forwardGroups) map.set(Number(group.id), group);
    return map;
  }, [forwardGroups, plans]);
  const planResourceSummary = planSummary?.resources || {
    ports: 0,
    tunnels: 0,
    chains: 0,
    groups: 0,
    legacyHosts: 0,
    otherForwardResources: 0,
  };
  const planResourceTotal = planResourceSummary.ports
    + planResourceSummary.tunnels
    + planResourceSummary.chains
    + planResourceSummary.groups
    + planResourceSummary.legacyHosts
    + planResourceSummary.otherForwardResources;
  // 资源明细只列有的那几类：「0 个端口转发 · 3 条隧道」里那个 0 是噪音。
  const planResourceBreakdown = [
    planResourceSummary.ports > 0 ? `${planResourceSummary.ports} 个端口转发` : "",
    planResourceSummary.tunnels > 0 ? `${planResourceSummary.tunnels} 条隧道` : "",
    planResourceSummary.chains > 0 ? `${planResourceSummary.chains} 条转发链` : "",
    planResourceSummary.groups > 0 ? `${planResourceSummary.groups} 个转发组` : "",
    planResourceSummary.legacyHosts > 0 ? `${planResourceSummary.legacyHosts} 个历史主机` : "",
    planResourceSummary.otherForwardResources > 0 ? `${planResourceSummary.otherForwardResources} 个兼容资源` : "",
  ].filter(Boolean).join(" · ");
  const selectedTunnelIds = useMemo(() => new Set(form.tunnelIds.map(Number)), [form.tunnelIds]);
  const selectedForwardGroupIds = useMemo(() => new Set(form.forwardGroupIds.map(Number)), [form.forwardGroupIds]);
  const portForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isPortForwardGroup(group)), [forwardGroups]);
  const chainForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isChainForwardGroup(group)), [forwardGroups]);
  const standardForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isStandardForwardGroup(group)), [forwardGroups]);
  const proxyNodeById = useMemo<Map<number, any>>(
    () => new Map((proxyNodeOptions as any[]).map((node) => [Number(node.id), node])),
    [proxyNodeOptions],
  );
  const selectedProxyNodes = useMemo(
    () => form.proxyNodeIds.map(Number).map((id) => proxyNodeById.get(id) || { id, name: `节点 #${id}` }),
    [form.proxyNodeIds, proxyNodeById],
  );
  const availableProxyNodes = useMemo(
    () => (proxyNodeOptions as any[]).filter((node) => !form.proxyNodeIds.map(Number).includes(Number(node.id))),
    [proxyNodeOptions, form.proxyNodeIds],
  );
  const selectedHosts = useMemo(() => selectedResourceItems(form.hostIds, hosts, "主机"), [form.hostIds, hosts]);
  const selectedTunnels = useMemo(() => selectedResourceItems(form.tunnelIds, tunnels, "隧道"), [form.tunnelIds, tunnels]);
  const selectedAssignPlan = useMemo(
    () => planOptions.find((plan: any) => Number(plan.id) === Number(assignPlanId)) || null,
    [assignPlanId, planOptions],
  );
  /**
   * 手动分配能选哪些周期。
   *
   * 套餐挂了多档之后，这里必须把那些档都列出来 —— 只给默认档的话，卖月付 / 年付
   * 的套餐，管理员想手动给一个年付都给不了。月付套餐仍然保留 1/3/6 个月这几个
   * 整月倍数（老behavior），再加一个「永久」。
   */
  const assignDurationChoices = useMemo(() => {
    if (!selectedAssignPlan) return [] as Array<{ value: string; label: string }>;
    const tiers = planPricingOptions(selectedAssignPlan as any, (selectedAssignPlan as any).priceTiers);
    const seen = new Set<number>();
    const out: Array<{ value: string; label: string }> = [];
    const push = (days: number, label?: string) => {
      if (seen.has(days)) return;
      seen.add(days);
      out.push({ value: String(days), label: label || durationLabel(days) });
    };
    for (const tier of tiers) push(tier.durationDays);
    if (Number(selectedAssignPlan.durationDays) === 30) for (const days of [30, 90, 180]) push(days);
    push(0, "永久");
    return out;
  }, [selectedAssignPlan]);
  const selectedPortForwardIds = useMemo(
    () => form.forwardGroupIds.map(Number).filter((id) => isPortForwardGroup(forwardGroupMap.get(id))),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedChainForwardIds = useMemo(
    () => form.forwardGroupIds.map(Number).filter((id) => isChainForwardGroup(forwardGroupMap.get(id))),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedStandardForwardGroupIds = useMemo(
    () => form.forwardGroupIds.map(Number).filter((id) => isStandardForwardGroup(forwardGroupMap.get(id))),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedOtherForwardResourceIds = useMemo(
    () =>
      form.forwardGroupIds
        .map(Number)
        .filter((id) => {
          const group = forwardGroupMap.get(id);
          return !group || (!isPortForwardGroup(group) && !isChainForwardGroup(group) && !isStandardForwardGroup(group));
        }),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedPortForwards = useMemo(
    () => selectedResourceItems(selectedPortForwardIds, portForwardGroups, "端口转发"),
    [portForwardGroups, selectedPortForwardIds],
  );
  const selectedChains = useMemo(
    () => selectedResourceItems(selectedChainForwardIds, chainForwardGroups, "转发链"),
    [chainForwardGroups, selectedChainForwardIds],
  );
  const selectedManagedForwardGroups = useMemo(
    () => selectedResourceItems(selectedStandardForwardGroupIds, standardForwardGroups, "转发组"),
    [selectedStandardForwardGroupIds, standardForwardGroups],
  );
  const selectedOtherForwardResources = useMemo(
    () => selectedResourceItems(selectedOtherForwardResourceIds, forwardGroups, "转发资源"),
    [forwardGroups, selectedOtherForwardResourceIds],
  );
  const availableTunnels = useMemo(() => tunnels.filter((tunnel: any) => !selectedTunnelIds.has(Number(tunnel.id))), [tunnels, selectedTunnelIds]);
  const availablePortForwards = useMemo(
    () => portForwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))),
    [portForwardGroups, selectedForwardGroupIds],
  );
  const availableChains = useMemo(
    () => chainForwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))),
    [chainForwardGroups, selectedForwardGroupIds],
  );
  const availableManagedForwardGroups = useMemo(
    () => standardForwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))),
    [selectedForwardGroupIds, standardForwardGroups],
  );

  const openPlanCreate = () => {
    setForm(emptyForm);
    setPlanDialogTab("settings");
    setEditing(true);
  };

  const openPlanEdit = (plan: any) => {
    setForm(toForm(plan));
    setPlanDialogTab("settings");
    setEditing(true);
  };
  const openCreate = () => openPlanCreate();

  const handlePlanViewModeChange = (viewMode: PlanListViewMode) => {
    setPlanViewMode(viewMode);
    storePlanListViewMode(viewMode);
  };

  const save = () => {
    if (!form.name.trim()) {
      setPlanDialogTab("settings");
      return toast.error("请填写套餐名称");
    }
    if (form.hostIds.length === 0 && form.tunnelIds.length === 0 && form.forwardGroupIds.length === 0) {
      setPlanDialogTab("resources");
      toast.error("至少选择一个端口转发、隧道、转发链或转发组");
      return;
    }
    /*
      开了一档却没填价，直接存下去就是 0 元 —— 商店里那一档立刻变成白送，
      而管理端看上去一切正常。0 是合法价（送的、内部用的），所以只拦「空着」。
    */
    const unpriced = unpricedTierLabels(form);
    if (unpriced.length > 0) {
      setPlanDialogTab("settings");
      toast.error(`「${unpriced.join("」「")}」还没填价格`, {
        description: "留空会按 0 元卖出去。真要送就填 0。",
      });
      return;
    }
    if (parseRatePercentToBps(form.referralRate) === null) {
      setPlanDialogTab("settings");
      toast.error("邀请返利比例需在 0 到 100 之间，最多两位小数");
      return;
    }
    const data = payload(form);
    if (form.id) updatePlan.mutate({ id: form.id, syncExistingSubscribers: form.syncExistingSubscribers, ...data });
    else createPlan.mutate(data);
  };
  const togglePlanActive = (plan: any) => {
    const isActive = !plan.isActive;
    updatePlanStatus.mutate({
      id: Number(plan.id),
      isActive,
      isStoreVisible: isActive ? !!plan.isStoreVisible : false,
    });
  };
  const togglePlanStoreVisible = (plan: any) => {
    if (!plan.isActive) {
      toast.info("套餐启用后才能开启商店展示");
      return;
    }
    updatePlanStatus.mutate({
      id: Number(plan.id),
      isActive: true,
      isStoreVisible: !plan.isStoreVisible,
    });
  };
  const submitAssignPlan = () => {
    if (!assignUserId || !assignPlanId) return;
    const durationDays = assignDurationChoices.length > 0 ? Number(assignDurationDays) : undefined;
    assignPlan.mutate({
      userId: Number(assignUserId),
      planId: Number(assignPlanId),
      durationDays,
    });
  };
  const addPlanResource = (key: PlanResourceKey, value: string) => {
    const id = Number(value);
    if (!id) return;
    setForm((current) => {
      const ids = current[key].map(Number);
      if (ids.includes(id)) return current;
      return { ...current, [key]: [...ids, id] };
    });
  };
  const removePlanResource = (key: PlanResourceKey, id: number) => {
    setForm((current) => ({ ...current, [key]: current[key].map(Number).filter((item) => item !== Number(id)) }));
  };
  const updateTrafficAddon = (index: number, patch: Partial<TrafficAddonForm>) => {
    setForm((current) => ({
      ...current,
      trafficAddons: current.trafficAddons.map((addon, addonIndex) => addonIndex === index ? { ...addon, ...patch } : addon),
    }));
  };
  const addTrafficAddon = () => {
    setForm((current) => ({
      ...current,
      trafficAddons: [
        ...current.trafficAddons,
        { trafficGB: "50", price: "10", isActive: true, sortOrder: String(current.trafficAddons.length) },
      ],
    }));
  };
  const removeTrafficAddon = (index: number) => {
    setForm((current) => ({
      ...current,
      trafficAddons: current.trafficAddons.filter((_, addonIndex) => addonIndex !== index),
    }));
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <WorkspaceHeader title={<>套餐管理</>} description={<>配置套餐、资源和端口。</>} actions={<>
            {/* 两个 tab 的「新增」在同一个位置（2026-10-21 用户要的）：套餐计费 → 新增套餐，流量计费 → 新增计费资源 */}
            {activeTab === "billing" ? (
              <Button onClick={() => setBillingCreateKey((value) => value + 1)}>
                <Plus className="mr-2 h-4 w-4" /> 新增计费资源
              </Button>
            ) : (
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> 新增套餐
              </Button>
            )}
            {/* 手动分配一个月用不了几次，收进「···」，页头只留一个主操作（标准布局重构工作包五） */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="更多套餐操作"><span aria-hidden="true">•••</span></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setAssignOpen(true)}>
                  <Settings2 className="h-4 w-4" />手动分配
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>} />

        {/*
          页头原来是四张卡：两张是开关（按量计费、商店），两张是数（套餐、资源），长得一样。
          数放进一条摘要；开关是设置，照设置页的写法放进分组列表 —— 手机上四张卡原来要翻
          一整屏才看到第一个套餐。
        */}
        <SummaryStrip
          ariaLabel="套餐概况"
          loading={planSummaryLoading}
          items={[
            { key: "plans", label: "套餐", value: Number(planSummary?.totalItems || 0), hint: `${activePlans} 个已启用`, cacheKey: "plans.count", fallbackValue: 0 },
            { key: "resources", label: "套餐资源", value: planResourceTotal, hint: planResourceBreakdown || "还没有资源", title: planResourceBreakdown || undefined, cacheKey: "plans.resourceTotal", fallbackValue: 0 },
            /*
              按量计费：只读，开关在「流量计费」tab 里统一管，点这一格就过去（原来是「对用户开放」里的一行）。
              它读的 trafficBilling.configs 查询无条件发，状态是真的 —— 以前带着 enabled: activeTab === "billing"，
              默认 tab 下根本不发，于是永远显示「已关闭」。
            */
            {
              key: "billing",
              label: "按量计费",
              value: trafficBillingLoading ? "…" : trafficBillingEnabled ? "已开启" : "已关闭",
              hint: trafficBillingEnabled ? `${trafficBillingConfigs.length} 个资源在按 GB 扣余额` : "配了价的资源也不扣",
              icon: Coins,
              onClick: () => setActiveTab("billing"),
            },
          ]}
        />
        <ListSection header="对用户开放">
          <ListRow
            icon={<ShoppingBag className="h-4 w-4" />}
            label="商店"
            detail={storeEnabled
              ? "开着：用户可以自助购买。"
              : storeVisiblePlans > 0
                ? `关着：${storeVisiblePlans} 个套餐的「购买入口」都不生效。`
                : "关着：用户面板里没有商店。"}
            trailing={(
              <OptimisticSwitch
                aria-label="商店"
                checked={storeEnabled}
                disabled={storeStatusLoading}
                onCheckedChangeAsync={(enabled) => setStoreEnabled.mutateAsync({ enabled })}
              />
            )}
          />
        </ListSection>



        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PlanManageTab)} className="space-y-4">
          <SlidingTabsList items={PLAN_MANAGE_TAB_ITEMS} activeValue={activeTab} ariaLabel="套餐管理" minItemWidthRem={9.5} />

          <TabsContent value="plans" className="mt-0 space-y-3">
            {/*
              原来这里是一张「套餐列表」大卡，套餐卡一张张嵌在里面（卡里套卡）。标题和上面
              选中的「套餐计费」是同一句话；留下说明和视图切换，卡片直接坐在页面上，和主机、
              规则的卡片一样。表格视图才需要一块白底托住。
            */}
            {/* 手机 + 精简：说明收起后这一行只剩一个视图切换，手机上卡片就够，整行不画（data-fx-compact-hide-phone） */}
            <div data-fx-compact-hide-phone="" className="flex items-center justify-between gap-3">
              <div data-fx-help="" className="min-w-0 text-meta text-muted-foreground">订阅后分配连续端口段。</div>
                <ViewModeToggle className="flex shrink-0"
                  value={planViewMode}
                  onChange={handlePlanViewModeChange}
                  items={[
                    { value: "card", label: "卡片视图", icon: LayoutGrid },
                    { value: "table", label: "列表视图", icon: List },
                  ]}
                />
            </div>
            <div>
                {isLoading ? (
                  <DataSectionLoading label="正在加载套餐数据" />
                ) : (
                  <AutoAnimateContainer duration={220}>
                    {planViewMode === "card" ? (
                      <AutoAnimateContainer key="plan-card-view" className="standard-card-grid gap-3" duration={220}>
                        {plans.map((plan: any) => (
                          <PlanCard
                            key={plan.id}
                            plan={plan}
                            resourceParts={planResourcePartsForDisplay(plan, forwardGroupMap)}
                            toggling={statusUpdatingPlanId === Number(plan.id)}
                            onEdit={() => openPlanEdit(plan)}
                            onDelete={() => confirmDeletePlan(plan)}
                            onToggleActive={() => togglePlanActive(plan)}
                            onToggleStoreVisible={() => togglePlanStoreVisible(plan)}
                          />
                        ))}
                        {/* 读失败时说「还没有套餐」，管理员下一步就是重新建一遍。 */}
                        {plans.length === 0 && (planPageQuery.error ? (
                          <DataSectionError
                            className="col-span-full"
                            label="套餐列表"
                            error={planPageQuery.error}
                            retrying={planPageQuery.isFetching}
                            onRetry={() => { void planPageQuery.refetch(); }}
                            minHeight="min-h-[120px]"
                          />
                        ) : (
                          <EmptyState className="col-span-full" icon={<Package />} title="还没有套餐" description="用「新增套餐」建第一个；建好之后可以放上商店，也可以手动分配给用户。" />
                        ))}
                      </AutoAnimateContainer>
                    ) : (
                      <div key="plan-table-view" className="overflow-x-auto rounded-[var(--fx-radius-surface)] border border-[var(--fx-stroke-weak)] bg-[var(--fx-l1-surface)]">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>套餐</TableHead>
                              <TableHead>价格</TableHead>
                              <TableHead>资源</TableHead>
                              <TableHead>限制</TableHead>
                              <TableHead>状态</TableHead>
                              <TableHead className="text-right">操作</TableHead>
                            </TableRow>
                          </TableHeader>
                          <AutoAnimateContainer as={TableBody} duration={220}>
                            {plans.map((plan: any) => (
                              <TableRow key={plan.id}>
                                <TableCell>
                                  <div className="font-medium">{plan.name}</div>
                                  <div className="max-w-md truncate text-xs text-muted-foreground">{planDescriptionSummary(plan.description) || "无描述"}</div>
                                </TableCell>
                                <TableCell>{money(plan.priceCents, plan.currency)} / {durationLabel(plan.durationDays)}</TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1">
                                    {planResourcePartsForDisplay(plan, forwardGroupMap).map((item) => (
                                      <Badge key={item.label} variant="outline">{item.label} {item.count}</Badge>
                                    ))}
                                  </div>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  <div>{plan.portCount} 个端口</div>
                                  <div>规则 {plan.maxRules || "不限"} · 流量 {formatQuotaBytes(plan.trafficLimit)}</div>
                                  <div>附加流量 {plan.trafficAddons?.length || 0} 档</div>
                                  <div>连接 {plan.maxConnections || "不限"} · 单 IP {plan.maxIPs || "不限"} · 限速 {speed(plan.rateLimitMbps)}</div>
                                  <div>邀请返利 {referralRateText(plan.referralRateBps)}</div>
                                </TableCell>
                                <TableCell>
                                  <PlanStatusSwitches
                                    plan={plan}
                                    layout="inline"
                                    disabled={statusUpdatingPlanId === Number(plan.id)}
                                    onToggleActive={() => togglePlanActive(plan)}
                                    onToggleStoreVisible={() => togglePlanStoreVisible(plan)}
                                  />
                                </TableCell>
                                <TableCell className="text-right">
                                  <EntityActions
                                    className="justify-end"
                                    primary={[{ key: "edit", label: "编辑", ariaLabel: `编辑套餐 ${plan.name}`, onSelect: () => openPlanEdit(plan) }]}
                                    menu={[{ key: "delete", label: "删除", ariaLabel: `删除套餐 ${plan.name}`, destructive: true, onSelect: () => confirmDeletePlan(plan) }]}
                                    menuLabel={`${plan.name} 的更多操作`}
                                  />
                                </TableCell>
                              </TableRow>
                            ))}
                            {plans.length === 0 && (planPageQuery.error ? (
                              <DataTableErrorRow
                                colSpan={6}
                                label="套餐列表"
                                error={planPageQuery.error}
                                retrying={planPageQuery.isFetching}
                                onRetry={() => { void planPageQuery.refetch(); }}
                              />
                            ) : (
                              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">还没有套餐</TableCell></TableRow>
                            ))}
                          </AutoAnimateContainer>
                        </Table>
                      </div>
                    )}
                  </AutoAnimateContainer>
                )}
            </div>
            <PersistentPagination pagination={planPagination} itemName="个套餐" />
          </TabsContent>

          <TabsContent value="billing" className="mt-0">
            <TrafficBillingSection createRequestKey={billingCreateKey} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="px-4 pt-4 sm:px-5 sm:pt-5">
            <DialogTitle>{form.id ? "编辑套餐" : "新增套餐"}</DialogTitle>
            <DialogDescription data-fx-help="">配置套餐限制，并绑定订阅后可用资源。</DialogDescription>
          </DialogHeader>

          <Tabs value={planDialogTab} onValueChange={(value) => setPlanDialogTab(value as PlanDialogTab)} className="flex min-h-0 flex-1 flex-col px-4 sm:px-5">
            {/* shrink-0 同理：它和下面那块可滚区域是同一列的兄弟，不钉住会被压扁，
                压扁之后标签自己溢出来，盖在上面的说明文字上。 */}
            <TabsList className="grid h-auto w-full shrink-0 grid-cols-2">
              <TabsTrigger value="settings">套餐设置</TabsTrigger>
              <TabsTrigger value="resources">资源绑定</TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              <TabsContent value="settings" className="mt-4 space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
            <FormField className="space-y-2">
              <Label>套餐名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：基础套餐" />
            </FormField>
            <FormField className="space-y-2">
              <Label>价格</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                disabled={form.priceTiers.length > 0}
                value={form.priceTiers.length > 0 ? tierDefault(form)?.price ?? form.price : form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
              {form.priceTiers.length > 0 ? (
                <p className="text-xs text-muted-foreground">下面选了多种周期，这里由最便宜那一档决定。</p>
              ) : null}
            </FormField>
            <FormField className="space-y-2">
              <Label>有效期</Label>
              <Select
                value={form.durationDays}
                disabled={form.priceTiers.length > 0}
                onValueChange={(durationDays) => setForm({ ...form, durationDays })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {durationOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.priceTiers.length > 0 ? "同上：由下面选的周期决定。" : "超过一个月按月重置流量。"}
              </p>
            </FormField>
            <div className="space-y-3 sm:col-span-2">
              <Label>卖哪几种周期</Label>
              {/*
                原来这里是一个「加一档」按钮，加出来一行空的、要自己填天数 —— 而商家
                心里想的从来不是「120 天」，是「月付、季付、年付」。让人把脑子里的词
                翻译成天数，是把我们的存储格式摊给他看。

                现在点一下就开卖。天数仍然存得下（下面「其他周期」那一栏），因为确实
                有人卖 45 天、100 天这种，但那是少数人的事，不该挡在多数人前面。
              */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                点一下就开卖，再点一下就下架。一种都不选，就只卖上面那一档。
                选了多种，客户在商店里自己挑，长周期省了多少会自动算给他看。
              </p>
              <div className="flex flex-wrap gap-2">
                {PLAN_DURATION_PRESETS.map((preset) => {
                  const active = form.priceTiers.some((tier) => Number(tier.durationDays || 0) === preset.days);
                  const full = !active && form.priceTiers.length >= PLAN_PRICE_TIER_LIMIT;
                  return (
                    <Button
                      key={preset.days}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      disabled={full}
                      className="rounded-full"
                      onClick={() => setForm({
                        ...form,
                        priceTiers: active
                          ? form.priceTiers.filter((tier) => Number(tier.durationDays || 0) !== preset.days)
                          : sortTiersByDuration([...form.priceTiers, { durationDays: String(preset.days), price: "" }]),
                      })}
                    >
                      {active ? <Check className="mr-1 h-3.5 w-3.5" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
                      {preset.label}
                    </Button>
                  );
                })}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="rounded-full text-muted-foreground"
                  disabled={form.priceTiers.length >= PLAN_PRICE_TIER_LIMIT}
                  onClick={() => setForm({
                    ...form,
                    priceTiers: sortTiersByDuration([...form.priceTiers, nextTierDraft(form)]),
                  })}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  其他周期
                </Button>
              </div>
              {form.priceTiers.length > 0 ? (
                <div className="space-y-2">
                  {form.priceTiers.map((tier, index) => {
                    const days = Number(tier.durationDays || 0);
                    const preview = tierPreview(form);
                    const info = preview.find((item) => item.durationDays === days);
                    const isPreset = isPresetTierDays(days);
                    const unpriced = String(tier.price ?? "").trim() === "";
                    return (
                      <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5">
                        {isPreset ? (
                          <span className="w-16 shrink-0 text-sm font-medium">{planDurationLabel(days)}</span>
                        ) : (
                          <div className="flex w-24 shrink-0 items-center gap-1">
                            <Input aria-label="自定义时长天数"
                              type="number"
                              min={1}
                              max={3650}
                              className="h-9"
                              value={tier.durationDays}
                              onChange={(e) => setForm({
                                ...form,
                                priceTiers: form.priceTiers.map((item, i) => i === index ? { ...item, durationDays: e.target.value } : item),
                              })}
                            />
                            <span className="shrink-0 text-xs text-muted-foreground">天</span>
                          </div>
                        )}
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <span className="shrink-0 text-xs text-muted-foreground">¥</span>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            className="h-9"
                            placeholder="填个价"
                            value={tier.price}
                            onChange={(e) => setForm({
                              ...form,
                              priceTiers: form.priceTiers.map((item, i) => i === index ? { ...item, price: e.target.value } : item),
                            })}
                          />
                        </div>
                        {/* 折成每月多少钱：商家自己也要一眼看出这几档之间划不划算。 */}
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {unpriced
                            ? "还没定价"
                            : info
                              ? `约 ¥${(planMonthlyEquivalentCents(info) / 100).toFixed(2)}/月${info.discountPercent > 0 ? ` · 省 ${info.discountPercent}%` : ""}`
                              : ""}
                        </span>
                        <Button
                          type="button"
                          size="icon" aria-label="删除价格档位"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          onClick={() => setForm({ ...form, priceTiers: form.priceTiers.filter((_, i) => i !== index) })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <FormField className="space-y-2">
              <Label>连续端口数</Label>
              <Input type="number" min={1} max={1024} value={form.portCount} onChange={(e) => setForm({ ...form, portCount: e.target.value })} />
            </FormField>
            <FormField className="space-y-2">
              <Label>总流量（GB，0 为不限）</Label>
              <Input type="number" min={0} value={form.trafficGB} onChange={(e) => setForm({ ...form, trafficGB: e.target.value })} />
            </FormField>
            <FormField className="space-y-2">
              <Label>限速（Mbps，0 为不限）</Label>
              <Input type="number" min={0} max={1000000} step={1} value={form.rateLimitMbps} onChange={(e) => setForm({ ...form, rateLimitMbps: e.target.value })} />
            </FormField>
            <FormField className="space-y-2">
              <Label>最大规则数（0 为不限）</Label>
              <Input type="number" min={0} value={form.maxRules} onChange={(e) => setForm({ ...form, maxRules: e.target.value })} />
            </FormField>
            <FormField className="space-y-2">
              <Label>最大落地节点数（0 为不限）</Label>
              <Input type="number" min={0} value={form.maxProxyInbounds} onChange={(e) => setForm({ ...form, maxProxyInbounds: e.target.value })} />
              <p data-fx-help="" className="text-xs text-muted-foreground">买了这个套餐能自己开几个落地节点。只在套餐开了客户端订阅时才有意义。</p>
            </FormField>
            <FormField className="space-y-2">
              <Label>最大订阅地址数（0 为不限）</Label>
              <Input type="number" min={0} value={form.maxProxySubTokens} onChange={(e) => setForm({ ...form, maxProxySubTokens: e.target.value })} />
              <p data-fx-help="" className="text-xs text-muted-foreground">能生成几条订阅地址。同样只在开了客户端订阅时才有意义。</p>
            </FormField>
            <FormField className="space-y-2">
              <Label>订阅设备数（0 为不限）</Label>
              <Input type="number" min={0} value={form.maxProxyDevices} onChange={(e) => setForm({ ...form, maxProxyDevices: e.target.value })} />
              <p data-fx-help="" className="text-xs text-muted-foreground">一条订阅地址最多在几台设备上用。要在「订阅运营 → 设置」里开了设备数限制才生效。</p>
            </FormField>
            <FormField className="space-y-2">
              <Label>订阅模板</Label>
              <Select value={form.proxySubTemplateId} onValueChange={(value) => setForm({ ...form, proxySubTemplateId: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">全局默认</SelectItem>
                  {(subTemplatesQuery.data?.templates || []).map((template) => (
                    <SelectItem key={template.id} value={String(template.id)}>{template.name}（{template.target}）</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p data-fx-help="" className="text-xs text-muted-foreground">买了这个套餐的人，规则订阅用哪份模板（「订阅运营 → 模板」里建）。</p>
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <div>
                  <Label className="text-sm">允许添加外部订阅</Label>
                  <p data-fx-help="" className="text-xs text-muted-foreground">还要在订阅运营里开总开关。</p>
                </div>
                <Checkbox aria-label="允许添加外部订阅" className="shrink-0" checked={form.allowExternalSubSources} onCheckedChange={(checked) => setForm({ ...form, allowExternalSubSources: checked === true })} />
              </FormField>
              <FormField className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <div>
                  <Label className="text-sm">订阅里插信息节点</Label>
                  <p data-fx-help="" className="text-xs text-muted-foreground">剩余流量、到期日、公告。</p>
                </div>
                <Checkbox aria-label="订阅里插信息节点" className="shrink-0" checked={form.showSubInfoNodes} onCheckedChange={(checked) => setForm({ ...form, showSubInfoNodes: checked === true })} />
              </FormField>
            </div>
            <FormField className="space-y-2">
              <Label>最大连接数</Label>
              <Input type="number" min={0} value={form.maxConnections} onChange={(e) => setForm({ ...form, maxConnections: e.target.value })} />
              <p data-fx-help="" className="text-xs text-muted-foreground">按主机或隧道聚合。</p>
            </FormField>
            <FormField className="space-y-2">
              <Label>单 IP 接入限制</Label>
              <Input type="number" min={0} value={form.maxIPs} onChange={(e) => setForm({ ...form, maxIPs: e.target.value })} />
            </FormField>
            <div className="space-y-2 sm:col-span-2">
              <FormField className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <Label>附带客户端订阅权限</Label>
                  <p data-fx-help="" className="mt-1 text-xs text-muted-foreground">
                    开启后，购买该套餐的用户即可使用客户端订阅。与转发权限不同，这项不会因为有订阅就自动开启。
                  </p>
                </div>
                <Checkbox
                  checked={form.allowProxySubscription}
                  onCheckedChange={(checked) => setForm({ ...form, allowProxySubscription: checked })}
                  className="mt-1 shrink-0"
                />
              </FormField>
              <p data-fx-help="" className="text-xs text-muted-foreground">同组规则共享限制。</p>
            </div>
            <FormField className="space-y-2">
              <Label htmlFor="plan-referral-rate">邀请返利比例（%）</Label>
              <Input
                id="plan-referral-rate"
                inputMode="decimal"
                placeholder="0"
                value={form.referralRate}
                onChange={(e) => setForm({ ...form, referralRate: e.target.value })}
                aria-invalid={parseRatePercentToBps(form.referralRate) === null}
              />
              <p data-fx-help="" className="text-xs text-muted-foreground">
                被邀请人买这个套餐（含续费）实付金额的百分之几返给邀请人，0 为不返。0 到 100，最多两位小数。需在「账单与兑换 › 邀请返利」里开启。
              </p>
            </FormField>
            <FormField className="space-y-2">
              <Label>排序</Label>
              <Input type="number" min={0} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
            </FormField>
                </div>

                <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">套餐状态</p>
                      <p className="text-xs text-muted-foreground">关闭后该套餐不可购买或分配。</p>
                    </div>
                    <Checkbox aria-label="套餐状态"
                      className="shrink-0"
                      checked={form.isActive}
                      onCheckedChange={(isActive) => setForm((current) => ({
                        ...current,
                        isActive,
                        isStoreVisible: isActive ? current.isStoreVisible : false,
                      }))}
                    />
                  </div>
                  <div className={`flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2 ${form.isActive ? "" : "opacity-60"}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">购买入口</p>
                      <p className="text-xs text-muted-foreground">
                        {storeEnabled
                          ? "开启后普通用户可在商店自助购买。"
                          : "商店总开关是关的，这里开了用户也看不到，得先去上面的「商店状态」打开。"}
                      </p>
                    </div>
                    <Checkbox aria-label="购买入口"
                      className="shrink-0"
                      checked={form.isActive && form.isStoreVisible}
                      disabled={!form.isActive}
                      onCheckedChange={(isStoreVisible) => setForm({ ...form, isStoreVisible })}
                    />
                  </div>
                  {form.id && (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2 sm:col-span-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">同步已购买用户</p>
                        <p data-fx-help="" className="text-xs text-muted-foreground">开启后保存套餐会同步已购买用户的生效权益；关闭后仅影响后续新购或新分配。</p>
                      </div>
                      <Checkbox
                        className="shrink-0"
                        checked={form.syncExistingSubscribers}
                        onCheckedChange={(syncExistingSubscribers) => setForm({ ...form, syncExistingSubscribers })}
                        title={form.syncExistingSubscribers ? "保存后同步已购买该套餐用户的生效权益" : "保存后仅影响后续新购或新分配，已购买用户保持当前权益"}
                      />
                    </div>
                  )}
                </div>

                <FormField className="space-y-2">
                  <PlanDescriptionEditor value={form.description} onChange={(description) => setForm({ ...form, description })} />
                </FormField>
              </TabsContent>

              <TabsContent value="resources" className="mt-3 space-y-3">
                <div className="space-y-3">
                  {true ? (
                    <>
                      {selectedHosts.length > 0 ? (
                        <PlanSelectedResourceList
                          title="历史主机绑定（兼容）"
                          countText={`${selectedHosts.length} 台`}
                          selectedItems={selectedHosts}
                          emptyText="当前没有历史主机绑定。"
                          note="仅用于兼容旧套餐，已不再支持新增主机绑定。"
                          onRemove={(id) => removePlanResource("hostIds", id)}
                          getId={(host) => Number(host.id)}
                          renderSelected={(host) => (
                            <PlanResourceOption
                              type="host"
                              item={host}
                              hosts={hosts}
                              title={hostTitle(host)}
                              kind="历史主机"
                              meta={hostMeta(host)}
                              showMultiplier={false}
                            />
                          )}
                        />
                      ) : null}
                      <PlanResourcePicker
                        title="端口转发"
                        countText={`${selectedPortForwards.length} 个`}
                        loading={forwardGroupsLoading}
                        loadingLabel="正在加载端口转发资源"
                        selectedItems={selectedPortForwards}
                        availableItems={availablePortForwards}
                        addPlaceholder="选择要添加的端口转发"
                        emptyText="暂未添加端口转发，可从下方选择添加。"
                        allAddedText={portForwardGroups.length > 0 ? "端口转发已全部添加" : "暂无可添加端口转发"}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || `端口转发 #${group.id}`}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? `${group.members.length} 成员` : forwardGroupTypeText(group)}
                          />
                        )}
                        renderSelected={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || `端口转发 #${group.id}`}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? `${group.members.length} 成员` : forwardGroupTypeText(group)}
                          />
                        )}
                      />
                      <PlanResourcePicker
                        title="隧道转发"
                        countText={`${form.tunnelIds.length} 条`}
                        loading={tunnelsLoading}
                        loadingLabel="正在加载隧道资源"
                        selectedItems={selectedTunnels}
                        availableItems={availableTunnels}
                        addPlaceholder="选择要添加的隧道"
                        emptyText="暂未添加隧道，可从下方选择添加。"
                        allAddedText={tunnels.length > 0 ? "隧道已全部添加" : "暂无可添加隧道"}
                        onAdd={(id) => addPlanResource("tunnelIds", id)}
                        onRemove={(id) => removePlanResource("tunnelIds", id)}
                        getId={(tunnel) => Number(tunnel.id)}
                        renderOption={(tunnel) => (
                          <PlanResourceOption
                            type="tunnel"
                            item={tunnel}
                            hosts={hosts}
                            title={tunnel.name || `隧道 #${tunnel.id}`}
                            kind={String(tunnel.mode || "").toUpperCase() || "隧道"}
                            meta={getTunnelRouteText(tunnel, hosts)}
                          />
                        )}
                        renderSelected={(tunnel) => (
                          <PlanResourceOption
                            type="tunnel"
                            item={tunnel}
                            hosts={hosts}
                            title={tunnel.name || `隧道 #${tunnel.id}`}
                            kind={String(tunnel.mode || "").toUpperCase() || "隧道"}
                            meta={getTunnelRouteText(tunnel, hosts)}
                          />
                        )}
                      />
                      <PlanResourcePicker
                        title="转发链"
                        countText={`${selectedChains.length} 条`}
                        loading={forwardGroupsLoading}
                        loadingLabel="正在加载转发链资源"
                        selectedItems={selectedChains}
                        availableItems={availableChains}
                        addPlaceholder="选择要添加的转发链"
                        emptyText="暂未添加转发链，可从下方选择添加。"
                        allAddedText={chainForwardGroups.length > 0 ? "转发链已全部添加" : "暂无可添加转发链"}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || `转发链 #${group.id}`}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? `${group.members.length} 节点` : forwardGroupTypeText(group)}
                          />
                        )}
                        renderSelected={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || `转发链 #${group.id}`}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? `${group.members.length} 节点` : forwardGroupTypeText(group)}
                          />
                        )}
                      />
                      <PlanResourcePicker
                        title="转发组"
                        countText={`${selectedManagedForwardGroups.length} 个`}
                        loading={forwardGroupsLoading}
                        loadingLabel="正在加载转发组资源"
                        selectedItems={selectedManagedForwardGroups}
                        availableItems={availableManagedForwardGroups}
                        addPlaceholder="选择要添加的转发组"
                        emptyText="暂未添加转发组，可从下方选择添加。"
                        allAddedText={standardForwardGroups.length > 0 ? "转发组已全部添加" : "暂无可添加转发组"}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || `转发组 #${group.id}`}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? `${group.members.length} 成员` : forwardGroupTypeText(group)}
                          />
                        )}
                        renderSelected={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || `转发组 #${group.id}`}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? `${group.members.length} 成员` : forwardGroupTypeText(group)}
                          />
                        )}
                      />
                      {selectedOtherForwardResources.length > 0 ? (
                        <PlanSelectedResourceList
                          title="其他转发资源（兼容）"
                          countText={`${selectedOtherForwardResources.length} 个`}
                          selectedItems={selectedOtherForwardResources}
                          emptyText="当前没有兼容转发资源。"
                          note="旧数据会继续保留，但这里不再支持新增入口组或出口组。"
                          onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                          getId={(group) => Number(group.id)}
                          renderSelected={(group) => (
                            <PlanResourceOption
                              type="forward_group"
                              item={group}
                              hosts={hosts}
                              title={group.name || `转发资源 #${group.id}`}
                              kind={forwardGroupTypeText(group)}
                              meta={(group.members || []).length ? `${group.members.length} 成员` : forwardGroupTypeText(group)}
                            />
                          )}
                        />
                      ) : null}
                    </>
                  ) : (
                    <></>
                  )}

                  <PlanResourcePicker
                    title="附带落地节点"
                    countText={`${selectedProxyNodes.length} 个`}
                    loading={proxyNodeOptionsLoading}
                    loadingLabel="正在加载落地节点"
                    selectedItems={selectedProxyNodes}
                    availableItems={availableProxyNodes}
                    addPlaceholder="选择要附带的落地节点"
                    emptyText="不附带节点。买了这个套餐的人只拿到转发权益，订阅里没有节点。"
                    allAddedText={(proxyNodeOptions as any[]).length > 0 ? "节点已全部附带" : "暂无可附带的节点"}
                    onAdd={(id) => addPlanResource("proxyNodeIds", id)}
                    onRemove={(id) => removePlanResource("proxyNodeIds", id)}
                    getId={(node) => Number(node.id)}
                    renderOption={(node) => (
                      <div className="min-w-0">
                        <p className="truncate text-sm">{node.name || `节点 #${node.id}`}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[node.protocol, node.address ? `${node.address}:${node.port}` : ""].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    )}
                    renderSelected={(node) => (
                      <div className="min-w-0">
                        <p className="truncate text-sm">{node.name || `节点 #${node.id}`}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[node.protocol, node.address ? `${node.address}:${node.port}` : ""].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    )}
                  />
                  {form.proxyNodeIds.length > 0 ? (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">给每人单开一个端口</p>
                        <p data-fx-help="" className="text-xs text-muted-foreground">
                          开：面板照着节点在同一台机器上给每位用户克隆一个端口，
                          <span className="font-medium text-foreground">流量能算到人头上</span>，可单独限速，代价是一人占一个端口。
                          关：大家共用原端口、各发一份凭据，省端口，但流量按端口统计、分不开。
                        </p>
                      </div>
                      <Checkbox aria-label="给每人单开一个端口"
                        className="shrink-0"
                        checked={form.dedicatedProxyPort}
                        onCheckedChange={(dedicatedProxyPort) => setForm({ ...form, dedicatedProxyPort })}
                      />
                    </div>
                  ) : null}
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    买了（或被分配）这个套餐的人，会在这些节点上<span className="font-medium text-foreground">各拿一份独立凭据</span>，直接出现在他的订阅里；
                    到期、取消、换套餐自动收回，不必手工分。支持一人一份凭据的协议才发得出来
                    （VLESS / VMess / Trojan / Hysteria2 / TUIC / AnyTLS）；
                    Shadowsocks / Snell 一个端口只有一份 PSK，挂上去等于大家共用同一份。
                  </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label className="text-sm font-medium">附加流量包</Label>
                <p data-fx-help="" className="mt-1 text-xs text-muted-foreground">用户在“我的套餐”内余额购买，仅当前流量周期有效。</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addTrafficAddon}>
                <Plus className="mr-2 h-4 w-4" /> 添加档位
              </Button>
            </div>
            <div className="space-y-2">
              {form.trafficAddons.map((addon, index) => (
                <div key={index} className="grid gap-2 rounded-md border border-border/50 p-3 sm:grid-cols-[1fr_1fr_110px_auto] sm:items-end">
                  <FormField className="space-y-1.5">
                    <Label className="text-xs">流量（GB）</Label>
                    <Input type="number" min={0} step="0.01" value={addon.trafficGB} onChange={(e) => updateTrafficAddon(index, { trafficGB: e.target.value })} />
                  </FormField>
                  <FormField className="space-y-1.5">
                    <Label className="text-xs">价格（元）</Label>
                    <Input type="number" min={0} step="0.01" value={addon.price} onChange={(e) => updateTrafficAddon(index, { price: e.target.value })} />
                  </FormField>
                  <label className="flex h-10 items-center justify-between gap-2 rounded-md border px-3 text-sm">
                    启用
                    <Checkbox aria-label="启用" checked={addon.isActive} onCheckedChange={(isActive) => updateTrafficAddon(index, { isActive })} />
                  </label>
                  <Button type="button" variant="ghost" size="icon" aria-label="删除流量加购" className="text-destructive" onClick={() => removeTrafficAddon(index)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {form.trafficAddons.length === 0 && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">未配置时用户不能自助购买附加流量。</div>
              )}
            </div>
          </div>

              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter className="border-t border-border/60 px-4 py-3 sm:px-5">
            <Button variant="outline" onClick={() => setEditing(false)}>取消</Button>
            <Button onClick={save} disabled={createPlan.isPending || updatePlan.isPending}>
              {(createPlan.isPending || updatePlan.isPending) ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={(open) => {
        setAssignOpen(open);
        if (!open) setAssignDurationDays("30");
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动分配套餐</DialogTitle>
            <DialogDescription>手动给用户分配套餐。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField className="space-y-2">
              <Label>用户</Label>
              <Select value={assignUserId} onValueChange={setAssignUserId}>
                <SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger>
                <SelectContent>
                  {users.map((user: any) => <SelectItem key={user.id} value={String(user.id)}>{user.name || user.username}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            <FormField className="space-y-2">
              <Label>套餐</Label>
              <Select value={assignPlanId} onValueChange={(value) => {
                setAssignPlanId(value);
                // 默认选这个套餐自己的默认档，而不是写死「一个月」—— 写死的话，
                // 一个只卖年付的套餐会默认分配成 30 天，而下拉里根本没有这一档。
                const picked = planOptions.find((plan: any) => Number(plan.id) === Number(value));
                const fallback = picked
                  ? defaultPricingOption(planPricingOptions(picked as any, (picked as any).priceTiers))
                  : null;
                setAssignDurationDays(String(fallback?.durationDays ?? 30));
              }}>
                <SelectTrigger><SelectValue placeholder="选择套餐" /></SelectTrigger>
                <SelectContent>
                  {planOptions.map((plan: any) => <SelectItem key={plan.id} value={String(plan.id)}>{plan.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            {selectedAssignPlan && assignDurationChoices.length > 0 ? (
              <FormField className="space-y-2">
                <Label>分配周期</Label>
                <Select value={assignDurationDays} onValueChange={setAssignDurationDays}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {assignDurationChoices.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p data-fx-help="" className="text-xs text-muted-foreground">
                  套餐挂着的周期都能选；选「永久」不设到期时间。手动分配不扣钱，也不走折扣。
                </p>
              </FormField>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>取消</Button>
            <Button
              onClick={submitAssignPlan}
              disabled={!assignUserId || !assignPlanId || assignPlan.isPending}
            >
              <ShoppingBag className="mr-2 h-4 w-4" /> 分配
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
