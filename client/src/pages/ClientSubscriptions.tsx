import { FormField } from "@/components/ui/form-field";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import MyHostsSection from "@/components/proxy/MyHostsSection";
import ProxyInboundsSection from "@/components/proxy/ProxyInboundsSection";
import { proxyNodeMetaText, type ProxyNodeRowSpec } from "@/components/proxy/ProxyNodeRow";
import { ProxyNodeShareDialog } from "@/components/proxy/ProxyNodeShareDialog";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { pollingInterval } from "@/lib/polling";
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
  PROXY_NODE_AUTO_GROUPS,
  PROXY_NODE_DEFAULT_AUTO_GROUP,
  PROXY_NODE_AUTO_GROUP_HINTS,
  PROXY_NODE_AUTO_GROUP_LABELS,
  normalizeProxyNodeAutoGroup,
  type ProxyNodeAutoGroup,
} from "@shared/proxySubscriptionPlan";
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
import { bytesFromGb, gbFromBytes } from "@shared/trafficGb";
import { MONTHLY_RESET_MAX_DAY } from "@shared/billingTime";
import { ProxyNodeQuotaDetail, ProxyNodeQuotaToggle } from "@/components/proxy/ProxyNodeQuotaCells";
import {
  normalizeProxyNodeGroupMode,
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
  EyeOff,
  KeyRound,
  Layers,
  Link2,
  Package,
  Pencil,
  Plug,
  Plus,
  QrCode,
  Rocket,
  Share2,
  Shield,
  Boxes,
  Ship,
  Binary,
  Blocks,
  Trash2,
  Waves,
  Zap,
  type LucideIcon,
  MoreHorizontal,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCompactLayout } from "@/hooks/useCompactLayout";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

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
) {
  return buildProxySubscriptionUrl({ origin: mobileAuth.panelOrigin(), token, format, kind, pinFormat });
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

const NODE_GROUP_MODE_STORAGE_KEY = "forwardx.proxyNodes.groupMode";
const NODE_COLLAPSED_STORAGE_KEY = "forwardx.proxyNodes.collapsed";

function readStoredGroupMode(): ProxyNodeGroupMode {
  if (typeof window === "undefined") return "none";
  try {
    return normalizeProxyNodeGroupMode(window.localStorage.getItem(NODE_GROUP_MODE_STORAGE_KEY));
  } catch {
    return "none";
  }
}

/** 折叠起来的分组键。存不上也不影响用，只是下次进来又是展开的。 */
function readStoredCollapsed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NODE_COLLAPSED_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeStored(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写不进去，忽略即可 —— 这只是个记住偏好的便利。
  }
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
 * 订阅内容的两类条目。
 *
 * 中转在前：那是主力 —— 直连条目只有开了「加进订阅」的节点才有，通常只有一两条，
 * 而且落地 IP 直接暴露在订阅里，放后面不容易被误当成常规入口。
 */
const PREVIEW_GROUPS = [
  { key: "relay", label: "中转" },
  { key: "direct", label: "直连" },
] as const;

/**
 * 子块小标题：一行文字 + 一条细横线。
 *
 * 「订阅内容」这张卡里原本有五个子块，各用一种样式 —— 彩色框、虚线框、灰底框、
 * 纯标题。样式不同会让人以为它们是不同性质的东西，其实都只是「订阅里的一部分」。
 * 统一成同一条线之后，视觉重量交还给内容本身。
 */
function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      {count !== undefined ? <span className="tabular-nums">({count})</span> : null}
      <span className="h-px flex-1 bg-border" />
    </div>
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
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();

  const permissionQuery = trpc.proxySubscriptions.permission.useQuery();
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
  const previewQuery = trpc.proxySubscriptions.preview.useQuery();
  const hideUnreachableQuery = trpc.proxySubscriptions.hideUnreachable.useQuery();
  const setHideUnreachableMutation = trpc.proxySubscriptions.setHideUnreachable.useMutation({
    onSuccess: () => {
      void utils.proxySubscriptions.hideUnreachable.invalidate();
      void utils.proxySubscriptions.preview.invalidate();
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });

  const [nodeGroupMode, setNodeGroupMode] = useState<ProxyNodeGroupMode>(readStoredGroupMode);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readStoredCollapsed);
  /** 「订阅内容」收成弹窗：它是预览，不是这一页的常驻内容。 */
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 「我的机器」也收成弹窗：它是自建节点的前置条件，不是并列的一段。 */
  const [hostsOpen, setHostsOpen] = useState(false);
  /** 展开了套餐详情的节点。只在本次会话里记着 —— 这是个随手看一眼的动作，不值得持久化。 */
  const [expandedQuotaIds, setExpandedQuotaIds] = useState<number[]>([]);

  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<number | null>(null);
  const [nodeName, setNodeName] = useState("");
  const [nodeLink, setNodeLink] = useState("");
  const [nodeAutoGroup, setNodeAutoGroup] = useState<ProxyNodeAutoGroup>("url-test");
  // 默认关：开了之后落地 IP 会出现在每一条订阅地址里。
  const [nodeIncludeDirect, setNodeIncludeDirect] = useState(false);
  // 0 表示不经由任何前置。
  const [nodeFrontProxyId, setNodeFrontProxyId] = useState(0);
  /** 落地机的套餐规格。带宽用 Mbps，总流量用 GB —— 机房就是按这两个单位卖的。 */
  const [nodeBandwidthMbps, setNodeBandwidthMbps] = useState("");
  const [nodeTrafficLimitGb, setNodeTrafficLimitGb] = useState("");
  const [nodeTrafficUsedGb, setNodeTrafficUsedGb] = useState("");
  const [nodeTrafficAutoReset, setNodeTrafficAutoReset] = useState(false);
  const [nodeTrafficResetDay, setNodeTrafficResetDay] = useState("1");
  // 订阅内容里改名：转发派生的条目改规则上的显示名，直连条目改模板名。
  const [renaming, setRenaming] = useState<
    { kind: "relay" | "direct"; ruleId: number; templateId: number; name: string } | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  // 一键订阅面板默认折叠，同一时间只展开一个，免得页面被撑得很长。
  const [importOpenTokenId, setImportOpenTokenId] = useState<number | null>(null);
  const [importKind, setImportKind] = useState<ProxySubscriptionKind>("nodes");
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

  const refresh = () => {
    void utils.proxySubscriptions.listNodes.invalidate();
    void utils.proxySubscriptions.listTokens.invalidate();
    void utils.proxySubscriptions.preview.invalidate();
  };

  const createNode = trpc.proxySubscriptions.createNode.useMutation({
    onSuccess: (result: any) => {
      toast.success("客户端节点已添加");
      /**
       * 顺手接上的那些转发要说出来。
       *
       * 先有转发、后加节点是很常见的顺序，这时面板会把已经指向它的转发一并加进
       * 订阅 —— 不吭声的话，他下次打开订阅会发现凭空多了几条线路。
       */
      const adopted = Number(result?.adoptedRuleCount || 0);
      if (adopted > 0) {
        toast.info(`顺手把 ${adopted} 条指向它的转发加进了订阅`, {
          description: "不想要的话，在「预览订阅」里逐条关掉。",
        });
      }
      setNodeDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateNode = trpc.proxySubscriptions.updateNode.useMutation({
    onSuccess: () => {
      toast.success("客户端节点已更新");
      setNodeDialogOpen(false);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
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
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const bindRule = trpc.proxySubscriptions.bindRule.useMutation({
    onSuccess: () => {
      toast.success("已加入订阅");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  /**
   * 「指向已经变了」那张卡上直接改绑。
   *
   * 同一个 bindRule 接口，分开一个实例只为了提示语：那边是「加入订阅」，这边是
   * 「改绑」或「移出」—— 用户在订阅这一屏就把事办了，不必再去转发页找这条规则。
   */
  const rebindRule = trpc.proxySubscriptions.bindRule.useMutation({
    onSuccess: (_data, variables) => {
      toast.success(variables.proxyNodeId === null ? "已移出订阅" : "已改绑落地节点");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const setRuleVisible = trpc.proxySubscriptions.setRuleVisible.useMutation({
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error.message),
  });
  const setRuleNodeName = trpc.proxySubscriptions.setRuleNodeName.useMutation({
    onSuccess: () => {
      toast.success("节点名已更新");
      setRenaming(null);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const createToken = trpc.proxySubscriptions.createToken.useMutation({
    onSuccess: () => {
      toast.success("订阅链接已创建");
      setTokenDialogOpen(false);
      setTokenName("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const updateToken = trpc.proxySubscriptions.updateToken.useMutation({
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error.message),
  });
  const rotateToken = trpc.proxySubscriptions.rotateToken.useMutation({
    onSuccess: () => {
      toast.success("订阅地址已重置，旧地址立即失效");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const compactLayout = useCompactLayout();
  const rotateTokenConfirmed = async (id: number) => {
    const ok = await confirm({
      title: "重置这个订阅地址？",
      description: "只更换订阅地址本身，不会重置流量。旧地址立即失效，已经导入过的客户端都要重新填写新地址。",
      confirmText: "重置地址",
    });
    if (ok) rotateToken.mutate({ id });
  };
  const deleteTokenConfirmed = async (id: number) => {
    const ok = await confirm({
      title: "删除这个订阅链接？",
      description: "使用该地址的客户端将立即无法更新节点。",
      confirmText: "删除",
    });
    if (ok) deleteToken.mutate({ id });
  };
  const deleteToken = trpc.proxySubscriptions.deleteToken.useMutation({
    onSuccess: () => {
      toast.success("订阅链接已删除");
      refresh();
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
    QRCode.toDataURL(qrTarget.url, { width: 480, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
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

  const nodes = nodesQuery.data ?? [];
  /** 一个节点都没有的时候，订阅链接那张卡要改口告诉他先去加节点。 */
  const nodeCount = (nodes as any[]).length;
  const tokens = tokensQuery.data ?? [];
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";

  /** 从节点这边发起分享。粘进来的节点只有一份凭据，所以就是一个列表。 */
  const [shareNode, setShareNode] = useState<{ id: number; name: string } | null>(null);
  const [nodeAdvancedOpen, setNodeAdvancedOpen] = useState(false);
  const [nodeRemark, setNodeRemark] = useState("");
  /** 对外标注：分享出去时对方看得到的那一句。备注是自己看的，两回事。 */
  const [nodePublicLabel, setNodePublicLabel] = useState("");

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
   * 模板 id → 那一条直连要标什么。订阅内容那边只有 templateId，标注在节点行上。
   *
   * 对外标注优先：分享进来的节点被抹掉了备注（那是对方的账本），只剩这一句 ——
   * 而它恰恰是收方最需要的（这条线是家宽还是 IEPL）。自己的节点两个都在时也用它：
   * 「订阅内容」这一屏说的是客户端会拿到什么，那是对外的口径。
   */
  const remarkByTemplateId = useMemo(() => {
    const map = new Map<number, string>();
    for (const node of nodes as any[]) {
      const label = String(node?.publicLabel || "").trim() || String(node?.remark || "").trim();
      if (label) map.set(Number(node.id), label);
    }
    return map;
  }, [nodes]);

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

  /**
   * 折叠着的「高级」里设了什么。
   *
   * 收起来省地方，但不能省到让人以为配置没了 —— 所以设过的那几项直接写在折叠条上。
   * 只写非默认的：默认值写出来是噪音，而这一行的全部价值就是「有没有东西被我藏起来」。
   */
  const advancedSummary = useMemo(() => {
    const parts: string[] = [];
    if (nodeAutoGroup !== PROXY_NODE_DEFAULT_AUTO_GROUP) {
      parts.push(PROXY_NODE_AUTO_GROUP_LABELS[nodeAutoGroup]);
    }
    if (nodeFrontProxyId > 0) {
      const front = (nodes as any[]).find((item: any) => Number(item.id) === nodeFrontProxyId);
      parts.push(`经由 ${front?.name || `#${nodeFrontProxyId}`}`);
    }
    return parts.join(" · ");
  }, [nodeAutoGroup, nodeFrontProxyId, nodes]);

  const toggleQuota = (id: number) => {
    setExpandedQuotaIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const isGroupCollapsed = (key: string) => collapsedGroups.includes(key);
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key];
      writeStored(NODE_COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  const groupModeOptions = useMemo(
    () => PROXY_NODE_GROUP_MODES.map((mode) => ({ value: mode, label: PROXY_NODE_GROUP_MODE_LABELS[mode] })),
    [],
  );

  /**
   * 粘贴进来的、以及别人分享来的节点，组装成行规格交给「我的节点」那张卡。
   *
   * 开关写的是这条 proxy_nodes 记录自己的 isEnabled，跟自建那一路写派生节点的
   * includeDirect 是两回事 —— 所以两路各自组装，列表只负责排版。
   */
  /**
   * 客户端里根本看不到的那些节点（服务端算的，它才知道谁被引用了）。
   *
   * 放在这里是因为下面的行规格要用它 —— 要动手的人就在那一行：行上原来只写
   * 「无转发绑定」，那是**机制**；「不在订阅里」才是后果，而且两者不等价 ——
   * 粘来的节点开了直连，没有转发照样在订阅里。
   */
  const unusedNodeIds = useMemo(
    () => new Set(((previewQuery.data?.warnings ?? []) as any[])
      .filter((item) => item?.reason === "node-unused")
      .map((item) => Number(item.nodeId))),
    [previewQuery.data],
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
    () => new Set(((previewQuery.data?.warnings ?? []) as any[])
      .filter((item) => item?.reason === "host-never-online")
      .map((item) => Number(item.nodeId))),
    [previewQuery.data],
  );
  const hostOfflineInboundIds = useMemo(() => {
    const ids = new Set<number>();
    for (const node of nodes as any[]) {
      const inboundId = Number(node?.inboundId || 0);
      if (inboundId > 0 && hostOfflineNodeIds.has(Number(node.id))) ids.add(inboundId);
    }
    return ids;
  }, [nodes, hostOfflineNodeIds]);

  const pastedRowSpecs = useMemo<ProxyNodeRowSpec[]>(() => pastedNodes.map((node: any) => {
    const quotaExpanded = expandedQuotaIds.includes(Number(node.id));
    return {
      key: `node-${node.id}`,
      // 粘来的和别人分享来的，左边色条不同：能不能改、凭据归谁，是这两类最大的差别。
      accent: node.sharedFrom ? ("shared" as const) : ("pasted" as const),
      protocol: String(node.protocol || ""),
      sortName: String(node.name || ""),
      leading: <ProxyNodeHealthDot health={node.health} />,
      name: node.name,
      tag: (
        <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px] font-normal">
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
        <Switch aria-label={`${node.name} 启用`}
          className="shrink-0 scale-90"
          checked={!!node.isEnabled}
          onCheckedChange={(checked) => updateNode.mutate({ id: node.id, isEnabled: checked })}
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
        { key: "edit", label: "编辑", icon: Pencil, onSelect: () => openEditNode(node) },
        {
          key: "delete",
          label: "删除",
          icon: Trash2,
          destructive: true,
          onSelect: async () => {
            const ok = await confirm({
              title: "删除这个客户端节点？",
              description: node.ruleCount > 0
                ? `${node.ruleCount} 条转发会被解绑，不再出现在订阅里。转发本身继续运行，不受影响。`
                : "该节点没有被任何转发绑定。",
              confirmText: "删除",
            });
            if (ok) deleteNode.mutate({ id: node.id });
          },
        },
      ],
    };
  }), [pastedNodes, unusedNodeIds, expandedQuotaIds, isAdmin]);

  const changeGroupMode = (mode: ProxyNodeGroupMode) => {
    setNodeGroupMode(mode);
    writeStored(NODE_GROUP_MODE_STORAGE_KEY, mode);
  };
  const preview = previewQuery.data;

  const previewNodes = (preview?.nodes ?? []) as any[];
  const directPreviewNodes = useMemo(
    () => previewNodes.filter((node) => node?.kind === "direct"),
    [previewNodes],
  );
  const relayPreviewNodes = useMemo(
    () => previewNodes.filter((node) => node?.kind !== "direct"),
    [previewNodes],
  );

  // 只有「已隐藏」需要一键恢复，其他原因要用户自己去改转发或模板。
  const hiddenRules = useMemo(
    () => (preview?.skipped ?? []).filter((item) => item.reason === "hidden"),
    [preview],
  );
  /**
   * 绑定已经对不上的那些：转发的目标不再是它绑的那个节点。
   *
   * 这条节点仍然在订阅里 —— 静默少一条是这套面板反复踩过的坑，而这类判断也不可能
   * 百分之百准。但它必须显眼：订阅里那条带的是这个落地的凭据，地址却写的是转发入口，
   * 入口通向别处时，客户端就会把凭据递给那台别的机器。
   */
  const driftedRules = useMemo(
    () => (preview?.warnings ?? []).filter((item: any) => item.reason === "target-mismatch"),
    [preview],
  );
  /**
   * 谁都没用的节点：没开直连，也没有任何转发绑到它上面 —— 客户端里根本没有它。
   *
   * 「我的节点」那一列里它看着好好的，这是当初「转发不绑节点就不进订阅、页面上还看不出」
   * 那个坑从节点这一侧再犯一次。
   */
  const unusedNodes = useMemo(
    () => (preview?.warnings ?? []).filter((item: any) => item.reason === "node-unused"),
    [preview],
  );
  /** 机器还没连上面板的那些节点 —— 发出去了，但现在连不上。 */
  const hostOfflineNodes = useMemo(
    () => (preview?.warnings ?? []).filter((item: any) => item.reason === "host-never-online"),
    [preview],
  );
  const unboundRules = useMemo(
    () => (preview?.skipped ?? []).filter((item) => item.reason === "unbound"),
    [preview],
  );
  const otherSkipped = useMemo(
    () => (preview?.skipped ?? []).filter((item) => item.reason !== "hidden" && item.reason !== "unbound"),
    [preview],
  );
  /**
   * 「待处理」那张卡上的数字：这一页所有要你动手的事加起来。
   *
   * 三件事分别躺在预览弹窗的三段里，各自都不显眼。合成一个数摆到最上面，才回答得了
   * 「我现在有没有东西要管」—— 进这一页时脑子里其实只有这一个问题。
   */
  /**
   * 在线情况怎么说。规矩在 shared/proxyNodeHealth 里：**没探测过不是在线** ——
   * 拿「离线为 0」当「全在线」，一个刚建好、一次都没探测过的面板会写着「节点全在线」。
   */
  const healthSummary = useMemo(
    () => summarizeProxyNodeHealthCounts({ total: nodeCount, online: onlineNodeCount, offline: offlineNodeCount }),
    [nodeCount, onlineNodeCount, offlineNodeCount],
  );
  const pendingCount = unboundRules.length + driftedRules.length + unusedNodes.length + hostOfflineNodes.length;
  const pendingSubtitle = pendingCount === 0
    ? "都对上了"
    : [
      unboundRules.length > 0 ? `${unboundRules.length} 条差节点` : "",
      driftedRules.length > 0 ? `${driftedRules.length} 条指向已变` : "",
      unusedNodes.length > 0 ? `${unusedNodes.length} 个没进订阅` : "",
      hostOfflineNodes.length > 0 ? `${hostOfflineNodes.length} 个机器没连上` : "",
    ].filter(Boolean).join(" · ");

  const enabledNodes = useMemo(() => nodes.filter((node: any) => node.isEnabled), [nodes]);

  const openCreateNode = () => {
    setEditingNodeId(null);
    setNodeName("");
    setNodeRemark("");
    setNodePublicLabel("");
    setNodeLink("");
    setNodeAutoGroup(PROXY_NODE_DEFAULT_AUTO_GROUP);
    setNodeIncludeDirect(false);
    setNodeFrontProxyId(0);
    setNodeBandwidthMbps("");
    setNodeTrafficLimitGb("");
    setNodeTrafficUsedGb("");
    setNodeTrafficAutoReset(false);
    setNodeTrafficResetDay("1");
    setNodeAdvancedOpen(false);
    setNodeDialogOpen(true);
  };

  const openEditNode = (node: any) => {
    setEditingNodeId(node.id);
    setNodeName(String(node.name || ""));
    setNodeRemark(String(node.remark || ""));
    setNodePublicLabel(String(node.publicLabel || ""));
    setNodeLink(String(node.sourceLink || ""));
    setNodeAutoGroup(normalizeProxyNodeAutoGroup(node.autoGroup));
    setNodeIncludeDirect(!!node.includeDirect);
    setNodeFrontProxyId(Number(node.frontProxyId || 0));
    setNodeBandwidthMbps(Number(node.bandwidthMbps || 0) > 0 ? String(node.bandwidthMbps) : "");
    setNodeTrafficLimitGb(gbFromBytes(node.trafficLimit));
    setNodeTrafficUsedGb(gbFromBytes(node.trafficUsed));
    setNodeTrafficAutoReset(!!node.trafficAutoReset);
    setNodeTrafficResetDay(String(Number(node.trafficResetDay || 1)));
    /*
      高级一律收着，配过的人也收着。

      原来是「不是默认值就自动展开」，出发点是别让人以为配置丢了。但那等于
      「谁配过谁的弹窗就永远长一截」—— 而改名字、换链接这种日常操作天天做，
      选路和前置代理配一次就不动了。

      不展开也不让人起疑，靠的是把里头设了什么写在折叠条上（见下面的 advancedSummary）：
      看得见就不会以为丢了，这比整段摊开便宜得多。
    */
    setNodeAdvancedOpen(false);
    setNodeDialogOpen(true);
  };

  const submitNode = () => {
    const name = nodeName.trim();
    const link = nodeLink.trim();
    if (!name) {
      toast.error("请填写节点名称");
      return;
    }
    if (!link) {
      toast.error("请粘贴落地机的节点链接");
      return;
    }
    const payload = {
      name,
      remark: nodeRemark.trim() || null,
      publicLabel: nodePublicLabel.trim() || null,
      link,
      autoGroup: nodeAutoGroup,
      includeDirect: nodeIncludeDirect,
      frontProxyId: nodeFrontProxyId,
      bandwidthMbps: Math.max(0, Math.floor(Number(nodeBandwidthMbps) || 0)),
      trafficLimit: bytesFromGb(nodeTrafficLimitGb),
      trafficAutoReset: nodeTrafficAutoReset,
      trafficResetDay: Math.min(MONTHLY_RESET_MAX_DAY, Math.max(1, Math.floor(Number(nodeTrafficResetDay) || 1))),
    };
    if (editingNodeId) {
      // 已用量只在编辑时能改：新建时还没有任何用量，给个输入框只会让人以为要填。
      updateNode.mutate({ id: editingNodeId, ...payload, trafficUsed: bytesFromGb(nodeTrafficUsedGb) });
    } else {
      createNode.mutate(payload);
    }
  };

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
      <div className="space-y-6">
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
          东西要处理」。这几个数就是这一页的全部问题，摆在最前面 —— 一条摘要，和主机页
          同一种画法，不是四张各带图标的卡片。
        */}
        <SummaryStrip
          ariaLabel="订阅概况"
          items={[
            {
              key: "nodes",
              label: "客户端线路",
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
            { key: "landing", label: "落地节点", value: nodeCount, hint: healthSummary.subtitle, loading: nodesQuery.isLoading, cacheKey: "subscriptions.stats.landing", fallbackValue: 0 },
            { key: "tokens", label: "订阅链接", value: tokens.length, hint: tokens.length > 0 ? "导入客户端用的地址" : "还没建", loading: tokensQuery.isLoading, cacheKey: "subscriptions.stats.tokens", fallbackValue: 0 },
            {
              key: "pending",
              label: "待处理",
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
                <span className="text-xs font-normal text-muted-foreground">{tokens.length} 条</span>
              ) : null}
            </CardTitle>
            <Button
              className="shrink-0"
              size="sm"
              onClick={() => {
                setTokenName("");
                setTokenDialogOpen(true);
              }}
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
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有订阅链接。
                {nodeCount > 0
                  ? "新建一个，然后把地址导入客户端。"
                  : "先在下面加节点 —— 自己机器上开一个，或者粘一条别处的链接 —— 再回来建链接。"}
              </p>
            ) : (
              <div className="space-y-4">
                {tokens.map((token: any) => {
                  const expanded = importOpenTokenId === token.id;
                  const kind = importKind;
                  const preset = normalizeProxyRulePreset(token.rulePreset);
                  // 手动复制的地址刻意不带 format：让服务端按客户端标识协商，
                  // 这样同一条地址粘到哪个客户端都能拿到对的格式。
                  const manualUrl = subscriptionUrl(token.token, "base64", kind);
                  return (
                  <div key={token.id} className="space-y-3 rounded-lg border p-3">
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
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch aria-label={`${token.name} 启用`}
                          checked={!!token.isEnabled}
                          onCheckedChange={(checked) => updateToken.mutate({ id: token.id, isEnabled: checked })}
                        />
                        {/* 光写"重置"配个刷新图标，在订阅面板里只会被读成"重置流量"。
                            补上宾语并换成钥匙图标：这个按钮的代价是所有已导入的客户端都要重填。 */}
                        {/* 精简布局：两个按钮收进一个「···」菜单，一行只剩名字、开关和菜单。 */}
                        {compactLayout ? (
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label={`${token.name} 的更多操作`}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => { void rotateTokenConfirmed(token.id); }}>
                                <KeyRound className="h-4 w-4" />重置地址
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onSelect={() => { void deleteTokenConfirmed(token.id); }}>
                                <Trash2 className="h-4 w-4" />删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              title="重置订阅地址（不会重置流量）"
                              onClick={() => { void rotateTokenConfirmed(token.id); }}
                            >
                              <KeyRound className="mr-1 h-4 w-4" />
                              重置地址
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title="删除订阅链接"
                              onClick={() => { void deleteTokenConfirmed(token.id); }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
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
                            const url = subscriptionUrl(token.token, target.format, kind, true);
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
                                <span className="w-full truncate text-center text-[10px] text-muted-foreground">
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
          onOpenPreview={() => setPreviewOpen(true)}
          previewAlertCount={pendingCount}
          onOpenHosts={isAdmin ? undefined : () => setHostsOpen(true)}
          onlineCount={onlineNodeCount}
          offlineCount={offlineNodeCount}
        />

      </div>

      {/*
        订阅内容：从常驻卡片改成弹窗。
        它回答的是「客户端会看到什么」，属于查看一眼就走的东西 —— 常驻的话，
        每次进这一页都要滚过它才够到下面。这份数据不轮询，进页面取一次就够；
        仍然保持常取而不是等弹窗打开才取，是因为「还没加入订阅的转发」这个提醒
        要显示在按钮的角标上（previewAlertCount），否则收进弹窗就等于藏掉了。
      */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>订阅内容</DialogTitle>
            <DialogDescription className="text-xs">
              客户端拉到的就是这些。
              {(preview?.nodes.length ?? 0) > 0 ? (
                <>
                  {" "}共 {preview!.nodes.length} 条
                  {relayPreviewNodes.length > 0 ? ` · 中转 ${relayPreviewNodes.length}` : ""}
                  {directPreviewNodes.length > 0 ? ` · 直连 ${directPreviewNodes.length}` : ""}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <ScrollFade className="min-h-0 flex-1 overflow-y-auto pr-1">
            {/*
              客户端测延迟只测到入口，后面断了照样显示几十毫秒，负载均衡组还会把连接分给它。
              开着的话，端到端探测连续不通的转发暂时不放进订阅，通了自动回来。
            */}
            <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">自动隐藏不通的节点</p>
                <p data-fx-help="" className="mt-0.5 text-xs text-muted-foreground">
                  端到端探测连续 3 次不通的转发暂时移出订阅，通了自动回来。客户端更新订阅后生效。
                </p>
              </div>
              <Switch
                aria-label="自动隐藏不通的节点"
                checked={hideUnreachableQuery.data?.enabled ?? true}
                disabled={hideUnreachableQuery.isLoading || setHideUnreachableMutation.isPending}
                onCheckedChange={(enabled) => setHideUnreachableMutation.mutate({ enabled })}
              />
            </div>
            {previewQuery.isLoading ? (
              <DataSectionLoading />
            ) : previewQuery.error && !preview ? (
              <DataSectionError
                label="订阅内容"
                error={previewQuery.error}
                retrying={previewQuery.isFetching}
                onRetry={() => { void previewQuery.refetch(); }}
              />
            ) : (
              <div className="space-y-4">
                {(preview?.nodes.length ?? 0) === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    订阅里还没有节点。先在「我的节点」里加一个 —— 自己机器上开一个，或者粘一条别处的链接。
                    指向它的转发会自动跟着进来。
                  </p>
                ) : (
                  <div className="space-y-3">
                    {PREVIEW_GROUPS.map((group) => {
                      const groupNodes = group.key === "direct" ? directPreviewNodes : relayPreviewNodes;
                      if (groupNodes.length === 0) return null;
                      const collapsed = isGroupCollapsed(group.key);
                      return (
                        <div key={group.key} className="space-y-1.5">
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={!collapsed}
                          >
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                            <span>{group.label}</span>
                            <span className="tabular-nums">({groupNodes.length})</span>
                            <span className="h-px flex-1 bg-border" />
                          </button>
                          {collapsed ? null : (
                            <div className="space-y-1.5">
                              {groupNodes.map((node: any) => {
                      // 直连条目不来自转发规则，ruleId 都是 0 —— 拿它当 key 会互相撞。
                      const direct = node.kind === "direct";
                      return (
                      <div
                        key={direct ? `direct-${node.templateId}` : `rule-${node.ruleId}`}
                        className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                      >
                        <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium leading-tight">{node.name}</span>
                            {/*
                              有备注就显示备注。原来一律标「直连」—— 这一段本来就叫
                              「直连」，每条都写一遍等于没说，还占着唯一能放信息的位置。
                            */}
                            {direct && (
                              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] font-normal">
                                {remarkByTemplateId.get(Number(node.templateId)) || "直连"}
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-[11px] leading-tight text-muted-foreground">
                            {node.address}:{node.port}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="改这个节点在订阅里显示的名字"
                            onClick={() => {
                              setRenaming({
                                kind: direct ? "direct" : "relay",
                                ruleId: node.ruleId,
                                templateId: node.templateId,
                                name: node.name,
                              });
                              setRenameValue(node.name);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {/* 直连条目的显隐在节点模板上，这里不给开关，免得点了没反应。 */}
                          {!direct && (
                            <Switch
                              className="scale-90"
                              checked
                              title="关掉只是不进订阅，转发照常运行"
                              onCheckedChange={() => setRuleVisible.mutate({ ruleId: node.ruleId, visible: false })}
                            />
                          )}
                        </div>
                      </div>
                      );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {hostOfflineNodes.length > 0 && (
                  <div className="space-y-2">
                    <SectionLabel count={hostOfflineNodes.length}>机器还没连上面板</SectionLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      这几台机器的 Agent 从没连上过 —— 配置下发不下去，节点虽然在订阅里，客户端现在连不上。
                      去「我的机器」拿安装命令，在那台机器上装好 Agent 就行。
                    </p>
                    {hostOfflineNodes.map((item: any) => (
                      <div
                        key={`host-offline-${item.nodeId}`}
                        className="space-y-1 rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn)]/[0.06] px-2.5 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--fx-warn-text)]" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.nodeName}</span>
                        </div>
                        <p className="break-all text-xs text-muted-foreground">
                          开在「{item.targetText}」上，这台机器的 Agent 还没装
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {unusedNodes.length > 0 && (
                  <div className="space-y-2">
                    <SectionLabel count={unusedNodes.length}>这些节点还没进订阅</SectionLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      它们没开直连，也没有任何转发指向它们 —— 客户端里看不到。
                      给它建一条转发（目标填它的地址端口，会自动认出来），或者在节点上打开「直连也放进订阅」。
                    </p>
                    {unusedNodes.map((item: any) => (
                      <div
                        key={`unused-${item.nodeId}`}
                        className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                      >
                        <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">{item.nodeName}</span>
                        <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">{item.nodeText}</span>
                      </div>
                    ))}
                  </div>
                )}

                {driftedRules.length > 0 && (
                  <div className="space-y-2">
                    <SectionLabel count={driftedRules.length}>指向已经变了</SectionLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      这几条转发的目标已经不是它绑的那个节点了。线路还在订阅里，但客户端连过去是
                      拿着原来那个落地的凭据去连新目标 —— 在这里改绑成现在真正通向的那个节点，
                      或者把转发的目标改回去；这条转发不再通向任何落地的话，就移出订阅。
                    </p>
                    {driftedRules.map((item) => {
                      /*
                        目标正好是某个节点的地址端口时，那个节点就是答案：单独点出来，
                        一下就能改过去，不用在下拉里翻。
                      */
                      const matched = enabledNodes.find((node: any) =>
                        Number(node.id) !== Number(item.nodeId)
                        && `${String(node.address || "").toLowerCase()}:${Number(node.port)}` === String(item.targetText || "").toLowerCase());
                      const busy = rebindRule.isPending && rebindRule.variables?.ruleId === item.ruleId;
                      return (
                        <div
                          key={`drift-${item.ruleId}`}
                          className="space-y-1.5 rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn)]/[0.06] px-2.5 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--fx-warn-text)]" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.ruleName}</span>
                          </div>
                          <p className="break-all text-xs text-muted-foreground">
                            绑的是「{item.nodeName}」（{item.nodeText}），现在指向 {item.targetText}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            <Select
                              value={String(item.nodeId)}
                              disabled={busy}
                              onValueChange={(value) => {
                                if (value === String(item.nodeId)) return;
                                rebindRule.mutate({
                                  ruleId: item.ruleId,
                                  proxyNodeId: value === "__unbind" ? null : Number(value),
                                });
                              }}
                            >
                              <SelectTrigger aria-label={`${item.ruleName} 改绑落地节点`} className="h-8 w-40 shrink-0 text-xs">
                                <SelectValue placeholder="改绑落地节点" />
                              </SelectTrigger>
                              <SelectContent>
                                {enabledNodes.map((node: any) => (
                                  <SelectItem key={node.id} value={String(node.id)}>
                                    {node.name}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__unbind">移出订阅（解绑）</SelectItem>
                              </SelectContent>
                            </Select>
                            {matched ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                disabled={busy}
                                onClick={() => rebindRule.mutate({ ruleId: item.ruleId, proxyNodeId: Number(matched.id) })}
                              >
                                目标就是「{matched.name}」，改绑过去
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {hiddenRules.length > 0 && (
                  <div className="space-y-2">
                    <SectionLabel count={hiddenRules.length}>被你关掉的</SectionLabel>
                    {hiddenRules.map((item) => (
                      <div
                        key={item.ruleId}
                        className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                      >
                        <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.ruleName}</span>
                        <Switch aria-label={`${item.ruleName} 放回订阅`}
                          className="shrink-0 scale-90"
                          checked={false}
                          onCheckedChange={() => setRuleVisible.mutate({ ruleId: item.ruleId, visible: true })}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {(preview?.groups.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <SectionLabel>
                      <Zap className="mr-1 inline h-3 w-3" />
                      自动选路组（Clash 与 sing-box）
                    </SectionLabel>
                    {preview!.groups.map((group) => (
                      <div key={group.name} className="truncate rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{group.name}</span>
                        {group.type === "url-test" ? " · 自动选最快 · " : group.type === "load-balance" ? " · 负载均衡 · " : " · 主备切换 · "}
                        {group.members.map((member, index) => (
                          group.type === "load-balance" && Array.isArray(group.weights) && group.weights[index]
                            ? `${member}×${group.weights[index]}`
                            : member
                        )).join(" / ")}
                        {group.type === "load-balance" && Array.isArray(group.weights) ? "（按带宽分连接，Clash / Mihomo 生效）" : ""}
                      </div>
                    ))}
                  </div>
                )}

                {unboundRules.length > 0 && (
                  <div className="space-y-2">
                    {/*
                      这一段和下面那段原来叫「还没加入订阅的转发」和「未进入订阅的
                      转发」—— 两个名字几乎一样，说的却是两件事：这一段**选个节点就能
                      进来**，下面那段是**进不来**。名字要让人一眼分得出哪个该动手。
                    */}
                    <SectionLabel count={unboundRules.length}>差一个落地节点</SectionLabel>
                    <p className="text-xs text-muted-foreground">
                      {enabledNodes.length === 0
                        ? "这些转发还没说清楚通往哪个落地节点，所以进不了订阅。先加一个节点，它们就能一起认上来。"
                        : "这些转发还没说清楚通往哪个落地节点，所以进不了订阅。选一个就好；目标地址正好是你某个节点时，以后新建的转发会自动认出来。"}
                    </p>
                    {/*
                      一个节点都还没有的时候，逐行摆一个选不了的下拉，等于把同一句
                      「请先添加落地节点」重复几十遍 —— 真正该做的那一件事（去加个节点）
                      反而被挤到看不见的地方。这种时候只把名字列出来：要动的手只有一次，
                      不是几十次。
                    */}
                    {enabledNodes.length === 0 ? (
                      <ul className="space-y-1">
                        {unboundRules.map((item) => (
                          <li key={item.ruleId} className="truncate text-xs text-muted-foreground">
                            {item.ruleName}
                          </li>
                        ))}
                      </ul>
                    ) : unboundRules.map((item) => (
                      <div
                        key={item.ruleId}
                        className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{item.ruleName}</span>
                        <Select
                          value=""
                          onValueChange={(value) => bindRule.mutate({
                            ruleId: item.ruleId,
                            proxyNodeId: Number(value),
                          })}
                        >
                          <SelectTrigger aria-label={`${item.ruleName} 选择落地节点`} className="h-8 w-36 shrink-0 text-xs">
                            <SelectValue placeholder="选择落地节点" />
                          </SelectTrigger>
                          <SelectContent>
                            {enabledNodes.map((node: any) => (
                              <SelectItem key={node.id} value={String(node.id)}>
                                {node.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}

                {otherSkipped.length > 0 && (
                  <div className="space-y-1.5">
                    <SectionLabel count={otherSkipped.length}>这些进不了订阅</SectionLabel>
                    <ul className="space-y-1">
                      {otherSkipped.map((item) => (
                        <li key={item.ruleId} className="text-xs text-muted-foreground">
                          {item.ruleName} —— {item.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </ScrollFade>
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog open={nodeDialogOpen} onOpenChange={setNodeDialogOpen}>
        {/* DialogContent 默认 max-h + overflow-hidden，内容超出直接裁掉、滚不动。
            改成 flex 列、正文单独一层可滚 —— 项目里其他长弹窗都是这个写法。 */}
        <DialogContent className="flex max-h-[92svh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{editingNodeId ? "编辑客户端节点" : "添加客户端节点"}</DialogTitle>
            <DialogDescription className="text-xs">只替换地址和端口，凭据不变。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
            <div className="space-y-2">
              <Label htmlFor="proxy-node-name">节点名称</Label>
              <Input
                id="proxy-node-name"
                value={nodeName}
                onChange={(event) => setNodeName(event.target.value)}
                placeholder="例如 HKT 落地"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-node-remark">备注</Label>
              <Input
                id="proxy-node-remark"
                value={nodeRemark}
                onChange={(event) => setNodeRemark(event.target.value)}
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
                value={nodePublicLabel}
                onChange={(event) => setNodePublicLabel(event.target.value)}
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
              <Label>加进订阅</Label>
              <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <p className="min-w-0 text-xs text-muted-foreground">
                  订阅里额外给出这个节点自己的地址。
                  {nodeIncludeDirect ? (
                    <span className="mt-1 block text-[var(--fx-warn-text)]">
                      该节点 IP 会出现在每条订阅地址里。
                    </span>
                  ) : null}
                </p>
                <Checkbox
                  checked={nodeIncludeDirect}
                  onCheckedChange={setNodeIncludeDirect}
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
                    value={nodeBandwidthMbps}
                    onChange={(event) => setNodeBandwidthMbps(event.target.value)}
                    placeholder="500"
                  />
                </FormField>
                <FormField className="min-w-0 space-y-1">
                  <Label className="text-xs text-muted-foreground">总流量（GB）</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={nodeTrafficLimitGb}
                    onChange={(event) => setNodeTrafficLimitGb(event.target.value)}
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
                      value={nodeTrafficUsedGb}
                      onChange={(event) => setNodeTrafficUsedGb(event.target.value)}
                      placeholder="0"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setNodeTrafficUsedGb("")}
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
                  {nodeTrafficAutoReset ? (
                    <Input aria-label="每月自动清零日期"
                      type="number"
                      inputMode="numeric"
                      className="h-8 w-16"
                      value={nodeTrafficResetDay}
                      onChange={(event) => setNodeTrafficResetDay(event.target.value)}
                    />
                  ) : null}
                  <Checkbox aria-label="每月自动清零" checked={nodeTrafficAutoReset} onCheckedChange={setNodeTrafficAutoReset} />
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
                onClick={() => setNodeAdvancedOpen((prev) => !prev)}
                aria-expanded={nodeAdvancedOpen}
              >
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${nodeAdvancedOpen ? "" : "-rotate-90"}`} />
                <span>高级</span>
                {!nodeAdvancedOpen && advancedSummary ? (
                  <span className="min-w-0 truncate font-normal text-foreground/70">{advancedSummary}</span>
                ) : null}
                <span className="h-px flex-1 bg-border" />
              </button>
              {nodeAdvancedOpen ? (
                <div className="space-y-4 pt-1">
                  <FormField className="space-y-2">
                    <Label>自动选路</Label>
                    <Select
                      value={nodeAutoGroup}
                      onValueChange={(value) => setNodeAutoGroup(value as ProxyNodeAutoGroup)}
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
                      {PROXY_NODE_AUTO_GROUP_HINTS[nodeAutoGroup]}
                    </p>
                  </FormField>
                  <FormField className="space-y-2">
                    <Label>前置代理</Label>
                    <Select
                      value={String(nodeFrontProxyId)}
                      onValueChange={(value) => setNodeFrontProxyId(Number(value))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="不经由" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">不经由</SelectItem>
                        {nodes
                          .filter((item: any) => Number(item.id) !== editingNodeId)
                          .map((item: any) => (
                            <SelectItem key={item.id} value={String(item.id)}>
                              {item.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      连接先经由它建立。
                      {nodeFrontProxyId > 0 ? (
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
                value={nodeLink}
                onChange={(event) => setNodeLink(event.target.value)}
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
            <Button variant="outline" onClick={() => setNodeDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={submitNode} disabled={createNode.isPending || updateNode.isPending}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建订阅链接</DialogTitle>
            <DialogDescription className="text-xs">
              建议一台设备一条。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proxy-token-name">用途</Label>
            <Input
              id="proxy-token-name"
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              placeholder="例如 我的手机"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const name = tokenName.trim();
                if (!name) {
                  toast.error("请填写用途，方便以后分清是哪台设备");
                  return;
                }
                // 格式与预设都在「一键订阅」面板里就地调整，创建时走服务端默认。
                createToken.mutate({ name });
              }}
              disabled={createToken.isPending}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>改节点名</DialogTitle>
            <DialogDescription className="text-xs">
              只影响这个节点在订阅里显示的名字，转发规则本身不受影响。
              {renaming?.kind === "direct" ? "这是直连条目，改的是节点模板的名字。" : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proxy-rename">节点名</Label>
            <Input
              id="proxy-rename"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={64}
              autoFocus
            />
            {renaming?.kind === "relay" && (
              <p data-fx-help="" className="text-xs text-muted-foreground">
                留空恢复默认名（由主机名和转发名自动拼出）。
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              disabled={setRuleNodeName.isPending || updateNode.isPending}
              onClick={() => {
                if (!renaming) return;
                const name = renameValue.trim();
                if (renaming.kind === "direct") {
                  // 直连条目的名字就是模板名，落到模板上。
                  if (!name) {
                    toast.error("节点模板的名字不能为空");
                    return;
                  }
                  updateNode.mutate({ id: renaming.templateId, name });
                  setRenaming(null);
                  return;
                }
                setRuleNodeName.mutate({ ruleId: renaming.ruleId, name });
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
