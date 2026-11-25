/**
 * 添加 / 编辑客户端节点（粘链接那一类）。
 *
 * 表单状态全在这个文件里：原来十几个 useState 挂在「订阅管理」页面上，在弹窗里每敲一个键，
 * 整页（节点列表、令牌卡、概览条）都跟着重画一遍。现在键击只重画弹窗自己。
 *
 * 表单初值在 DialogContent 里面那个子组件的 useState 初始化器里取：Radix 关掉弹窗时会把
 * Content 整个卸掉，下次打开就是按新的 node 重新初始化 —— 不需要「open 变了就重置」的 effect。
 */

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { MONTHLY_RESET_MAX_DAY } from "@shared/billingTime";
import { proxySubRegionLabel } from "@shared/proxySubRegion";
import {
  PROXY_NODE_AUTO_GROUPS,
  PROXY_NODE_AUTO_GROUP_HINTS,
  PROXY_NODE_AUTO_GROUP_LABELS,
  PROXY_NODE_DEFAULT_AUTO_GROUP,
  normalizeProxyNodeAutoGroup,
  type ProxyNodeAutoGroup,
} from "@shared/proxySubscriptionPlan";
import { bytesFromGb, gbFromBytes } from "@shared/trafficGb";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

/** 弹窗要读的那几个字段。页面上的节点列表是服务端拼出来的宽对象，这里只认用到的。 */
export type ProxyNodeEditable = {
  id: number;
  name?: string | null;
  remark?: string | null;
  publicLabel?: string | null;
  countryCode?: string | null;
  sourceLink?: string | null;
  autoGroup?: string | null;
  includeDirect?: boolean | null;
  frontProxyId?: number | null;
  bandwidthMbps?: number | null;
  trafficLimit?: unknown;
  trafficUsed?: unknown;
  trafficAutoReset?: boolean | null;
  trafficResetDay?: number | null;
};

/** 前置代理下拉里的候选：所有节点（自建的也能当前置，那是「自建落地 + 中转」的正常用法）。 */
export type ProxyNodeOption = { id: number; name?: string | null };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建。 */
  node: ProxyNodeEditable | null;
  nodes: ReadonlyArray<ProxyNodeOption>;
  /** 保存成功之后（弹窗已经关了）。页面在这里做定向失效。 */
  onSaved?: () => void;
};

export function ProxyNodeEditDialog({ open, onOpenChange, node, nodes, onSaved }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent 默认整块可滚（max-h + overflow-y-auto）。这里显式 overflow-hidden 改成 flex 列、
          只让正文那一层滚，标题和底栏钉住 —— 项目里其他长弹窗都是这个写法。 */}
      <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{node ? "编辑客户端节点" : "添加客户端节点"}</DialogTitle>
          <DialogDescription className="text-xs">只替换地址和端口，凭据不变。</DialogDescription>
        </DialogHeader>
        <ProxyNodeEditForm node={node} nodes={nodes} onOpenChange={onOpenChange} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

function ProxyNodeEditForm({ node, nodes, onOpenChange, onSaved }: Omit<Props, "open">) {
  const editingNodeId = node?.id ?? null;
  const [name, setName] = useState(() => String(node?.name || ""));
  const [remark, setRemark] = useState(() => String(node?.remark || ""));
  /** 手工指定的地区（国家码）；空 = 按机器位置 / 名字猜。 */
  const [countryCode, setCountryCode] = useState(() => String(node?.countryCode || ""));
  /** 对外标注：分享出去时对方看得到的那一句。备注是自己看的，两回事。 */
  const [publicLabel, setPublicLabel] = useState(() => String(node?.publicLabel || ""));
  const [link, setLink] = useState(() => String(node?.sourceLink || ""));
  const [autoGroup, setAutoGroup] = useState<ProxyNodeAutoGroup>(() => (node ? normalizeProxyNodeAutoGroup(node.autoGroup) : PROXY_NODE_DEFAULT_AUTO_GROUP));
  // 默认关：开了之后落地 IP 会出现在每一条订阅地址里。
  const [includeDirect, setIncludeDirect] = useState(() => !!node?.includeDirect);
  // 0 表示不经由任何前置。
  const [frontProxyId, setFrontProxyId] = useState(() => Number(node?.frontProxyId || 0));
  /** 落地机的套餐规格。带宽用 Mbps，总流量用 GB —— 机房就是按这两个单位卖的。 */
  const [bandwidthMbps, setBandwidthMbps] = useState(() => (Number(node?.bandwidthMbps || 0) > 0 ? String(node?.bandwidthMbps) : ""));
  const [trafficLimitGb, setTrafficLimitGb] = useState(() => (node ? gbFromBytes(node.trafficLimit) : ""));
  const [trafficUsedGb, setTrafficUsedGb] = useState(() => (node ? gbFromBytes(node.trafficUsed) : ""));
  const [trafficAutoReset, setTrafficAutoReset] = useState(() => !!node?.trafficAutoReset);
  const [trafficResetDay, setTrafficResetDay] = useState(() => String(Number(node?.trafficResetDay || 1)));
  /*
    高级一律收着，配过的人也收着。

    原来是「不是默认值就自动展开」，出发点是别让人以为配置丢了。但那等于
    「谁配过谁的弹窗就永远长一截」—— 而改名字、换链接这种日常操作天天做，
    选路和前置代理配一次就不动了。

    不展开也不让人起疑，靠的是把里头设了什么写在折叠条上（见下面的 advancedSummary）：
    看得见就不会以为丢了，这比整段摊开便宜得多。
  */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const utils = trpc.useUtils();
  /** 节点变了，列表和订阅内容都要重取；令牌那张卡不受影响，不碰。 */
  const afterSaved = () => {
    void utils.proxySubscriptions.listNodes.invalidate();
    void utils.proxySubscriptions.preview.invalidate();
    onOpenChange(false);
    onSaved?.();
  };
  const createNode = trpc.proxySubscriptions.createNode.useMutation({
    onSuccess: (result) => {
      toast.success("客户端节点已添加");
      /**
       * 顺手接上的那些转发要说出来。
       *
       * 先有转发、后加节点是很常见的顺序，这时面板会把已经指向它的转发一并加进
       * 订阅 —— 不吭声的话，他下次打开订阅会发现凭空多了几条线路。
       */
      const adopted = Number((result as { adoptedRuleCount?: number } | undefined)?.adoptedRuleCount || 0);
      if (adopted > 0) {
        toast.info(`顺手把 ${adopted} 条指向它的转发加进了订阅`, {
          description: "不想要的话，在「预览订阅」里逐条关掉。",
        });
      }
      afterSaved();
    },
    onError: (error) => toast.error(error.message),
  });
  /*
    这个 updateNode 只给弹窗里的「保存」用。行上的开关、订阅内容里的下拉另有各自的实例 ——
    原来共用一个，结果拨一下行开关也弹「客户端节点已更新」、还把正开着的弹窗关掉。
  */
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({
    onSuccess: () => {
      toast.success("客户端节点已更新");
      afterSaved();
    },
    onError: (error) => toast.error(error.message),
  });

  /**
   * 折叠着的「高级」里设了什么。
   *
   * 收起来省地方，但不能省到让人以为配置没了 —— 所以设过的那几项直接写在折叠条上。
   * 只写非默认的：默认值写出来是噪音，而这一行的全部价值就是「有没有东西被我藏起来」。
   */
  const advancedSummary = useMemo(() => {
    const parts: string[] = [];
    if (autoGroup !== PROXY_NODE_DEFAULT_AUTO_GROUP) {
      parts.push(PROXY_NODE_AUTO_GROUP_LABELS[autoGroup]);
    }
    if (frontProxyId > 0) {
      const front = nodes.find((item) => Number(item.id) === frontProxyId);
      parts.push(`经由 ${front?.name || `#${frontProxyId}`}`);
    }
    return parts.join(" · ");
  }, [autoGroup, frontProxyId, nodes]);

  const submit = () => {
    const trimmedName = name.trim();
    const trimmedLink = link.trim();
    if (!trimmedName) {
      toast.error("请填写节点名称");
      return;
    }
    if (!trimmedLink) {
      toast.error("请粘贴落地机的节点链接");
      return;
    }
    const payload = {
      name: trimmedName,
      remark: remark.trim() || null,
      publicLabel: publicLabel.trim() || null,
      countryCode: countryCode.trim().toUpperCase() || null,
      link: trimmedLink,
      autoGroup,
      includeDirect,
      frontProxyId,
      bandwidthMbps: Math.max(0, Math.floor(Number(bandwidthMbps) || 0)),
      trafficLimit: bytesFromGb(trafficLimitGb),
      trafficAutoReset,
      trafficResetDay: Math.min(MONTHLY_RESET_MAX_DAY, Math.max(1, Math.floor(Number(trafficResetDay) || 1))),
    };
    if (editingNodeId) {
      // 已用量只在编辑时能改：新建时还没有任何用量，给个输入框只会让人以为要填。
      updateNode.mutate({ id: editingNodeId, ...payload, trafficUsed: bytesFromGb(trafficUsedGb) });
    } else {
      createNode.mutate(payload);
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
        <div className="space-y-2">
          <Label htmlFor="proxy-node-name">节点名称</Label>
          <Input
            id="proxy-node-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 HKT 落地"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="proxy-node-remark">备注</Label>
          <Input
            id="proxy-node-remark"
            value={remark}
            onChange={(event) => setRemark(event.target.value)}
            placeholder="例如 给张三的 / 这条快到期"
            maxLength={12}
          />
          <p data-fx-help="" className="text-xs text-muted-foreground">
            只给你自己看。分享出去的节点，对方看不到这一句。
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="proxy-node-public-label">对外标注</Label>
          <Input
            id="proxy-node-public-label"
            value={publicLabel}
            onChange={(event) => setPublicLabel(event.target.value)}
            placeholder="例如 家宽 / IEPL / 深港专线"
            maxLength={12}
          />
          {/*
            和备注分开是因为它们服务两种人。

            备注是主人自己的账本（「给张三的」「便宜线」），泄给租户会出事；
            对外标注是线路本身的属性（「家宽」「IEPL」）—— 恰恰是租户最想知道、
            而只有主人说得出的那件事。合成一个字段，两种用途只能二选一：
            要么泄露账本，要么租户看到的永远是一个没有信息量的「直连」。
          */}
          <p data-fx-help="" className="text-xs text-muted-foreground">
            会顶掉「订阅内容」里那个「直连」标签，分享出去的人也看得到。不进订阅。
          </p>
        </div>
        <FormField className="space-y-2">
          <Label>直连也放进订阅</Label>
          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <p className="min-w-0 text-xs text-muted-foreground">
              订阅里额外给出这个节点自己的地址；关掉只藏直连，经它中转的线路照常在。
              {includeDirect ? (
                <span className="mt-1 block text-[var(--fx-warn-text)]">
                  该节点 IP 会出现在每条订阅地址里。
                </span>
              ) : null}
            </p>
            <Checkbox
              checked={includeDirect}
              onCheckedChange={setIncludeDirect}
              className="mt-0.5 shrink-0"
            />
          </div>
        </FormField>
        <div className="space-y-2 rounded-lg border p-3">
          <Label>这台落地机的套餐</Label>
          <div className="grid grid-cols-2 gap-2">
            <FormField className="min-w-0 space-y-1">
              <Label className="text-xs text-muted-foreground">带宽（Mbps）</Label>
              <Input
                type="number"
                inputMode="numeric"
                value={bandwidthMbps}
                onChange={(event) => setBandwidthMbps(event.target.value)}
                placeholder="500"
              />
            </FormField>
            <FormField className="min-w-0 space-y-1">
              <Label className="text-xs text-muted-foreground">总流量（GB）</Label>
              <Input
                type="number"
                inputMode="numeric"
                value={trafficLimitGb}
                onChange={(event) => setTrafficLimitGb(event.target.value)}
                placeholder="1000"
              />
            </FormField>
          </div>
          {editingNodeId ? (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">已用流量（GB）</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={trafficUsedGb}
                  onChange={(event) => setTrafficUsedGb(event.target.value)}
                  placeholder="0"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setTrafficUsedGb("")}
                >
                  清零
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                面板自己会累加，这里只是用来跟机房的账单对齐。
                <span className="mt-1 block text-[var(--fx-warn-text)]">
                  面板只数得到经转发规则走过的流量 —— 订阅里的「直连」条目和这台机器上跑的别的服务都不计入，
                  所以这个数只会比机房账单小，不会大。
                </span>
              </p>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="min-w-0">
              <Label className="text-xs">每月自动清零</Label>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {trafficAutoReset ? (
                <Input aria-label="每月自动清零日期"
                  type="number"
                  inputMode="numeric"
                  className="h-8 w-16"
                  value={trafficResetDay}
                  onChange={(event) => setTrafficResetDay(event.target.value)}
                />
              ) : null}
              <Checkbox aria-label="每月自动清零" checked={trafficAutoReset} onCheckedChange={setTrafficAutoReset} />
            </div>
          </div>
        </div>
        {/*
          自动选路和前置代理都是少数人才用的东西，平铺在这里会把「改个名字、
          换条链接」这种日常操作推到第二屏。所以一律收着 —— 配过的人也收着。

          代价是「我设过的东西看不见了」，所以折叠条上直接写出里头设了什么。
          摊开是为了让人看见，而看见并不非得摊开。
        */}
        <div className="space-y-2">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            aria-expanded={advancedOpen}
          >
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${advancedOpen ? "" : "-rotate-90"}`} />
            <span>高级</span>
            {!advancedOpen && advancedSummary ? (
              <span className="min-w-0 truncate font-normal text-foreground/70">{advancedSummary}</span>
            ) : null}
            <span className="h-px flex-1 bg-border" />
          </button>
          {advancedOpen ? (
            <div className="space-y-4 pt-1">
              <FormField className="space-y-2">
                <Label>地区</Label>
                <Input
                  value={countryCode}
                  onChange={(event) => setCountryCode(event.target.value)}
                  maxLength={2}
                  placeholder="国家码，如 HK、JP；留空自动猜"
                />
                <p className="text-xs text-muted-foreground">
                  {countryCode.trim().length === 2
                    ? proxySubRegionLabel(countryCode.trim().toUpperCase()) || "不认识这个国家码"
                    : "订阅里的国旗、地区组、按地区排序都看它。留空时按机器位置或名字里的关键字（香港 / HK / 🇭🇰）猜。"}
                </p>
              </FormField>
              <FormField className="space-y-2">
                <Label>自动选路</Label>
                <Select
                  value={autoGroup}
                  onValueChange={(value) => setAutoGroup(value as ProxyNodeAutoGroup)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROXY_NODE_AUTO_GROUPS.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {PROXY_NODE_AUTO_GROUP_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  多条中转指向这个落地时，订阅里额外生成一个选路组。
                  {PROXY_NODE_AUTO_GROUP_HINTS[autoGroup]}
                </p>
              </FormField>
              <FormField className="space-y-2">
                <Label>前置代理</Label>
                <Select
                  value={String(frontProxyId)}
                  onValueChange={(value) => setFrontProxyId(Number(value))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="不经由" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">不经由</SelectItem>
                    {nodes
                      .filter((item) => Number(item.id) !== editingNodeId)
                      .map((item) => (
                        <SelectItem key={item.id} value={String(item.id)}>
                          {item.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  连接先经由它建立。
                  {frontProxyId > 0 ? (
                    <span className="mt-1 block text-[var(--fx-warn-text)]">
                      Loon 与 QX 需在客户端里手连一次。
                    </span>
                  ) : null}
                </p>
              </FormField>
            </div>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="proxy-node-link">节点链接</Label>
          <Textarea
            id="proxy-node-link"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder={'vless:// vmess:// trojan:// ss:// hysteria2:// tuic:// anytls:// socks://\nSnell 没有链接，粘 Surge 那行：名字 = snell, 地址, 端口, psk=密钥, version=4\n或粘贴 JSON：{"type":"vless","server":"...","server_port":443,...}'}
            rows={5}
            className="font-mono text-xs"
          />
        </div>
      </div>
      {/*
        footer 要自己占住位置：shrink-0 挡住被正文压扁，border-t 把它和可滚的
        正文分开 —— 不然滚到底时按钮和最后一行字糊在一起，看着像叠上去的。
      */}
      <DialogFooter className="shrink-0 border-t pt-3">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button onClick={submit} disabled={createNode.isPending || updateNode.isPending}>
          保存
        </Button>
      </DialogFooter>
    </>
  );
}
