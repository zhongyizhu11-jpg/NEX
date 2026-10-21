import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Gift, ShieldCheck, Users } from "lucide-react";
import EmptyState from "@/components/EmptyState";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError, { DataTableErrorRow } from "@/components/DataSectionError";
import MobileInfoRow from "@/components/MobileInfoRow";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { ListRow, ListSection } from "@/components/ios/GroupedList";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatMoneyCents as money } from "@shared/formatMoney";
import { formatRateBps, REFERRAL_MODE_LABELS, type ReferralMode } from "@shared/referral";

const PAGE_SIZE = 20;

function dateText(value?: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN");
}

function sourceText(type: string) {
  return type === "payment_order" ? "在线支付" : type === "balance_purchase" ? "余额购买" : type || "-";
}

/**
 * 账单与兑换 › 邀请返利：三个全局开关 + 全部返利记录。
 *
 * 各套餐返多少在「套餐管理」里逐个设（0 = 不返）；这里只管开不开、怎么返、要不要强制邀请注册。
 */
export default function AdminReferralPanel() {
  const utils = trpc.useUtils();
  const pageRequest = usePersistentPageRequest("forwardx.billing.referral.page");
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);
  useEffect(() => {
    pageRequest.setPage(1);
  }, [appliedKeyword, pageRequest.setPage]);

  const settingsQuery = trpc.referral.settings.useQuery(undefined, { staleTime: 10_000 });
  const setSettings = trpc.referral.setSettings.useMutation({
    onSuccess: async () => {
      toast.success("邀请返利设置已保存");
      await Promise.all([utils.referral.settings.invalidate(), utils.system.publicInfo.invalidate(), utils.referral.me.invalidate()]);
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const commissionsQuery = trpc.referral.adminCommissions.useQuery({
    page: pageRequest.page,
    pageSize: PAGE_SIZE,
    inviterUsername: appliedKeyword || undefined,
  }, {
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const rows = (commissionsQuery.data?.items || []) as any[];
  const pagination = useServerPagination(
    rows,
    Number(commissionsQuery.data?.totalItems || 0),
    pageRequest,
    { pageSize: PAGE_SIZE, isReady: !commissionsQuery.isLoading && !!commissionsQuery.data },
  );

  const settings = settingsQuery.data;
  const loading = settingsQuery.isLoading;
  const enabled = settings?.enabled === true;

  return (
    <div className="space-y-4">
      <ListSection header="邀请返利" footer="各套餐的返利比例在「套餐管理」里逐个设置，0 为不返。只有真金白银买套餐（在线支付或余额，含续费）才返；充值、兑换码、管理员分配都不返。">
        <ListRow
          icon={<Gift className="h-4 w-4" />}
          label="开启邀请返利"
          detail={loading ? "正在加载" : enabled ? "已开启 · 用户可在「邀请返利」页拿到邀请链接" : "已关闭 · 不返利，也不显示入口"}
          trailing={(
            <OptimisticSwitch
              aria-label="开启邀请返利"
              checked={enabled}
              disabled={loading}
              onCheckedChangeAsync={(checked) => setSettings.mutateAsync({ enabled: checked })}
            />
          )}
        />
        <ListRow
          icon={<Users className="h-4 w-4" />}
          label="返利方式"
          detail={settings?.mode === "recurring" ? "被邀请人每次购买、续费都返" : "每个被邀请人只返第一笔"}
          trailing={(
            <Select
              value={settings?.mode || "first"}
              disabled={loading || setSettings.isPending}
              onValueChange={(mode) => setSettings.mutate({ mode: mode as ReferralMode })}
            >
              <SelectTrigger aria-label="返利方式" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REFERRAL_MODE_LABELS) as ReferralMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>{REFERRAL_MODE_LABELS[mode]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <ListRow
          icon={<ShieldCheck className="h-4 w-4" />}
          label="必须邀请注册"
          detail={!enabled ? "开启邀请返利后才生效" : settings?.forceInvite ? "注册必须填写有效邀请码" : "邀请码选填，填错会被忽略"}
          trailing={(
            <OptimisticSwitch
              aria-label="必须邀请注册"
              checked={settings?.forceInvite === true}
              disabled={loading}
              onCheckedChangeAsync={(checked) => setSettings.mutateAsync({ forceInvite: checked })}
            />
          )}
        />
      </ListSection>

      <Card>
        <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5" /> 返利记录</CardTitle>
            <CardDescription keep>
              {commissionsQuery.data
                ? `共 ${Number(commissionsQuery.data.totalItems || 0)} 笔，合计 ${money(commissionsQuery.data.totalCommissionCents || 0)}`
                : "所有邀请人的返利。"}
            </CardDescription>
          </div>
          <Input
            aria-label="按邀请人用户名筛选"
            placeholder="按邀请人用户名筛选"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            className="w-full sm:w-64"
          />
        </CardHeader>
        <CardContent>
          {commissionsQuery.isLoading && !commissionsQuery.data ? (
            <DataSectionLoading label="正在加载返利记录" />
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {rows.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">{item.inviterUsername || `#${item.inviterId}`}</p>
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">邀请了 {item.inviteeUsername || `#${item.inviteeId}`}</p>
                      </div>
                      <div className="shrink-0 text-sm font-medium tabular-nums text-[var(--fx-healthy-text)]">+{money(item.commissionCents)}</div>
                    </div>
                    <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                      <MobileInfoRow label="套餐">{item.planName}</MobileInfoRow>
                      <MobileInfoRow label="实付 / 比例">{money(item.baseAmountCents)} · {formatRateBps(item.rateBps)}%</MobileInfoRow>
                      <MobileInfoRow label="来源"><Badge variant="outline">{sourceText(item.sourceType)}</Badge></MobileInfoRow>
                      <MobileInfoRow label="关联" valueClassName="font-mono text-xs text-muted-foreground">{item.sourceRef || "-"}</MobileInfoRow>
                      <MobileInfoRow label="时间">{dateText(item.createdAt)}</MobileInfoRow>
                    </div>
                  </div>
                ))}
                {rows.length === 0 && (commissionsQuery.error ? (
                  <DataSectionError label="返利记录" error={commissionsQuery.error} retrying={commissionsQuery.isFetching} onRetry={() => { void commissionsQuery.refetch(); }} minHeight="min-h-[120px]" />
                ) : (
                  <EmptyState icon={<Gift />} title="暂无返利记录" />
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>邀请人</TableHead>
                      <TableHead>被邀请人</TableHead>
                      <TableHead>套餐</TableHead>
                      <TableHead>来源</TableHead>
                      <TableHead className="text-right">实付</TableHead>
                      <TableHead className="text-right">比例</TableHead>
                      <TableHead className="text-right">返利</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="whitespace-nowrap">{dateText(item.createdAt)}</TableCell>
                        <TableCell className="break-all">{item.inviterUsername || `#${item.inviterId}`}</TableCell>
                        <TableCell className="break-all">{item.inviteeUsername || `#${item.inviteeId}`}</TableCell>
                        <TableCell>{item.planName}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span>{sourceText(item.sourceType)}</span>
                            <span className="break-all font-mono text-[11px] text-muted-foreground">{item.sourceRef || "-"}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(item.baseAmountCents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRateBps(item.rateBps)}%</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">+{money(item.commissionCents)}</TableCell>
                      </TableRow>
                    ))}
                    {rows.length === 0 && (commissionsQuery.error ? (
                      <DataTableErrorRow colSpan={8} label="返利记录" error={commissionsQuery.error} retrying={commissionsQuery.isFetching} onRetry={() => { void commissionsQuery.refetch(); }} />
                    ) : (
                      <TableRow>
                        <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">暂无返利记录</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <PersistentPagination pagination={pagination} itemName="笔返利" />
    </div>
  );
}
