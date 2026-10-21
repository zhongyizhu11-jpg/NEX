import TrafficBillingConfigManager from "@/components/TrafficBillingConfigManager";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OptimisticSwitch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Coins, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * 按量计费的全部配置，收在套餐管理的「流量计费」一页里。
 *
 * 「按量收钱」这件事原来散在四个地方，而且拼不成一句完整的话：
 *
 *   - **总开关**在 /traffic-billing —— 那一页侧边栏点不到，全站零链接，只能手敲 URL。
 *   - **资源定价**在套餐管理的一个 tab 里，那个 tab 又刻意不渲染总开关。
 *   - **谁能用**在用户管理 → 编辑用户 → 两个多选框里。
 *   - **租户余额**在账单与兑换。
 *
 * 四处都对了才真的收得到钱，错一处就是静悄悄不生效，而没有任何一个地方告诉你缺哪
 * 一环。所以这一块要回答的是一句话：**「我这套配好了没有，还差什么」**。
 *
 * 清单上每一环都给具体的数而不是一个勾：「3 个资源在计费」和「都要授权但一个人都
 * 没授权过」是完全不同的处境，缩成 ok/not ok 等于没说。
 */

type StepTone = "ok" | "todo" | "warn";

function SetupStep({
  index,
  title,
  tone,
  detail,
  action,
}: {
  index: number;
  title: string;
  tone: StepTone;
  detail: ReactNode;
  action?: ReactNode;
}) {
  const badge = tone === "ok"
    ? "border-[color-mix(in_srgb,var(--fx-healthy)_40%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]"
    : tone === "warn"
    ? "border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]"
    : "border-border/60 bg-muted/40 text-muted-foreground";
  const Icon = tone === "ok" ? Check : tone === "warn" ? AlertTriangle : X;
  return (
    <div className="flex min-w-0 items-start gap-3 py-3">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${badge}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          <span className="text-muted-foreground">{index}. </span>
          {title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * createRequestKey：套餐管理页把「新增计费资源」放在页头（和「新增套餐」同一个位置，按 tab 换文案），
 * 每点一次 +1，这里转给下面的 TrafficBillingConfigManager 开新建弹窗。不传就自己带一个按钮。
 */
export default function TrafficBillingSection({ createRequestKey: externalCreateRequestKey }: { createRequestKey?: number } = {}) {
  const [, navigate] = useLocation();
  const [localCreateRequestKey, setCreateRequestKey] = useState(0);
  const createRequestKey = externalCreateRequestKey ?? localCreateRequestKey;
  const ownCreateButton = externalCreateRequestKey === undefined;
  // 「配到哪一步了」平时折叠成一行（手机上四步展开占一屏，用户圈出来要折叠），点标题展开
  const [stepsOpen, setStepsOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: status, isLoading } = trpc.trafficBilling.setupStatus.useQuery();
  const setEnabled = trpc.trafficBilling.setEnabled.useMutation({
    onSuccess: async (_data, variables) => {
      await Promise.all([
        utils.trafficBilling.setupStatus.invalidate(),
        utils.trafficBilling.configs.invalidate(),
        utils.trafficBilling.status.invalidate(),
        utils.trafficBilling.storeResources.invalidate(),
      ]);
      toast.success(variables.enabled ? "按量计费已开启" : "按量计费已关闭");
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });

  const enabled = !!status?.enabled;
  const configs = status?.configs;
  const active = configs?.active || 0;
  const open = configs?.open || 0;
  const permissionOnly = configs?.permissionOnly || 0;
  const authorizedUsers = status?.authorizedUsers || 0;
  const fundedUsers = status?.fundedUsers || 0;
  const tenantUsers = status?.tenantUsers || 0;

  // 第三环：租户到底用不用得上。公开资源谁有余额都能用；只授权的资源得有人被授权过。
  const reachable = open > 0 || authorizedUsers > 0;
  const stepsDone = [enabled, active > 0, active > 0 && reachable, active > 0 && fundedUsers > 0].filter(Boolean).length;
  const jump = (path: string, label: string) => (
    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => navigate(path)}>
      {label} <ArrowRight className="h-3 w-3" />
    </Button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            按 GB 扣租户余额的那一套：哪些转发在计费、按什么价、谁用得上。没配价的转发照旧记进各自的套餐流量额度。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2">
            <span className="text-sm text-muted-foreground">总开关</span>
            {isLoading ? (
              <Skeleton className="h-6 w-11 rounded-full" />
            ) : (
              <OptimisticSwitch aria-label="总开关"
                checked={enabled}
                onCheckedChangeAsync={(checked: boolean) => setEnabled.mutateAsync({ enabled: checked })}
              />
            )}
          </div>
          {/*
            下面那个组件的「新增」长在它自己的 header 里，而这里两个 header 都关掉了（总开关已经在上面，
            不要两个）。套餐管理页把这个按钮放在页头（createRequestKey 从外面来），只有单独用时才自己带一个。
          */}
          {ownCreateButton ? (
            <Button onClick={() => setCreateRequestKey((value) => value + 1)}>
              <Plus className="mr-2 h-4 w-4" /> 新增计费资源
            </Button>
          ) : null}
        </div>
      </div>

      {/*
        总开关关着时，下面配的一切都不生效。这一条要摆在最显眼处 ——
        这个开关原来在界面上根本点不到，人配完了价等账单，等到的是 0。
      */}
      {!isLoading && !enabled ? (
        <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-sm text-[var(--fx-warn-text)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>总开关关着</strong>，下面配的价一分钱都不会扣，转发的流量仍然记进各自的套餐额度。
            {active > 0 ? ` 已经有 ${active} 个资源配好了价，打开开关就开始计费。` : ""}
          </span>
        </div>
      ) : null}

      <Card>
        <CardContent className={stepsOpen ? "divide-y divide-border/60 p-4 sm:p-5" : "p-4 sm:p-5"}>
          <button
            type="button"
            className={stepsOpen ? "flex w-full items-center gap-2 pb-2 text-left" : "flex w-full items-center gap-2 text-left"}
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((value) => !value)}
          >
            <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="text-sm font-semibold">配到哪一步了</h3>
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
              {isLoading ? "…" : stepsDone === 4 ? "4 步都配好了" : `${stepsDone} / 4 步`}
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${stepsOpen ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
          {!stepsOpen ? null : isLoading ? (
            <div className="space-y-3 py-3">
              {[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-10 w-full" />)}
            </div>
          ) : (
            <>
              <SetupStep
                index={1}
                title="打开总开关"
                tone={enabled ? "ok" : "todo"}
                detail={enabled ? "已开启，下面配了价的资源正在计费。" : "关着的时候整套按量计费都不生效，右上角打开它。"}
              />
              <SetupStep
                index={2}
                title="给资源定价"
                tone={active > 0 ? "ok" : "todo"}
                detail={active === 0
                  ? "还没有任何资源配了价。可以按端口转发 / 隧道 / 转发链 / 转发组配，也可以在主机管理里给整台机器配兜底价。"
                  // 总开关关着时不能说「在计费」—— 这时候一分钱都不扣，
                  // 上面的警告条已经这么说了，这一句再说反就是自相矛盾。
                  : enabled
                  ? `${active} 个资源在计费（公开 ${open} 个、需授权 ${permissionOnly} 个）。没配价的转发走各自的套餐流量额度。`
                  : `${active} 个资源配了价（公开 ${open} 个、需授权 ${permissionOnly} 个），但总开关关着，现在一分钱都不扣。`}
                action={active > 0 ? undefined : jump("/hosts", "去主机管理")}
              />
              <SetupStep
                index={3}
                title="让租户用得上"
                tone={active === 0 ? "todo" : reachable ? "ok" : "warn"}
                detail={active === 0
                  ? "先配好价，再决定谁能用。"
                  : reachable
                  ? `${open > 0 ? `${open} 个公开资源（任何有余额的租户都能直接用，也会出现在商店里）` : ""}${open > 0 && authorizedUsers > 0 ? "；" : ""}${authorizedUsers > 0 ? `${authorizedUsers} 位租户被单独授权` : ""}。`
                  : `${permissionOnly} 个资源都要单独授权，但一个人都还没授权过 —— 现在没有任何租户用得上它们。去用户管理里给人开。`}
                action={active > 0 && !reachable ? jump("/users", "去用户管理") : undefined}
              />
              <SetupStep
                index={4}
                title="租户得有余额"
                tone={active === 0 ? "todo" : fundedUsers > 0 ? "ok" : "warn"}
                detail={active === 0
                  ? "先配好价。"
                  : fundedUsers > 0
                  ? `${tenantUsers} 位租户里有 ${fundedUsers} 位有余额。`
                  : `${tenantUsers} 位租户余额都是 0。按量计费扣不动余额会停掉那个人名下全部转发 —— 先充值，或者别把他们的转发放在计费资源上。`}
                action={active > 0 && fundedUsers === 0 ? jump("/billing", "去账单与兑换") : undefined}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* 资源列表和概览沿用原来的组件；总开关已经在上面了，这里不再重复一个。 */}
      <TrafficBillingConfigManager showHeader={false} showEmbeddedHeader={false} createRequestKey={createRequestKey} />
    </div>
  );
}
