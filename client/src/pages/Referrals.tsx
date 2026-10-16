import WorkspaceHeader from "@/components/WorkspaceHeader";
import DashboardLayout from "@/components/DashboardLayout";
import EmptyState from "@/components/EmptyState";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError, { DataTableErrorRow } from "@/components/DataSectionError";
import MobileInfoRow from "@/components/MobileInfoRow";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import { formatMoneyCents as money } from "@shared/formatMoney";
import { planDurationLabel } from "@shared/planPricing";
import { buildInviteLink, formatRateBps, REFERRAL_MODE_LABELS } from "@shared/referral";
import { Copy, Gift, Package, Users } from "lucide-react";
import { toast } from "sonner";

const PAGE_SIZE = 20;

function dateText(value?: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN");
}

async function copyText(value: string, message: string) {
  // 面板常跑在 http://ip:port 上，那时 navigator.clipboard 不存在，走共享实现的回退。
  if (await copyTextToClipboard(value)) {
    toast.success(message);
    return;
  }
  toast.error(
    clipboardNeedsManualCopy()
      ? "当前是 http 访问，浏览器限制了剪贴板，请长按选中后复制"
      : "复制失败，请长按选中后复制",
  );
}

/**
 * 「邀请返利」：我的邀请码 / 链接、邀请了几个人、拿了多少返利、返利明细，
 * 以及哪些套餐能返、各返多少。
 */
export default function Referrals() {
  const pageRequest = usePersistentPageRequest("forwardx.referrals.page");
  const meQuery = trpc.referral.me.useQuery(undefined, { placeholderData: (previousData) => previousData });
  const enabled = meQuery.data?.enabled === true;
  const plansQuery = trpc.referral.plans.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
    placeholderData: (previousData) => previousData,
  });
  const commissionsQuery = trpc.referral.myCommissions.useQuery({ page: pageRequest.page, pageSize: PAGE_SIZE }, {
    enabled,
    placeholderData: (previousData) => previousData,
  });
  const commissions = (commissionsQuery.data?.items || []) as any[];
  const pagination = useServerPagination(
    commissions,
    Number(commissionsQuery.data?.totalItems || 0),
    pageRequest,
    { pageSize: PAGE_SIZE, isReady: !commissionsQuery.isLoading && !!commissionsQuery.data },
  );

  const inviteCode = meQuery.data?.inviteCode || "";
  const inviteLink = inviteCode ? buildInviteLink(mobileAuth.panelOrigin(), inviteCode) : "";
  const plans = (plansQuery.data || []) as any[];

  if (meQuery.isLoading && !meQuery.data) {
    return (
      <DashboardLayout>
        <DataSectionLoading label="正在加载邀请返利" />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <WorkspaceHeader title="邀请返利" description="邀请好友注册，好友购买套餐后按套餐比例返到你的余额。" />

        {meQuery.error && !meQuery.data ? (
          <DataSectionError label="邀请返利" error={meQuery.error} retrying={meQuery.isFetching} onRetry={() => { void meQuery.refetch(); }} />
        ) : !enabled ? (
          <EmptyState icon={<Gift />} title="邀请返利未开启" description="管理员开启后，这里会出现你的邀请码和邀请链接。" />
        ) : (
          <>
            <SummaryStrip
              ariaLabel="邀请概况"
              items={[
                { key: "invited", label: "已邀请", value: Number(meQuery.data?.invitedCount || 0), hint: "通过你的邀请码注册" },
                { key: "earned", label: "累计返利", value: money(meQuery.data?.totalCommissionCents || 0), hint: `${Number(meQuery.data?.commissionCount || 0)} 笔` },
                { key: "mode", label: "返利方式", value: REFERRAL_MODE_LABELS[meQuery.data?.mode === "recurring" ? "recurring" : "first"], hint: meQuery.data?.mode === "recurring" ? "好友每次购买、续费都返" : "每位好友只返第一单" },
              ]}
            />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5" /> 我的邀请</CardTitle>
                <CardDescription>把邀请链接发给好友，好友用它注册后，购买套餐的实付金额按下表比例返到你的余额（不足一分不返）。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="referral-code">邀请码</Label>
                  <div className="flex gap-2">
                    <Input id="referral-code" readOnly value={inviteCode} className="font-mono tracking-widest" />
                    <Button type="button" variant="outline" disabled={!inviteCode} onClick={() => void copyText(inviteCode, "邀请码已复制")}>
                      <Copy className="mr-2 h-4 w-4" />
                      复制
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="referral-link">邀请链接</Label>
                  <div className="flex gap-2">
                    <Input id="referral-link" readOnly value={inviteLink} className="min-w-0 font-mono text-xs" />
                    <Button type="button" variant="outline" disabled={!inviteLink} onClick={() => void copyText(inviteLink, "邀请链接已复制")}>
                      <Copy className="mr-2 h-4 w-4" />
                      复制
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> 可返利的套餐</CardTitle>
                <CardDescription>好友买下面这些套餐（含续费）时有返利，比例按套餐分别设置。</CardDescription>
              </CardHeader>
              <CardContent>
                {plansQuery.isLoading && !plansQuery.data ? (
                  <DataSectionLoading label="正在加载套餐" />
                ) : plans.length === 0 ? (
                  <EmptyState icon={<Package />} title="暂时没有可返利的套餐" />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>套餐</TableHead>
                          <TableHead>价格</TableHead>
                          <TableHead className="text-right">返利比例</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {plans.map((plan) => (
                          <TableRow key={plan.id}>
                            <TableCell className="font-medium">{plan.name}</TableCell>
                            <TableCell className="tabular-nums">{money(plan.priceCents, plan.currency)} / {planDurationLabel(plan.durationDays)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatRateBps(plan.referralRateBps)}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> 返利明细</CardTitle>
                <CardDescription>返利直接进余额，余额流水里记为「邀请返利」。</CardDescription>
              </CardHeader>
              <CardContent>
                {commissionsQuery.isLoading && !commissionsQuery.data ? (
                  <DataSectionLoading label="正在加载返利明细" />
                ) : (
                  <>
                    <div className="grid gap-3 md:hidden">
                      {commissions.map((item) => (
                        <div key={item.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="break-words text-sm font-medium">{item.planName}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">{item.inviteeUsername}</p>
                            </div>
                            <div className="shrink-0 text-sm font-medium tabular-nums text-[var(--fx-healthy-text)]">+{money(item.commissionCents)}</div>
                          </div>
                          <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                            <MobileInfoRow label="实付">{money(item.baseAmountCents)}</MobileInfoRow>
                            <MobileInfoRow label="比例">{formatRateBps(item.rateBps)}%</MobileInfoRow>
                            <MobileInfoRow label="时间">{dateText(item.createdAt)}</MobileInfoRow>
                          </div>
                        </div>
                      ))}
                      {commissions.length === 0 && (commissionsQuery.error ? (
                        <DataSectionError label="返利明细" error={commissionsQuery.error} retrying={commissionsQuery.isFetching} onRetry={() => { void commissionsQuery.refetch(); }} minHeight="min-h-[120px]" />
                      ) : (
                        <EmptyState icon={<Users />} title="还没有返利" description="好友通过你的链接注册并购买套餐后，会出现在这里。" />
                      ))}
                    </div>
                    <div className="hidden overflow-x-auto md:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>时间</TableHead>
                            <TableHead>好友</TableHead>
                            <TableHead>套餐</TableHead>
                            <TableHead className="text-right">实付</TableHead>
                            <TableHead className="text-right">比例</TableHead>
                            <TableHead className="text-right">返利</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {commissions.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell className="whitespace-nowrap">{dateText(item.createdAt)}</TableCell>
                              <TableCell className="font-mono text-xs">{item.inviteeUsername}</TableCell>
                              <TableCell>{item.planName}</TableCell>
                              <TableCell className="text-right tabular-nums">{money(item.baseAmountCents)}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatRateBps(item.rateBps)}%</TableCell>
                              <TableCell className="text-right font-medium tabular-nums">+{money(item.commissionCents)}</TableCell>
                            </TableRow>
                          ))}
                          {commissions.length === 0 && (commissionsQuery.error ? (
                            <DataTableErrorRow colSpan={6} label="返利明细" error={commissionsQuery.error} retrying={commissionsQuery.isFetching} onRetry={() => { void commissionsQuery.refetch(); }} />
                          ) : (
                            <TableRow>
                              <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                                还没有返利。好友通过你的链接注册并购买套餐后，会出现在这里。
                              </TableCell>
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
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

