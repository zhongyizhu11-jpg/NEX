import { avatarQuotaState } from "@/lib/avatarQuota";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import OpsProfileExtraSections from "@/features/ops/slots/ProfileExtraSections";
import GoogleAccountSection from "@/features/googleLogin/GoogleAccountSection";
import DiscordAccountSection from "@/features/discordLogin/DiscordAccountSection";
import { useAuth } from "@/_core/hooks/useAuth";
import { AvatarPicker } from "@/components/AvatarPicker";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { useLayoutPreference } from "@/hooks/useCompactLayout";
import { PERSONALIZATION_LAYOUTS, type PersonalizationLayoutId } from "@shared/personalization";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import { migrateLegacyAvatarValue } from "@/lib/avatar";
import { copyTextToClipboard } from "@/lib/clipboard";
import { mobileAuth } from "@/lib/mobileAuth";
import { openMobileReleasePage } from "@/lib/mobileNotifications";
import { useMobileAppUpdateCheck } from "@/lib/mobileAppUpdateCheck";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  LayoutList,
  Link2Off,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  Shield,
  UserRound,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { authErrorMessage } from "@/lib/authErrorMessage";

const DISPLAY_NAME_MAX_LENGTH = 24;

async function copyText(text: string) {
  const copied = await copyTextToClipboard(text);
  if (copied) toast.success("已复制到剪贴板");
  else toast.error("复制失败，请长按或手动选中复制");
}

function ProfileContent() {
  const { user, logout } = useAuth();
  const utils = trpc.useUtils();
  const [avatarDraft, setAvatarDraft] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [telegramBind, setTelegramBind] = useState<any | null>(null);
  const [telegramBindTick, setTelegramBindTick] = useState(Date.now());
  const [showTelegramUnbindConfirm, setShowTelegramUnbindConfirm] = useState(false);
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ setupId: string; secret: string; otpauthUrl: string; expiresAt: Date; expiresInSeconds: number } | null>(null);
  const [twoFactorQrCode, setTwoFactorQrCode] = useState("");
  const [twoFactorSetupTick, setTwoFactorSetupTick] = useState(Date.now());
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  // 发现新版本时不弹对话框：这一页有地方常驻显示版本对比和「前往下载」，
  // 见下面的卡片。toast 只是个「查完了」的确认。
  const {
    checking: checkingMobileUpdate,
    updateInfo: mobileUpdateInfo,
    check: handleMobileUpdateCheck,
  } = useMobileAppUpdateCheck((result) => {
    toast.success(`发现 APP 新版本 v${result.latestVersion.replace(/^v/i, "")}`);
  });

  const isAdmin = user?.role === "admin";

  const { data: avatarQuota } = trpc.users.avatarQuota.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: telegramStatus } = trpc.telegram.status.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status || status.bound) return false;
      const expiresAt = status.pendingBind?.expiresAt ? new Date(status.pendingBind.expiresAt).getTime() : 0;
      return expiresAt > Date.now() ? 2000 : false;
    },
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: twoFactorStatus } = trpc.auth.twoFactorStatus.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (user) setAvatarDraft(migrateLegacyAvatarValue((user as any).avatar, `user-${user.id}`));
  }, [user?.id, (user as any)?.avatar]);

  useEffect(() => {
    if (user) setDisplayNameDraft(String(user.name || user.username || ""));
  }, [user?.id, user?.name, user?.username]);

  const updateProfileMutation = trpc.auth.updateProfile.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      toast.success("显示名称已更新");
    },
    onError: (error) => toast.error(error.message || "显示名称更新失败"),
  });

  const updateTelegramAnnouncementSubscriptionMutation = trpc.auth.updateProfile.useMutation({
    onSuccess: async (_data, variables) => {
      await Promise.all([
        utils.auth.me.invalidate(),
        utils.telegram.status.invalidate(),
      ]);
      toast.success(variables.telegramAnnouncementSubscribed ? "已开启公告 TG 推送" : "已关闭公告 TG 推送");
    },
    onError: (error) => toast.error(error.message || "公告 TG 推送设置失败"),
  });

  const layoutPreference = useLayoutPreference();

  const updateAvatarMutation = trpc.users.updateAvatar.useMutation({
    onSuccess: (data) => {
      utils.auth.me.invalidate();
      utils.users.avatarQuota.invalidate();
      toast.success(data.quota?.unlimited ? "头像已更新" : `头像已更新，今日剩余 ${data.quota?.remaining ?? 0} 次`);
    },
    onError: (error) => toast.error(error.message || "头像更新失败"),
  });

  const randomAvatarMutation = trpc.users.randomAvatar.useMutation({
    onSuccess: (data) => {
      setAvatarDraft(data.avatar);
      utils.auth.me.invalidate();
      utils.users.avatarQuota.invalidate();
      toast.success(data.quota?.unlimited ? "头像已随机更新" : `头像已随机更新，今日剩余 ${data.quota?.remaining ?? 0} 次`);
    },
    onError: (error) => toast.error(error.message || "随机头像失败"),
  });

  const changePasswordMutation = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      toast.success("密码已修改");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error) => toast.error(error.message || "密码修改失败"),
  });

  const createTelegramBindMutation = trpc.telegram.createBindCode.useMutation({
    onSuccess: (data) => {
      setTelegramBind(data);
      setTelegramBindTick(Date.now());
      utils.telegram.status.invalidate();
      toast.success("Telegram 绑定码已生成");
    },
    onError: (error) => toast.error(error.message || "生成 Telegram 绑定码失败"),
  });

  const unbindTelegramMutation = trpc.telegram.unbind.useMutation({
    onSuccess: () => {
      setTelegramBind(null);
      setShowTelegramUnbindConfirm(false);
      utils.telegram.status.invalidate();
      toast.success("Telegram 已解绑");
    },
    onError: (error) => toast.error(error.message || "解绑 Telegram 失败"),
  });

  const beginTwoFactorSetupMutation = trpc.auth.beginTwoFactorSetup.useMutation({
    onSuccess: (data) => {
      setTwoFactorSetup(data);
      setTwoFactorQrCode("");
      setTwoFactorSetupTick(Date.now());
      setTwoFactorPassword("");
      setTwoFactorCode("");
      toast.success("双重验证二维码已生成");
    },
    onError: (error) => toast.error(error.message || "生成双重验证二维码失败"),
  });

  const enableTwoFactorMutation = trpc.auth.enableTwoFactor.useMutation({
    onSuccess: () => {
      toast.success("双重验证已启用");
      setTwoFactorSetup(null);
      setTwoFactorQrCode("");
      setTwoFactorPassword("");
      setTwoFactorCode("");
      utils.auth.twoFactorStatus.invalidate();
      utils.auth.me.invalidate();
    },
    onError: (error) => toast.error(authErrorMessage(error.message, "启用双重验证失败")),
  });

  const disableTwoFactorMutation = trpc.auth.disableTwoFactor.useMutation({
    onSuccess: () => {
      toast.success("双重验证已关闭");
      setTwoFactorPassword("");
      setTwoFactorCode("");
      utils.auth.twoFactorStatus.invalidate();
      utils.auth.me.invalidate();
    },
    onError: (error) => toast.error(authErrorMessage(error.message, "关闭双重验证失败")),
  });

  useEffect(() => {
    if (!twoFactorSetup?.otpauthUrl) {
      setTwoFactorQrCode("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(twoFactorSetup.otpauthUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8,
      color: { dark: "#0f172aff", light: "#ffffffff" },
    })
      .then((url) => {
        if (!cancelled) setTwoFactorQrCode(url);
      })
      .catch(() => {
        if (!cancelled) toast.error("二维码生成失败，请使用备用密钥添加");
      });
    return () => {
      cancelled = true;
    };
  }, [twoFactorSetup?.otpauthUrl]);

  useEffect(() => {
    if (twoFactorStatus?.enabled || !twoFactorSetup) return;
    const timer = window.setInterval(() => setTwoFactorSetupTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [twoFactorSetup, twoFactorStatus?.enabled]);

  useEffect(() => {
    if (!telegramBind?.expiresAt) return;
    const timer = window.setInterval(() => setTelegramBindTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [telegramBind?.expiresAt]);

  const { remaining: avatarQuotaRemaining, unlimited: avatarQuotaUnlimited, exhausted: avatarQuotaExhausted } = avatarQuotaState(avatarQuota, user?.role === "admin");
  const avatarBusy = updateAvatarMutation.isPending || randomAvatarMutation.isPending;
  const twoFactorSetupExpiresAt = twoFactorSetup?.expiresAt ? new Date(twoFactorSetup.expiresAt).getTime() : 0;
  const twoFactorSetupRemaining = twoFactorSetupExpiresAt ? Math.max(0, Math.ceil((twoFactorSetupExpiresAt - twoFactorSetupTick) / 1000)) : 0;
  const twoFactorSetupExpired = !!twoFactorSetup && twoFactorSetupRemaining <= 0;
  const twoFactorSetupRemainingLabel = `${Math.floor(twoFactorSetupRemaining / 60)}:${String(twoFactorSetupRemaining % 60).padStart(2, "0")}`;
  const telegramBindExpiresAt = telegramBind?.expiresAt ? new Date(telegramBind.expiresAt).getTime() : 0;
  const telegramBindRemaining = telegramBindExpiresAt ? Math.max(0, Math.ceil((telegramBindExpiresAt - telegramBindTick) / 1000)) : 0;
  const telegramBindExpired = !!telegramBind && telegramBindRemaining <= 0;
  const telegramBindRemainingLabel = `${Math.floor(telegramBindRemaining / 60)}:${String(telegramBindRemaining % 60).padStart(2, "0")}`;
  const telegramBindUrl = telegramBind?.botUsername && telegramBind?.code
    ? `https://t.me/${telegramBind.botUsername}?start=${encodeURIComponent(telegramBind.code)}`
    : "";
  const telegramBotUrl = (telegramBind?.botUsername || telegramStatus?.botUsername)
    ? `https://t.me/${telegramBind?.botUsername || telegramStatus?.botUsername}`
    : "";

  useEffect(() => {
    if (telegramStatus?.bound) {
      if (telegramBind) setTelegramBind(null);
      return;
    }
    if (!telegramBind && telegramStatus?.pendingBind?.code) {
      setTelegramBind(telegramStatus.pendingBind);
      setTelegramBindTick(Date.now());
    }
  }, [telegramBind, telegramStatus?.bound, telegramStatus?.pendingBind]);

  const handleSaveAvatar = () => {
    if (!avatarDraft) {
      toast.error("请选择头像");
      return;
    }
    if (avatarQuotaExhausted) {
      toast.error("今日头像修改次数已用完");
      return;
    }
    updateAvatarMutation.mutate({ avatar: avatarDraft });
  };

  const handleSaveDisplayName = () => {
    const nextName = displayNameDraft.trim();
    if (!nextName) {
      toast.error("显示名称不能为空");
      return;
    }
    if (nextName.length > DISPLAY_NAME_MAX_LENGTH) {
      toast.error(`显示名称最多 ${DISPLAY_NAME_MAX_LENGTH} 个字符`);
      return;
    }
    if (nextName === String(user?.name || user?.username || "")) {
      toast.info("显示名称没有变化");
      return;
    }
    updateProfileMutation.mutate({ name: nextName });
  };

  const handleChangePassword = () => {
    if (!oldPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("新密码至少6个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    changePasswordMutation.mutate({ oldPassword, newPassword });
  };

  const handleEnableTwoFactor = () => {
    if (!twoFactorSetup) {
      beginTwoFactorSetupMutation.mutate();
      return;
    }
    if (twoFactorSetupExpired) {
      toast.error("二维码已过期，请重新生成");
      return;
    }
    if (!twoFactorPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (twoFactorCode.length < 6) {
      toast.error("请输入 6 位动态验证码");
      return;
    }
    enableTwoFactorMutation.mutate({
      setupId: twoFactorSetup.setupId,
      password: twoFactorPassword,
      code: twoFactorCode,
    });
  };

  const handleDisableTwoFactor = () => {
    if (!twoFactorPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (twoFactorCode.length < 6) {
      toast.error("请输入 6 位动态验证码");
      return;
    }
    disableTwoFactorMutation.mutate({ password: twoFactorPassword, code: twoFactorCode });
  };

  const handleTelegramBind = () => {
    if (telegramStatus?.configured === false) {
      toast.error("Telegram 机器人尚未配置");
      return;
    }
    createTelegramBindMutation.mutate();
  };

  const handleTelegramAnnouncementSubscribedChange = (enabled: boolean) => (
    updateTelegramAnnouncementSubscriptionMutation.mutateAsync({ telegramAnnouncementSubscribed: enabled })
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <WorkspaceHeader title={<>个人资料</>} description={<>管理账号安全、头像和 Telegram。</>} />
        <Badge variant="outline" className="w-fit gap-1.5 px-3 py-1.5">
          <UserRound className="h-3.5 w-3.5" />
          {isAdmin ? "管理员" : "用户"}
        </Badge>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRound className="h-4 w-4 text-primary" />
                头像与账号
              </CardTitle>
              <CardDescription>低于 50K 的头像会直接上传，较大的图片会自动压缩。</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              账号、显示名称、今日还能改几次头像，原来挤在一个灰框里排成三列，下面头像选择又是
              一个框。账号和名字写成设置行；「今日剩余」说的是头像，挪到头像那一块下面。
            */}
            <SettingList>
              <SettingRow keepDescription label="账号" description={<span className="break-all">{user?.username || "-"}</span>} />
              <SettingRow label="显示名称">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="profile-display-name"
                    aria-label="显示名称"
                    value={displayNameDraft}
                    onChange={(e) => setDisplayNameDraft(e.target.value)}
                    maxLength={DISPLAY_NAME_MAX_LENGTH}
                    placeholder={user?.username || "请输入显示名称"}
                    className="h-9 min-w-0"
                  />
                  <Button
                    type="button"
                    className="h-9 shrink-0"
                    onClick={handleSaveDisplayName}
                    disabled={updateProfileMutation.isPending}
                  >
                    {updateProfileMutation.isPending ? "保存中..." : "保存"}
                  </Button>
                </div>
              </SettingRow>
            </SettingList>
            <div className="border-t border-[var(--fx-stroke-weak)] pt-4">
              <AvatarPicker
                value={avatarDraft}
                onChange={setAvatarDraft}
                fallback={user?.id || user?.username}
                disabled={avatarBusy || avatarQuotaExhausted}
                randomDisabled={avatarQuotaExhausted}
                randomLoading={randomAvatarMutation.isPending}
                onRandom={() => randomAvatarMutation.mutate()}
                onError={(message) => toast.error(message)}
                controlsClassName="items-center"
                previewClassName="h-16 w-16"
                gridClassName="grid-cols-5 sm:grid-cols-6 2xl:grid-cols-8"
                actions={(
                  <Button
                    type="button"
                    size="sm"
                    className="gap-2"
                    onClick={handleSaveAvatar}
                    disabled={avatarBusy || avatarQuotaExhausted}
                  >
                    {updateAvatarMutation.isPending ? "保存中..." : "保存头像"}
                  </Button>
                )}
              />
            </div>
            {!avatarQuotaUnlimited ? (
              <div className={cn("text-meta", avatarQuotaExhausted ? "text-[var(--fx-warn-text)]" : "text-muted-foreground")}>
                {avatarQuotaExhausted
                  ? "今日头像修改次数已用完，明天可继续修改。"
                  : `今天还能改 ${avatarQuotaRemaining} / ${avatarQuota?.limit ?? 3} 次头像。`}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LayoutList className="h-4 w-4 text-primary" />
              界面
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              {/*
                布局密度：跟随站点（管理员在设置 › 个性化 › 布局 定的）/ 标准 / 精简。只改这个账号看到的界面。
                画法见 client/src/styles/compact.css。
              */}
              <SettingRow
                label="布局"
                description={`精简：控件和卡片更矮、说明文字收起来、侧栏更窄，一屏多看一截；功能和数据一样。跟随站点现在是「${PERSONALIZATION_LAYOUTS.find((item) => item.id === layoutPreference.siteLayout)?.name ?? "标准"}」。`}
                control={(
                  <div className={cn(segmentedControlClassName, "grid grid-cols-3 gap-1")} role="radiogroup" aria-label="布局">
                    {([{ id: null, name: "跟随站点" }, ...PERSONALIZATION_LAYOUTS] as Array<{ id: PersonalizationLayoutId | null; name: string }>).map((option) => {
                      const active = layoutPreference.preference === option.id;
                      return (
                        <button
                          key={option.id ?? "site"}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={layoutPreference.saving}
                          onClick={() => { if (!active) void layoutPreference.setPreference(option.id); }}
                          className={segmentedOptionClassName(active, layoutPreference.saving, "px-2.5")}
                        >
                          {option.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              />
            </SettingList>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" />
              登录密码
            </CardTitle>
            <CardDescription>修改当前账号的登录密码。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="profile-old-password">当前密码</Label>
              <PasswordInput id="profile-old-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} placeholder="请输入当前密码" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-new-password">新密码</Label>
              <PasswordInput id="profile-new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 6 个字符" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-confirm-password">确认新密码</Label>
              <PasswordInput id="profile-confirm-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再次输入新密码" />
            </div>
            <Button className="w-full" onClick={handleChangePassword} disabled={changePasswordMutation.isPending}>
              {changePasswordMutation.isPending ? "修改中..." : "修改密码"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/50 bg-card/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="h-4 w-4 text-primary" />
                Telegram 绑定
              </CardTitle>
              <CardDescription>绑定后可接收提醒，并支持 Telegram 登录。</CardDescription>
            </div>
            <Badge variant={telegramStatus?.bound ? "default" : "outline"} className="w-fit">
              {telegramStatus?.bound ? "已绑定" : "未绑定"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow
                label="公告 Telegram 推送"
                description={telegramStatus?.bound
                  ? "默认关闭。开启后，新公告仅在管理员选择 TG 推送时发送到已绑定的 Telegram。"
                  : "绑定 Telegram 后才能开启。开启后，新公告仅在管理员选择 TG 推送时发送过来。"}
                control={(
                  <OptimisticSwitch aria-label="公告 Telegram 推送"
                    checked={!!telegramStatus?.announcementSubscribed}
                    disabled={!telegramStatus?.bound}
                    onCheckedChangeAsync={handleTelegramAnnouncementSubscribedChange}
                  />
                )}
              />
            </SettingList>
            {telegramStatus?.bound ? (
              <SettingList>
                <SettingRow keepDescription
                  label="Telegram"
                  description={telegramStatus.account?.linkedAt ? `${new Date(telegramStatus.account.linkedAt).toLocaleString()} 绑定` : undefined}
                  control={(
                    <span className="truncate text-secondary-type font-medium">
                      {telegramStatus.account?.username ? `@${telegramStatus.account.username}` : telegramStatus.account?.id || "-"}
                    </span>
                  )}
                />
                {/* 解绑是破坏性的，但它就是这一块唯一的操作：放在这一行右边，描边红字，不用实心红块。 */}
                <SettingRow
                  label="解绑"
                  description="解绑后收不到提醒，也不能用 Telegram 登录。"
                  control={(
                    <Button variant="outline" size="sm" className="gap-2 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setShowTelegramUnbindConfirm(true)} disabled={unbindTelegramMutation.isPending}>
                      <Link2Off className="h-4 w-4" />
                      {unbindTelegramMutation.isPending ? "解绑中..." : "解绑 Telegram"}
                    </Button>
                  )}
                />
              </SettingList>
            ) : telegramStatus?.configured === false ? (
              <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>管理员尚未配置 Telegram 机器人。</span>
              </div>
            ) : telegramBind ? (
              <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_180px]">
                <div className="space-y-3">
                  {telegramBotUrl && (
                    <Button variant="outline" asChild className="w-full justify-center gap-2 sm:w-auto">
                      <a href={telegramBotUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        打开 Telegram 机器人
                      </a>
                    </Button>
                  )}
                  <div className="flex flex-col gap-2 rounded-lg border border-border/40 bg-muted/20 p-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className={`min-w-0 break-all font-mono text-base font-semibold tracking-widest ${telegramBindExpired ? "text-muted-foreground line-through" : ""}`}>
                          {telegramBind.code}
                        </code>
                        <Badge variant={telegramBindExpired ? "destructive" : "outline"} className="shrink-0">
                          {telegramBindExpired ? "已过期" : `${telegramBindRemainingLabel} 后过期`}
                        </Badge>
                      </div>
                      {/* 「已过期」是状态，精简布局下也要看到；「5 分钟内有效」那句才是说明 */}
                      <p data-fx-help={telegramBindExpired ? undefined : ""} className="mt-2 text-xs text-muted-foreground">
                        {telegramBindExpired ? "绑定码已过期，请重新生成。" : "5 分钟内有效，可复制备用，也可以直接打开 Telegram 完成绑定。"}
                      </p>
                    </div>
                    <Button variant="outline" size="icon" onClick={() => copyText(telegramBind.code)} title="复制绑定码" disabled={telegramBindExpired}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  {telegramBindUrl && !telegramBindExpired && (
                    <Button asChild className="w-full gap-2 sm:w-auto">
                      <a href={telegramBindUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        打开 Telegram 完成绑定
                      </a>
                    </Button>
                  )}
                </div>
                <Button variant="outline" className="w-full self-end" onClick={handleTelegramBind} disabled={createTelegramBindMutation.isPending}>
                  {createTelegramBindMutation.isPending ? "生成中..." : telegramBindExpired ? "重新生成绑定码" : "重新生成"}
                </Button>
              </div>
            ) : (
              <Button className="w-full gap-2 sm:w-auto" onClick={handleTelegramBind} disabled={createTelegramBindMutation.isPending}>
                <Send className="h-4 w-4" />
                {createTelegramBindMutation.isPending ? "生成中..." : "生成绑定码"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="h-4 w-4 text-primary" />
                双因素认证 (2FA)
              </CardTitle>
              <CardDescription>使用 2FA 软件生成动态验证码。</CardDescription>
            </div>
            <Badge variant={twoFactorStatus?.enabled ? "default" : "outline"} className="w-fit">
              {twoFactorStatus?.enabled ? "已启用" : "未启用"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {!twoFactorStatus?.globalEnabled ? (
              <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>管理员尚未启用双重验证功能。</span>
              </div>
            ) : twoFactorStatus?.enabled ? (
              <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--fx-healthy)_25%,transparent)] bg-[var(--fx-healthy-soft)] p-3 text-sm text-[var(--fx-healthy-text)]">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>当前账号已启用双因素认证。</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-disable-password">当前密码</Label>
                      <PasswordInput id="profile-2fa-disable-password" value={twoFactorPassword} onChange={(e) => setTwoFactorPassword(e.target.value)} placeholder="请输入当前密码" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-disable-code">动态验证码</Label>
                      <Input id="profile-2fa-disable-code" inputMode="numeric" maxLength={6} value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" />
                    </div>
                  </div>
                </div>
                <div className="flex items-end">
                  <Button variant="destructive" className="w-full" onClick={handleDisableTwoFactor} disabled={disableTwoFactorMutation.isPending}>
                    {disableTwoFactorMutation.isPending ? "关闭中..." : "关闭双重验证"}
                  </Button>
                </div>
              </div>
            ) : !twoFactorSetup ? (
              <Button className="w-full sm:w-auto" onClick={() => beginTwoFactorSetupMutation.mutate()} disabled={beginTwoFactorSetupMutation.isPending}>
                {beginTwoFactorSetupMutation.isPending ? "生成中..." : "生成绑定二维码"}
              </Button>
            ) : (
              <div className="grid gap-4 2xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex flex-col items-center gap-3">
                  <div className={`flex h-48 w-48 items-center justify-center rounded-lg border bg-white p-3 ${twoFactorSetupExpired ? "opacity-45" : ""}`}>
                    {twoFactorQrCode ? (
                      <img src={twoFactorQrCode} alt="2FA 绑定二维码" className="h-full w-full" />
                    ) : (
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <div className={`text-xs ${twoFactorSetupExpired ? "text-destructive" : "text-muted-foreground"}`}>
                    {twoFactorSetupExpired ? "二维码已过期" : `剩余 ${twoFactorSetupRemainingLabel}`}
                  </div>
                </div>
                <div className="space-y-3">
                  {twoFactorSetup.otpauthUrl && (
                    <Button variant="outline" asChild className="w-full gap-2">
                      <a href={twoFactorSetup.otpauthUrl}>
                        <ExternalLink className="h-4 w-4" />
                        打开 2FA 软件添加
                      </a>
                    </Button>
                  )}
                  <div className="space-y-2">
                    <Label>备用密钥</Label>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 font-mono text-sm">
                        {twoFactorSetup.secret}
                      </code>
                      <Button variant="outline" size="icon" onClick={() => copyText(twoFactorSetup.secret)} disabled={twoFactorSetupExpired} title="复制备用密钥">
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-enable-password">当前密码</Label>
                      <PasswordInput id="profile-2fa-enable-password" value={twoFactorPassword} onChange={(e) => setTwoFactorPassword(e.target.value)} placeholder="请输入当前密码" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-enable-code">动态验证码</Label>
                      <Input id="profile-2fa-enable-code" inputMode="numeric" maxLength={6} value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    {twoFactorSetupExpired && (
                      <Button variant="outline" onClick={() => beginTwoFactorSetupMutation.mutate()} disabled={beginTwoFactorSetupMutation.isPending}>
                        {beginTwoFactorSetupMutation.isPending ? "生成中..." : "重新生成二维码"}
                      </Button>
                    )}
                    <Button onClick={handleEnableTwoFactor} disabled={enableTwoFactorMutation.isPending || twoFactorSetupExpired}>
                      {enableTwoFactorMutation.isPending ? "启用中..." : "启用双重验证"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {mobileAuth.isNative && (
        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-primary" />
              软件更新
            </CardTitle>
            <CardDescription>检查当前 APP 是否有新版本。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {mobileUpdateInfo && (
              <SettingList>
                <SettingRow label="当前版本" control={<span className="font-mono text-secondary-type">{mobileUpdateInfo.currentVersion ? `v${mobileUpdateInfo.currentVersion.replace(/^v/i, "")}` : "-"}</span>} />
                <SettingRow label="最新版本" control={<span className="font-mono text-secondary-type">{mobileUpdateInfo.latestVersion ? `v${mobileUpdateInfo.latestVersion.replace(/^v/i, "")}` : "-"}</span>} />
              </SettingList>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {mobileUpdateInfo?.hasUpdate && (
                <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={() => openMobileReleasePage(mobileUpdateInfo.releaseUrl)}>
                  <ExternalLink className="h-4 w-4" />
                  前往下载
                </Button>
              )}
              <Button className="w-full gap-2 sm:w-auto" onClick={handleMobileUpdateCheck} disabled={checkingMobileUpdate}>
                {checkingMobileUpdate ? <RefreshCw className="forwardx-icon-spin h-4 w-4" /> : <Download className="h-4 w-4" />}
                {checkingMobileUpdate ? "检查中..." : "检查 APP 更新"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <GoogleAccountSection />

      <DiscordAccountSection />

      <OpsProfileExtraSections />

      {/* 精简布局：右上角账户菜单里就有退出登录，这张卡不再占一行 */}
      <div className="grid gap-4 lg:grid-cols-2" data-fx-compact-hide="">
        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LogOut className="h-4 w-4 text-primary" />
              退出登录
            </CardTitle>
            <CardDescription>结束当前浏览器或 APP 的登录会话。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="w-full gap-2 border-[color-mix(in_srgb,var(--fx-down)_35%,transparent)] text-[var(--fx-down-text,var(--fx-down))] hover:bg-[var(--fx-down-soft)] hover:text-[var(--fx-down-text,var(--fx-down))] sm:w-auto" onClick={logout}>
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showTelegramUnbindConfirm} onOpenChange={setShowTelegramUnbindConfirm}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            解绑 Telegram
          </DialogTitle>
          <DialogDescription>
            解绑后将无法继续通过 Telegram 接收提醒或登录。确认要解绑当前 Telegram 账号吗？
          </DialogDescription>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowTelegramUnbindConfirm(false)}
              disabled={unbindTelegramMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              className="gap-2"
              onClick={() => unbindTelegramMutation.mutate()}
              disabled={unbindTelegramMutation.isPending}
            >
              <Link2Off className="h-4 w-4" />
              {unbindTelegramMutation.isPending ? "解绑中..." : "确认解绑"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Profile() {
  return (
    <DashboardLayout>
      <ProfileContent />
    </DashboardLayout>
  );
}
