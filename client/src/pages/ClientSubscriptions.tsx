import { getFormatLocale } from "@/i18n";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import MyHostsSection from "@/components/proxy/MyHostsSection";
import ProxyInboundsSection from "@/components/proxy/ProxyInboundsSection";
import { proxyNodeMetaText, type ProxyNodeRowSpec } from "@/components/proxy/ProxyNodeRow";
import { ProxyNodeShareDialog } from "@/components/proxy/ProxyNodeShareDialog";
import { ProxyNodeEditDialog, type ProxyNodeEditable } from "@/components/proxy/ProxyNodeEditDialog";
import { ProxySubTokenCreateDialog } from "@/components/proxy/ProxySubTokenCreateDialog";
import { ProxyPreviewRenameDialog, type ProxyPreviewRenameTarget } from "@/components/proxy/ProxyPreviewRenameDialog";
import { NODE_GROUP_MODE_STORAGE_KEY, readStoredGroupMode, writeStoredPref } from "@/components/proxy/proxyNodeViewPrefs";
import { summarizeProxyPreview } from "@/components/proxy/proxyPreviewSummary";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import EmptyState from "@/components/EmptyState";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { useCompactLayout } from "@/hooks/useCompactLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch } from "@/components/ui/switch";
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { pollingInterval } from "@/lib/polling";
import { configQuery } from "@/lib/queryPresets";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import {
  PROXY_NODE_PROTOCOL_LABELS,
  type ProxyNodeProtocol,
} from "@shared/proxyNode";
import {
  normalizeProxySubscriptionFormat,
  PROXY_SUBSCRIPTION_FORMATS,
  PROXY_SUBSCRIPTION_FORMAT_LABELS,
  type ProxySubscriptionFormat,
} from "@shared/proxySubscription";
import {
  PROXY_RULE_PRESETS,
  PROXY_RULE_PRESET_HINTS,
  PROXY_RULE_PRESET_LABELS,
  normalizeProxyRulePreset,
  type ProxyRulePreset,
} from "@shared/proxyRuleset";
import {
  buildProxySubscriptionUrl,
  detectProxyClientPlatform,
  proxyClientPlatformsLabel,
  PROXY_CLIENT_PLATFORM_LABELS,
  PROXY_CLIENT_TARGETS,
  proxyClientImportFor,
  proxySubscriptionKindSupported,
  proxySubscriptionProfileName,
  PROXY_SUBSCRIPTION_KINDS,
  PROXY_SUBSCRIPTION_KIND_HINTS,
  PROXY_SUBSCRIPTION_KIND_LABELS,
  type ProxyClientPlatform,
  type ProxyClientTarget,
  type ProxySubscriptionKind,
} from "@shared/proxyClientImport";
import { summarizeProxyNodeHealthCounts, type ProxyNodeHealth } from "@shared/proxyNodeHealth";
import { PROXY_SUB_TOKEN_FAILURE_LABELS, proxySubTokenStatus } from "@shared/proxySubTokenStatus";
import { ProxyNodeQuotaDetail, ProxyNodeQuotaToggle } from "@/components/proxy/ProxyNodeQuotaCells";
import {
  PROXY_NODE_GROUP_MODES,
  PROXY_NODE_GROUP_MODE_LABELS,
  type ProxyNodeGroupMode,
} from "@shared/proxyNodeGrouping";
import {
  AlertTriangle,
  Atom,
  AudioLines,
  Cat,
  ChevronDown,
  Copy,
  Eye,
  Globe,
  KeyRound,
  Layers,
  Link2,
  Package,
  Server,
  TriangleAlert,
  Pencil,
  Plus,
  QrCode,
  Rocket,
  Share2,
  Shield,
  Boxes,
  Ship,
  Squirrel,
  Binary,
  Blocks,
  Trash2,
  Waves,
  Zap,
  type LucideIcon,
  MoreHorizontal,
  History,
  ListOrdered,
  Smartphone,
  Waypoints,
} from "lucide-react";
import { useLocation } from "wouter";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NodeExitDialog, type ExitCheckSubject } from "@/components/proxy/ExitQualityView";
import { LandingPoolMembersDetail, LandingPoolMembersToggle, type LandingPoolMemberLine } from "@/components/proxy/LandingPoolMembers";
import {
  ProxySubTokenDevicesDialog,
  ProxySubTokenEditDialog,
  ProxySubTokenLogsDialog,
  ProxySubTokenPreviewDialog,
  type ProxySubTokenLike,
} from "@/components/proxy/ProxySubTokenDialogs";
import ProxySubSourcesSection from "@/components/proxy/ProxySubSourcesSection";
import ProxyNodeReorderDialog from "@/components/proxy/ProxyNodeReorderDialog";
import { PROXY_SUB_IP_VERSIONS, PROXY_SUB_IP_VERSION_LABELS, type ProxySubIpVersion } from "@shared/proxySubIpVersion";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/*
  「订阅内容」弹窗有五百多行、只在点开时才用：单独一个包，点开再下载。
  页面自己仍然取 preview 这份数据（概览条上的数字要它），弹窗打开后吃同一份缓存。
*/
const ProxySubscriptionPreviewDialog = lazy(() => import("@/components/proxy/ProxySubscriptionPreviewDialog"));
/*
  节点列表还没回来时的兜底。写成模块级常量而不是 `?? []`：后者每次渲染都是新数组，
  传给排序弹窗等子组件后，它们按引用比较的 effect / memo 每帧都会重跑一遍。
*/
const EMPTY_NODES: never[] = [];

/**
 * 每个客户端一个可辨识的图案 + 各自的品牌色。
 *
 * 刻意不用各家的官方 logo：那些是第三方商标资源，不该擅自打包进仓库，而且面板的
 * CSP 也不允许从外部 CDN 拉图片（不少面板还跑在内网）。七格清一色同一个下载图标
 * 等于没有图标 —— 用户还是得逐字读标签，网格就白排了。
 */
const CLIENT_ICONS: Record<string, { icon: LucideIcon; className: string }> = {
  // mihomo 的吉祥物就是只猫。
  clash: { icon: Cat, className: "bg-[var(--fx-path-soft)] text-[var(--fx-path)]" },
  stash: { icon: Layers, className: "bg-[var(--fx-delivery-soft)] text-[var(--fx-delivery)]" },
  singbox: { icon: Package, className: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]" },
  loon: { icon: Waves, className: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]" },
  surge: { icon: AudioLines, className: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]" },
  quantumultx: { icon: Atom, className: "bg-[var(--fx-delivery-soft)] text-[var(--fx-delivery)]" },
  hiddify: { icon: Shield, className: "bg-[var(--fx-path-soft)] text-[var(--fx-path)]" },
  shadowrocket: { icon: Rocket, className: "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)]" },
  v2rayng: { icon: Binary, className: "bg-[var(--fx-path-soft)] text-[var(--fx-path)]" },
  surfboard: { icon: Ship, className: "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]" },
  nekobox: { icon: Boxes, className: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]" },
  nekoray: { icon: Blocks, className: "bg-[var(--fx-delivery-soft)] text-[var(--fx-delivery)]" },
  v2rayn: { icon: Binary, className: "bg-[var(--fx-l3-control-fill)] text-muted-foreground" },
  // Egern 在丹麦语里是松鼠。
  egern: { icon: Squirrel, className: "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]" },
};

function clientIcon(target: ProxyClientTarget) {
  return CLIENT_ICONS[target.id] ?? { icon: Package, className: "bg-muted text-muted-foreground" };
}

/**
 * 可选的官方图标：把图片丢进 assets/clientLogos/<客户端 id>.svg|png|webp 就会自动用上。
 *
 * 构建期扫描而不是运行期探测：没放图标的面板不会为此发一串 404 请求，放了的
 * 也走正常打包，不受 CSP 限制（面板常跑在内网，外部 CDN 一律拉不到）。
 * 仓库里不预置这些图 —— 闭源客户端的图标是各自开发者的商标资源，
 * 而这个面板是公开分发的。详见该目录下的 README。
 */
const CLIENT_LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../assets/clientLogos/*.{svg,png,webp,jpg,jpeg,ico}", {
      eager: true,
      import: "default",
    }) as Record<string, string>,
  ).map(([path, url]) => [path.replace(/^.*\/(.+)\.\w+$/, "$1"), url]),
);

/** 当前设备。识别不出来时返回 null —— 那就退回展示全部，别把人挡在外面。 */
function currentPlatform(): ProxyClientPlatform | null {
  if (typeof navigator === "undefined") return null;
  return detectProxyClientPlatform(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

function subscriptionUrl(
  token: string,
  format: ProxySubscriptionFormat,
  kind: ProxySubscriptionKind,
  pinFormat = false,
  ipVersion: ProxySubIpVersion | null = null,
) {
  return buildProxySubscriptionUrl({ origin: mobileAuth.panelOrigin(), token, format, kind, pinFormat, ipVersion });
}

async function copyText(value: string, message: string) {
  // 面板常跑在 http://ip:port 上，非安全上下文里 navigator.clipboard 根本不存在，
  // 所以走带 execCommand 回退的共享实现，而不是直接调 clipboard API。
  if (await copyTextToClipboard(value)) {
    toast.success(message);
    return;
  }
  // 说一句为什么，否则用户只会以为是面板坏了，反复点。
  toast.error(
    clipboardNeedsManualCopy()
      ? "当前是 http 访问，浏览器限制了剪贴板，请长按选中地址复制"
      : "复制失败，请长按选中地址复制",
  );
}

const NODE_HEALTH_STYLES: Record<ProxyNodeHealth["state"], string> = {
  online: "bg-[var(--fx-healthy)]",
  offline: "bg-[var(--fx-down)]",
  // 灰色而不是红色：没人在探它不等于它挂了，标红会把好节点冤枉成故障。
  unknown: "bg-muted-foreground/40",
};

/**
 * 落地节点的在线小圆点。
 *
 * 探测是中转机发出的 tcping，所以这里回答的是「中转连不连得上这个落地」，
 * 不是「你的客户端连不连得上」—— 悬停说明里写明了，免得红点被当成落地挂了
 * 而其实只是中转到落地那一段不通。
 */
function ProxyNodeHealthDot({ health }: { health?: ProxyNodeHealth | null }) {
  const state = health?.state || "unknown";
  const detail = health?.title || "暂无探测结果";
  const label = state === "online" ? "在线" : state === "offline" ? "离线" : "未知";
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${NODE_HEALTH_STYLES[state]}`}
      title={`${label} · ${detail}（由中转机探测，不代表你的客户端能连上）`}
      aria-label={`${label}：${detail}`}
    />
  );
}

/**
 * 令牌行上那句「最近一次被拒」。
 *
 * 只在**最近一次确实是失败**时出现（成功之后就不再挂着，见 proxySubTokenStatus）。
 * 说不了的那一种也照实说不了：地址被改过或重置过时，请求根本落不到任何一行上。
 */
function renderTokenFailure(token: any) {
  const status = proxySubTokenStatus(token);
  if (status.kind !== "failed") return null;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--fx-warn-text)]"
      title={`客户端来拉过，被挡下了：${PROXY_SUB_TOKEN_FAILURE_LABELS[status.reason]}`}
    >
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span className="truncate">最近一次没拉到：{PROXY_SUB_TOKEN_FAILURE_LABELS[status.reason]}</span>
    </span>
  );
}

export default function ClientSubscriptionsPage() {
  const [, navigate] = useLocation();
  const compactLayout = useCompactLayout();
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();

  // 权限和公开设置变得慢，半分钟内按缓存走（lib/queryPresets）。
  const permissionQuery = trpc.proxySubscriptions.permission.useQuery(undefined, configQuery);
  const allowed = permissionQuery.data?.allowed ?? true;

  /**
   * 轮询而不是只在进页面时取一次：在线状态与流量是会变的，不刷新的话那个小圆点
   * 会一直停在你进页面那一刻的颜色 —— 一个不动的状态灯比没有状态灯更误导。
   * 探测的新鲜期是 6 分钟，30 秒一次足够跟上，也不至于把面板打满。
   */
  const nodesQuery = trpc.proxySubscriptions.listNodes.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    refetchOnWindowFocus: true,
  });
  const tokensQuery = trpc.proxySubscriptions.listTokens.useQuery();
  // 用户看得到的订阅设置：备用域名、默认外观、能不能加外部订阅。
  const subSettingsQuery = trpc.proxySubscriptions.settingsPublic.useQuery(undefined, configQuery);
  /*
    订阅内容这份数据不轮询，进页面取一次就够。弹窗没打开也要取：概览条上的「客户端线路」
    「待处理」两个数字和节点行上的「不在订阅里」都从它算；弹窗打开后用同一个查询键，吃这份缓存。
  */
  const previewQuery = trpc.proxySubscriptions.preview.useQuery();

  const [nodeGroupMode, setNodeGroupMode] = useState<ProxyNodeGroupMode>(readStoredGroupMode);
  /** 「订阅内容」收成弹窗：它是预览，不是这一页的常驻内容。 */
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 「我的机器」也收成弹窗：它是自建节点的前置条件，不是并列的一段。 */
  const [hostsOpen, setHostsOpen] = useState(false);
  /** 展开了套餐详情的节点。只在本次会话里记着 —— 这是个随手看一眼的动作，不值得持久化。 */
  const [expandedQuotaIds, setExpandedQuotaIds] = useState<number[]>([]);

  /*
    三个弹窗（节点、新建链接、改名）的表单状态都在各自的组件里（components/proxy/*Dialog）。
    页面只记「开着没有、编辑的是哪条」—— 原来十几个输入框的 useState 挂在这里，弹窗里每敲
    一个键整页重画一遍，节点列表跟着重排。
  */
  const [nodeDialog, setNodeDialog] = useState<{ open: boolean; node: ProxyNodeEditable | null }>({ open: false, node: null });
  // 订阅内容里改名：转发派生的条目改规则上的显示名，直连条目改模板名。
  const [renaming, setRenaming] = useState<ProxyPreviewRenameTarget | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  // 一键订阅面板默认折叠，同一时间只展开一个，免得页面被撑得很长。
  const [importOpenTokenId, setImportOpenTokenId] = useState<number | null>(null);
  const [importKind, setImportKind] = useState<ProxySubscriptionKind>("nodes");
  // 地址按哪种 IP 出：默认照旧（域名 / 首选地址），选了就固定带上 ipVersion，服务端不会退回另一种。
  const [importIpVersion, setImportIpVersion] = useState<ProxySubIpVersion | null>(null);
  const [qrTarget, setQrTarget] = useState<{ title: string; url: string; hint?: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [showAllClients, setShowAllClients] = useState(false);
  // 服务器数据目录里放的图标。放了就盖掉内置图案，没放（多数情况）就是个空对象。
  const [runtimeLogos, setRuntimeLogos] = useState<Record<string, string>>({});
  // 只认一次：UA 在页面生命周期里不会变。
  const platform = useMemo(() => currentPlatform(), []);
  const visibleTargets = useMemo(() => {
    if (!platform || showAllClients) return [...PROXY_CLIENT_TARGETS];
    return PROXY_CLIENT_TARGETS.filter((target) => target.platforms.includes(platform));
  }, [platform, showAllClients]);
  const hiddenCount = PROXY_CLIENT_TARGETS.length - visibleTargets.length;

  /**
   * 失效按影响范围分两份，不再一把全失效。
   *
   * 节点变了 → listNodes + preview（订阅内容由节点和转发算出来）；令牌变了 → 只有 listTokens。
   * 原来每个写操作都把三个一起重取：拨一下行开关多发两个请求，令牌那张卡还会跟着闪一下。
   * 返回 promise 是给乐观开关用的：mutateAsync 等到重取落地才算完，开关跑完一轮不会按旧值闪一下。
   */
  const invalidateNodes = useCallback(() => Promise.all([
    utils.proxySubscriptions.listNodes.invalidate(),
    utils.proxySubscriptions.preview.invalidate(),
  ]), [utils]);
  const invalidateTokens = useCallback(() => utils.proxySubscriptions.listTokens.invalidate(), [utils]);
  // 子组件的 onSaved / onChanged 这类位置要的是 () => void。
  const refreshNodes = useCallback(() => { void invalidateNodes(); }, [invalidateNodes]);
  const refreshTokens = useCallback(() => { void invalidateTokens(); }, [invalidateTokens]);

  /*
    这个 updateNode 只给行上的开关用（启用 / 直连进订阅）。弹窗里的「保存」有自己的实例 ——
    原来共用一个，拨一下开关也会弹「客户端节点已更新」、还把正开着的弹窗关掉。
  */
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({
    onSuccess: invalidateNodes,
    onError: (error) => toast.error(error.message),
  });
  const updateNodeAsync = updateNode.mutateAsync;
  const deleteNode = trpc.proxySubscriptions.deleteNode.useMutation({
    onSuccess: (result) => {
      /**
       * 删一个节点可能同时改掉两样别的东西：绑着它的转发，和正在卖它的套餐。
       * 套餐那一头尤其要说 —— 商店页上的节点数量当场就变了，不说没人知道。
       */
      const notes: string[] = [];
      if (result.releasedRules > 0) notes.push(`${result.releasedRules} 条转发已解绑（转发本身继续运行）`);
      if (result.releasedPlans > 0) notes.push(`${result.releasedPlans} 个套餐已移除该节点`);
      toast.success(notes.length > 0 ? `节点已删除，${notes.join("；")}` : "节点已删除");
      void invalidateNodes();
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteNodeMutate = deleteNode.mutate;
  const updateToken = trpc.proxySubscriptions.updateToken.useMutation({
    onSuccess: invalidateTokens,
    onError: (error) => toast.error(error.message),
  });
  const rotateToken = trpc.proxySubscriptions.rotateToken.useMutation({
    onSuccess: (result) => {
      if (result.warning) toast.warning(result.warning);
      else toast.success("订阅地址已重置，旧地址和短链接立即失效");
      void invalidateTokens();
    },
    onError: (error) => toast.error(error.message),
  });
  const rotateTokenConfirmed = async (id: number) => {
    const ok = await confirm({
      title: "重置这个订阅地址？",
      description: "只更换订阅地址本身，不会重置流量。旧地址和短链接立即失效，已经导入过的客户端都要重新填写新地址。",
      confirmText: "重置地址",
      tone: "destructive",
    });
    if (ok) rotateToken.mutate({ id });
  };
  const deleteTokenConfirmed = async (id: number) => {
    const ok = await confirm({
      title: "删除这个订阅链接？",
      // 删的只是「下载入口」：节点凭据是按入站发的，已导入的客户端照常能连。
      // 不说清这一点，用户会以为删了地址就等于断网。
      description: "只是这条地址失效：用它的客户端拉不到更新，但已经导入的节点照常能连。要让某台设备彻底断开，去落地节点上「重置凭据」（其他设备要重新拉订阅）。",
      confirmText: "删除",
      tone: "destructive",
    });
    if (ok) deleteToken.mutate({ id });
  };
  const deleteToken = trpc.proxySubscriptions.deleteToken.useMutation({
    onSuccess: () => {
      toast.success("订阅链接已删除");
      void invalidateTokens();
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`${mobileAuth.panelOrigin()}/api/client-logos`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") {
          setRuntimeLogos(data as Record<string, string>);
        }
      })
      // 拿不到就用内置图案，不值得为此打扰用户。
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 二维码固定黑白：跟着主题走的话，深色模式下扫不出来。
  useEffect(() => {
    if (!qrTarget) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    // 二维码库只在点开二维码时才用得上，不跟这一页一起进包（和 DashboardLayout 开双重验证那里一样）。
    import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(qrTarget.url, { width: 480, margin: 1, color: { dark: "#000000", light: "#ffffff" } }))
      .then((value) => {
        if (!cancelled) setQrDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) toast.error("二维码生成失败，复制地址手动添加即可");
      });
    return () => {
      cancelled = true;
    };
  }, [qrTarget]);

  const nodes = nodesQuery.data ?? EMPTY_NODES;
  /** 一个节点都没有的时候，订阅链接那张卡要改口告诉他先去加节点。 */
  const nodeCount = (nodes as any[]).length;
  const tokens = tokensQuery.data ?? [];
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";

  /** 从节点这边发起分享。粘进来的节点只有一份凭据，所以就是一个列表。 */
  const [shareNode, setShareNode] = useState<{ id: number; name: string } | null>(null);
  // 令牌的几个弹窗：编辑、预览、拉取记录、设备；节点排序。
  const [editingToken, setEditingToken] = useState<ProxySubTokenLike | null>(null);
  const [previewToken, setPreviewToken] = useState<{ id: number; name: string } | null>(null);
  // 节点菜单「出口检测」：自建传入站 id，粘贴传节点 id。
  const [exitCheck, setExitCheck] = useState<{ subject: ExitCheckSubject; name: string } | null>(null);
  const openInboundExitCheck = useCallback((inboundId: number, name: string) => setExitCheck({ subject: { inboundId }, name }), []);
  const openNodeExitCheck = useCallback((nodeId: number, name: string) => setExitCheck({ subject: { nodeId }, name }), []);
  const [logsToken, setLogsToken] = useState<{ id: number; name: string } | null>(null);
  const [devicesToken, setDevicesToken] = useState<{ id: number; name: string } | null>(null);
  const [reorderOpen, setReorderOpen] = useState(false);

  /**
   * 「落地节点」这一段只列粘进来的，不列自建节点派生出来的那些。
   *
   * 派生节点在上面的「新建节点」里管着，两处都列就成了同一个节点出现两次；
   * 而且这一段的「编辑」是按「换一条节点链接」设计的，派生节点根本没有链接，
   * 点进去只会得到一句「请粘贴落地机的节点链接」—— 一个必然失败的入口。
   *
   * 但它们仍然留在 nodes 里：绑转发的下拉和前置代理的下拉都要能选到自建节点，
   * 那是「自建落地 + 中转」的正常用法。
   */
  const pastedNodes = useMemo(
    // 别人分享进来的节点即便在对方那边是自建派生的，在这一侧也没有「新建节点」
    // 可以管，过滤掉的话它会在订阅里出现却在管理页上找不到，所以留在这一段。
    () => (nodes as any[]).filter((node) => !Number(node?.inboundId || 0) || node?.sharedFrom),
    [nodes],
  );

  /**
   * 入站 id → 它派生节点的探测结果。
   *
   * 一个入站可以有多份凭据、派生出多个节点，但它们走的是同一个端口 —— 任一可达
   * 就说明这个端口是活的，所以取最好的那个状态（在线 > 离线 > 未知）。分享进来的
   * 节点不算在内：那些在下面的 extraRows 里各自带着自己的点。
   */
  const healthByInboundId = useMemo(() => {
    const rank = (state?: string) => (state === "online" ? 2 : state === "offline" ? 1 : 0);
    const map = new Map<number, ProxyNodeHealth>();
    for (const node of nodes as any[]) {
      const inboundId = Number(node?.inboundId || 0);
      if (!inboundId || node?.sharedFrom) continue;
      const health = node?.health as ProxyNodeHealth | undefined;
      if (!health) continue;
      const prev = map.get(inboundId);
      if (!prev || rank(health.state) > rank(prev.state)) map.set(inboundId, health);
    }
    return map;
  }, [nodes]);
  const inboundLeading = useCallback(
    (inboundId: number) => <ProxyNodeHealthDot health={healthByInboundId.get(inboundId)} />,
    [healthByInboundId],
  );

  /**
   * 「我的节点」卡头上的在线/离线：数的是合并后**整张列表**。
   *
   * 只数粘贴那一半会得到一个对不上的数字 —— 卡头写着「12 个 · 2 在线」，而另外
   * 十行自建的明明也亮着绿点。自建那边按入站去数，跟行数对得上。
   */
  const inboundHealthStates = useMemo(
    () => [...healthByInboundId.values()].map((health) => health.state),
    [healthByInboundId],
  );
  const onlineNodeCount = useMemo(
    () => pastedNodes.filter((node) => node?.health?.state === "online").length
      + inboundHealthStates.filter((state) => state === "online").length,
    [pastedNodes, inboundHealthStates],
  );
  const offlineNodeCount = useMemo(
    () => pastedNodes.filter((node) => node?.health?.state === "offline").length
      + inboundHealthStates.filter((state) => state === "offline").length,
    [pastedNodes, inboundHealthStates],
  );

  const toggleQuota = useCallback((id: number) => {
    setExpandedQuotaIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }, []);

  const groupModeOptions = useMemo(
    () => PROXY_NODE_GROUP_MODES.map((mode) => ({ value: mode, label: PROXY_NODE_GROUP_MODE_LABELS[mode] })),
    [],
  );

  const preview = previewQuery.data;
  /** 订阅内容分成几段（和「订阅内容」弹窗同一份算法）：这一页只用到数字和两个 id 集合。 */
  const previewSummary = useMemo(() => summarizeProxyPreview(preview), [preview]);
  const { pendingCount, pendingSubtitle, relayNodes: relayPreviewNodes, directNodes: directPreviewNodes } = previewSummary;

  /**
   * 客户端里根本看不到的那些节点（服务端算的，它才知道谁被引用了）。
   *
   * 放在这里是因为下面的行规格要用它 —— 要动手的人就在那一行：行上原来只写
   * 「无转发绑定」，那是**机制**；「不在订阅里」才是后果，而且两者不等价 ——
   * 粘来的节点开了直连，没有转发照样在订阅里。
   */
  const unusedNodeIds = useMemo(
    () => new Set(previewSummary.unusedNodes.map((item) => Number(item.nodeId))),
    [previewSummary],
  );
  const unusedInboundIds = useMemo(() => {
    const ids = new Set<number>();
    for (const node of nodes as any[]) {
      const inboundId = Number(node?.inboundId || 0);
      if (inboundId > 0 && unusedNodeIds.has(Number(node.id))) ids.add(inboundId);
    }
    return ids;
  }, [nodes, unusedNodeIds]);

  /**
   * 机器的 Agent 从没连上过的那些节点。
   *
   * 这种机器上开的端口，配置根本下发不下去 —— 节点照样在订阅里（机器可能下一分钟
   * 就连上了，悄悄拿掉比发出去更糟），但得在行上说出来。掉线不算：那是暂时的，
   * 状态点已经在说了。
   */
  const hostOfflineNodeIds = useMemo(
    () => new Set(previewSummary.hostOfflineNodes.map((item) => Number(item.nodeId))),
    [previewSummary],
  );
  const hostOfflineInboundIds = useMemo(() => {
    const ids = new Set<number>();
    for (const node of nodes as any[]) {
      const inboundId = Number(node?.inboundId || 0);
      if (inboundId > 0 && hostOfflineNodeIds.has(Number(node.id))) ids.add(inboundId);
    }
    return ids;
  }, [nodes, hostOfflineNodeIds]);

  /*
    传给 ProxyInboundsSection（memo 过）的回调全部 useCallback：它和里面的 ProxyNodeRow 只在
    props 真变了才重画。这一页因为别的原因重画（开关弹窗、二维码）时，节点列表不动。
  */
  const openCreateNode = useCallback(() => setNodeDialog({ open: true, node: null }), []);
  const openEditNode = useCallback((node: ProxyNodeEditable) => setNodeDialog({ open: true, node }), []);
  const openPreview = useCallback(() => setPreviewOpen(true), []);
  const openHosts = useCallback(() => setHostsOpen(true), []);
  const changeGroupMode = useCallback((mode: ProxyNodeGroupMode) => {
    setNodeGroupMode(mode);
    writeStoredPref(NODE_GROUP_MODE_STORAGE_KEY, mode);
  }, []);
  const confirmDeleteNode = useCallback(async (node: { id: number; ruleCount?: number }) => {
    const ruleCount = Number(node.ruleCount || 0);
    const ok = await confirm({
      title: "删除这个客户端节点？",
      description: ruleCount > 0
        ? `${ruleCount} 条转发会被解绑，不再出现在订阅里。转发本身继续运行，不受影响。`
        : "该节点没有被任何转发绑定。",
      confirmText: "删除",
      tone: "destructive",
    });
    if (ok) deleteNodeMutate({ id: node.id });
  }, [confirm, deleteNodeMutate]);

  /**
   * 粘贴进来的、以及别人分享来的节点，组装成行规格交给「我的节点」那张卡。
   *
   * 开关写的是这条 proxy_nodes 记录自己的 isEnabled，跟自建那一路写派生节点的
   * includeDirect 是两回事 —— 所以两路各自组装，列表只负责排版。
   * 行上的开关是乐观的：拨下去当场变，请求失败弹回（updateNode 的 onError 会提示）。
   */
  const pastedRowSpecs = useMemo<ProxyNodeRowSpec[]>(() => pastedNodes.map((node: any) => {
    const quotaExpanded = expandedQuotaIds.includes(Number(node.id));
    /*
      落地池的池节点（2.3.500）：整个池在订阅里就这一条。名字、协议、密钥、启停都跟着节点池走（只读），
      这里能做的是分享、看在哪些转发里用、设了直连域名时开关「直连进订阅」。
    */
    if (node.landingPool && !node.sharedFrom) {
      const pool = node.landingPool as { id: number; name: string; members: number; ready: number; directDomain: string | null; summary: string; memberList: LandingPoolMemberLine[] };
      return {
        key: `node-${node.id}`,
        accent: "own" as const,
        protocol: String(node.protocol || ""),
        sortName: String(node.name || ""),
        leading: <ProxyNodeHealthDot health={node.health} />,
        name: node.name,
        tag: (
          <Badge variant="secondary" size="sm" className="shrink-0 font-normal">
            {PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol}
          </Badge>
        ),
        muted: !node.isEnabled,
        meta: proxyNodeMetaText([
          "落地池",
          pool.summary,
          pool.directDomain ? `直连 ${pool.directDomain}` : "只走中转",
          node.ruleCount > 0 ? `${node.ruleCount} 条转发` : "无转发绑定",
          unusedNodeIds.has(Number(node.id)) ? "不在订阅里" : "",
          node.sharedToUserIds?.length ? `已分享 ${node.sharedToUserIds.length} 人` : "",
          !node.isEnabled ? "一台都没开出来" : "",
        ]),
        // 点「3/3 台」展开看每台开在哪个端口（成员入站不在列表里各占一行）
        detail: quotaExpanded ? (
          <div className="flex flex-col gap-2">
            <LandingPoolMembersDetail members={pool.memberList || []} directDomain={pool.directDomain} onOpenPool={isAdmin ? () => navigate("/tunnels?tab=pools") : undefined} />
            <ProxyNodeQuotaDetail node={node} />
          </div>
        ) : null,
        inline: <LandingPoolMembersToggle ready={pool.ready} total={pool.members} expanded={quotaExpanded} onToggle={() => toggleQuota(Number(node.id))} />,
        toggle: pool.directDomain ? (
          <OptimisticSwitch aria-label={`${node.name} 直连进订阅`}
            className="shrink-0 scale-90"
            checked={!!node.includeDirect}
            title={node.includeDirect ? `订阅里有一条直连（${pool.directDomain}），关掉就只走中转` : "订阅里加一条直连（走域名）"}
            onCheckedChangeAsync={(checked) => updateNodeAsync({ id: node.id, includeDirect: checked })}
          />
        ) : null,
        actions: [
          // 节点池页（/tunnels）只有管理员进得去：普通用户不显示这一项，成员明细在上面「几台」里展开看
          ...(isAdmin
            ? [
              { key: "pool", label: "到节点池里改", icon: Waypoints, onSelect: () => navigate("/tunnels?tab=pools") },
              { key: "share", label: "分享给用户", icon: Share2, onSelect: () => setShareNode({ id: Number(node.id), name: String(node.name || "") }) },
            ]
            : []),
        ],
      };
    }
    return {
      key: `node-${node.id}`,
      // 粘来的和别人分享来的，左边色条不同：能不能改、凭据归谁，是这两类最大的差别。
      accent: node.sharedFrom ? ("shared" as const) : ("pasted" as const),
      protocol: String(node.protocol || ""),
      sortName: String(node.name || ""),
      leading: <ProxyNodeHealthDot health={node.health} />,
      name: node.name,
      tag: (
        <Badge variant="secondary" size="sm" className="shrink-0 font-normal">
          {PROXY_NODE_PROTOCOL_LABELS[node.protocol as ProxyNodeProtocol] || node.protocol}
        </Badge>
      ),
      muted: !node.isEnabled,
      meta: proxyNodeMetaText([
        // 来源排最前：合成一个列表之后，这是认出这行是什么的第一眼信息。
        node.sharedFrom ? "管理员分享" : "粘贴",
        `${node.address}:${node.port}`,
        String(node.remark || "").trim(),
        node.sharedFrom
          ? "不可修改"
          : node.ruleCount > 0 ? `${node.ruleCount} 条转发` : "无转发绑定",
        // 后果放在机制后面：没转发不等于不在订阅里（开了直连照样在）。
        unusedNodeIds.has(Number(node.id)) ? "不在订阅里" : "",
        node.sharedToUserIds?.length ? `已分享 ${node.sharedToUserIds.length} 人` : "",
        !node.isEnabled ? "已停用" : "",
      ]),
      detail: quotaExpanded ? <ProxyNodeQuotaDetail node={node} /> : null,
      inline: (
        <ProxyNodeQuotaToggle
          node={node}
          expanded={quotaExpanded}
          onToggle={() => toggleQuota(Number(node.id))}
        />
      ),
      toggle: node.sharedFrom ? null : (
        <OptimisticSwitch aria-label={`${node.name} 启用`}
          className="shrink-0 scale-90"
          checked={!!node.isEnabled}
          title="停用后它的直连和经它中转的线路都不进订阅；只想藏直连，去「预览订阅」里关那一条"
          onCheckedChangeAsync={(checked) => updateNodeAsync({ id: node.id, isEnabled: checked })}
        />
      ),
      /* 分享进来的节点对收方是只读的：服务端本来就按 userId 挡着，这里把入口一并
         收起来，别让人点进去才发现改不了。 */
      actions: node.sharedFrom ? [] : [
        ...(isAdmin
          ? [{
            key: "share",
            label: "分享给用户",
            icon: Share2,
            onSelect: () => setShareNode({ id: Number(node.id), name: String(node.name || "") }),
          }]
          : []),
        { key: "exit", label: "出口检测", icon: Globe, onSelect: () => openNodeExitCheck(Number(node.id), String(node.name || "")) },
        { key: "edit", label: "编辑", icon: Pencil, onSelect: () => openEditNode(node) },
        {
          key: "delete",
          label: "删除",
          icon: Trash2,
          destructive: true,
          onSelect: () => { void confirmDeleteNode(node); },
        },
      ],
    };
  }), [pastedNodes, unusedNodeIds, expandedQuotaIds, isAdmin, navigate, toggleQuota, updateNodeAsync, openNodeExitCheck, openEditNode, confirmDeleteNode]);

  /**
   * 在线情况怎么说。规矩在 shared/proxyNodeHealth 里：**没探测过不是在线** ——
   * 拿「离线为 0」当「全在线」，一个刚建好、一次都没探测过的面板会写着「节点全在线」。
   */
  const healthSummary = useMemo(
    () => summarizeProxyNodeHealthCounts({ total: nodeCount, online: onlineNodeCount, offline: offlineNodeCount }),
    [nodeCount, onlineNodeCount, offlineNodeCount],
  );
  // 权限查询未回来时先不下结论，避免闪一下「无权限」再闪回正常。
  if (permissionQuery.isLoading) {
    return (
      <DashboardLayout>
        <DataSectionLoading />
      </DashboardLayout>
    );
  }

  if (!allowed) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <WorkspaceHeader title={<>订阅管理</>} description={<>你有哪些线路，以及怎么把它们带进客户端。</>} />
          <Card className="relative overflow-hidden border-border bg-card">
            <CardContent className="py-10 text-center">
              {/*
                原来只说「没有权限，联系管理员」—— 那等于把人挡在门外还不说门后是什么。
                说清楚开通之后能拿到什么，他才知道值不值得去要。
              */}
              <p className="text-sm text-muted-foreground">
                这个账号还没开通客户端订阅。
              </p>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
                开通之后，你可以在自己的机器上开落地节点、把别处的节点粘进来，
                再用一条订阅地址把它们一次导入客户端 —— 转发和节点会自动对上。
                需要的话，找管理员开一下。
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6" data-fx-page="subscriptions">
        <div className="flex items-center justify-between gap-4">
          <WorkspaceHeader title={<>订阅管理</>} description={<>你有哪些线路，以及怎么把它们带进客户端。</>} />
          {healthSummary.badge ? (
            <Badge
              variant="outline"
              className={`shrink-0 gap-1.5 px-3 py-1.5 ${
                healthSummary.badge.tone === "warn"
                  ? "border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] text-[var(--fx-warn-text)]"
                  : "border-[color-mix(in_srgb,var(--fx-healthy)_30%,transparent)] text-[var(--fx-healthy-text)]"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${healthSummary.badge.tone === "warn" ? "bg-[var(--fx-warn)]" : "bg-[var(--fx-healthy)]"}`} />
              {healthSummary.badge.text}
            </Badge>
          ) : null}
        </div>

        {/*
          顶上这一排概览。
          原来一进来就是两张大卡片，得逐个展开才知道「我现在到底有几条线路、有没有
          东西要处理」。这几个数就是这一页的全部问题，摆在最前面。
          2026-11 起和总览那四张卡一个样（用户要求大小颜色和主页一样）：外面包一层 fx-ov-stats
          （styles/overview-pearl.css），每格带图标和颜色；标准布局下也带 data-fx-std-page，数字不按精简缩小。
        */}
        <div className="fx-ov-stats" data-fx-std-page={compactLayout ? undefined : ""}>
        <SummaryStrip
          ariaLabel="订阅概况"
          items={[
            {
              key: "nodes",
              label: "客户端线路",
              icon: Waypoints,
              iconTone: "violet",
              value: preview?.nodes.length ?? 0,
              hint: `中转 ${relayPreviewNodes.length} · 直连 ${directPreviewNodes.length}`,
              loading: previewQuery.isLoading,
              cacheKey: "subscriptions.stats.nodes",
              fallbackValue: 0,
              /*
                「客户端线路」和「待处理」讲的是同一件事的两面 —— 订阅里有什么、还差什么。
                所以两个数都通向「订阅内容」那个弹窗：想看细节的人不必再去找那个按钮。
              */
              onClick: (preview?.nodes.length ?? 0) > 0 ? () => setPreviewOpen(true) : undefined,
            },
            { key: "landing", label: "落地节点", icon: Server, iconTone: "sky", value: nodeCount, hint: healthSummary.subtitle, loading: nodesQuery.isLoading, cacheKey: "subscriptions.stats.landing", fallbackValue: 0 },
            { key: "tokens", label: "订阅链接", icon: Link2, iconTone: "teal", value: tokens.length, hint: tokens.length > 0 ? "导入客户端用的地址" : "还没建", loading: tokensQuery.isLoading, cacheKey: "subscriptions.stats.tokens", fallbackValue: 0 },
            {
              key: "pending",
              label: "待处理",
              icon: TriangleAlert,
              iconTone: "orange",
              value: pendingCount,
              hint: pendingSubtitle,
              tone: pendingCount > 0 ? "warn" : undefined,
              loading: previewQuery.isLoading,
              cacheKey: "subscriptions.stats.pending",
              fallbackValue: 0,
              // 写着「你有 N 件事要处理」的数，本来就该是点进去处理的入口。
              onClick: pendingCount > 0 ? () => setPreviewOpen(true) : undefined,
            },
          ]}
        />
        </div>

        {/*
          订阅链接排在最前面。

          回头客来这一页十次有九次只干一件事：把链接复制走或者重新导入 —— 原来它
          压在五张卡片的最后，每次都要滚到底。第一次来的人也不吃亏：这时它是空的，
          空状态里就写着「先在下面加节点，再回来建链接」，等于把顺序讲了一遍。
        */}
        {/*
          原来顶上还有一道渐变高光，写着「和仪表盘那几张同一种做法」—— 仪表盘在 Dashboard 2.0
          已经把它去掉了（手册：颜色只说状态，装饰性的主色渐变不说任何事）。
        */}
        <Card className="relative overflow-hidden border-border bg-card">
          {/*
            手机上原来三层内边距叠着吃宽度：外层 main 12px + 卡片 24px + 每行自己的
            12px，414 的屏幕先去掉 72。内容被挤成一条，看着就不饱满。卡片这一层在手机上
            收到 12，桌面端照旧 24。
          */}
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 px-3 pb-3 pt-4 sm:px-6 sm:pt-6">
            {/*
              小色章：颜色和上面那张概览卡是同一个。
              「订阅链接」在概览里是紫的，往下这一段也是紫的 —— 眼睛能把上下两处对上，
              不用再读一遍标题。图标散着放也能认，但认的是图标；带上颜色认的是「这一块」。
            */}
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--fx-delivery-soft)] text-[var(--fx-delivery)]">
                <Link2 className="h-3.5 w-3.5" />
              </span>
              订阅链接
              {tokens.length > 0 ? (
                <span data-fx-compact-hide="" className="text-xs font-normal text-muted-foreground">{tokens.length} 条</span>
              ) : null}
            </CardTitle>
            <Button
              className="shrink-0"
              size="sm"
              onClick={() => setTokenDialogOpen(true)}
            >
              <Plus className="mr-1 h-4 w-4" />
              新建链接
            </Button>
          </CardHeader>
          <CardContent className="px-3 pb-4 sm:px-6 sm:pb-6">
            {tokensQuery.isLoading ? (
              <DataSectionLoading />
            ) : tokensQuery.error && tokens.length === 0 ? (
              /* 「还没有订阅链接」得是真的没有。读失败还这么说，等于让人再建一条重复的。 */
              <DataSectionError
                label="订阅链接"
                error={tokensQuery.error}
                retrying={tokensQuery.isFetching}
                onRetry={() => { void tokensQuery.refetch(); }}
              />
            ) : tokens.length === 0 ? (
              <EmptyState
                icon={<Link2 />}
                title="还没有订阅链接"
                description={nodeCount > 0
                  ? "新建一个，然后把地址导入客户端。"
                  : "先在下面加节点 —— 自己机器上开一个，或者粘一条别处的链接 —— 再回来建链接。"}
              />
            ) : (
              <div className="fx-sub-token-list space-y-4">
                {tokens.map((token: any) => {
                  const expanded = importOpenTokenId === token.id;
                  const kind = importKind;
                  const preset = normalizeProxyRulePreset(token.rulePreset);
                  // 手动复制的地址刻意不带 format：让服务端按客户端标识协商，
                  // 这样同一条地址粘到哪个客户端都能拿到对的格式。
                  const manualUrl = subscriptionUrl(token.token, "base64", kind, false, importIpVersion);
                  return (
                  <div key={token.id} className="fx-sub-token space-y-3 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{token.name}</span>
                        {!token.isEnabled && <Badge variant="outline">已停用</Badge>}
                        <span className="text-xs text-muted-foreground">
                          已拉取 {token.accessCount || 0} 次
                        </span>
                        {/*
                          最近一次是被拒的，就把原因摆在这。
                          「客户说订阅更新不了」原来无从回答 —— 行上只有成功次数，
                          分不出他到底试没试、被挡在哪一步。
                        */}
                        {renderTokenFailure(token)}
                        {token.alias ? <Badge variant="outline" className="font-mono">/s/{token.alias}</Badge> : null}
                        {token.expiresAt ? (
                          <span className={`text-xs ${new Date(token.expiresAt).getTime() < Date.now() ? "text-[var(--fx-down-text)]" : "text-muted-foreground"}`}>
                            {new Date(token.expiresAt).getTime() < Date.now() ? "已过期" : `${new Date(token.expiresAt).toLocaleDateString(getFormatLocale())} 到期`}
                          </span>
                        ) : null}
                        {token.lastClientLabel ? <span className="text-xs text-muted-foreground">最近 {token.lastClientLabel}</span> : null}
                        {Number(token.deviceCount || 0) > 0 ? <span className="text-xs text-muted-foreground">{token.deviceCount} 台设备</span> : null}
                        {token.remark ? <span className="text-xs text-muted-foreground">· {token.remark}</span> : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {/* 乐观开关：拨下去当场变，失败弹回；只让令牌列表重取（见 invalidateTokens）。 */}
                        <OptimisticSwitch aria-label={`${token.name} 启用`}
                          checked={!!token.isEnabled}
                          onCheckedChangeAsync={(checked) => updateToken.mutateAsync({ id: token.id, isEnabled: checked })}
                        />
                        {/* 光写"重置"配个刷新图标，在订阅面板里只会被读成"重置流量"。
                            补上宾语并换成钥匙图标：这个按钮的代价是所有已导入的客户端都要重填。 */}
                        {/* 两个按钮收进一个「···」菜单，一行只剩名字、开关和菜单。 */}
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label={`${token.name} 的更多操作`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setEditingToken(token)}>
                                <Pencil className="h-4 w-4" />编辑（范围 / 外观）
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setPreviewToken({ id: token.id, name: token.name })}>
                                <Eye className="h-4 w-4" />预览内容
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setLogsToken({ id: token.id, name: token.name })}>
                                <History className="h-4 w-4" />拉取记录
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setDevicesToken({ id: token.id, name: token.name })}>
                                <Smartphone className="h-4 w-4" />设备
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => { void rotateTokenConfirmed(token.id); }}>
                                <KeyRound className="h-4 w-4" />重置地址
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onSelect={() => { void deleteTokenConfirmed(token.id); }}>
                                <Trash2 className="h-4 w-4" />删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                      </div>
                    </div>

                    <Button
                      variant={expanded ? "secondary" : "default"}
                      className="fx-token-subscribe w-full"
                      onClick={() => setImportOpenTokenId(expanded ? null : token.id)}
                    >
                      <Zap className="mr-1.5 h-4 w-4" />
                      一键订阅
                      <ChevronDown
                        className={`ml-1.5 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
                      />
                    </Button>

                    {expanded && (
                      /* 不再套一层边框：它已经被令牌那个框包着，而且只在展开时出现，
                         归属关系本来就清楚。三层边框套在一起才是真的乱。 */
                      <div className="space-y-3 border-t pt-3">
                        <div className="flex rounded-md border bg-background p-0.5">
                          {PROXY_SUBSCRIPTION_KINDS.map((item) => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => setImportKind(item)}
                              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                                kind === item
                                  ? "bg-primary text-primary-foreground"
                                  : "text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {PROXY_SUBSCRIPTION_KIND_LABELS[item]}
                            </button>
                          ))}
                        </div>
                        <p data-fx-help="" className="text-xs text-muted-foreground">
                          {PROXY_SUBSCRIPTION_KIND_HINTS[kind]}
                        </p>

                        {/* 只走 v6 的家宽、v4 很烂的手机流量：地址上钉死一种 IP。下面所有地址、图标、二维码一起变。 */}
                        <div className="space-y-1 rounded-md border bg-background px-2 py-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">节点地址</span>
                            <Select
                              value={importIpVersion || "default"}
                              onValueChange={(value) => setImportIpVersion(value === "4" || value === "6" ? value : null)}
                            >
                              <SelectTrigger aria-label="节点地址按哪种 IP 输出" className="h-7 w-28 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">默认</SelectItem>
                                {PROXY_SUB_IP_VERSIONS.map((item) => (
                                  <SelectItem key={item} value={item}>{PROXY_SUB_IP_VERSION_LABELS[item]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {importIpVersion ? (
                            <p data-fx-help="" className="text-xs text-muted-foreground">
                              地址带上 ipVersion={importIpVersion}：每个节点用入口机器真实的 IPv{importIpVersion} 地址，没有 IPv{importIpVersion} 的节点直接跳过，不会悄悄换成另一种；一个都不剩时客户端会收到「没有可用的 IPv{importIpVersion} 节点」。
                            </p>
                          ) : null}
                        </div>

                        {kind === "rules" && (
                          <div className="space-y-1.5 rounded-md border bg-background px-2 py-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                              分流规则：{PROXY_RULE_PRESET_LABELS[preset]}
                            </span>
                            <Select
                              value={preset}
                              onValueChange={(value) => updateToken.mutate({
                                id: token.id,
                                rulePreset: value as ProxyRulePreset,
                              })}
                            >
                              <SelectTrigger aria-label="分流规则" className="h-7 w-24 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PROXY_RULE_PRESETS.filter((item) => item !== "off").map((item) => (
                                  <SelectItem key={item} value={item}>
                                    {PROXY_RULE_PRESET_LABELS[item]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            </div>
                            {/* 光看"精简/均衡/完整"不知道差在哪，说明得跟着控件走。 */}
                            <p data-fx-help="" className="text-xs text-muted-foreground">{PROXY_RULE_PRESET_HINTS[preset]}</p>
                          </div>
                        )}

                        {/* 一键导入走 deep link，只有装了该客户端的设备点得动 ——
                            在 Windows 上摆一格 loon:// 就是个死按钮。所以按当前设备筛，
                            但留一个口子：识别错了或者想看别的平台，点开就是。 */}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {visibleTargets.map((target) => {
                            const supported = proxySubscriptionKindSupported(target.format, kind);
                            // 规则订阅在 Loon / QX / Shadowrocket 上是完整配置，导入方式和节点订阅不同。
                            const importer = proxyClientImportFor(target, kind);
                            // 从客户端图标点进去时已经知道是哪个客户端了，钉死格式，
                            // 不让它掉到令牌默认格式上。
                            const url = subscriptionUrl(token.token, target.format, kind, true, importIpVersion);
                            const importName = proxySubscriptionProfileName(String(token.name || ""), kind, String(me?.username || ""));
                            const { icon: Icon, className: iconClass } = clientIcon(target);
                            // 运行时的优先：放在服务器上就能换图，不必重新构建。
                            const logo = runtimeLogos[target.id]
                              ? `${mobileAuth.panelOrigin()}/api/client-logos/${target.id}`
                              : CLIENT_LOGOS[target.id];
                            const offPlatform = platform ? !target.platforms.includes(platform) : false;
                            const usable = supported && !offPlatform;
                            const tile = (
                              <>
                                <span
                                  className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg ${
                                    logo ? "bg-transparent" : usable ? iconClass : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {logo ? (
                                    // 置灰的格子连图标一起褪色，否则一格彩色 logo 配一行"本机没有"很矛盾。
                                    <img
                                      src={logo}
                                      alt=""
                                      className={`h-full w-full object-contain ${usable ? "" : "opacity-50 grayscale"}`}
                                    />
                                  ) : (
                                    <Icon className="h-4 w-4" />
                                  )}
                                </span>
                                <span className="w-full truncate text-center text-[11px] font-medium leading-tight">
                                  {target.shortLabel}
                                </span>
                                <span className="w-full truncate text-center text-[11px] text-muted-foreground">
                                  {!supported
                                    ? "不支持规则"
                                    : offPlatform
                                      ? "本机没有"
                                      : importer.buildImportUrl
                                        ? proxyClientPlatformsLabel(target)
                                        : "手动添加"}
                                </span>
                              </>
                            );
                            const tileClass =
                              "flex flex-col items-center gap-1.5 rounded-lg border bg-background p-2.5 text-inherit transition-colors hover:border-primary hover:bg-primary/5";
                            const covers = target.covers ? `。同样适用于：${target.covers}` : "";

                            // 不支持时置灰而不是隐藏：藏起来用户不知道为什么少了几个客户端。
                            if (usable && !importer.buildImportUrl) {
                              // 没有官方 scheme 的客户端：点开给它对应格式的地址和二维码，
                              // 外加一句粘到哪儿 —— 订阅地址本身对任何客户端都有效，
                              // 少的只是自动跳转那一步，不是不支持。
                              return (
                                <button
                                  key={target.id}
                                  type="button"
                                  title={`${target.label} 没有一键导入，点开取地址手动添加${covers}`}
                                  onClick={() =>
                                    setQrTarget({
                                      title: `${target.label} · ${PROXY_SUBSCRIPTION_KIND_LABELS[kind]}`,
                                      url,
                                      hint: importer.manualHint,
                                    })
                                  }
                                  className={tileClass}
                                >
                                  {tile}
                                </button>
                              );
                            }

                            return usable ? (
                              <a
                                key={target.id}
                                href={importer.buildImportUrl!(url, importName)}
                                title={`在 ${target.label} 中打开${covers}`}
                                className={tileClass}
                              >
                                {tile}
                              </a>
                            ) : (
                              <div
                                key={target.id}
                                title={
                                  !supported
                                    ? `${target.label} 的订阅是节点列表，表达不了分流规则；改用「节点订阅」即可。`
                                    : `${target.label} 不支持${platform ? PROXY_CLIENT_PLATFORM_LABELS[platform] : "当前系统"}，在这台设备上点了不会有反应。`
                                }
                                className="flex cursor-not-allowed flex-col items-center gap-1.5 rounded-lg border border-dashed bg-background/50 p-2.5 opacity-60"
                              >
                                {tile}
                              </div>
                            );
                          })}
                        </div>

                        {platform && hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAllClients((value) => !value)}
                            className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                          >
                            {showAllClients
                              ? `只看 ${PROXY_CLIENT_PLATFORM_LABELS[platform]} 能用的`
                              : `还有 ${hiddenCount} 个别的平台的客户端，显示全部`}
                          </button>
                        )}

                        {/* 手机上一行放不下「地址 + 两个按钮」，挤到地址只剩几个字符，
                            所以窄屏竖排、宽屏再并成一行。 */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 text-xs">
                            {manualUrl}
                          </code>
                          <div className="flex shrink-0 items-center gap-2">
                            {/* 上面的图标只在「面板和客户端同一台设备」时有用；
                                在电脑上看面板、往手机里导入，走的是这个二维码。 */}
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 sm:flex-none"
                              onClick={() =>
                                setQrTarget({
                                  title: `${token.name} · ${PROXY_SUBSCRIPTION_KIND_LABELS[kind]}`,
                                  url: manualUrl,
                                })
                              }
                            >
                              <QrCode className="mr-1 h-3.5 w-3.5" />
                              扫码
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 sm:flex-none"
                              onClick={() => copyText(manualUrl, "订阅地址已复制")}
                            >
                              <Copy className="mr-1 h-3.5 w-3.5" />
                              复制
                            </Button>
                          </div>
                        </div>
                        {(token.alias || (subSettingsQuery.data?.domains.length ?? 0) > 0) ? (
                          <div className="space-y-1">
                            {token.alias ? (
                              <div className="flex items-center gap-2">
                                <span className="shrink-0 text-xs text-muted-foreground">短链</span>
                                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{manualUrl.replace(`/api/sub/${token.token}`, `/s/${token.alias}`)}</code>
                                <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="复制短链" onClick={() => copyText(manualUrl.replace(`/api/sub/${token.token}`, `/s/${token.alias}`), "短链已复制")}><Copy className="h-3.5 w-3.5" /></Button>
                              </div>
                            ) : null}
                            {(subSettingsQuery.data?.domains || []).map((origin) => {
                              const alt = subscriptionUrl(token.token, "base64", kind, false, importIpVersion).replace(/^https?:\/\/[^/]+/, origin);
                              return (
                                <div key={origin} className="flex items-center gap-2">
                                  <span className="shrink-0 text-xs text-muted-foreground">备用</span>
                                  <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">{alt}</code>
                                  <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`复制 ${origin} 的备用地址`} onClick={() => copyText(alt, "备用地址已复制")}><Copy className="h-3.5 w-3.5" /></Button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        <div className="space-y-1.5">
                          <p data-fx-help="" className="text-xs text-muted-foreground">
                            其他客户端用这条地址手动添加。
                          </p>
                          {/* 这个设置只在「客户端标识认不出来」时才生效，所以就放在那句话下面。
                              上面图标点进去的地址都钉死了格式，走不到这里。 */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">认不出来时按</span>
                            <Select
                              value={normalizeProxySubscriptionFormat(token.defaultFormat)}
                              onValueChange={(value) => updateToken.mutate({
                                id: token.id,
                                defaultFormat: value as ProxySubscriptionFormat,
                              })}
                            >
                              <SelectTrigger aria-label="认不出客户端时用的订阅格式" className="h-7 w-auto gap-1 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PROXY_SUBSCRIPTION_FORMATS.map((format) => (
                                  <SelectItem key={format} value={format}>
                                    {PROXY_SUBSCRIPTION_FORMAT_LABELS[format]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <span className="text-xs text-muted-foreground">返回</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/*
          这一页现在只有两张卡：上面「订阅链接」（要复制走的东西），下面「我的节点」。
          自建、粘贴、别人分享来的三类节点合成一个列表 —— 租户脑子里它们本来就是
          同一件事（「我有哪些线路」），按来源分成三张卡是我们的实现细节漏到了界面上。
          「我的机器」和「订阅内容」降级成这张卡上的两个按钮：前者是自建的前置条件，
          后者本来就是预览，都不该各占一张常驻卡片。
        */}
        <ProxyInboundsSection
          extraRows={pastedRowSpecs}
          extraLoading={nodesQuery.isLoading}
          groupMode={nodeGroupMode}
          onGroupModeChange={changeGroupMode}
          groupModeOptions={groupModeOptions}
          onPasteNode={openCreateNode}
          inboundLeading={inboundLeading}
          notInSubscriptionInboundIds={unusedInboundIds}
          hostNeverOnlineInboundIds={hostOfflineInboundIds}
          onOpenPreview={openPreview}
          previewAlertCount={pendingCount}
          onOpenHosts={isAdmin ? undefined : openHosts}
          onlineCount={onlineNodeCount}
          offlineCount={offlineNodeCount}
          onExitCheck={openInboundExitCheck}
        />

        {nodes.some((node: any) => !node.sharedFrom) ? (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => setReorderOpen(true)}>
              <ListOrdered className="mr-1 h-4 w-4" />节点顺序
            </Button>
          </div>
        ) : null}

        <ProxySubSourcesSection
          allowed={!!subSettingsQuery.data?.externalSourcesAllowed}
          maxPerUser={subSettingsQuery.data?.externalSourceMaxPerUser || 0}
          onChanged={refreshNodes}
        />
      </div>

      <ProxySubTokenEditDialog
        open={!!editingToken}
        onOpenChange={(open) => { if (!open) setEditingToken(null); }}
        token={editingToken}
        nodes={nodes as any[]}
        settings={subSettingsQuery.data || null}
        isAdmin={isAdmin}
        onSaved={refreshTokens}
        onPreview={setPreviewToken}
      />
      <NodeExitDialog subject={exitCheck?.subject ?? null} name={exitCheck?.name || ""} onOpenChange={(open) => { if (!open) setExitCheck(null); }} />
      <ProxySubTokenPreviewDialog open={!!previewToken} onOpenChange={(open) => { if (!open) setPreviewToken(null); }} tokenId={previewToken?.id || null} tokenName={previewToken?.name || ""} />
      <ProxySubTokenLogsDialog open={!!logsToken} onOpenChange={(open) => { if (!open) setLogsToken(null); }} tokenId={logsToken?.id || null} tokenName={logsToken?.name || ""} />
      <ProxySubTokenDevicesDialog open={!!devicesToken} onOpenChange={(open) => { if (!open) setDevicesToken(null); }} tokenId={devicesToken?.id || null} tokenName={devicesToken?.name || ""} />
      <ProxyNodeReorderDialog open={reorderOpen} onOpenChange={setReorderOpen} nodes={nodes} onSaved={refreshNodes} />

      {/*
        订阅内容：从常驻卡片改成弹窗。
        它回答的是「客户端会看到什么」，属于查看一眼就走的东西 —— 常驻的话，
        每次进这一页都要滚过它才够到下面。这份数据不轮询，进页面取一次就够；
        仍然保持常取而不是等弹窗打开才取，是因为「还没加入订阅的转发」这个提醒
        要显示在按钮的角标上（previewAlertCount），否则收进弹窗就等于藏掉了。
      */}
      {previewOpen && (
        <Suspense fallback={null}>
          <ProxySubscriptionPreviewDialog
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            nodes={nodes}
            onRename={setRenaming}
          />
        </Suspense>
      )}

      {/* 「我的机器」：自建节点的前置条件，收进弹窗，不再占一张常驻卡片。 */}
      <Dialog open={hostsOpen} onOpenChange={setHostsOpen}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>我的机器</DialogTitle>
            <DialogDescription className="text-xs">
              装了 Agent 的机器才能让面板在上面开节点。加一台之后把命令粘进那台机器执行。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <MyHostsSection />
          </div>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => setHostsOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProxyNodeShareDialog
        open={!!shareNode}
        onOpenChange={(open) => { if (!open) setShareNode(null); }}
        targets={shareNode ? [{ id: shareNode.id, label: shareNode.name }] : []}
        title={shareNode ? `分享「${shareNode.name}」` : "分享这个节点"}
      />

      {/* 三个表单弹窗各自管自己的输入状态：在里面打字不会重画这一页（见 components/proxy/ProxyNodeEditDialog）。 */}
      <ProxyNodeEditDialog
        open={nodeDialog.open}
        onOpenChange={(open) => setNodeDialog((prev) => ({ ...prev, open }))}
        node={nodeDialog.node}
        nodes={nodes}
      />

      <ProxySubTokenCreateDialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen} />

      <ProxyPreviewRenameDialog target={renaming} onClose={() => setRenaming(null)} />

      <Dialog open={!!qrTarget} onOpenChange={(open) => !open && setQrTarget(null)}>
        {/* DialogContent 是 grid，子项默认 min-width:auto —— 底下那条不可断行的长地址
            会把整列撑宽再被 overflow-hidden 切掉，所以这里逐层 min-w-0，地址本身也断行。 */}
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-sm">
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-4 w-4 shrink-0" />
              扫码导入
            </DialogTitle>
            <DialogDescription className="truncate text-xs">{qrTarget?.title}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
            <div className="flex justify-center">
              {qrDataUrl ? (
                // 白底不能省：二维码本身是透明背景的黑块，深色主题下会糊成一片。
                // 宽度跟着对话框走，窄屏上整体缩小而不是被裁掉一半。
                <div className="w-full max-w-[264px] rounded-lg bg-white p-3">
                  <img src={qrDataUrl} alt="订阅二维码" className="block h-auto w-full" />
                </div>
              ) : (
                <div className="flex aspect-square w-full max-w-[264px] items-center justify-center rounded-lg border text-sm text-muted-foreground">
                  二维码生成中…
                </div>
              )}
            </div>

            {qrTarget?.hint ? (
              <p className="rounded-md border border-dashed bg-muted/40 px-2 py-1.5 text-xs leading-relaxed">
                <span className="font-medium">粘到这里：</span>
                {qrTarget.hint}
              </p>
            ) : (
              <p data-fx-help="" className="text-xs text-muted-foreground">
                在客户端的「添加订阅」里扫，别用系统相机。
              </p>
            )}

            {/* 手机上截断的地址等于没有：复制失败时连手动选中都做不到，所以整条断行显示。 */}
            <code className="block break-all rounded bg-muted px-2 py-1.5 text-xs leading-relaxed">
              {qrTarget?.url}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => qrTarget && copyText(qrTarget.url, "订阅地址已复制")}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              复制地址
            </Button>

            <p className="text-xs text-muted-foreground">
              含完整凭据，别外发。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
