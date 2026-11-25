import { getFormatLocale } from "@/i18n";
import { FormField } from "@/components/ui/form-field";
import OpsUserMenuItems from "@/features/ops/slots/UserMenuItems";
import { UserOnlineIpsDialogHost } from "@/features/ops/online/UserOnlineIpsMenuItem";
import { UserTrafficHistoryDialogHost } from "@/components/users/UserTrafficHistory";
import EmptyState from "@/components/EmptyState";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import DataSectionError from "@/components/DataSectionError";
import { forwardAccessRestoredNote } from "@shared/forwardAccessMessage";

/**
 * 管理员这边的四个动作（启用账户、重置流量、充值、改余额）服务端都会顺手
 * 检查一遍「这个人的转发是不是被停了、现在够条件恢复吗」。恢复了就接在
 * 原来那句话后面说出来 —— 不说的话管理员不知道自己顺带救回了什么。
 */
function withRestoredNote(base: string, restored: unknown) {
  const note = forwardAccessRestoredNote(!!restored, "user");
  return note ? `${base} · ${note}` : base;
}
import { subscriptionSourceLabel, subscriptionStatusLabel } from "@shared/ledgerLabels";
import { formatMoneyCents as formatCurrencyCny } from "@shared/formatMoney";
import { formatBytes } from "@shared/formatBytes";
import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import { SummaryStrip } from "@/components/entity/SummaryStrip";
import DatePickerInput from "@/components/DatePickerInput";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { AvatarPicker } from "@/components/AvatarPicker";
import { UserAvatar } from "@/components/UserAvatar";
import { migrateLegacyAvatarValue } from "@/lib/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormDialog, useFormDirty } from "@/components/ui/form-dialog";
import { useDialogTarget } from "@/components/useDialogTarget";
import { parseTrafficInputGB } from "@/components/users/trafficInputs";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OptimisticSwitch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { pollingInterval } from "@/lib/polling";
import { useUrlTab } from "@/hooks/useUrlTab";
import { trpc } from "@/lib/trpc";
import AdminUserReferralPanel from "@/components/referral/AdminUserReferralPanel";
import { forwardAccessResultMessage } from "@shared/forwardAccessMessage";
import {
  ChevronRight,
  ShieldOff,
  Package,
  Plus,
  ShieldCheck,
  Trash2,
  User,
  Users as UsersIcon,
  RotateCcw,
  CalendarClock,
  WalletCards,
  Send,
  Mail,
  MoreHorizontal,
  Pencil,
  LogIn,
} from "lucide-react";
import { openUserBackend } from "@/lib/userImpersonation";
import { mobileAuth } from "@/lib/mobileAuth";
import { lazy, Suspense, useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { BILLING_DATE_TIME_FORMAT_OPTIONS, BILLING_TIME_ZONE, formatBillingDateInput, parseBillingDateInput } from "@shared/billingTime";

function formatSpeedMbps(mbps: number | string | null | undefined): string {
  const num = Number(mbps);
  if (!num || isNaN(num) || num <= 0) return "不限";
  return `${parseFloat(num.toFixed(2))} Mbps`;
}

function formatForwardRateLimit(inMbps: unknown, outMbps: unknown): string {
  const up = Math.max(0, Math.floor(Number(inMbps) || 0));
  const down = Math.max(0, Math.floor(Number(outMbps) || 0));
  if (up === 0 && down === 0) return "不限";
  if (up === down) return `上下行 ${formatSpeedMbps(up)}`;
  return `上行 ${up > 0 ? formatSpeedMbps(up) : "不限"} / 下行 ${down > 0 ? formatSpeedMbps(down) : "不限"}`;
}

// 「流量与权限设置」近 800 行，只有点开某个用户时才用：拆成独立模块按需加载
const UserTrafficSettingsDialog = lazy(() => import("@/components/users/UserTrafficSettingsDialog"));

function userLabel(user: any) {
  return user?.name || user?.username || `#${user?.id}`;
}

const USER_MANAGE_TYPES = ["accounts", "subscriptions"] as const;
type UserManageType = typeof USER_MANAGE_TYPES[number];

function dateText(value?: string | Date | null) {
  if (!value) return "永久";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString(getFormatLocale());
}

function billingDateTimeText(value?: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(getFormatLocale(), BILLING_DATE_TIME_FORMAT_OPTIONS);
}

function isSubscriptionActive(sub: any) {
  return sub?.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt).getTime() > Date.now());
}

function UsersContent() {
  const { user: currentUser } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  /*
    删用户 / 移除 2FA / 重置流量 / 取消订阅四个确认都走共享的确认框：请求在路上时弹窗留着、
    按钮写「删除中...」，成功才关。原来每个都是一套 show / id / name 三元组加一个手写 Dialog。
  */
  const confirmDialog = useConfirmDialog();

  // Create user dialog
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserName, setNewUserName] = useState("");
  // 出于安全考虑，后台创建的用户一律为普通用户
  const [newCanAddRules, setNewCanAddRules] = useState(true);
  // 默认关：订阅地址里带着全部节点凭据，得管理员显式给。
  const [newAllowProxySubscription, setNewAllowProxySubscription] = useState(false);
  // 填了一半点遮罩不该直接没了：改过就在关前问「放弃修改？」（ui/form-dialog）
  const createUserDirty = useFormDirty(showCreateUser, { newUsername, newUserPassword, newUserName, newCanAddRules, newAllowProxySubscription });
  // Reset password dialog
  /*
    「弹窗对着哪个用户」收成 useDialogTarget：原来每个弹窗 show / id / name 三个 state，开关各三连。
    xxxUserId 看 target（关了就是 null，mutation 不会打到旧人），xxxUserName 看 shown（关闭动画里名字不闪没）。
  */
  const accountDialog = useDialogTarget<{ id: number; name: string }>();
  const resetUserId = accountDialog.target?.id ?? null;
  const resetUserName = accountDialog.shown?.name ?? "";
  const [resetUsernameInput, setResetUsernameInput] = useState("");
  const [resetDisplayNameInput, setResetDisplayNameInput] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetAvatarInput, setResetAvatarInput] = useState("");
  const rechargeDialog = useDialogTarget<{ id: number; name: string }>();
  const rechargeUserId = rechargeDialog.target?.id ?? null;
  const rechargeUserName = rechargeDialog.shown?.name ?? "";
  const [rechargeAmount, setRechargeAmount] = useState("");
  const setBalanceDialog = useDialogTarget<{ id: number; name: string }>();
  const setBalanceUserId = setBalanceDialog.target?.id ?? null;
  const setBalanceUserName = setBalanceDialog.shown?.name ?? "";
  const [setBalanceAmount, setSetBalanceAmount] = useState("");
  const emailDialog = useDialogTarget<{ id: number; name: string }>();
  const emailUserId = emailDialog.target?.id ?? null;
  const emailUserName = emailDialog.shown?.name ?? "";
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailContent, setEmailContent] = useState("");

  // 「流量与权限设置」对着哪个用户；表单本身在 components/users/UserTrafficSettingsDialog 里
  const trafficDialog = useDialogTarget<any>();

  // Subscription management dialogs
  const [manageType, setManageType] = useUrlTab<UserManageType>({
    values: USER_MANAGE_TYPES,
    defaultValue: "accounts",
    storageKey: "forwardx.users.type",
  });
  /*
    窄屏上点开的那个人。存 id 而不是整行数据 —— 存整行的话，列表刷新后弹窗里还是
    旧数字（余额刚充完、开关刚拨过），而这一屏正是拿来看这些数的。
  */
  const [detailUserId, setDetailUserId] = useState<number | null>(null);
  const addonDialog = useDialogTarget<{ id: number; name: string }>();
  const addonUserId = addonDialog.target?.id ?? null;
  const addonUserName = addonDialog.shown?.name ?? "";
  const [addonSubscriptionId, setAddonSubscriptionId] = useState("");
  const [addonSubscriptionLabel, setAddonSubscriptionLabel] = useState("");
  const [addonTrafficGB, setAddonTrafficGB] = useState("");
  const extendDialog = useDialogTarget<{ id: number; label: string }>();
  const extendSubscriptionId = extendDialog.target?.id ?? null;
  const extendSubscriptionLabel = extendDialog.shown?.label ?? "";
  const [extendExpiresAtInput, setExtendExpiresAtInput] = useState("");
  const [hiddenCancelledSubscriptionIds, setHiddenCancelledSubscriptionIds] = useState<number[]>([]);
  const { data: userSummary, isLoading: summaryLoading } = trpc.users.summary.useQuery(undefined, {
    enabled: currentUser?.role === "admin",
    refetchInterval: pollingInterval("slow"),
    placeholderData: (previousData) => previousData,
  });
  const subscriptionPageRequest = usePersistentPageRequest("forwardx.users.subscriptions.page");
  const subscriptionPageQuery = trpc.plans.subscriptionsPage.useQuery({
    page: subscriptionPageRequest.page,
    pageSize: 12,
  }, { enabled: currentUser?.role === "admin" && manageType === "subscriptions", placeholderData: (previousData) => previousData });
  const allSubscriptions = subscriptionPageQuery.data?.items || [];
  const subscriptionsLoading = subscriptionPageQuery.isLoading;

  useEffect(() => {
    if (currentUser && currentUser.role !== "admin") {
      setLocation("/");
    }
  }, [currentUser, setLocation]);

  const userPageRequest = usePersistentPageRequest("forwardx.users.page");
  const userPageInput = { page: userPageRequest.page, pageSize: 12 } as const;
  const userPageQuery = trpc.users.listPage.useQuery(userPageInput, {
    enabled: currentUser?.role === "admin" && manageType === "accounts",
    placeholderData: (previousData) => previousData,
  });
  const users = userPageQuery.data?.items;
  const isLoading = userPageQuery.isLoading;

  const patchCachedUser = (userId: number, patch: Record<string, unknown>) => {
    const current = utils.users.listPage.getData(userPageInput);
    if (!current) return;
    utils.users.listPage.setData(userPageInput, {
      ...current,
      items: current.items.map((user: any) => (Number(user.id) === Number(userId) ? { ...user, ...patch } : user)),
    });
  };

  const createUserMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      utils.users.options.invalidate();
      utils.users.listPage.invalidate();
      toast.success("用户已创建");
      setShowCreateUser(false);
      setNewUsername("");
      setNewUserPassword("");
      setNewUserName("");
      setNewCanAddRules(true);
      setNewAllowProxySubscription(false);
    },
    onError: (err) => toast.error(err.message || "创建用户失败"),
  });

  /*
    进入用户后台：新标签页里以这个用户的身份看面板，这个标签页还是管理员（lib/userImpersonation.ts）。
    App 里没有「新标签页」，不提供。
  */
  const enterUserBackendMutation = trpc.users.enterUserBackend.useMutation();
  const enterUserBackend = (u: { id: number }) => {
    void openUserBackend(() => enterUserBackendMutation.mutateAsync({ userId: u.id }))
      .catch((error) => toast.error(error instanceof Error ? error.message : "进入用户后台失败"));
  };

  const resetPasswordMutation = trpc.users.resetPassword.useMutation({
    onSuccess: () => {
      utils.users.options.invalidate();
      utils.users.listPage.invalidate();
      toast.success("账户信息已更新");
      accountDialog.close();
      setResetUsernameInput("");
      setResetNewPassword("");
      setResetAvatarInput("");
    },
    onError: (err) => toast.error(err.message || "更新账户信息失败"),
  });

  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      utils.users.options.invalidate();
      utils.users.listPage.invalidate();
      // 删用户会连带删掉他名下的全部转发规则，规则列表和统计要跟着刷新。
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.listSummary.invalidate();
      utils.rules.mapItems.invalidate();
      toast.success("用户已删除");
    },
    onError: (err) => toast.error(err.message || "删除用户失败"),
  });

  const removeTwoFactorMutation = trpc.users.removeTwoFactor.useMutation({
    onSuccess: (data) => {
      utils.users.listPage.invalidate();
      toast.success(data.removed ? "双因素认证已移除" : "该用户未绑定双因素认证");
    },
    onError: (err) => toast.error(err.message || "移除双因素认证失败"),
  });

  const sendEmailMutation = trpc.users.sendEmail.useMutation({
    onSuccess: () => {
      toast.success("邮件已发送");
      emailDialog.close();
      setEmailSubject("");
      setEmailContent("");
    },
    onError: (err) => toast.error(err.message || "邮件发送失败"),
  });


  const resetTrafficMutation = trpc.users.resetTraffic.useMutation({
    onSuccess: (data, variables) => {
      patchCachedUser(variables.userId, {
        trafficUsed: 0,
        trafficBillingUsed: 0,
      });
      utils.users.listPage.invalidate();
      toast.success(withRestoredNote("流量统计已重置", (data as any)?.forwardAccessRestored));
    },
    onError: (err) => toast.error(err.message || "重置流量失败"),
  });

  const updateForwardAccessMutation = trpc.users.setForwardAccess.useMutation({
    onMutate: async (variables) => {
      await utils.users.listPage.cancel(userPageInput);
      const previousUsers = utils.users.listPage.getData(userPageInput);
      patchCachedUser(variables.userId, {
        canAddRules: variables.enabled,
        manualCanAddRules: variables.enabled,
        manualAllowForwardXTunnel: variables.enabled,
      });
      return { previousUsers };
    },
    onSuccess: (result: any, variables) => {
      /*
        按**服务端实际落成的值**回填，不是按我们刚发出去的那个。

        服务端记下管理员的意图（manualCanAddRules）之后会重算生效值 —— 用户超额时
        生效值仍然是关。原来这里拿 variables.enabled 去 patch 并弹「已开启」：
        toast 说开了，开关还是灰的，刷新一次原样。管理员以为开好了，租户那边一条
        转发都跑不起来。意图照旧记下（额度一放开就会自动生效），但话得说实。
      */
      const effective = typeof result?.canAddRules === "boolean" ? result.canAddRules : variables.enabled;
      patchCachedUser(variables.userId, {
        canAddRules: effective,
        manualCanAddRules: variables.enabled,
        manualAllowForwardXTunnel: variables.enabled,
      });
      utils.rules.list.invalidate();
      const message = forwardAccessResultMessage({
        requested: variables.enabled,
        effective: result?.canAddRules,
        reason: result?.pauseReason,
      });
      if (message.tone === "warning") toast.warning(message.text);
      else toast.success(message.text);
    },
    onError: (err, _variables, context) => {
      if (context?.previousUsers) utils.users.listPage.setData(userPageInput, context.previousUsers);
      toast.error(err.message || "更新转发权限失败");
    },
    onSettled: async () => {
      await Promise.all([
        utils.users.listPage.invalidate(),
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
      ]);
    },
  });

  const updateAccountEnabledMutation = trpc.users.setAccountEnabled.useMutation({
    onMutate: async (variables) => {
      await utils.users.listPage.cancel(userPageInput);
      const previousUsers = utils.users.listPage.getData(userPageInput);
      patchCachedUser(variables.userId, { accountEnabled: variables.enabled });
      return { previousUsers };
    },
    onSuccess: (data, variables) => {
      patchCachedUser(variables.userId, { accountEnabled: variables.enabled });
      utils.rules.list.invalidate();
      // 启用账户时服务端顺手做了「够条件就恢复转发」，恢复了就得说出来。
      toast.success(withRestoredNote(
        variables.enabled ? "账户已启用" : "账户已禁用，已有规则已失效",
        (data as any)?.forwardAccessRestored,
      ));
    },
    onError: (err, _variables, context) => {
      if (context?.previousUsers) utils.users.listPage.setData(userPageInput, context.previousUsers);
      toast.error(err.message || "更新账户状态失败");
    },
    onSettled: async () => {
      await Promise.all([
        utils.users.listPage.invalidate(),
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
      ]);
    },
  });

  const adminRechargeMutation = trpc.billing.adminRecharge.useMutation({
    onSuccess: (data) => {
      utils.users.listPage.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.billing.listTransactionsPage.invalidate();
      toast.success(withRestoredNote("余额已充值", (data as any)?.forwardAccessRestored));
      rechargeDialog.close();
      setRechargeAmount("");
    },
    onError: (err) => toast.error(err.message || "充值失败"),
  });

  const adminSetBalanceMutation = trpc.billing.adminSetBalance.useMutation({
    onSuccess: (data) => {
      utils.users.listPage.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledgerPage.invalidate();
      utils.billing.listTransactionsPage.invalidate();
      toast.success(withRestoredNote(data.changed ? "余额已修改" : "余额未变化", (data as any)?.forwardAccessRestored));
      setBalanceDialog.close();
      setSetBalanceAmount("");
    },
    onError: (err) => toast.error(err.message || "修改余额失败"),
  });
  const adminAddTrafficAddonMutation = trpc.billing.adminAddTrafficAddon.useMutation({
    onSuccess: () => {
      utils.users.listPage.invalidate();
      utils.users.summary.invalidate();
      utils.plans.subscriptions.invalidate();
      utils.plans.subscriptionsPage.invalidate();
      toast.success("本周期附加流量已生效");
      addonDialog.close();
      setAddonSubscriptionId("");
      setAddonSubscriptionLabel("");
      setAddonTrafficGB("");
    },
    onError: (err) => toast.error(err.message || "附加流量失败"),
  });

  const extendSubscriptionMutation = trpc.plans.extendSubscription.useMutation({
    onSuccess: () => {
      utils.users.listPage.invalidate();
      utils.users.summary.invalidate();
      utils.plans.subscriptions.invalidate();
      utils.plans.subscriptionsPage.invalidate();
      toast.success("订阅到期时间已更新");
      extendDialog.close();
      setExtendExpiresAtInput("");
    },
    onError: (err) => toast.error(err.message || "更新订阅到期时间失败"),
  });

  const cancelSubscriptionMutation = trpc.plans.cancelSubscription.useMutation({
    onMutate: (variables) => {
      const id = Number(variables.id);
      if (id > 0) {
        setHiddenCancelledSubscriptionIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
      }
    },
    onSuccess: () => {
      utils.users.listPage.invalidate();
      utils.users.summary.invalidate();
      utils.plans.subscriptions.invalidate();
      utils.plans.subscriptionsPage.invalidate();
      toast.success("订阅已取消");
    },
    onError: (err, variables) => {
      const id = Number(variables.id);
      setHiddenCancelledSubscriptionIds((ids) => ids.filter((item) => item !== id));
      toast.error(err.message || "取消订阅失败");
    },
  });

  const adminCount = Number(userSummary?.adminUsers ?? userPageQuery.data?.adminItems ?? 0);
  const visibleSubscriptions = useMemo(
    () => (allSubscriptions as any[]).filter((sub: any) => sub?.status !== "cancelled" && !hiddenCancelledSubscriptionIds.includes(Number(sub?.id))),
    [allSubscriptions, hiddenCancelledSubscriptionIds],
  );
  const activeSubscriptionCount = Number(userSummary?.activeSubscriptions ?? subscriptionPageQuery.data?.activeItems ?? 0);
  const userManageTabItems = useMemo<SlidingTabItem<UserManageType>[]>(() => [
    { value: "accounts", label: "账户管理", icon: UsersIcon },
    {
      value: "subscriptions",
      label: "用户套餐",
      icon: Package,
      badge: (summaryLoading || activeSubscriptionCount > 0) ? (
        <AnimatedStatValue
          value={activeSubscriptionCount}
          loading={summaryLoading}
          cacheKey="users.tabs.activeSubscriptionCount"
          fallbackValue={0}
          className="leading-none"
        />
      ) : null,
    },
  ], [activeSubscriptionCount, summaryLoading]);
  const userPagination = useServerPagination(users || [], Number(userPageQuery.data?.totalItems || 0), userPageRequest, {
    pageSize: 12,
    isReady: !isLoading && !!userPageQuery.data,
  });
  const pagedUsers = userPagination.items;
  // 弹窗里的那个人现从列表取：列表一刷新，弹窗里的数跟着新。
  const detailUser = detailUserId === null
    ? null
    : (pagedUsers as any[]).find((item: any) => Number(item.id) === detailUserId) || null;
  const subscriptionPagination = useServerPagination(visibleSubscriptions, Number(subscriptionPageQuery.data?.totalItems || 0), subscriptionPageRequest, {
    pageSize: 12,
    isReady: !subscriptionsLoading && !!subscriptionPageQuery.data,
  });
  const pagedSubscriptions = subscriptionPagination.items;

  if (currentUser?.role !== "admin") return null;

  const openTrafficSettings = (u: any) => {
    if (u.role === "admin") {
      toast.info("管理员默认拥有全部权限，且不受流量/资源限制");
      return;
    }
    trafficDialog.open(u);
  };

  const handleCreateUser = () => {
    if (!newUsername.trim()) {
      toast.error("请输入用户名");
      return;
    }
    if (newUserName.trim().length > 24) {
      toast.error("显示名称最多 24 个字符");
      return;
    }
    if (newUserPassword.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    createUserMutation.mutate({
      username: newUsername.trim(),
      password: newUserPassword,
      name: newUserName.trim() || undefined,
      canAddRules: newCanAddRules,
      allowProxySubscription: newAllowProxySubscription,
    });
  };

  const handleResetPassword = () => {
    if (!resetUserId) return;
    const username = resetUsernameInput.trim();
    const password = resetNewPassword.trim();
    if (!username) {
      toast.error("请输入账号");
      return;
    }
    if (resetDisplayNameInput.trim().length > 24) {
      toast.error("显示名称最多 24 个字符");
      return;
    }
    if (password && password.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    resetPasswordMutation.mutate({
      userId: resetUserId,
      username,
      name: resetDisplayNameInput.trim() || null,
      avatar: resetAvatarInput || migrateLegacyAvatarValue("", `user-${resetUserId}`),
      newPassword: password || undefined,
    });
  };

  const openRechargeDialog = (u: any) => {
    rechargeDialog.open({ id: u.id, name: userLabel(u) });
    setRechargeAmount("");
  };

  const openSetBalanceDialog = (u: any) => {
    setBalanceDialog.open({ id: u.id, name: userLabel(u) });
    setSetBalanceAmount((Number(u.balanceCents || 0) / 100).toFixed(2));
  };

  const openResetTrafficDialog = (u: any) => {
    void confirmDialog({
      title: "重置流量统计",
      description: `确认重置 "${userLabel(u)}" 的套餐/分配流量和按量计费流量统计？已产生的扣费记录不会撤销。`,
      confirmText: "确认重置",
      confirmPendingText: "重置中...",
      onConfirm: () => resetTrafficMutation.mutateAsync({ userId: u.id }),
    });
  };

  const openAccountDialog = (u: any) => {
    accountDialog.open({ id: u.id, name: userLabel(u) });
    setResetUsernameInput(u.username || "");
    setResetDisplayNameInput(u.name || u.username || "");
    setResetNewPassword("");
    setResetAvatarInput(migrateLegacyAvatarValue(u.avatar, `user-${u.id}`));
  };

  const confirmDeleteUser = (u: any) => {
    if (u.id === currentUser?.id) return;
    void confirmDialog({
      title: "删除用户",
      description: `确认删除用户 "${userLabel(u)}"？该操作会同时删除该用户名下的全部转发规则（先结算流量并停止转发）和权限配置，且不可撤销。该用户名下还有隧道、转发组或主机时无法删除，请先转移给其他用户或删除。`,
      confirmText: "确认删除",
      confirmPendingText: "删除中...",
      onConfirm: () => deleteMutation.mutateAsync({ userId: u.id }),
    });
  };

  const openRemoveTwoFactorDialog = (u: any) => {
    void confirmDialog({
      title: "移除双因素认证",
      description: `确认移除 "${userLabel(u)}" 已绑定的 2FA？移除后该用户下次登录不再需要双因素验证码。`,
      confirmText: "确认移除",
      confirmPendingText: "移除中...",
      onConfirm: () => removeTwoFactorMutation.mutateAsync({ userId: u.id }),
    });
  };

  const openSendEmail = (u: any) => {
    if (!u.email || !u.emailVerified) {
      toast.error("该用户邮箱尚未验证，不能发送邮件");
      return;
    }
    emailDialog.open({ id: u.id, name: userLabel(u) });
    setEmailTo(u.email);
    setEmailSubject("");
    setEmailContent("");
  };

  const handleSendEmail = () => {
    if (!emailUserId) return;
    if (!emailSubject.trim() || !emailContent.trim()) {
      toast.error("请填写邮件标题和内容");
      return;
    }
    sendEmailMutation.mutate({
      userId: emailUserId,
      subject: emailSubject.trim(),
      content: emailContent.trim(),
    });
  };


  const handleRecharge = () => {
    if (!rechargeUserId) return;
    const amountCents = Math.round(Number(rechargeAmount || 0) * 100);
    if (amountCents <= 0) return toast.error("请输入有效充值金额");
    adminRechargeMutation.mutate({ userId: rechargeUserId, amountCents, description: "用户管理手动充值" });
  };

  const handleSetBalance = () => {
    if (!setBalanceUserId) return;
    const balanceCents = Math.round(Number(setBalanceAmount || 0) * 100);
    if (!Number.isFinite(balanceCents) || balanceCents < 0) return toast.error("请输入有效余额");
    adminSetBalanceMutation.mutate({ userId: setBalanceUserId, balanceCents, description: "用户管理手动修改余额" });
  };

  const handleManageTypeChange = (value: string) => {
    const next = value === "subscriptions" ? "subscriptions" : "accounts";
    setManageType(next);
  };

  const openAddonDialog = (sub: any) => {
    if (!isSubscriptionActive(sub) || Number(sub.trafficLimit || 0) <= 0) {
      toast.error("只有生效中的流量套餐可以附加流量");
      return;
    }
    addonDialog.open({ id: Number(sub.userId), name: userLabel({ username: sub.username, name: sub.name, id: sub.userId }) });
    setAddonSubscriptionId(String(sub.id));
    setAddonSubscriptionLabel(`${sub.planName || `套餐 #${sub.planId}`} · ${formatBytes(sub.trafficLimit)}`);
    setAddonTrafficGB("");
  };

  const openExtendDialog = (sub: any) => {
    if (sub.status === "cancelled") {
      toast.error("已取消的订阅不能更改到期时间");
      return;
    }
    extendDialog.open({ id: Number(sub.id), label: `${userLabel({ username: sub.username, name: sub.name, id: sub.userId })} · ${sub.planName || `套餐 #${sub.planId}`}` });
    setExtendExpiresAtInput(formatBillingDateInput(sub.expiresAt));
  };

  const openCancelSubscriptionDialog = (sub: any) => {
    if (!isSubscriptionActive(sub)) {
      toast.error("只有生效中的订阅可以取消");
      return;
    }
    const label = userLabel({ username: sub.username, name: sub.name, id: sub.userId });
    const planLabel = sub.planName || `套餐 #${sub.planId}`;
    void confirmDialog({
      title: "取消订阅",
      description: `确认取消 "${label}" 的 ${planLabel || "当前套餐"} 订阅？`,
      details: (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-muted-foreground">
          取消后该订阅会立即停止生效，关联的本周期附加流量也会失效。用户账户和历史记录不会被删除。
        </div>
      ),
      confirmText: "确认取消",
      confirmPendingText: "取消中...",
      tone: "destructive",
      onConfirm: () => cancelSubscriptionMutation.mutateAsync({ id: Number(sub.id) }),
    });
  };

  const handleAdminAddTrafficAddon = () => {
    if (!addonUserId) return;
    const trafficBytes = parseTrafficInputGB(addonTrafficGB);
    if (trafficBytes <= 0) return toast.error("请输入大于 0 的附加流量");
    adminAddTrafficAddonMutation.mutate({
      userId: addonUserId,
      trafficBytes,
      subscriptionId: addonSubscriptionId ? Number(addonSubscriptionId) : undefined,
      description: "管理员手动附加本周期流量",
    });
  };

  const handleExtendSubscription = () => {
    if (!extendSubscriptionId) return;
    const text = extendExpiresAtInput.trim();
    if (text && !parseBillingDateInput(text)) return toast.error("请选择有效到期日期");
    extendSubscriptionMutation.mutate({
      id: extendSubscriptionId,
      expiresAt: text ? parseBillingDateInput(text)?.toISOString() || null : null,
    });
  };


  /**
   * 一个用户的全部细节 —— 就是原来窄屏那张大卡的内容，一项没少，只是挪进了弹窗。
   *
   * 列表上只留认人用的那几样，其余全在这儿：点开才看，而不是每找一个人都滑过
   * 别人的全部家当。
   */
  const renderUserDetail = (u: any) => {
    const limit = Number(u.trafficLimit) || 0;
    const used = Number(u.trafficUsed) || 0;
    const billingUsed = Number(u.trafficBillingUsed) || 0;
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const isExpired = u.expiresAt && new Date(u.expiresAt) <= new Date();
    const isOverLimit = limit > 0 && used >= limit;
    const speedLimit = Math.max(Number(u.gostRateLimitIn) || 0, Number(u.gostRateLimitOut) || 0);
    return (
      <div className="grid gap-2">
        <div className="rounded-md bg-muted/25 p-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">套餐/分配</span>
            <span className="min-w-0 truncate text-right tabular-nums">
              {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : "不限"}
            </span>
          </div>
          {limit > 0 && (
            <Progress value={pct} className={`mt-2 h-1.5 ${isOverLimit ? "[&>div]:bg-destructive" : ""}`} />
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {isOverLimit && <Badge variant="destructive" className="h-5 px-1.5 text-[11px]">超额</Badge>}
            {u.trafficAutoReset && (
              <Badge variant="outline" className="h-5 px-1.5 text-[11px]">每月{u.trafficResetDay || 1}日重置</Badge>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs">
            <span className="shrink-0 text-muted-foreground">按量计费</span>
            <span className="min-w-0 truncate text-right font-medium tabular-nums">{formatBytes(billingUsed)}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="min-w-0 rounded-md bg-muted/25 p-2">
            <p className="text-muted-foreground">余额</p>
            <p className="mt-1 truncate font-medium">{formatCurrencyCny(u.balanceCents)}</p>
          </div>
          <div className="min-w-0 rounded-md bg-muted/25 p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground">到期</p>
              {isExpired && <Badge variant="destructive" className="h-5 shrink-0 px-1.5 text-[11px]">已到期</Badge>}
            </div>
            <p className={`mt-1 truncate font-medium ${isExpired ? "text-destructive" : ""}`}>
              {u.expiresAt ? new Date(u.expiresAt).toLocaleDateString(undefined, { timeZone: BILLING_TIME_ZONE }) : "不限"}
            </p>
          </div>
          <div className="min-w-0 rounded-md bg-muted/25 p-2">
            <p className="text-muted-foreground">Telegram</p>
            <p className="mt-1 truncate font-medium">
              {u.telegramId ? (u.telegramUsername ? `@${u.telegramUsername}` : u.telegramFirstName || u.telegramId) : "未绑定"}
            </p>
          </div>
          <div className="min-w-0 rounded-md bg-muted/25 p-2">
            <p className="text-muted-foreground">邮箱</p>
            <p className="mt-1 truncate font-medium">{u.emailVerified ? "已验证" : u.email ? "未验证" : "未填写"}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <span>规则: {u.maxRules ? `${u.maxRules} 条` : "不限"}</span>
          <span>端口: {u.maxPorts ? `${u.maxPorts} 个` : "不限"}</span>
          <span>连接: {u.maxConnections ? `${u.maxConnections}` : "不限"}</span>
          <span>单 IP: {u.maxIPs ? `${u.maxIPs}` : "不限"}</span>
          {speedLimit > 0 && <span className="col-span-2">转发限速: {formatForwardRateLimit(u.gostRateLimitIn, u.gostRateLimitOut)}</span>}
        </div>

        <AdminUserReferralPanel userId={Number(u.id)} />

        <div className="flex h-9 items-center justify-between rounded-md border border-border/50 px-2">
          <span className="text-xs text-muted-foreground">转发</span>
          <OptimisticSwitch aria-label={`允许 ${u.username} 添加转发`}
            checked={u.role === "admin" || !!u.canAddRules}
            disabled={u.role === "admin"}
            onCheckedChangeAsync={(checked) => updateForwardAccessMutation.mutateAsync({ userId: u.id, enabled: checked })}
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 pt-1">
          {renderAccountEnabledControl(u, true)}
          {/*
            编辑会开另一个弹窗。不先把详情关掉的话两层弹窗叠在一起，
            关掉上面那个会连下面一起关，人会以为自己的改动没保存。
          */}
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-2 text-xs"
            onClick={() => { setDetailUserId(null); openTrafficSettings(u); }}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            编辑
          </Button>
          {renderUserMoreMenu(u, "h-9 justify-center gap-1 rounded-md border border-border/50 px-2 text-xs")}
        </div>
      </div>
    );
  };

  const renderAccountEnabledControl = (u: any, compact = false) => {
    const enabled = u.accountEnabled !== false;
    const isSelf = u.id === currentUser?.id;
    const title = isSelf
      ? "不能停用当前登录账号"
      : `${enabled ? "停用" : "启用"}账号 ${u.username || ""}`;
    return (
      <div
        className={
          compact
            ? "flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/50 px-2 py-1.5"
            : "flex items-center justify-center"
        }
      >
        {compact && <span className="min-w-0 truncate text-xs text-muted-foreground">账户</span>}
        <OptimisticSwitch
          checked={enabled}
          disabled={isSelf}
          onCheckedChangeAsync={(checked) => updateAccountEnabledMutation.mutateAsync({ userId: u.id, enabled: checked })}
          className="shrink-0"
          title={title}
          aria-label={title}
        />
      </div>
    );
  };

  const renderUserMoreMenu = (u: any, triggerClassName = "h-8 px-2") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={triggerClassName} title="更多操作">
          <MoreHorizontal className="h-4 w-4" />
          <span className="text-xs">更多</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <OpsUserMenuItems user={u} />
        {!mobileAuth.isNative ? (
          <DropdownMenuItem
            disabled={u.role === "admin" || u.accountEnabled === false || enterUserBackendMutation.isPending}
            onSelect={() => enterUserBackend(u)}
            title={u.role === "admin" ? "不能进入管理员账号的后台" : u.accountEnabled === false ? "账号已停用" : "在新窗口以这个用户的身份查看，当前窗口不受影响"}
          >
            <LogIn />
            <span>进入后台</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => openRechargeDialog(u)}>
          <WalletCards />
          <span>余额充值</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSetBalanceDialog(u)}>
          <Pencil />
          <span>修改余额</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openAccountDialog(u)}>
          <User />
          <span>账户信息</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!u.emailVerified || !u.email} onSelect={() => openSendEmail(u)}>
          <Mail />
          <span>发送邮件</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openResetTrafficDialog(u)}>
          <RotateCcw />
          <span>重置流量统计</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!u.twoFactorEnabled} onSelect={() => openRemoveTwoFactorDialog(u)}>
          <ShieldOff />
          <span>移除 2FA</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={u.id === currentUser?.id}
          onSelect={() => confirmDeleteUser(u)}
          variant="destructive"
        >
          <Trash2 />
          <span>删除用户</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-6">
      <WorkspaceHeader title={<>用户管理</>} description={<>
            管理系统用户、权限和流量配额
          </>} actions={<>
          {/* 精简布局：下面的统计条已经是这两个数，页头不再重复（data-fx-compact-hide） */}
          <Badge data-fx-compact-hide="" variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <ShieldCheck className="h-3 w-3 text-[var(--fx-warn-text)]" />
            <AnimatedStatValue
              value={`${adminCount} 管理员`}
              loading={isLoading || !users}
              cacheKey="users.header.adminCount"
              fallbackValue="0 管理员"
            />
          </Badge>
          <Badge data-fx-compact-hide="" variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <UsersIcon className="h-3 w-3 text-primary" />
            <AnimatedStatValue
              value={`${userPageQuery.data?.totalItems ?? 0} 用户`}
              loading={isLoading || !users}
              cacheKey="users.header.totalUsers"
              fallbackValue="0 用户"
            />
          </Badge>
          <Button size="sm" className="col-span-2 sm:col-span-1" onClick={() => setShowCreateUser(true)}>
            <Plus className="h-4 w-4 mr-1" />
            添加用户
          </Button>
        </>} />

      <SummaryStrip
        ariaLabel="用户概况"
        loading={summaryLoading}
        items={[
          { key: "users", label: "用户", value: userSummary?.totalUsers ?? userPageQuery.data?.totalItems ?? 0, hint: `${adminCount} 个管理员`, loading: summaryLoading || isLoading, cacheKey: "users.summary.totalUsers", fallbackValue: 0 },
          { key: "rules", label: "转发规则", value: userSummary?.totalRules ?? 0, hint: `${userSummary?.activeRules ?? 0} 条已启用`, cacheKey: "users.summary.totalRules", fallbackValue: 0 },
          { key: "in", label: "累计入站", value: formatBytes(userSummary?.totalTrafficIn ?? 0), hint: "所有用户", cacheKey: "users.summary.totalTrafficIn", fallbackValue: "0 B" },
          { key: "out", label: "累计出站", value: formatBytes(userSummary?.totalTrafficOut ?? 0), hint: "所有用户", cacheKey: "users.summary.totalTrafficOut", fallbackValue: "0 B" },
        ]}
      />

      <Tabs value={manageType} onValueChange={handleManageTypeChange} className="space-y-4">
        <SlidingTabsList items={userManageTabItems} activeValue={manageType} ariaLabel="用户管理" minItemWidthRem={10.5} />

        <TabsContent value="accounts" className="space-y-4 data-[state=inactive]:hidden">

      {isLoading && (
        <DataSectionLoading className="sm:hidden" label="正在加载用户数据" minHeight="min-h-[220px]" />
      )}

      {/*
        一人一行，点开看详情。

        原来每个用户在窄屏上是一整张卡：套餐、按量、余额、到期、TG、邮箱、四个配额、
        两个开关、三个按钮 —— 一屏一个人。管理员在这一页干的最多的事是**找人**
        （「张三那个号还在不在」「谁超额了」），而找人只需要名字和状态；剩下那十几项
        是找到之后才看的。把它们平铺在列表里，等于每找一个人都要滑过别人的全部家当。

        所以行上只留**用来认人和判断要不要点进去**的东西：名字、角色、异常徽章、
        一句用量。其余的原样搬进详情弹窗，一项没少。
      */}
      {!isLoading && users && users.length > 0 && (
        <AutoAnimateContainer className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/50 bg-card/70 sm:hidden">
          {pagedUsers.map((u: any) => {
            const limit = Number(u.trafficLimit) || 0;
            const used = Number(u.trafficUsed) || 0;
            const isExpired = u.expiresAt && new Date(u.expiresAt) <= new Date();
            const isOverLimit = limit > 0 && used >= limit;
            return (
              <button
                key={u.id}
                type="button"
                className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors active:bg-muted/40"
                onClick={() => setDetailUserId(u.id)}
              >
                <UserAvatar user={u} className="h-9 w-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-semibold">{u.username || "未命名"}</span>
                    {u.role === "admin" && <Badge size="sm" className="shrink-0">管理员</Badge>}
                    {u.id === currentUser?.id && (
                      <Badge variant="outline" size="sm" className="shrink-0 text-primary">当前</Badge>
                    )}
                    {/*
                      异常要在行上就看得见 —— 「谁被禁了 / 谁超额了 / 谁过期了」正是
                      管理员扫这一屏在找的东西，藏进详情就等于要一个个点开找。
                    */}
                    {u.accountEnabled === false && (
                      <Badge variant="destructive" size="sm" className="shrink-0">禁用</Badge>
                    )}
                    {isOverLimit && <Badge variant="destructive" size="sm" className="shrink-0">超额</Badge>}
                    {isExpired && <Badge variant="destructive" size="sm" className="shrink-0">已到期</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    #{u.id}
                    {u.displayRemark ? ` · ${u.displayRemark}` : ""}
                    {" · "}
                    {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : "不限"}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </AutoAnimateContainer>
      )}

      {/* 「暂无其他用户」读失败时是假话 —— 一屏的租户不会一起消失。 */}
      {!isLoading && (!users || users.length === 0) && userPageQuery.error && (
        <div className="sm:hidden">
          <DataSectionError
            label="用户列表"
            error={userPageQuery.error}
            retrying={userPageQuery.isFetching}
            onRetry={() => { void userPageQuery.refetch(); }}
          />
        </div>
      )}

      {!isLoading && (!users || users.length === 0) && !userPageQuery.error && (
        <EmptyState icon={<UsersIcon className="h-7 w-7 opacity-40" />} title={<>暂无其他用户</>} description={<>点击添加用户创建账号</>} />
      )}

      <Card className="glass-panel hidden overflow-hidden sm:block">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <DataSectionLoading label="正在加载用户数据" />
            </div>
          ) : users && users.length > 0 ? (
            <div className="overflow-x-auto">
              <Table className="fx-users-table min-w-[720px] sm:min-w-[860px] md:min-w-[1120px] lg:min-w-[1380px] xl:min-w-[1520px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead data-fx-compact-hide="" className="w-[60px] whitespace-nowrap">ID</TableHead>
                    <TableHead className="w-[260px] whitespace-nowrap">用户</TableHead>
                    <TableHead className="w-[210px] whitespace-nowrap">流量使用</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap xl:table-cell">Telegram</TableHead>
                    <TableHead className="hidden w-[120px] whitespace-nowrap md:table-cell">余额</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap md:table-cell">到期时间</TableHead>
                    <TableHead className="hidden w-[160px] whitespace-nowrap text-center lg:table-cell">转发总开关</TableHead>
                    <TableHead className="hidden w-[240px] whitespace-nowrap lg:table-cell">规则限制</TableHead>
                    <TableHead className="w-[150px] whitespace-nowrap text-center">账户状态</TableHead>
                    <TableHead className="w-[190px] whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <AutoAnimateContainer as={TableBody}>
                  {pagedUsers.map((u: any) => {
                    const limit = Number(u.trafficLimit) || 0;
                    const used = Number(u.trafficUsed) || 0;
                    const billingUsed = Number(u.trafficBillingUsed) || 0;
                    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                    const isExpired = u.expiresAt && new Date(u.expiresAt) <= new Date();
                    const isOverLimit = limit > 0 && used >= limit;

                    return (
                      <TableRow key={u.id}>
                        {/* 精简布局：ID 列不占位（详情框里有 #id） */}
                        <TableCell data-fx-compact-hide="">
                          <span className="text-xs text-muted-foreground font-mono">#{u.id}</span>
                        </TableCell>
                        <TableCell className="py-3">
                          <div className="flex items-center gap-2.5">
                            <UserAvatar user={u} className="h-8 w-8 shrink-0" />
                            <div className="min-w-0 py-0.5">
                              {/* 名字和标签同一行，备注放悬停，一行用户不再叠四行（标准布局重构工作包二） */}
                              <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                                <p className="min-w-0 truncate text-sm font-medium leading-5" title={u.displayRemark ? `${u.username || "未命名"} · ${u.displayRemark}` : undefined}>{u.username || "未命名"}</p>
                                <span className="contents">
                                {/* 精简布局：「普通用户」是默认，不标；管理员照标 */}
                                <Badge data-fx-compact-hide={u.role === "admin" ? undefined : ""} variant={u.role === "admin" ? "default" : "outline"} className="h-5 w-fit shrink-0 px-1.5 text-[11px] leading-4">
                                  {u.role === "admin" ? "管理员" : "普通用户"}
                                </Badge>
                                {u.accountEnabled === false && (
                                  <Badge variant="destructive" className="h-5 w-fit shrink-0 px-1.5 text-[11px]">账户禁用</Badge>
                                )}
                                {u.id === currentUser?.id && (
                                  <span className="shrink-0 text-[11px] font-medium leading-4 text-primary">当前登录</span>
                                )}
                                </span>
                              </div>
                              {u.displayRemark && (
                                <p className="truncate text-xs text-muted-foreground">{u.displayRemark}</p>
                              )}
                              {u.role !== "admin" && (
                                <div className="mt-1 flex w-fit items-center gap-2 lg:hidden">
                                  <OptimisticSwitch aria-label={`允许 ${u.username} 添加转发`}
                                    checked={!!u.canAddRules}
                                    onCheckedChangeAsync={(checked) => updateForwardAccessMutation.mutateAsync({ userId: u.id, enabled: checked })}
                                    className="shrink-0"
                                  />
                                  <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                                    {u.canAddRules ? "转发启用" : "转发停用"}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="min-w-[190px] space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="shrink-0 text-[11px] text-muted-foreground">套餐/分配</span>
                              <div className="flex min-w-0 items-center justify-end gap-1">
                                {isOverLimit && (
                                  <Badge variant="destructive" className="h-3.5 shrink-0 px-1 py-0 text-[11px]">超额</Badge>
                                )}
                                <span className="truncate text-xs tabular-nums">
                                  {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : "不限"}
                                </span>
                              </div>
                            </div>
                            {limit > 0 && (
                              <Progress
                                value={pct}
                                className={`h-1 ${isOverLimit ? "[&>div]:bg-destructive" : ""}`}
                              />
                            )}
                            <div className="flex items-center justify-between gap-2">
                              <span className="shrink-0 text-[11px] text-muted-foreground">按量计费</span>
                              <span className="truncate text-xs font-medium tabular-nums">{formatBytes(billingUsed)}</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          {u.telegramId ? (
                            <div className="flex items-center gap-2">
                              <Send className="h-3.5 w-3.5 text-primary" />
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium">
                                  {u.telegramUsername ? `@${u.telegramUsername}` : u.telegramFirstName || u.telegramId}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {u.telegramLinkedAt ? new Date(u.telegramLinkedAt).toLocaleDateString() : "已绑定"}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">未绑定</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-sm font-medium">
                            {formatCurrencyCny(u.balanceCents)}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="flex min-w-[120px] flex-col items-start gap-1">
                            {u.expiresAt ? (
                              <>
                                <div className="flex items-center gap-1.5 whitespace-nowrap">
                                  <CalendarClock className="h-3 w-3 text-muted-foreground" />
                                  <span className={`text-xs ${isExpired ? "text-destructive" : "text-muted-foreground"}`}>
                                    {new Date(u.expiresAt).toLocaleDateString(undefined, { timeZone: BILLING_TIME_ZONE })}
                                  </span>
                                </div>
                                {isExpired && (
                                  <Badge variant="destructive" className="h-4 px-1.5 py-0 text-[11px]">已到期</Badge>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">不限</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden min-w-[160px] text-center lg:table-cell">
                          <div className="mx-auto flex w-fit min-w-[140px] flex-col items-center gap-1">
                            <div className="flex items-center justify-center gap-2 whitespace-nowrap">
                              <OptimisticSwitch aria-label={`允许 ${u.username} 添加转发`}
                                checked={u.role === "admin" || !!u.canAddRules}
                                disabled={u.role === "admin"}
                                onCheckedChangeAsync={(checked) => updateForwardAccessMutation.mutateAsync({ userId: u.id, enabled: checked })}
                                className="shrink-0"
                              />
                              {/* 精简布局：开关本身就是状态，旁边那枚「转发启用 / 停用」不再标 */}
                              {u.canAddRules || u.role === "admin" ? (
                                <Badge data-fx-compact-hide="" variant="outline" className="h-5 w-fit shrink-0 whitespace-nowrap border-chart-2/30 px-2 py-0 text-[11px] text-chart-2">
                                  转发启用
                                </Badge>
                              ) : (
                                <Badge data-fx-compact-hide="" variant="outline" className="h-5 w-fit shrink-0 whitespace-nowrap border-muted-foreground/30 px-2 py-0 text-[11px] text-muted-foreground">
                                  转发停用
                                </Badge>
                              )}
                            </div>
                            {u.trafficAutoReset && (
                              <span className="whitespace-nowrap text-center text-[11px] text-muted-foreground">
                                每月{u.trafficResetDay || 1}日重置
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden min-w-[240px] lg:table-cell">
                          {/* fx-quota-chips：精简布局下去掉每个值的小框，排成「规则 10 · 端口 20」一行（compact.css） */}
                          <div className="fx-quota-chips flex min-w-[220px] flex-wrap items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
                            <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-border/50 bg-muted/20 px-2">规则 {u.maxRules ? `${u.maxRules} 条` : "不限"}</span>
                            <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-border/50 bg-muted/20 px-2">端口 {u.maxPorts ? `${u.maxPorts} 个` : "不限"}</span>
                            <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-border/50 bg-muted/20 px-2">连接 {u.maxConnections ? `${u.maxConnections}` : "不限"}</span>
                            <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-border/50 bg-muted/20 px-2">单 IP {u.maxIPs ? `${u.maxIPs}` : "不限"}</span>
                            {(Number(u.gostRateLimitIn) > 0 || Number(u.gostRateLimitOut) > 0) && (
                              <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-border/50 bg-muted/20 px-2">转发限速 {formatForwardRateLimit(u.gostRateLimitIn, u.gostRateLimitOut)}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex justify-center">
                            {renderAccountEnabledControl(u)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1 px-2 text-xs"
                              title="流量与权限"
                              aria-label={`编辑 ${userLabel(u)} 的流量与权限`}
                              onClick={() => openTrafficSettings(u)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              编辑
                            </Button>
                            {renderUserMoreMenu(u, "h-8 gap-1 rounded-md border border-border/50 px-2 text-xs")}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </AutoAnimateContainer>
              </Table>
            </div>
          ) : userPageQuery.error ? (
            <DataSectionError
              className="border-0 bg-transparent"
              label="用户列表"
              error={userPageQuery.error}
              retrying={userPageQuery.isFetching}
              onRetry={() => { void userPageQuery.refetch(); }}
              minHeight="min-h-[260px]"
            />
          ) : (
            <EmptyState icon={<UsersIcon className="h-8 w-8 opacity-40" />} title={<>暂无其他用户</>} description={<>
                点击"添加用户"按钮创建新用户
              </>} />
          )}
        </CardContent>
      </Card>
      {!isLoading && users && users.length > 0 && (
        <PersistentPagination pagination={userPagination} itemName="个用户" />
      )}
        </TabsContent>

        <TabsContent value="subscriptions" className="space-y-4 data-[state=inactive]:hidden">
          {subscriptionsLoading ? (
            <DataSectionLoading label="正在加载订阅数据" minHeight="min-h-[240px]" />
          ) : visibleSubscriptions.length === 0 ? (
            <EmptyState icon={<Package className="h-7 w-7 opacity-40" />} title={<>暂无用户套餐</>} description={<>分配或购买套餐后会显示在这里。</>} />
          ) : (
            <>
              <AutoAnimateContainer className="standard-card-grid gap-3">
                {pagedSubscriptions.map((sub: any) => {
                  const active = isSubscriptionActive(sub);
                  const trafficLimit = Number(sub.trafficLimit || 0);
                  const purchasedAddonBytes = Number(sub.purchasedTrafficAddonBytes || 0);
                  const grantedAddonBytes = Number(sub.grantedTrafficAddonBytes || 0);
                  const canAddAddon = active && trafficLimit > 0;
                  const canChangeExpiry = sub.status !== "cancelled";
                  return (
                    <Card key={sub.id} className="border-border/40 bg-card/60">
                      <CardContent className="space-y-3 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{userLabel({ username: sub.username, name: sub.name, id: sub.userId })}</p>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{sub.planName || `套餐 #${sub.planId}`}</p>
                          </div>
                          <Badge variant={active ? "default" : "secondary"} className="shrink-0 text-[11px]">
                            {subscriptionStatusLabel(sub.status)}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">来源</p>
                            <p className="mt-1 truncate font-medium">{subscriptionSourceLabel(sub.source)}</p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">端口段</p>
                            <p className="mt-1 truncate font-medium tabular-nums">
                              {sub.portRangeStart && sub.portRangeEnd ? `${sub.portRangeStart}-${sub.portRangeEnd}` : "-"}
                            </p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">套餐额度</p>
                            <p className="mt-1 break-words font-medium">{trafficLimit > 0 ? formatBytes(trafficLimit) : "不限"}</p>
                          </div>
                          {purchasedAddonBytes > 0 && (
                            <div className="min-w-0 rounded-md bg-muted/25 p-2">
                              <p className="text-muted-foreground">已购附加流量</p>
                              <p className="mt-1 break-words font-medium">{formatBytes(purchasedAddonBytes)}</p>
                            </div>
                          )}
                          {grantedAddonBytes > 0 && (
                            <div className="min-w-0 rounded-md bg-muted/25 p-2">
                              <p className="text-muted-foreground">管理员加赠</p>
                              <p className="mt-1 break-words font-medium">{formatBytes(grantedAddonBytes)}</p>
                            </div>
                          )}
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">到期</p>
                            <p className={`mt-1 truncate font-medium ${sub.expiresAt && !active ? "text-destructive" : ""}`}>{dateText(sub.expiresAt)}</p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">流量周期</p>
                            <p className="mt-1 truncate font-medium">{billingDateTimeText(sub.nextTrafficResetAt)}</p>
                          </div>
                        </div>

                        {/* 三个按钮收成「加赠流量 + ···」，和列表页的「编辑 + ···」一致（标准布局重构工作包二） */}
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 text-xs"
                            onClick={() => openAddonDialog(sub)}
                            disabled={!canAddAddon || adminAddTrafficAddonMutation.isPending}
                          >
                            加赠流量
                          </Button>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="订阅的更多操作">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem disabled={!canChangeExpiry || extendSubscriptionMutation.isPending} onSelect={() => openExtendDialog(sub)}>
                                更改到期
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" disabled={!active || cancelSubscriptionMutation.isPending} onSelect={() => openCancelSubscriptionDialog(sub)}>
                                取消订阅
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </AutoAnimateContainer>
              <PersistentPagination pagination={subscriptionPagination} itemName="条订阅" />
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* 流量与权限设置：懒加载，第一次打开才拉这个模块；关闭动画期间 shown 还在，面板不会先塌掉 */}
      {trafficDialog.shown ? (
        <Suspense fallback={null}>
          <UserTrafficSettingsDialog
            open={trafficDialog.isOpen}
            onOpenChange={(open) => { if (!open) trafficDialog.close(); }}
            user={trafficDialog.shown}
            userName={userLabel(trafficDialog.shown)}
            patchCachedUser={patchCachedUser}
          />
        </Suspense>
      ) : null}

      {/* Create User Dialog：FormDialog —— 回车提交、填了一半关之前先问、创建中不许关 */}
      <FormDialog
        open={showCreateUser}
        onOpenChange={setShowCreateUser}
        title="添加用户"
        description="创建系统用户。"
        descriptionProps={{ "data-fx-help": "" }}
        className="sm:max-w-md"
        onSubmit={handleCreateUser}
        submitText="创建用户"
        pendingText="创建中..."
        pending={createUserMutation.isPending}
        dirty={createUserDirty}
      >
        <div className="space-y-2">
          <Label htmlFor="create-username">用户名</Label>
          <Input
            id="create-username"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="请输入用户名"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="create-password">密码</Label>
          <PasswordInput
            id="create-password"
            value={newUserPassword}
            onChange={(e) => setNewUserPassword(e.target.value)}
            placeholder="请输入密码（至少6个字符）"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="create-name">显示名称（可选）</Label>
          <Input
            id="create-name"
            value={newUserName}
            onChange={(e) => setNewUserName(e.target.value)}
            placeholder="请输入显示名称"
            maxLength={24}
          />
        </div>
        <FormField className="space-y-2">
          <Label>转发总开关</Label>
          <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
            <div className="min-w-0 pr-3">
              <p data-fx-help="" className="text-xs text-muted-foreground">关闭后不能创建或启用规则。</p>
            </div>
            <Checkbox
              checked={newCanAddRules}
              onCheckedChange={(checked) => {
                setNewCanAddRules(checked);
              }}
            />
          </div>
        </FormField>
        <FormField className="space-y-2">
          <Label>客户端订阅</Label>
          <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
            <div className="min-w-0 pr-3">
              <p data-fx-help="" className="text-xs text-muted-foreground">
                允许生成订阅地址导入客户端。与转发权限互不影响。
              </p>
            </div>
            <Checkbox
              checked={newAllowProxySubscription}
              onCheckedChange={setNewAllowProxySubscription}
            />
          </div>
        </FormField>
      </FormDialog>

      {/* Account Dialog */}
      <Dialog {...accountDialog.dialogProps}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>账户信息</DialogTitle>
          <DialogDescription>修改 "{resetUserName}" 的账号信息。</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reset-username">账号</Label>
              <Input
                id="reset-username"
                value={resetUsernameInput}
                onChange={(e) => setResetUsernameInput(e.target.value)}
                placeholder="请输入账号"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-display-name">显示名称</Label>
              <Input
                id="reset-display-name"
                value={resetDisplayNameInput}
                onChange={(e) => setResetDisplayNameInput(e.target.value)}
                placeholder="请输入显示名称"
                maxLength={24}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-password">新密码</Label>
              <PasswordInput
                id="reset-password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                placeholder="留空不修改密码"
              />
            </div>
            <div className="space-y-2">
              <Label>用户头像</Label>
              <AvatarPicker
                value={resetAvatarInput}
                onChange={setResetAvatarInput}
                fallback={resetUserId || resetUsernameInput}
                disabled={resetPasswordMutation.isPending}
                onError={(message) => toast.error(message)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={accountDialog.close}>
              取消
            </Button>
            <Button onClick={handleResetPassword} disabled={resetPasswordMutation.isPending}>
              {resetPasswordMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog {...rechargeDialog.dialogProps}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>余额充值</DialogTitle>
          <DialogDescription>给 "{rechargeUserName}" 增加余额。</DialogDescription>
          <div className="space-y-4 py-2">
            <FormField className="space-y-2">
              <Label>充值金额</Label>
              <Input
                type="number"
                min={0.01}
                step="0.01"
                value={rechargeAmount}
                onChange={(e) => setRechargeAmount(e.target.value)}
                placeholder="例如：50"
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={rechargeDialog.close}>
              取消
            </Button>
            <Button onClick={handleRecharge} disabled={adminRechargeMutation.isPending}>
              {adminRechargeMutation.isPending ? "充值中..." : "确认充值"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog {...setBalanceDialog.dialogProps}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>修改余额</DialogTitle>
          <DialogDescription>直接设置 "{setBalanceUserName}" 的当前余额。</DialogDescription>
          <div className="space-y-4 py-2">
            <FormField className="space-y-2">
              <Label>当前余额</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={setBalanceAmount}
                onChange={(e) => setSetBalanceAmount(e.target.value)}
                placeholder="例如：50"
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={setBalanceDialog.close} disabled={adminSetBalanceMutation.isPending}>
              取消
            </Button>
            <Button onClick={handleSetBalance} disabled={adminSetBalanceMutation.isPending}>
              {adminSetBalanceMutation.isPending ? "修改中..." : "确认修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog {...emailDialog.dialogProps}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>发送邮件</DialogTitle>
          <DialogDescription>发送给用户 "{emailUserName}" 的已验证邮箱：{emailTo}</DialogDescription>
          <div className="space-y-4 py-2">
            <FormField className="space-y-2">
              <Label>邮件标题</Label>
              <Input
                value={emailSubject}
                maxLength={120}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="请输入邮件标题"
              />
            </FormField>
            <div className="space-y-2">
              <Label>邮件内容</Label>
              <textarea
                value={emailContent}
                maxLength={4000}
                onChange={(e) => setEmailContent(e.target.value)}
                placeholder="请输入邮件内容"
                className="flex min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
              <p className="text-right text-xs text-muted-foreground">{emailContent.length}/4000</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={emailDialog.close}>
              取消
            </Button>
            <Button onClick={handleSendEmail} disabled={sendEmailMutation.isPending}>
              {sendEmailMutation.isPending ? "发送中..." : "发送邮件"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        窄屏上点开一个人看详情。内容就是原来那张大卡，一项没少。

        按 id 从当前列表里现取，不存整行：存整行的话，充值 / 拨开关之后列表刷新了，
        弹窗里还是旧数字 —— 而这一屏正是拿来看这些数的。
      */}
      <Dialog open={detailUser !== null} onOpenChange={(open) => !open && setDetailUserId(null)}>
        <DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-md">
          {detailUser && (
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-2">
                  <UserAvatar user={detailUser} className="h-8 w-8 shrink-0" />
                  <span className="min-w-0 truncate">{detailUser.username || "未命名"}</span>
                  <Badge variant={detailUser.role === "admin" ? "default" : "outline"} className="h-5 shrink-0 px-1.5 text-[11px]">
                    {detailUser.role === "admin" ? "管理员" : "普通用户"}
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  #{detailUser.id}{detailUser.displayRemark ? ` · ${detailUser.displayRemark}` : ""}
                </DialogDescription>
              </DialogHeader>
              {renderUserDetail(detailUser)}
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog {...addonDialog.dialogProps}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>加赠本周期流量</DialogTitle>
          <DialogDescription>
            给 "{addonUserName}" 的 {addonSubscriptionLabel || "当前套餐"} 增加仅本周期有效的流量。
          </DialogDescription>
          <div className="space-y-4 py-2">
            <FormField className="space-y-2">
              <Label>加赠流量</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={addonTrafficGB}
                  onChange={(e) => setAddonTrafficGB(e.target.value)}
                  placeholder="例如：50"
                />
                <span className="shrink-0 text-sm text-muted-foreground">GB</span>
              </div>
              <p data-fx-help="" className="text-xs text-muted-foreground">附加流量会在当前套餐流量周期结束或订阅到期时自动失效。</p>
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={addonDialog.close}>
              取消
            </Button>
            <Button onClick={handleAdminAddTrafficAddon} disabled={adminAddTrafficAddonMutation.isPending}>
              {adminAddTrafficAddonMutation.isPending ? "加赠中..." : "确认加赠"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog {...extendDialog.dialogProps}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>更改到期时间</DialogTitle>
          <DialogDescription>给 "{extendSubscriptionLabel}" 设置订阅到期时间。</DialogDescription>
          <div className="space-y-4 py-2">
            <FormField className="space-y-2">
              <Label>到期日期</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <DatePickerInput
                  value={extendExpiresAtInput}
                  onChange={setExtendExpiresAtInput}
                  placeholder="永久有效"
                />
                <Button type="button" variant="outline" className="h-8 px-3" onClick={() => setExtendExpiresAtInput("")}>
                  永久有效
                </Button>
              </div>
              <p data-fx-help="" className="text-xs text-muted-foreground">留空表示永久有效。</p>
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={extendDialog.close}>
              取消
            </Button>
            <Button onClick={handleExtendSubscription} disabled={extendSubscriptionMutation.isPending}>
              {extendSubscriptionMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserOnlineIpsDialogHost />
      <UserTrafficHistoryDialogHost />
    </div>
  );

}

export default function Users() {
  return (
    <DashboardLayout>
      <UsersContent />
    </DashboardLayout>
  );
}
