/*
  从 client/src/pages/Users.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。
  「流量与权限设置」近 800 行 JSX 加上它自己的 30 多个 state、10 个查询、6 个 mutation，
  只有点开某个用户时才用得上；原来和用户列表打在同一个包里。
*/
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { configQuery, optionsQuery } from "@/lib/queryPresets";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { useResetOnOpen } from "@/components/useDialogTarget";
import { parseSpeedInputMbps, parseTrafficInputGB } from "@/components/users/trafficInputs";
import UserProxySubConfig from "@/components/proxy/UserProxySubConfig";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DatePickerInput from "@/components/DatePickerInput";
import { FormField } from "@/components/ui/form-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterChips } from "@/components/ui/filter-chips";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarClock, Database, Gauge, RotateCcw, Server, Shield, Trash2 } from "lucide-react";
import { MONTHLY_RESET_MAX_DAY, billingCalendarParts, formatBillingDateInput, parseBillingDateInput } from "@shared/billingTime";
import { FORWARD_TYPES } from "@shared/forwardTypes";

/**
 * 用户列表里的一行，只列弹窗种子表单要读的那些列。
 * listPage 的返回在类型上还是宽的（仓储层带 any），所以这里自己写清楚，别让 any 漏进这个文件。
 */
type UserRow = {
  id: number;
  role?: string | null;
  displayRemark?: string | null;
  manualTrafficLimit?: number | string | null;
  manualExpiresAt?: Date | string | number | null;
  trafficAutoReset?: boolean | number | null;
  trafficResetDay?: number | null;
  manualGostRateLimitIn?: number | string | null;
  manualGostRateLimitOut?: number | string | null;
  forwardBurstMbps?: number | string | null;
  forwardBurstSeconds?: number | string | null;
  manualMaxRules?: number | null;
  manualMaxProxyInbounds?: number | null;
  maxSelfServiceHosts?: number | string | null;
  manualMaxProxySubTokens?: number | null;
  manualMaxProxyDevices?: number | null;
  manualMaxPorts?: number | null;
  manualMaxConnections?: number | null;
  manualAllowProxySubscription?: boolean | number | null;
  manualMaxIPs?: number | null;
  allowedForwardTypes?: string | null;
};

/** trafficBilling.configs 里的一条：这里只看它是哪类资源、开没开、要不要授权。 */
type BillingConfigRow = { resourceType: string; enabled?: boolean | number | null; requiresPermission?: boolean | number | null; resourceId: number | string };

function currentBillingResetDay() {
  return Math.min(billingCalendarParts(new Date()).day, MONTHLY_RESET_MAX_DAY);
}


export default function UserTrafficSettingsDialog({ open, onOpenChange, user, userName, patchCachedUser }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 对着哪个用户（列表里那一行）。关闭动画期间页面传的是上一份，所以这里不会突然变空。 */
  user: UserRow | null;
  /** 标题里显示的名字（页面按 name / username / #id 算好）。 */
  userName: string;
  /** 保存成功后把改动写回列表缓存（页面那头的 listPage 缓存）。 */
  patchCachedUser: (userId: number, patch: Record<string, unknown>) => void;
}) {
  const utils = trpc.useUtils();
  // 下面的查询、effect 和保存逻辑都按「弹窗开着 + 对着哪个用户」走，名字沿用页面里原来的
  const showTrafficSettings = open;
  const trafficUserId = user?.id ?? null;
  const trafficUserName = userName;
  // Traffic settings dialog
  const [trafficDisplayRemark, setTrafficDisplayRemark] = useState("");
  const [trafficLimitInput, setTrafficLimitInput] = useState("");
  const [gostRateLimitInInput, setGostRateLimitInInput] = useState("");
  const [gostRateLimitOutInput, setGostRateLimitOutInput] = useState("");
  const [forwardBurstMbpsInput, setForwardBurstMbpsInput] = useState("");
  const [forwardBurstSecondsInput, setForwardBurstSecondsInput] = useState("");
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [trafficAutoReset, setTrafficAutoReset] = useState(false);
  const [trafficResetDay, setTrafficResetDay] = useState(1);

  const [maxRules, setMaxRules] = useState(0);
  /** 自建落地节点数上限。0 = 不限，与其他配额一致。 */
  const [maxProxyInbounds, setMaxProxyInbounds] = useState(0);
  /**
   * 能自助加几台机器。存成字符串，因为**空串和 "0" 是两回事**：
   * 空 = 跟随系统设置，0 = 一台都不许加。用 number 的话两者都会塌成 0。
   */
  const [maxSelfServiceHosts, setMaxSelfServiceHosts] = useState("");
  /** 订阅地址条数上限。0 = 不限。 */
  const [maxProxySubTokens, setMaxProxySubTokens] = useState(0);
  const [maxProxyDevices, setMaxProxyDevices] = useState(0);
  const [maxPorts, setMaxPorts] = useState(0);
  const [maxConnections, setMaxConnections] = useState(0);
  const [allowProxySubscription, setAllowProxySubscription] = useState(false);
  const [maxIPs, setMaxIPs] = useState(0);
  // 允许使用的转发方式：默认三种全部允许
  const [allowIptables, setAllowIptables] = useState(true);
  const [allowNftables, setAllowNftables] = useState(true);
  const [allowRealm, setAllowRealm] = useState(true);
  const [allowSocat, setAllowSocat] = useState(true);
  const [allowGost, setAllowGost] = useState(true);

  // Agent 权限
  const [allowedHostIds, setAllowedHostIds] = useState<number[]>([]);
  const [allowedForwardGroupIds, setAllowedForwardGroupIds] = useState<number[]>([]);
  const [allowedTunnelIds, setAllowedTunnelIds] = useState<number[]>([]);
  type ResourceGrantKind = "port" | "group" | "tunnel" | "node" | "lgHost" | "billingGroup" | "billingHost" | "billingTunnel";
  const [resourceGrantKind, setResourceGrantKind] = useState<ResourceGrantKind>("port");
  // 精简布局：资源授权按类型切换、用户表一行一人、订阅卡按钮收进菜单；标准布局照旧
  const [trafficBillingHostIds, setTrafficBillingHostIds] = useState<number[]>([]);
  const [trafficBillingTunnelIds, setTrafficBillingTunnelIds] = useState<number[]>([]);
  const [trafficBillingForwardGroupIds, setTrafficBillingForwardGroupIds] = useState<number[]>([]);
  const [addAllowedHostId, setAddAllowedHostId] = useState("");
  const [addAllowedPortForwardId, setAddAllowedPortForwardId] = useState("");
  const [addAllowedForwardGroupId, setAddAllowedForwardGroupId] = useState("");
  const [addAllowedTunnelId, setAddAllowedTunnelId] = useState("");
  const [sharedProxyNodeIds, setSharedProxyNodeIds] = useState<number[]>([]);
  const [addSharedProxyNodeId, setAddSharedProxyNodeId] = useState("");
  const [addBillingHostId, setAddBillingHostId] = useState("");
  const [addBillingTunnelId, setAddBillingTunnelId] = useState("");
  const [addBillingForwardGroupId, setAddBillingForwardGroupId] = useState("");
  /*
    五份候选名单按选中的资源类型按需拉：八类资源一次只看一类，主机名单只在「网络测试主机 / 历史计费主机 /
    隧道（画路线要主机名）」时才要，节点分享名单只在「订阅节点分享」时才要。原来弹窗一开十个查询齐发。
    转发组名单例外：顶上药丸的「端口转发 / 转发链」两个数字要靠它分类，所以开着就拉。
    五份「这个用户已授权什么」不按类型门控 —— 保存时五个列表一起写回，少拉一份就会把那一份写成空。
  */
  const needsHostOptions = resourceGrantKind === "lgHost" || resourceGrantKind === "billingHost" || resourceGrantKind === "tunnel" || resourceGrantKind === "billingTunnel";
  const needsTunnelOptions = resourceGrantKind === "tunnel" || resourceGrantKind === "billingTunnel";
  const needsBillingConfigs = resourceGrantKind === "billingHost" || resourceGrantKind === "billingTunnel" || resourceGrantKind === "billingGroup";
  const { data: allHosts } = trpc.hosts.options.useQuery(undefined, { enabled: showTrafficSettings && needsHostOptions, ...optionsQuery });
  const { data: allTunnels } = trpc.tunnels.options.useQuery(undefined, { enabled: showTrafficSettings && needsTunnelOptions, ...optionsQuery });
  const { data: allForwardGroups } = trpc.forwardGroups.options.useQuery(undefined, { enabled: showTrafficSettings, ...optionsQuery });
  const { data: trafficBillingConfigs } = trpc.trafficBilling.configs.useQuery(undefined, { enabled: showTrafficSettings && needsBillingConfigs, ...configQuery });
  const { data: userHostPerms } = trpc.users.getHostPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId, ...configQuery }
  );
  const { data: userForwardGroupPerms } = trpc.users.getForwardGroupPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId, ...configQuery }
  );
  const { data: userTunnelPerms } = trpc.users.getTunnelPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId, ...configQuery }
  );
  const { data: userTrafficBillingPerms } = trpc.users.getTrafficBillingPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId, ...configQuery }
  );
  const { data: userProxyNodeShares } = trpc.users.getProxyNodeShares.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId, ...configQuery }
  );
  const { data: proxyNodeShareOptions } = trpc.users.proxyNodeShareOptions.useQuery(undefined, { enabled: showTrafficSettings && resourceGrantKind === "node", ...optionsQuery });
  /*
    「权限加载中」看的是**这个用户的数据到了没**，不是 isLoading。

    同一个用户关了再开，五个查询全是热缓存：isLoading 是 false、data 的引用也没变。上一版打开时
    先把列表清成 []，再靠「data 变了」的 effect 回填 —— 这时一个 effect 都不跑，列表停在 []，
    保存按钮却能点，一点就把他的主机 / 转发组 / 隧道授权全写成空（2.3.5xx 线上踩过）。
    现在 effect 以「弹窗打开 + 用户」为键重新种子（见下面），这里按 data 是否 undefined 判断：
    换到另一个用户时 query key 一换，data 立刻是 undefined，保存按钮就禁住，直到他的数据回来。
  */
  const permissionDataLoading = showTrafficSettings && !!trafficUserId && (
    userHostPerms === undefined
    || userForwardGroupPerms === undefined
    || userTunnelPerms === undefined
    || userTrafficBillingPerms === undefined
    || userProxyNodeShares === undefined
  );
  type ForwardGroupOption = NonNullable<typeof allForwardGroups>[number];
  type TunnelOption = NonNullable<typeof allTunnels>[number];
  const updateForwardGroupPermsMutation = trpc.users.setForwardGroupPermissions.useMutation({
    onSuccess: () => {
      void utils.users.options.invalidate();
      void utils.users.listPage.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新转发组授权失败"),
  });
  const updateHostPermsMutation = trpc.users.setHostPermissions.useMutation({
    onSuccess: () => {
      void utils.users.options.invalidate();
      void utils.users.listPage.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新主机授权失败"),
  });
  const updateTunnelPermsMutation = trpc.users.setTunnelPermissions.useMutation({
    onSuccess: () => {
      void utils.users.options.invalidate();
      void utils.users.listPage.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新隧道权限失败"),
  });
  const updateProxyNodeSharesMutation = trpc.users.setProxyNodeShares.useMutation({
    /**
     * 没生效的要当场说出来。
     *
     * 原来这里只报「已保存」：挑了几个节点、点保存、一切正常，而实际上一条都没
     * 写进去（比如挑到了他自己的节点）—— 只能等租户来说「我这儿没有」才发现。
     */
    onSuccess: (result) => {
      const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
      if (skipped.length > 0) {
        const self = skipped.filter((item) => item.reason === "self");
        const gone = skipped.filter((item) => item.reason === "missing");
        const failed = skipped.filter((item) => item.reason === "credential");
        const parts = [
          self.length ? `${self.length} 个是他自己的节点（本来就在他订阅里）` : "",
          gone.length ? `${gone.length} 个节点已不存在` : "",
          failed.length ? `${failed.length} 个发不出凭据` : "",
        ].filter(Boolean);
        toast.warning(`有 ${skipped.length} 个没有生效：${parts.join("；")}`);
      }
      const ownerCredential = Array.isArray(result?.sharedOwnerCredential) ? result.sharedOwnerCredential : [];
      if (ownerCredential.length > 0) {
        // 这类节点分出去的是主人的真实密码，取消分享 / 对方到期都收不回来。
        const names = ownerCredential.slice(0, 3).map((item) => item.name || `#${item.nodeId}`).join("、");
        toast.warning(`${names}${ownerCredential.length > 3 ? " 等" : ""} 分享的是节点主人的真实凭据：以后取消分享或对方到期，他手上的配置仍然能连，只能靠换密码收回。能用多用户入站的话，改用多用户入站分享`);
      }
      if (result?.recipientCanUse === false) {
        toast.warning("这个用户还没有客户端订阅权限，分享了他也看不到 —— 在上面「权限」里打开后才生效");
      }
    },
    onError: (err) => toast.error(err.message || "更新节点分享失败"),
  });
  const updateTrafficBillingPermsMutation = trpc.users.setTrafficBillingPermissions.useMutation({
    onSuccess: () => {
      void utils.users.listPage.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新流量计费授权失败"),
  });


  /*
    权限数据到了就同步到表单状态。

    依赖里带上 showTrafficSettings 和 trafficUserId，不能只看 data：openTrafficSettings 每次打开都把
    列表清成 []，而同一个用户再次打开时 data 还是缓存里那个引用，只看 data 的 effect 不会再跑，
    列表就停在 []（见上面 permissionDataLoading 的注释）。以「打开 + 用户 + 数据」为键，每次打开都
    从缓存重新种子；换用户时 data 先是 undefined，等他的数据回来再种。
  */
  useEffect(() => {
    if (userHostPerms) {
      setAllowedHostIds([...userHostPerms]);
    }
  }, [showTrafficSettings, trafficUserId, userHostPerms]);

  useEffect(() => {
    if (userForwardGroupPerms) {
      setAllowedForwardGroupIds([...userForwardGroupPerms]);
    }
  }, [showTrafficSettings, trafficUserId, userForwardGroupPerms]);

  useEffect(() => {
    if (userTunnelPerms) {
      setAllowedTunnelIds([...userTunnelPerms]);
    }
  }, [showTrafficSettings, trafficUserId, userTunnelPerms]);

  useEffect(() => {
    if (userProxyNodeShares) {
      setSharedProxyNodeIds([...userProxyNodeShares]);
    }
  }, [showTrafficSettings, trafficUserId, userProxyNodeShares]);

  useEffect(() => {
    if (userTrafficBillingPerms) {
      setTrafficBillingHostIds([...(userTrafficBillingPerms.hostIds || [])]);
      setTrafficBillingTunnelIds([...(userTrafficBillingPerms.tunnelIds || [])]);
      setTrafficBillingForwardGroupIds([...(userTrafficBillingPerms.forwardGroupIds || [])]);
    }
  }, [showTrafficSettings, trafficUserId, userTrafficBillingPerms]);

  const updateTrafficMutation = trpc.users.updateTrafficSettings.useMutation({
    onSuccess: (_, variables) => {
      patchCachedUser(variables.userId, {
        displayRemark: variables.displayRemark,
        manualTrafficLimit: variables.trafficLimit,
        manualGostRateLimitIn: variables.gostRateLimitIn,
        manualGostRateLimitOut: variables.gostRateLimitOut,
        manualExpiresAt: variables.expiresAt ? parseBillingDateInput(variables.expiresAt) : null,
        trafficAutoReset: variables.trafficAutoReset,
        trafficResetDay: variables.trafficResetDay,
        manualMaxRules: variables.maxRules,
        manualMaxProxyInbounds: variables.maxProxyInbounds,
        manualMaxProxySubTokens: variables.maxProxySubTokens,
        manualMaxProxyDevices: variables.maxProxyDevices,
        manualMaxPorts: variables.maxPorts,
        manualMaxConnections: variables.maxConnections,
        manualMaxIPs: variables.maxIPs,
        allowedForwardTypes: variables.allowedForwardTypes,
      });
      void utils.users.listPage.invalidate();
      toast.success("流量设置已更新");
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message || "更新流量设置失败"),
  });

  /*
    打开（或换人）时从这个用户种子整张表单。管理员的拦截在页面那头（点菜单时就提示），这里只管填。
  */
  const openTrafficSettings = (u: UserRow) => {
    setTrafficDisplayRemark(String(u.displayRemark || ""));
    const limitBytes = Number(u.manualTrafficLimit) || 0;
    if (limitBytes > 0) {
      const gb = limitBytes / (1024 * 1024 * 1024);
      // 以 GB 为单位、保留最多 2 位小数（去尾零）
      setTrafficLimitInput(parseFloat(gb.toFixed(2)).toString());
    } else {
      setTrafficLimitInput("0");
    }
    setExpiresAtInput(formatBillingDateInput(u.manualExpiresAt));
    setTrafficAutoReset(!!u.trafficAutoReset);
    setTrafficResetDay(u.trafficResetDay || 1);
    setGostRateLimitInInput(String(Math.max(0, Number(u.manualGostRateLimitIn) || 0)));
    setGostRateLimitOutInput(String(Math.max(0, Number(u.manualGostRateLimitOut) || 0)));
    setForwardBurstMbpsInput(String(Math.max(0, Number(u.forwardBurstMbps) || 0)));
    setForwardBurstSecondsInput(String(Math.max(0, Number(u.forwardBurstSeconds) || 0)));
    setMaxRules(u.manualMaxRules || 0);
    setMaxProxyInbounds(u.manualMaxProxyInbounds || 0);
    setMaxSelfServiceHosts(u.maxSelfServiceHosts == null ? "" : String(u.maxSelfServiceHosts));
    setMaxProxySubTokens(u.manualMaxProxySubTokens || 0);
    setMaxProxyDevices(u.manualMaxProxyDevices || 0);
    setMaxPorts(u.manualMaxPorts || 0);
    setMaxConnections(u.manualMaxConnections || 0);
    setAllowProxySubscription(!!u.manualAllowProxySubscription);
    setMaxIPs(u.manualMaxIPs || 0);
    // 转发方式权限：allowedForwardTypes 为 null 表示全部允许，空串表示全部禁用
    const allowedRaw = (u.allowedForwardTypes as string | null) || "";
    if (u.allowedForwardTypes === null || u.allowedForwardTypes === undefined) {
      setAllowIptables(true); setAllowNftables(true); setAllowRealm(true); setAllowSocat(true); setAllowGost(true);
    } else {
      const set = new Set(allowedRaw.split(",").map((s: string) => s.trim()));
      setAllowIptables(set.has("iptables"));
      setAllowNftables(set.has("nftables"));
      setAllowRealm(set.has("realm"));
      setAllowSocat(set.has("socat"));
      setAllowGost(set.has("gost"));
    }
    // 五个列表一起清空，等上面的 effect 按「打开 + 用户」从缓存种子；少清一个就会把上一个用户的留给这一个。
    setAllowedForwardGroupIds([]);
    setAllowedHostIds([]);
    setAllowedTunnelIds([]);
    setSharedProxyNodeIds([]);
    setTrafficBillingHostIds([]);
    setTrafficBillingTunnelIds([]);
    setTrafficBillingForwardGroupIds([]);
    setAddAllowedPortForwardId("");
    setAddAllowedForwardGroupId("");
    setAddAllowedTunnelId("");
    setAddBillingHostId("");
    setAddBillingTunnelId("");
    setAddBillingForwardGroupId("");
  };
  useResetOnOpen(open, user?.id, () => { if (user) openTrafficSettings(user); });

  const handleSaveTrafficSettings = () => {
    if (!trafficUserId) return;
    const limitBytes = parseTrafficInputGB(trafficLimitInput);
    // 拼接转发方式权限：三种都允许时传 null（后端为 null 表示全部）
    const allowed: string[] = [];
    if (allowIptables) allowed.push("iptables");
    if (allowNftables) allowed.push("nftables");
    if (allowRealm) allowed.push("realm");
    if (allowSocat) allowed.push("socat");
    if (allowGost) allowed.push("gost");
    const allowedForwardTypes = allowed.length === FORWARD_TYPES.length ? null : allowed.join(",");
    const rateLimitIn = parseSpeedInputMbps(gostRateLimitInInput);
    const rateLimitOut = parseSpeedInputMbps(gostRateLimitOutInput);
    const burstMbps = parseSpeedInputMbps(forwardBurstMbpsInput);
    const burstSeconds = Math.min(3600, parseSpeedInputMbps(forwardBurstSecondsInput));
    const displayRemark = trafficDisplayRemark.trim().slice(0, 24);
    const expiresAt = expiresAtInput.trim() || null;
    updateTrafficMutation.mutate({
      userId: trafficUserId,
      displayRemark: displayRemark || null,
      trafficLimit: limitBytes,
      gostRateLimitIn: rateLimitIn,
      gostRateLimitOut: rateLimitOut,
      forwardBurstMbps: burstMbps,
      forwardBurstSeconds: burstSeconds,
      expiresAt,
      trafficAutoReset,
      trafficResetDay,
      maxRules,
      maxProxyInbounds,
      // 空串要送 null（跟随全局），不能送 0 —— 0 是「一台都不许加」。
      maxSelfServiceHosts: maxSelfServiceHosts.trim() === "" ? null : Math.max(0, parseInt(maxSelfServiceHosts, 10) || 0),
      maxProxySubTokens,
      maxProxyDevices,
      maxPorts,
      maxConnections,
      maxIPs,
      allowedForwardTypes,
      allowProxySubscription,
    });
    // 保留旧版主机授权。新版资源授权与历史主机授权是并行权限，保存流量设置不能清空后者。
    updateHostPermsMutation.mutate({
      userId: trafficUserId,
      hostIds: allowedHostIds,
    });
    updateForwardGroupPermsMutation.mutate({
      userId: trafficUserId,
      forwardGroupIds: allowedForwardGroupIds,
    });
    updateTunnelPermsMutation.mutate({
      userId: trafficUserId,
      tunnelIds: allowedTunnelIds,
    });
    updateProxyNodeSharesMutation.mutate({
      userId: trafficUserId,
      nodeIds: sharedProxyNodeIds,
    });
    updateTrafficBillingPermsMutation.mutate({
      userId: trafficUserId,
      hostIds: trafficBillingHostIds,
      tunnelIds: trafficBillingTunnelIds,
      forwardGroupIds: trafficBillingForwardGroupIds,
    });
  };

  const addForwardGroupPermission = (value: string) => {
    const forwardGroupId = Number(value);
    if (!Number.isFinite(forwardGroupId)) return;
    setAllowedForwardGroupIds(prev => (prev.includes(forwardGroupId) ? prev : [...prev, forwardGroupId]));
    setAddAllowedPortForwardId("");
    setAddAllowedForwardGroupId("");
  };

  const addHostPermission = (value: string) => {
    const hostId = Number(value);
    if (!Number.isFinite(hostId)) return;
    setAllowedHostIds(prev => (prev.includes(hostId) ? prev : [...prev, hostId]));
    setAddAllowedHostId("");
  };

  const addProxyNodeShare = (value: string) => {
    const nodeId = Number(value);
    if (!Number.isFinite(nodeId)) return;
    setSharedProxyNodeIds(prev => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
    setAddSharedProxyNodeId("");
  };

  const addTunnelPermission = (value: string) => {
    const tunnelId = Number(value);
    if (!Number.isFinite(tunnelId)) return;
    setAllowedTunnelIds(prev => (prev.includes(tunnelId) ? prev : [...prev, tunnelId]));
    setAddAllowedTunnelId("");
  };

  const addTrafficBillingHost = (value: string) => {
    const hostId = Number(value);
    if (!Number.isFinite(hostId)) return;
    setTrafficBillingHostIds(prev => (prev.includes(hostId) ? prev : [...prev, hostId]));
    setAddBillingHostId("");
  };

  const addTrafficBillingTunnel = (value: string) => {
    const tunnelId = Number(value);
    if (!Number.isFinite(tunnelId)) return;
    setTrafficBillingTunnelIds(prev => (prev.includes(tunnelId) ? prev : [...prev, tunnelId]));
    setAddBillingTunnelId("");
  };

  const addTrafficBillingForwardGroup = (value: string) => {
    const forwardGroupId = Number(value);
    if (!Number.isFinite(forwardGroupId)) return;
    setTrafficBillingForwardGroupIds(prev => (prev.includes(forwardGroupId) ? prev : [...prev, forwardGroupId]));
    setAddBillingForwardGroupId("");
  };

  const tunnelRouteText = (tunnel: TunnelOption) => getTunnelRouteText(tunnel, allHosts);
  const billableHostIds = new Set(((trafficBillingConfigs?.configs || []) as BillingConfigRow[]).filter((item) => item.resourceType === "host" && item.enabled && item.requiresPermission).map((item) => Number(item.resourceId)));
  const billableTunnelIds = new Set(((trafficBillingConfigs?.configs || []) as BillingConfigRow[]).filter((item) => item.resourceType === "tunnel" && item.enabled && item.requiresPermission).map((item) => Number(item.resourceId)));
  const billableForwardGroupIds = new Set(((trafficBillingConfigs?.configs || []) as BillingConfigRow[]).filter((item) => item.resourceType === "forward_group" && item.enabled && item.requiresPermission).map((item) => Number(item.resourceId)));
  const normalizeForwardGroupModeForAuth = (group: ForwardGroupOption | null | undefined) => {
    const mode = String(group?.groupMode || "failover");
    return mode === "port" || mode === "chain" || mode === "failover" ? mode : "other";
  };
  const forwardGroupAuthLabel = (group: ForwardGroupOption | null | undefined) => {
    const mode = normalizeForwardGroupModeForAuth(group);
    if (mode === "port") return "端口转发";
    if (mode === "chain") return "转发链";
    return "转发组";
  };
  const authForwardGroups = (allForwardGroups || []).filter((group) => {
    const mode = normalizeForwardGroupModeForAuth(group);
    return mode === "port" || mode === "chain" || mode === "failover";
  });
  const portForwardGroups = authForwardGroups.filter((group) => normalizeForwardGroupModeForAuth(group) === "port");
  const chainAndFailoverGroups = authForwardGroups.filter((group) => normalizeForwardGroupModeForAuth(group) !== "port");
  const selectedAllowedPortForwards = portForwardGroups.filter((group) => allowedForwardGroupIds.includes(Number(group.id)));
  const availableAllowedPortForwards = portForwardGroups.filter((group) => !allowedForwardGroupIds.includes(Number(group.id)));
  const selectedAllowedChainAndFailoverGroups = chainAndFailoverGroups.filter((group) => allowedForwardGroupIds.includes(Number(group.id)));
  const availableAllowedChainAndFailoverGroups = chainAndFailoverGroups.filter((group) => !allowedForwardGroupIds.includes(Number(group.id)));
  const selectedAllowedHosts = (allHosts || []).filter((host) => allowedHostIds.includes(Number(host.id)));
  const availableAllowedHosts = (allHosts || []).filter((host) => !allowedHostIds.includes(Number(host.id)));
  /**
   * 分享候选：排掉他自己的节点 —— 自己的节点本来就在他订阅里，再分享一遍
   * 客户端里会出现两条一模一样的线路。
   */
  const shareableProxyNodes = (proxyNodeShareOptions || []).filter(
    (node) => Number(node.userId) !== Number(trafficUserId || 0),
  );
  const selectedSharedProxyNodes = shareableProxyNodes.filter((node) => sharedProxyNodeIds.includes(Number(node.id)));
  const availableSharedProxyNodes = shareableProxyNodes.filter((node) => !sharedProxyNodeIds.includes(Number(node.id)));
  const selectedAllowedTunnels = (allTunnels || []).filter((t) => allowedTunnelIds.includes(Number(t.id)));
  const availableAllowedTunnels = (allTunnels || []).filter((t) => !allowedTunnelIds.includes(Number(t.id)));
  const billableHosts = (allHosts || []).filter((h) => billableHostIds.has(Number(h.id)));
  const availableBillingHosts = billableHosts.filter((h) => !trafficBillingHostIds.includes(Number(h.id)));
  const selectedBillingHosts = billableHosts.filter((h) => trafficBillingHostIds.includes(Number(h.id)));
  const billableTunnels = (allTunnels || []).filter((t) => billableTunnelIds.has(Number(t.id)));
  const availableBillingTunnels = billableTunnels.filter((t) => !trafficBillingTunnelIds.includes(Number(t.id)));
  const selectedBillingTunnels = billableTunnels.filter((t) => trafficBillingTunnelIds.includes(Number(t.id)));
  const billableForwardGroups = authForwardGroups.filter((group) => billableForwardGroupIds.has(Number(group.id)));
  const availableBillingForwardGroups = billableForwardGroups.filter((group) => !trafficBillingForwardGroupIds.includes(Number(group.id)));
  const selectedBillingForwardGroups = billableForwardGroups.filter((group) => trafficBillingForwardGroupIds.includes(Number(group.id)));

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* overflow-hidden：滚动只交给下面的 TabsContent，否则 DialogContent 默认的 overflow-y-auto 会再套一层滚动区 */}
        <DialogContent className="sm:max-w-lg max-h-[90svh] flex flex-col overflow-hidden">
          <DialogTitle>流量与权限设置</DialogTitle>
          <DialogDescription data-fx-help="">
            设置 "{trafficUserName}" 的管理员额外配额和权限；套餐权益在订阅管理中单独体现。
          </DialogDescription>
          <Tabs defaultValue="permission" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="permission" className="gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                <span>权限</span>
              </TabsTrigger>
              <TabsTrigger value="traffic" className="gap-1.5">
                <Database className="h-3.5 w-3.5" />
                <span>流量</span>
              </TabsTrigger>
              <TabsTrigger value="hosts" className="gap-1.5">
                <Server className="h-3.5 w-3.5" />
                <span>授权</span>
              </TabsTrigger>
            </TabsList>

            {/* 权限标签页 */}
            <TabsContent value="permission" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-3 data-[state=inactive]:hidden">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField className="space-y-2 sm:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>用户备注</Label>
                    <span className="text-xs text-muted-foreground">{trafficDisplayRemark.trim().length}/24</span>
                  </div>
                  <Input
                    value={trafficDisplayRemark}
                    maxLength={24}
                    onChange={(e) => setTrafficDisplayRemark(e.target.value.slice(0, 24))}
                    placeholder="可选，留空则不显示"
                  />
                </FormField>
                <FormField className="space-y-2">
                  <Label>最大规则数</Label>
                  <Input
                    type="number"
                    value={maxRules || ""}
                    onChange={(e) => setMaxRules(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">0 或留空表示不限制</p>
                </FormField>
                <FormField className="space-y-2">
                  <Label>最大落地节点数</Label>
                  <Input
                    type="number"
                    value={maxProxyInbounds || ""}
                    onChange={(e) => setMaxProxyInbounds(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    他自己能在被授权的主机上开几个落地节点。管理员替他开的也算在内。0 或留空表示不限制。
                  </p>
                </FormField>
                <FormField className="space-y-2">
                  <Label>能自助加几台机器</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxSelfServiceHosts}
                    onChange={(e) => setMaxSelfServiceHosts(e.target.value)}
                    placeholder="留空=按系统设置"
                  />
                  {/*
                    空和 0 刻意分开：这是个数量字段，人填 0 就是想说「一台都不给他」。
                    当成「不限」就把他放开了，当成「跟随全局」就等于根本没法卡死某一个人。
                  */}
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    他自己能在「我的机器」里加几台。<strong>留空</strong>＝跟随系统设置里的全局上限；<strong>填 0</strong>＝一台都不许加。
                  </p>
                </FormField>
                <FormField className="space-y-2">
                  <Label>最大订阅地址数</Label>
                  <Input
                    type="number"
                    value={maxProxySubTokens || ""}
                    onChange={(e) => setMaxProxySubTokens(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    他能生成几条订阅地址。每条都是一份完整凭据，发出去就只能靠吊销那一条收回。0 或留空表示不限制。
                  </p>
                </FormField>
                <FormField className="space-y-2">
                  <Label>订阅设备数上限</Label>
                  <Input
                    type="number"
                    value={maxProxyDevices || ""}
                    onChange={(e) => setMaxProxyDevices(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    一条订阅地址最多在几台设备上用。要在「订阅运营 → 设置」里开了设备数限制才生效；和套餐、令牌上的上限取最严。0 或留空表示不限制。
                  </p>
                </FormField>
                <div className="sm:col-span-2">
                  <UserProxySubConfig userId={trafficUserId} />
                </div>
                <FormField className="space-y-2">
                  <Label>最大端口数</Label>
                  <Input
                    type="number"
                    value={maxPorts || ""}
                    onChange={(e) => setMaxPorts(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">0 或留空表示不限制</p>
                </FormField>
                <FormField className="space-y-2">
                  <Label>最大连接数</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxConnections || ""}
                    onChange={(e) => setMaxConnections(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">按主机或隧道聚合。</p>
                </FormField>
                <FormField className="space-y-2">
                  <Label>单 IP 接入限制</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxIPs || ""}
                    onChange={(e) => setMaxIPs(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p data-fx-help="" className="text-xs text-muted-foreground">限制每个来源 IP 的 TCP 并发连接数，不是 IP 个数。隧道按规则计数；普通转发要在系统设置里打开「普通转发接入限制」才执行，按用户、入口主机共享。UDP 不适用。</p>
                </FormField>
              </div>
              <Separator />
              <FormField className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Label>客户端订阅</Label>
                  <p data-fx-help="" className="mt-1 text-xs text-muted-foreground">
                    允许生成订阅地址导入客户端，与转发权限互不影响。
                    套餐已附带该权限的用户不受这里影响；流量用尽或账号被停时自动收回。
                  </p>
                </div>
                <Checkbox
                  checked={allowProxySubscription}
                  onCheckedChange={setAllowProxySubscription}
                  className="mt-1 shrink-0"
                />
              </FormField>
              <Separator />
              <div className="space-y-2">
                <Label className="text-sm font-medium">允许使用的转发方式</Label>
                <p data-fx-help="" className="text-xs text-muted-foreground">全部关闭则禁止转发。</p>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">iptables</span>
                    <Checkbox aria-label="允许使用 iptables" className="shrink-0" checked={allowIptables} onCheckedChange={setAllowIptables} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">nftables</span>
                    <Checkbox aria-label="允许使用 nftables" className="shrink-0" checked={allowNftables} onCheckedChange={setAllowNftables} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">realm</span>
                    <Checkbox aria-label="允许使用 realm" className="shrink-0" checked={allowRealm} onCheckedChange={setAllowRealm} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">socat</span>
                    <Checkbox aria-label="允许使用 socat" className="shrink-0" checked={allowSocat} onCheckedChange={setAllowSocat} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">gost</span>
                    <Checkbox aria-label="允许使用 gost" className="shrink-0" checked={allowGost} onCheckedChange={setAllowGost} />
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* 流量标签页 */}
            <TabsContent value="traffic" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-4 data-[state=inactive]:hidden">
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <Database className="h-3.5 w-3.5" />
                  流量限额
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={trafficLimitInput}
                    onChange={(e) => setTrafficLimitInput(e.target.value)}
                    placeholder="0"
                    className="flex-1"
                  />
                  <span className="text-sm text-muted-foreground select-none">GB</span>
                </div>
                <p data-fx-help="" className="text-xs text-muted-foreground">
                  单位 GB，0 表示不限。
                </p>
              </div>

              <Separator />

              <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5 text-sm">
                    <Gauge className="h-3.5 w-3.5" />
                    转发限速
                  </Label>
                  <p data-fx-help="" className="text-xs text-muted-foreground">
                    对普通端口转发和隧道入口生效。同一用户在一台主机上的所有规则、所有连接共用这个速度，开多线程也绕不过去。
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {([
                    ["上行（客户端 → 目标）", gostRateLimitInInput, setGostRateLimitInInput],
                    ["下行（目标 → 客户端）", gostRateLimitOutInput, setGostRateLimitOutInput],
                  ] as const).map(([label, value, setValue]) => (
                    <div key={label} className="space-y-2">
                      <Label className="text-xs">{label}</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={1000000}
                          step="1"
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          placeholder="0"
                          aria-label={label}
                        />
                        <span className="text-xs text-muted-foreground select-none whitespace-nowrap">Mbps</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs">突发峰值</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={1000000}
                        step="1"
                        value={forwardBurstMbpsInput}
                        onChange={(e) => setForwardBurstMbpsInput(e.target.value)}
                        placeholder="0"
                        aria-label="突发峰值"
                      />
                      <span className="text-xs text-muted-foreground select-none whitespace-nowrap">Mbps</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">突发时长</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={3600}
                        step="1"
                        value={forwardBurstSecondsInput}
                        onChange={(e) => setForwardBurstSecondsInput(e.target.value)}
                        placeholder="0"
                        aria-label="突发时长"
                      />
                      <span className="text-xs text-muted-foreground select-none whitespace-nowrap">秒</span>
                    </div>
                  </div>
                </div>
                <p data-fx-help="" className="text-xs text-muted-foreground">
                  填 0 表示不限速。突发：先按峰值跑这么多秒，用满了降回上面的速度，用得少时额度慢慢回满；峰值不高于上下行速度时不生效。
                  上下行分开和突发需要 Agent 2.2.230 以上，gost 转发和隧道入口只按上下行速度限、不做突发。
                </p>
              </div>

              <Separator />

              <FormField className="space-y-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <CalendarClock className="h-3.5 w-3.5" />
                  到期日期
                </Label>
                <DatePickerInput
                  value={expiresAtInput}
                  onChange={setExpiresAtInput}
                  placeholder="永久有效"
                />
                <p data-fx-help="" className="text-xs text-muted-foreground">
                  留空表示永久有效。
                </p>
              </FormField>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      <RotateCcw className="h-3.5 w-3.5" />
                      启用月度自动重置
                    </p>
                    <p data-fx-help="" className="text-xs text-muted-foreground">每月自动清零已用流量。</p>
                  </div>
                  <Checkbox aria-label="启用月度自动重置"
                    checked={trafficAutoReset}
                    onCheckedChange={(checked) => {
                      setTrafficAutoReset(checked);
                      // 启用时默认以当前日期作为重置日；29–31 日在小月按月末重置
                      if (checked) {
                        const today = currentBillingResetDay();
                        setTrafficResetDay(today);
                      }
                    }}
                  />
                </div>
                {trafficAutoReset && (
                  <FormField className="space-y-2 pt-1">
                    <Label>重置日期（每月第几天）</Label>
                    <Select
                      value={String(trafficResetDay)}
                      onValueChange={(v) => setTrafficResetDay(parseInt(v))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: MONTHLY_RESET_MAX_DAY }, (_, i) => i + 1).map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            每月 {d} 日
                            {d === currentBillingResetDay() ? "（今日）" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p data-fx-help="" className="text-xs text-muted-foreground">
                      默认以启用当天作为重置日，可修改为每月 1–{MONTHLY_RESET_MAX_DAY} 号中任意一天；小月在月末重置（如 31 日在 2 月按 28/29 日）
                    </p>
                  </FormField>
                )}
              </div>
            </TabsContent>

            {/* 授权标签页 */}
            <TabsContent value="hosts" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-4 data-[state=inactive]:hidden">
              <p data-fx-help="" className="text-xs text-muted-foreground">
                默认不展开全部资源，按需选择要授权给该用户的端口转发、转发链、转发组、隧道、网络测试主机和计费资源。
              </p>
              {/*
                八类资源原来一段接一段竖着排、各带一个表头和空提示，一屏翻不完（标准布局重构工作包二）。
                现在一排药丸选类型，只列选中的那一类；数字是已授权的个数。两种布局都这样。
              */}
              <FilterChips
                ariaLabel="资源类型"
                wrap
                value={resourceGrantKind}
                onChange={setResourceGrantKind}
                items={[
                  { value: "port", label: "端口转发", count: selectedAllowedPortForwards.length },
                  { value: "group", label: "转发链/转发组", count: selectedAllowedChainAndFailoverGroups.length },
                  { value: "tunnel", label: "隧道转发", count: allowedTunnelIds.length },
                  { value: "node", label: "订阅节点分享", count: sharedProxyNodeIds.length },
                  { value: "lgHost", label: "网络测试主机", count: allowedHostIds.length },
                  { value: "billingGroup", label: "流量计费资源", count: trafficBillingForwardGroupIds.length },
                  { value: "billingHost", label: "历史计费主机", count: trafficBillingHostIds.length },
                  { value: "billingTunnel", label: "流量计费隧道", count: trafficBillingTunnelIds.length },
                ]}
              />

              {resourceGrantKind === "port" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">端口转发授权</Label>
                  <Badge variant="outline" className="text-[11px]">{selectedAllowedPortForwards.length} 条</Badge>
                </div>
                <Select value={addAllowedPortForwardId} onValueChange={addForwardGroupPermission} disabled={!availableAllowedPortForwards.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableAllowedPortForwards.length ? "选择要授权的端口转发" : "暂无可添加端口转发"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAllowedPortForwards.map((group) => (
                      <SelectItem key={group.id} value={String(group.id)}>
                        {group.name} · {String(group.forwardType || "-")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAllowedPortForwards.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedAllowedPortForwards.map((group) => (
                      <div key={group.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">{group.name}</span>
                          <span className="text-[11px] text-muted-foreground font-mono truncate">{String(group.forwardType || "-")}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${group.name}`}
                          onClick={() => setAllowedForwardGroupIds(prev => prev.filter(id => id !== Number(group.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权端口转发，可从上方选择添加。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "group" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">转发链/转发组授权</Label>
                  <Badge variant="outline" className="text-[11px]">{selectedAllowedChainAndFailoverGroups.length} 条</Badge>
                </div>
                <Select value={addAllowedForwardGroupId} onValueChange={addForwardGroupPermission} disabled={!availableAllowedChainAndFailoverGroups.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableAllowedChainAndFailoverGroups.length ? "选择要授权的转发链或转发组" : "暂无可添加转发链或转发组"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAllowedChainAndFailoverGroups.map((group) => (
                      <SelectItem key={group.id} value={String(group.id)}>
                        {group.name} · {forwardGroupAuthLabel(group)} · {String(group.forwardType || "-")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAllowedChainAndFailoverGroups.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedAllowedChainAndFailoverGroups.map((group) => (
                      <div key={group.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">{group.name}</span>
                          <Badge variant="outline" className="text-[11px] px-1.5 py-0">{forwardGroupAuthLabel(group)}</Badge>
                          <span className="text-[11px] text-muted-foreground font-mono truncate">{String(group.forwardType || "-")}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${group.name}`}
                          onClick={() => setAllowedForwardGroupIds(prev => prev.filter(id => id !== Number(group.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权转发链或转发组，可从上方选择添加。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "tunnel" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">隧道转发</Label>
                  <Badge variant="outline" className="text-[11px]">{allowedTunnelIds.length} 条</Badge>
                </div>
                <Select value={addAllowedTunnelId} onValueChange={addTunnelPermission} disabled={!availableAllowedTunnels.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableAllowedTunnels.length ? "选择要授权的隧道" : "暂无可添加隧道"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAllowedTunnels.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name} · {tunnelRouteText(t)} :{t.listenPort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAllowedTunnels.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedAllowedTunnels.map((t) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{t.name}</span>
                            <Badge variant="outline" className="text-[11px] px-1.5 py-0">{String(t.mode || "tls")}</Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {tunnelRouteText(t)} :{t.listenPort}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${t.name}`}
                          onClick={() => setAllowedTunnelIds(prev => prev.filter(id => id !== Number(t.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权隧道，可从上方选择添加。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "node" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">订阅节点分享</Label>
                  <Badge variant="outline" className="text-[11px]">{sharedProxyNodeIds.length} 个</Badge>
                </div>
                <p data-fx-help="" className="text-xs text-muted-foreground">
                  选中的节点会直接出现在他的订阅里，节点仍然是原主人的，他改不了也删不掉。
                  流量记在节点主人名下 —— 同一个端口分给几个人用，面板按端口计量，拆不开。
                  {/* 找不到东西在哪儿，是这个功能最常见的「以为没生效」。 */}
                  他在「订阅管理 → 我的节点」里看到它们，标着「管理员分享」；「我的套餐」那一页只管套餐，不列节点。
                </p>
                <Select value={addSharedProxyNodeId} onValueChange={addProxyNodeShare} disabled={!availableSharedProxyNodes.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableSharedProxyNodes.length ? "选择要分享的节点" : "暂无可分享的节点"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSharedProxyNodes.map((node) => (
                      <SelectItem key={node.id} value={String(node.id)}>
                        {node.name} · {String(node.protocol || "-")} · {String(node.address || "-")}:{node.port}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedSharedProxyNodes.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedSharedProxyNodes.map((node) => (
                      <div key={node.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{node.name}</span>
                            <Badge variant="outline" className="text-[11px] px-1.5 py-0">{String(node.protocol || "-")}</Badge>
                            {!node.isEnabled ? (
                              <Badge variant="outline" className="text-[11px] px-1.5 py-0 text-muted-foreground">已停用</Badge>
                            ) : null}
                          </div>
                          <p className="text-[11px] text-muted-foreground font-mono truncate">
                            {String(node.address || "-")}:{node.port}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="取消分享"
                          onClick={() => setSharedProxyNodeIds(prev => prev.filter(id => id !== Number(node.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未分享节点。只租一两个落地、不值得单开端口的用户可以从上方选。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "lgHost" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">网络测试主机授权</Label>
                  <Badge variant="outline" className="text-[11px]">{allowedHostIds.length} 台</Badge>
                </div>
                <p data-fx-help="" className="text-xs text-muted-foreground">
                  网络测试会展示用户自己创建、通过主机授权或套餐授权获得的主机；这里用于手动增加授权。端口转发、转发链或转发组的成员主机不会因此单独展示。
                </p>
                <Select value={addAllowedHostId} onValueChange={addHostPermission} disabled={!availableAllowedHosts.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableAllowedHosts.length ? "选择要授权用于网络测试的主机" : "暂无可添加网络测试主机"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAllowedHosts.map((host) => (
                      <SelectItem key={host.id} value={String(host.id)} textValue={String(host.name || host.ip || `主机 #${host.id}`)}>
                        {String(host.name || host.ip || `主机 #${host.id}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAllowedHosts.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedAllowedHosts.map((host) => (
                      <div key={host.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <span className="min-w-0 truncate text-sm font-medium">{String(host.name || host.ip || `主机 #${host.id}`)}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${String(host.name || host.ip || `主机 #${host.id}`)}`}
                          onClick={() => setAllowedHostIds(prev => prev.filter(id => id !== Number(host.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未额外授权网络测试主机。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "billingGroup" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">流量计费转发资源</Label>
                  <Badge variant="outline" className="text-[11px]">{trafficBillingForwardGroupIds.length} 个</Badge>
                </div>
                <Select value={addBillingForwardGroupId} onValueChange={addTrafficBillingForwardGroup} disabled={!availableBillingForwardGroups.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableBillingForwardGroups.length ? "选择要授权的计费转发资源" : "暂无可添加计费转发资源"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBillingForwardGroups.map((group) => (
                      <SelectItem key={group.id} value={String(group.id)}>
                        {group.name || `转发资源 #${group.id}`} · {forwardGroupAuthLabel(group)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedBillingForwardGroups.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedBillingForwardGroups.map((group) => (
                      <div key={group.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{group.name || `转发资源 #${group.id}`}</span>
                            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">{forwardGroupAuthLabel(group)}</Badge>
                          </div>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {(group.members || []).length ? `${group.members.length} 成员` : "链路管理资源"}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${group.name || `转发资源 #${group.id}`}`}
                          onClick={() => setTrafficBillingForwardGroupIds(prev => prev.filter(id => id !== Number(group.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权计费转发资源，可从上方选择添加。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "billingHost" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">历史计费主机</Label>
                  <Badge variant="outline" className="text-[11px]">{trafficBillingHostIds.length} 台</Badge>
                </div>
                <Select value={addBillingHostId} onValueChange={addTrafficBillingHost} disabled={!availableBillingHosts.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableBillingHosts.length ? "选择要授权的历史计费主机" : "暂无可添加历史计费主机"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBillingHosts.map((h) => (
                      <SelectItem key={h.id} value={String(h.id)}>
                        {h.name} {h.ip ? `· ${h.ip}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedBillingHosts.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedBillingHosts.map((h) => (
                      <div key={h.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{h.name}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">{h.ip}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${h.name}`}
                          onClick={() => setTrafficBillingHostIds(prev => prev.filter(id => id !== Number(h.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权历史计费主机。
                  </p>
                )}
              </FormField>
              )}

              {resourceGrantKind === "billingTunnel" && (
              <FormField className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">流量计费隧道</Label>
                  <Badge variant="outline" className="text-[11px]">{trafficBillingTunnelIds.length} 条</Badge>
                </div>
                <Select value={addBillingTunnelId} onValueChange={addTrafficBillingTunnel} disabled={!availableBillingTunnels.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableBillingTunnels.length ? "选择要授权计费的隧道" : "暂无可添加计费隧道"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBillingTunnels.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name} · {tunnelRouteText(t)} :{t.listenPort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedBillingTunnels.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedBillingTunnels.map((t) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{t.name}</span>
                            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">{String(t.mode || "tls")}</Badge>
                          </div>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {tunnelRouteText(t)} :{t.listenPort}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          aria-label={`移除授权 ${t.name}`}
                          onClick={() => setTrafficBillingTunnelIds(prev => prev.filter(id => id !== Number(t.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="fx-empty-hint rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权计费隧道，可从上方选择添加。
                  </p>
                )}
              </FormField>
              )}
            </TabsContent>
          </Tabs>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={handleSaveTrafficSettings} disabled={updateTrafficMutation.isPending || permissionDataLoading}>
              {updateTrafficMutation.isPending ? "保存中..." : permissionDataLoading ? "权限加载中..." : "保存设置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
