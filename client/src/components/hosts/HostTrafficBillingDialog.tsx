import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  MIN_PRICE_PER_GB_MILLI_CENTS,
  milliCentsFromYuan,
  priceInputFromMilliCents,
} from "@shared/trafficBillingPrice";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * 给一台机器配「整台按量计费」。
 *
 * 面板里计费配置本来只能按**转发组 / 隧道**配（流量计费管理那一页）。可商家买机器
 * 是按台买的、机房账单也是按台出的，「这台机器上的转发一律按 X 元/GB」是个很自然
 * 的诉求，原来得给这台上的每个转发组各配一遍，漏一个就有一批流量不计费。
 *
 * 底层没有新东西：转发找计费配置本来就是 转发组 → 隧道 → **主机** 三档，主机那一档
 * 一直在跑，只是界面上被标成「历史主机」并禁用了新建。这个弹窗把那一档重新接出来。
 *
 * 三件事必须在界面上说清楚，否则就是「面板承诺了它没做到的事」：
 *
 * 1. **它是兜底，不是覆盖**。转发组 / 隧道上单独配过价的转发走它们自己的价。
 *    不说的话，人改了这里的价发现某几条的账没变，只会以为面板算错了。
 * 2. **总开关关着时它一分钱都不扣**。
 * 3. **「需要单独授权」默认开着**。关掉等于把这台机器摆进商店：面板上任何有余额的
 *    用户都能在你这台机器上开转发。一台机器比一个转发组大得多，默认不能是敞开的。
 */
export default function HostTrafficBillingDialog({
  open,
  onOpenChange,
  host,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: any;
  onSaved?: () => void;
}) {
  const config = host?.hostBillingConfig || null;
  const [price, setPrice] = useState("");
  const [requiresPermission, setRequiresPermission] = useState(true);

  // 每次打开都按当前这台机器回填。弹窗是复用的，不重置的话会把上一台的价带过来。
  useEffect(() => {
    if (!open) return;
    setPrice(priceInputFromMilliCents(config?.pricePerGbMilliCents));
    setRequiresPermission(config ? !!config.requiresPermission : true);
  }, [open, host?.id]);

  const { data: billingStatus } = trpc.trafficBilling.configs.useQuery(undefined, {
    enabled: open,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const featureEnabled = billingStatus?.enabled !== false;

  /*
    保存前先问清楚：这个价会把谁接管过去、会停掉谁。

    兜底价接管的是这台机器上**所有**没被转发组 / 隧道单独计价的转发，包括走套餐的
    租户的 —— 计费那条路的判断里没有「这个人是套餐户还是计费户」。套餐户通常余额
    是 0，而余额 ≤ 0 会被停掉名下全部转发。
  */
  const { data: takeover } = trpc.trafficBilling.hostTakeoverPreview.useQuery(
    { hostId: Number(host?.id || 0) },
    { enabled: open && Number(host?.id || 0) > 0, refetchOnWindowFocus: false },
  );
  const takeoverUsers = (takeover?.users || []) as any[];
  const planUsers = takeoverUsers.filter((row) => row.hasPlanQuota);
  const stopUsers = takeoverUsers.filter((row) => row.wouldStop);

  const utils = trpc.useUtils();
  const afterWrite = async (disabledRules: number) => {
    await Promise.all([
      utils.hosts.listPage.invalidate(),
      utils.trafficBilling.configs.invalidate(),
      utils.trafficBilling.status.invalidate(),
      utils.trafficBilling.storeResources.invalidate(),
      utils.trafficBilling.hostTakeoverPreview.invalidate(),
    ]);
    // 改计费资源会牵动授权：靠这个资源才用得上这台机器的用户可能因此失去访问，
    // 他的转发被停。这件事原来只写进服务端日志 —— 而挨停的是别人的业务。
    if (disabledRules > 0) toast.warning(`顺带停掉了 ${disabledRules} 条失去资源授权的转发`);
    onOpenChange(false);
    onSaved?.();
  };

  const saveConfig = trpc.trafficBilling.saveConfig.useMutation({
    onSuccess: (result: any) => {
      toast.success("这台机器的按量计费已保存");
      afterWrite(Number(result?.disabledRules || 0));
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const deleteConfig = trpc.trafficBilling.deleteConfig.useMutation({
    onSuccess: (result: any) => {
      toast.success("已取消这台机器的按量计费，转发改回记进套餐流量");
      afterWrite(Number(result?.disabledRules || 0));
    },
    onError: (error) => toast.error(error.message || "取消失败"),
  });
  const busy = saveConfig.isPending || deleteConfig.isPending;

  const save = () => {
    const pricePerGbMilliCents = milliCentsFromYuan(price);
    if (pricePerGbMilliCents < MIN_PRICE_PER_GB_MILLI_CENTS) {
      return toast.error("单价最低 0.001 元/GB —— 填 0 不是免费，是一条扣不到钱的计费配置");
    }
    saveConfig.mutate({
      id: config?.id,
      resourceType: "host",
      resourceId: Number(host?.id),
      enabled: true,
      requiresPermission,
      pricePerGbMilliCents,
    } as any);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>按量计费 · {host?.name || `主机 #${host?.id}`}</DialogTitle>
          <DialogDescription data-fx-help="">
            这台机器上的转发按 GB 扣用户余额，不再记进他的套餐流量额度。
          </DialogDescription>
        </DialogHeader>

        {!featureEnabled ? (
          <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] p-3 text-xs text-[var(--fx-warn-text)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              流量计费<strong>总开关是关着的</strong>，这里配了也一分钱都不会扣。要去「套餐管理 → 流量计费」先打开。
            </span>
          </div>
        ) : null}

        {takeover && takeover.takeoverRules > 0 ? (
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
            <p className="text-muted-foreground">
              保存后，这台机器上
              <strong className="text-foreground"> {takeover.takeoverRules} / {takeover.totalRules} </strong>
              条转发会改成按 GB 扣余额
              {takeover.takeoverRules < takeover.totalRules ? "（其余的已经被所属转发组 / 隧道单独计价，不受影响）" : ""}。
            </p>
            {planUsers.length > 0 ? (
              <p className="text-muted-foreground">
                其中
                <strong className="text-foreground"> {planUsers.length} </strong>
                位是<strong className="text-foreground">有套餐额度</strong>的租户
                （{planUsers.map((row) => row.username).join("、")}）——
                他们本来走套餐流量，之后会改成扣余额。
              </p>
            ) : null}
            {stopUsers.length > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>{stopUsers.length} 人余额为 0</strong>
                  （{stopUsers.map((row) => `${row.username}${row.role === "admin" ? "，管理员" : ""}`).join("、")}），
                  扣不动余额会被停掉<strong>名下全部 {takeover.stopRules} 条转发</strong>——
                  不只是这台机器上的。要么先给他们充值，要么别用整台兜底价，改成按转发组 / 隧道单独配。
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">单价（元 / GB）</Label>
            <Input
              type="number"
              min={0.001}
              step="0.001"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="例如 2.8"
            />
            <p data-fx-help="" className="text-xs text-muted-foreground">
              这是<strong>兜底价</strong>：这台机器上的转发，凡是没有被它所属的转发组 / 隧道单独计价的，都按这个价走；
              单独配过价的仍然走它们自己的价。
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="min-w-0">
              <Label className="text-sm">需要单独授权才能用</Label>
              <p data-fx-help="" className="mt-1 text-xs text-muted-foreground">
                开着：只有你在用户管理里授权过的人能在这台机器上开转发，已经在跑的转发照常计费。
                关掉：面板上<strong>任何有余额的用户</strong>都能用这台机器。
              </p>
            </div>
            <Checkbox aria-label="需要单独授权才能用" className="shrink-0" checked={requiresPermission} onCheckedChange={setRequiresPermission} disabled={busy} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={busy || !config}
            onClick={() => deleteConfig.mutate({ id: Number(config?.id) })}
          >
            取消这台的按量计费
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
            <Button onClick={save} disabled={busy}>保存</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
