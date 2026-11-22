/* 从 client/src/pages/Settings.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { AUTH_CAPTCHA_MODE_LABELS, AUTH_CAPTCHA_MODES, normalizeAuthCaptchaMode, type AuthCaptchaMode } from "@shared/authCaptchaMode";
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { FormField } from "@/components/ui/form-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingList, SettingRow } from "@/components/SettingRow";
import { SegmentedControl } from "@/components/ui/segmented-control";
import DataSectionLoading from "@/components/DataSectionLoading";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import { getPanelUpgradeProgress, PANEL_UPGRADE_REFRESH_DELAY_SECONDS } from "@/lib/panelUpgrade";
import { FORWARD_PROTOCOL_LABELS, FORWARD_TYPES, TUNNEL_PROTOCOLS, normalizeForwardProtocolSettings, type ForwardProtocolSettings } from "@shared/forwardTypes";
import { SIDEBAR_MENU_KEYS, SIDEBAR_MENU_LABELS, normalizeSidebarMenuSettings, type SidebarMenuKey, type SidebarMenuSettings } from "@shared/sidebarMenu";
import { buildPanelInstallerCommand, normalizeGithubAcceleratorUrl, panelUpdateGithubAccelerator } from "@shared/githubAccelerator";
import { Copy, CheckCircle2, Settings2, Download, Github, Send, Globe, ShieldCheck, Shield, Route, ExternalLink, RefreshCw, Rocket, AlertTriangle, Cloud, UserPlus, Wifi, Lock, MoveRight, Loader2, Monitor, PanelLeft } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import GoogleLoginSettingsCard from "@/components/settings/GoogleLoginSettingsCard";
import DiscordSettingsCard from "@/components/settings/DiscordSettingsCard";
import DnspodRecordsCard from "@/components/settings/DnspodRecordsCard";
import OidcLoginSettingsCard from "@/components/settings/OidcLoginSettingsCard";
import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { toast } from "sonner";
import { DEFAULT_RULE_SWITCH_BRIDGE_HOURS, MAX_RULE_SWITCH_BRIDGE_HOURS, normalizeRuleSwitchBridgeHours } from "@shared/ruleEntryBridge";
import { DOCS_BASE_URL } from "@/lib/docsLinks";

// No GitHub mirror ships with this build, so acceleration stays off until an
// administrator supplies one.
const defaultGithubAcceleratorUrl = "";

const githubAcceleratorUrlPlaceholder = "https://mirror.example.com";

type DdnsProvider = "disabled" | "cloudflare" | "webhook" | "huaweicloud" | "aliyun" | "tencentcloud";

const ddnsProviders: DdnsProvider[] = ["disabled", "cloudflare", "webhook", "huaweicloud", "aliyun", "tencentcloud"];

const docsBaseUrl = DOCS_BASE_URL;

const ddnsProviderGuideAnchors: Record<DdnsProvider, string> = {
  disabled: "quick-setup",
  cloudflare: "cloudflare",
  webhook: "webhook",
  huaweicloud: "huaweicloud",
  aliyun: "aliyun",
  tencentcloud: "tencentcloud",
};


function normalizeConfigUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}


function isDdnsProvider(value: unknown): value is DdnsProvider {
  return ddnsProviders.includes(value as DdnsProvider);
}


function ddnsProviderGuideUrl(provider: DdnsProvider) {
  return `${docsBaseUrl}/guide/ddns#${ddnsProviderGuideAnchors[provider] || "quick-setup"}`;
}


function panelVersionCommand(command: string, targetVersion: string) {
  const target = String(targetVersion || "").trim().replace(/^v/i, "");
  if (!target) return command;
  const env = `FORWARDX_TARGET_VERSION=${target}`;
  return command
    .replace(/\|\s*sudo\s+bash\s+-s\s+--\s+upgrade/g, `| sudo env ${env} bash -s -- upgrade`)
    .replace(/\|\s*bash\s+-s\s+--\s+upgrade/g, `| env ${env} bash -s -- upgrade`)
    .replace(/^\/bin\/bash\s+/i, `${env} /bin/bash `);
}


const directForwardProtocolKeys = [...FORWARD_TYPES] as const;

const tunnelForwardProtocolKeys = [...TUNNEL_PROTOCOLS];


/** 「已开启 5 / 6」：设置行右边那个数。开了几个是重点，所以只有前一个数加粗。 */
function EnabledCount({ enabled, total }: { enabled: number; total: number }) {
  return (
    <span className="text-secondary-type tabular-nums text-muted-foreground">
      已开启 <span className="font-semibold text-foreground">{enabled}</span> / {total}
    </span>
  );
}

type SystemSettingsSaveKey =
  | "networkTest"
  | "linkWizard"
  | "panelUrl"
  | "registration"
  | "twoFactor"
  | "sessionPolicy"
  | "updateAutoCheck"
  | "ddns"
  | "hostMonitor"
  | "forwardProtocols"
  | "sidebarMenu"
  | "agentInstall"
  | "agentAuth"
  | "entryBridge"
  | "portAccessLimits";


function isValidWebPort(value: string | number) {
  const port = Math.floor(Number(value));
  return Number.isFinite(port) && port >= 1 && port <= 65535;
}


function normalizeTtl(value: string, fallback: number) {
  const ttl = Math.floor(Number(value));
  if (!Number.isFinite(ttl)) return fallback;
  return Math.min(86400, Math.max(60, ttl));
}


function normalizePublicHostMonitorPathInput(value: string) {
  return String(value || "dev")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}


export default function SystemInfoSection() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const settingsData = settings;
  // 和侧栏是同一个查询（同 key 共享缓存）。升级进行中要熬过面板重启和手机锁屏，见 DashboardLayout 里那段说明。
  const { data: upgradeStatus, refetch: refetchUpgradeStatus, isError: upgradeStatusUnreachable } = trpc.system.upgradeStatus.useQuery(
    undefined,
    {
      // 只有升级在跑时才快刷（2 秒）；平时一分钟看一眼就够了 —— 发起升级 / 回退 / 检查更新之后都会立刻主动拉一次。
      refetchInterval: (query) => ((query.state.data as any)?.job?.status === "running" ? 2000 : 60_000),
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: (query) => (query.state.data as any)?.job?.status === "running",
    }
  );
  const [upgradeClock, setUpgradeClock] = useState(() => Date.now());
  const [panelUrlInput, setPanelUrlInput] = useState("");
  const [webPortInput, setWebPortInput] = useState("");
  const [panelSslEnabled, setPanelSslEnabled] = useState(false);
  const [panelSslMode, setPanelSslMode] = useState<"path" | "pem">("path");
  const [panelSslCertPath, setPanelSslCertPath] = useState("");
  const [panelSslKeyPath, setPanelSslKeyPath] = useState("");
  const [panelSslCertPem, setPanelSslCertPem] = useState("");
  const [panelSslKeyPem, setPanelSslKeyPem] = useState("");
  // 私钥不再随设置返回：服务端只说存没存，私钥框留空保存 = 沿用已保存的。
  const [panelSslKeyPemSaved, setPanelSslKeyPemSaved] = useState(false);
  const [showWebPortConfirm, setShowWebPortConfirm] = useState(false);
  const [webPortCountdown, setWebPortCountdown] = useState(5);
  const [showPanelSslConfirm, setShowPanelSslConfirm] = useState(false);
  const [panelSslCountdown, setPanelSslCountdown] = useState(5);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [authCaptchaEnabled, setAuthCaptchaEnabled] = useState(true);
  const [authCaptchaMode, setAuthCaptchaMode] = useState<AuthCaptchaMode>("click");
  const [telegramLoginEnabled, setTelegramLoginEnabled] = useState(true);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(true);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [lookingGlassUserEnabled, setLookingGlassUserEnabled] = useState(true);
  const [forwardProtocols, setForwardProtocols] = useState<ForwardProtocolSettings>(() => normalizeForwardProtocolSettings());
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuSettings>(() => normalizeSidebarMenuSettings());
  const [githubAcceleratorEnabled, setGithubAcceleratorEnabled] = useState(false);
  const [githubAcceleratorPanelUpdateEnabled, setGithubAcceleratorPanelUpdateEnabled] = useState(false);
  const [githubAcceleratorUrlInput, setGithubAcceleratorUrlInput] = useState(defaultGithubAcceleratorUrl);
  const [agentPreferPanelInstall, setAgentPreferPanelInstall] = useState(false);
  const [agentLegacyAuthRejected, setAgentLegacyAuthRejected] = useState(false);
  const [ruleSwitchBridgeHours, setRuleSwitchBridgeHours] = useState(String(DEFAULT_RULE_SWITCH_BRIDGE_HOURS));
  const [portAccessLimitsEnabled, setPortAccessLimitsEnabled] = useState(false);
  const [linkWizardEnabled, setLinkWizardEnabled] = useState(false);
  const [ddnsEnabled, setDdnsEnabled] = useState(false);
  const [ddnsProvider, setDdnsProvider] = useState<DdnsProvider>("disabled");
  const [ddnsTtl, setDdnsTtl] = useState("60");
  const [ddnsCloudflareApiToken, setDdnsCloudflareApiToken] = useState("");
  const [ddnsHuaweiCloudAccessKeyId, setDdnsHuaweiCloudAccessKeyId] = useState("");
  const [ddnsHuaweiCloudSecretKey, setDdnsHuaweiCloudSecretKey] = useState("");
  const [ddnsHuaweiCloudRegion, setDdnsHuaweiCloudRegion] = useState("cn-north-4");
  const [ddnsHuaweiCloudEndpoint, setDdnsHuaweiCloudEndpoint] = useState("");
  const [ddnsHuaweiCloudZoneId, setDdnsHuaweiCloudZoneId] = useState("");
  const [ddnsHuaweiCloudLine, setDdnsHuaweiCloudLine] = useState("default_view");
  const [ddnsAliyunAccessKeyId, setDdnsAliyunAccessKeyId] = useState("");
  const [ddnsAliyunAccessKeySecret, setDdnsAliyunAccessKeySecret] = useState("");
  const [ddnsAliyunDomainName, setDdnsAliyunDomainName] = useState("");
  const [ddnsAliyunEndpoint, setDdnsAliyunEndpoint] = useState("https://alidns.aliyuncs.com");
  const [ddnsAliyunLine, setDdnsAliyunLine] = useState("default");
  const [ddnsTencentCloudSecretId, setDdnsTencentCloudSecretId] = useState("");
  const [ddnsTencentCloudSecretKey, setDdnsTencentCloudSecretKey] = useState("");
  const [ddnsTencentCloudDomainName, setDdnsTencentCloudDomainName] = useState("");
  const [ddnsTencentCloudRecordLine, setDdnsTencentCloudRecordLine] = useState("默认");
  const [ddnsTencentCloudRecordLineId, setDdnsTencentCloudRecordLineId] = useState("");
  const [ddnsWebhookUrl, setDdnsWebhookUrl] = useState("");
  const [ddnsWebhookMethod, setDdnsWebhookMethod] = useState<"POST" | "PUT" | "GET">("POST");
  const [ddnsWebhookHeaders, setDdnsWebhookHeaders] = useState("");
  // 请求头只回打码后的样子：框里留空 = 保持原值，要删得点「清除」。
  const [ddnsWebhookHeadersClear, setDdnsWebhookHeadersClear] = useState(false);
  const [ruleEntryDomainSuffix, setRuleEntryDomainSuffix] = useState("");
  const [publicHostMonitorEnabled, setPublicHostMonitorEnabled] = useState(false);
  const [publicHostMonitorPath, setPublicHostMonitorPath] = useState("dev");
  const [publicHostMonitorTitle, setPublicHostMonitorTitle] = useState("");
  const [allowMultiDeviceLogin, setAllowMultiDeviceLogin] = useState(false);
  const [loginNewDeviceNotify, setLoginNewDeviceNotify] = useState(true);
  const [updateAutoCheckEnabled, setUpdateAutoCheckEnabled] = useState(true);
  const [showForwardProtocolDialog, setShowForwardProtocolDialog] = useState(false);
  const [showSidebarMenuDialog, setShowSidebarMenuDialog] = useState(false);
  const [savingSetting, setSavingSetting] = useState<SystemSettingsSaveKey | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showRollbackDialog, setShowRollbackDialog] = useState(false);
  const [rollbackType, setRollbackType] = useState<"panel" | "agent">("panel");
  const [selectedRollbackVersion, setSelectedRollbackVersion] = useState("");
  const [showDockerUpgradeScript, setShowDockerUpgradeScript] = useState(false);
  const previousUpgradeStatus = useRef<string | null>(null);
  const shownDockerUpgradeVersion = useRef<string | null>(null);
  const lastPanelUpdateCheck = useRef(0);
  const rollbackVersionsQuery = trpc.system.rollbackVersions.useQuery(
    { force: false },
    { enabled: showRollbackDialog, refetchOnWindowFocus: false, retry: false }
  );

  /*
    把表单填回服务端存的值：首次拿到设置、存完之后设置刷新、玫瑰主题下贴底栏点「放弃」都走这里。
  */
  const loadFromSettings = useCallback((settings: NonNullable<typeof settingsData>) => {
    {
      setPanelUrlInput(settings.panelPublicUrl || "");
      setWebPortInput(String(settings.webPort || 3000));
      setPanelSslEnabled(!!settings.panelSsl?.enabled);
      setPanelSslMode(settings.panelSsl?.mode === "pem" ? "pem" : "path");
      setPanelSslCertPath(settings.panelSsl?.certPath || "");
      setPanelSslKeyPath(settings.panelSsl?.keyPath || "");
      setPanelSslCertPem(settings.panelSsl?.certPem || "");
      setPanelSslKeyPem(settings.panelSsl?.keyPem || "");
      setPanelSslKeyPemSaved(!!settings.panelSsl?.keyPemConfigured);
      setRegistrationEnabled(settings.registrationEnabled ?? true);
      setAuthCaptchaEnabled(settings.authCaptchaEnabled ?? true);
      setAuthCaptchaMode(normalizeAuthCaptchaMode(settings.authCaptchaMode));
      setTelegramLoginEnabled(settings.telegramLoginEnabled !== false);
      setPasswordResetEnabled(settings.passwordResetEnabled ?? true);
      setTwoFactorEnabled(!!settings.twoFactorEnabled);
      setLookingGlassUserEnabled(settings.lookingGlassUserEnabled ?? true);
      setAllowMultiDeviceLogin(!!settings.allowMultiDeviceLogin);
      setLoginNewDeviceNotify(settings.loginNewDeviceNotify !== false);
      setUpdateAutoCheckEnabled(settings.upgrade?.autoCheckEnabled !== false);
      setForwardProtocols(normalizeForwardProtocolSettings(settings.forwardProtocols));
      setSidebarMenu(normalizeSidebarMenuSettings({
        ...settings.sidebarMenu,
        plugins: settings.pluginsEnabled === true || settings.sidebarMenu?.plugins === true,
      }));
      setGithubAcceleratorEnabled(!!settings.githubAccelerator?.enabled);
      setGithubAcceleratorPanelUpdateEnabled(!!settings.githubAccelerator?.panelUpdateEnabled);
      setGithubAcceleratorUrlInput(settings.githubAccelerator?.url || "");
      setAgentPreferPanelInstall(!!settings.agentPreferPanelInstall);
      setAgentLegacyAuthRejected(!!(settings as any).agentLegacyAuthRejected);
      setRuleSwitchBridgeHours(String(normalizeRuleSwitchBridgeHours((settings as any).ruleSwitchBridgeHours)));
      setPortAccessLimitsEnabled(!!(settings as any).portAccessLimitsEnabled);
      setLinkWizardEnabled(!!(settings as any).linkWizardEnabled);
      setDdnsEnabled(!!settings.ddns?.enabled);
      setDdnsProvider(isDdnsProvider(settings.ddns?.provider) ? settings.ddns.provider : "disabled");
      const ddnsUnifiedTtl = String(settings.ddns?.ttl || settings.ddns?.huaweicloudTtl || settings.ddns?.aliyunTtl || settings.ddns?.tencentcloudTtl || 60);
      setDdnsTtl(ddnsUnifiedTtl);
      setDdnsHuaweiCloudAccessKeyId(settings.ddns?.huaweicloudAccessKeyId || "");
      setDdnsHuaweiCloudRegion(settings.ddns?.huaweicloudRegion || "cn-north-4");
      setDdnsHuaweiCloudEndpoint(settings.ddns?.huaweicloudEndpoint || "");
      setDdnsHuaweiCloudZoneId(settings.ddns?.huaweicloudZoneId || "");
      setDdnsHuaweiCloudLine(settings.ddns?.huaweicloudLine || "default_view");
      setDdnsAliyunAccessKeyId(settings.ddns?.aliyunAccessKeyId || "");
      setDdnsAliyunDomainName(settings.ddns?.aliyunDomainName || "");
      setDdnsAliyunEndpoint(settings.ddns?.aliyunEndpoint || "https://alidns.aliyuncs.com");
      setDdnsAliyunLine(settings.ddns?.aliyunLine || "default");
      setDdnsTencentCloudSecretId(settings.ddns?.tencentcloudSecretId || "");
      setDdnsTencentCloudDomainName(settings.ddns?.tencentcloudDomainName || "");
      setDdnsTencentCloudRecordLine(settings.ddns?.tencentcloudRecordLine || "默认");
      setDdnsTencentCloudRecordLineId(settings.ddns?.tencentcloudRecordLineId || "");
      setDdnsWebhookUrl(settings.ddns?.webhookUrl || "");
      setDdnsWebhookMethod((settings.ddns?.webhookMethod === "PUT" || settings.ddns?.webhookMethod === "GET") ? settings.ddns.webhookMethod : "POST");
      setDdnsWebhookHeaders(settings.ddns?.webhookHeaders || "");
      setDdnsWebhookHeadersClear(false);
      setRuleEntryDomainSuffix(settings.ddns?.ruleEntryDomainSuffix || "");
      if (settings.publicHostMonitor) {
        setPublicHostMonitorEnabled(!!settings.publicHostMonitor.enabled);
        setPublicHostMonitorPath(settings.publicHostMonitor.path || "dev");
        setPublicHostMonitorTitle(settings.publicHostMonitor.title || "");
      }
    }
  }, []);

  useEffect(() => {
    if (settings) loadFromSettings(settings);
  }, [settings, loadFromSettings]);

  useEffect(() => {
    if (!showWebPortConfirm) return;
    setWebPortCountdown(5);
    const timer = window.setInterval(() => {
      setWebPortCountdown((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showWebPortConfirm]);

  useEffect(() => {
    if (!showPanelSslConfirm) return;
    setPanelSslCountdown(5);
    const timer = window.setInterval(() => {
      setPanelSslCountdown((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showPanelSslConfirm]);

  useEffect(() => {
    const status = upgradeStatus?.job?.status;
    if (!status || status === "idle") return;
    const previous = previousUpgradeStatus.current;
    const actionLabel = upgradeStatus?.job?.mode === "rollback" ? "回退" : "升级";
    if (previous === "running" && status === "success") {
      toast.success(`面板${actionLabel}成功，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`);
    }
    if (previous === "running" && status === "waiting_assets") {
      toast.info(upgradeStatus?.job?.error || "发布资产仍在构建中，请稍后重试");
    }
    if (previous === "running" && status === "error") {
      toast.error(upgradeStatus?.job?.error || `面板${actionLabel}失败`);
    }
    previousUpgradeStatus.current = status;
  }, [upgradeStatus?.job?.status, upgradeStatus?.job?.error]);

  useEffect(() => {
    if (!showRollbackDialog) return;
    const versions = rollbackType === "panel"
      ? (rollbackVersionsQuery.data?.panelVersions || []).map((item: any) => item.panelVersion)
      : (rollbackVersionsQuery.data?.agentVersions || []).map((item: any) => item.agentVersion);
    if (versions.length === 0) {
      setSelectedRollbackVersion("");
      return;
    }
    if (!selectedRollbackVersion || !versions.includes(selectedRollbackVersion)) {
      setSelectedRollbackVersion(versions[0]);
    }
  }, [
    rollbackType,
    rollbackVersionsQuery.data?.agentVersions,
    rollbackVersionsQuery.data?.panelVersions,
    selectedRollbackVersion,
    showRollbackDialog,
  ]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      utils.system.forwardProtocols.invalidate();
      toast.success("面板设置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
    onSettled: () => setSavingSetting(null),
  });

  const updateAutoCheckMutation = trpc.system.updateSettings.useMutation();

  const updateWebPortMutation = trpc.system.updateWebPort.useMutation({
    onSuccess: (result) => {
      utils.system.getSettings.invalidate();
      if (result.restartScheduled) {
        toast.success(`Web 端口已修改为 ${result.port}，服务正在重启`);
      } else {
        toast.info("Web 端口未变化");
      }
      setShowWebPortConfirm(false);
    },
    onError: (err) => toast.error(err.message || "修改 Web 端口失败"),
  });

  const updatePanelSslMutation = trpc.system.updatePanelSsl.useMutation({
    onSuccess: (result) => {
      utils.system.getSettings.invalidate();
      if (result.restartScheduled) {
        toast.success(result.enabled ? "面板 SSL 已开启，服务正在重启" : "面板 SSL 已关闭，服务正在重启");
      } else {
        toast.info("面板 SSL 配置未变化");
      }
      setShowPanelSslConfirm(false);
    },
    onError: (err) => toast.error(err.message || "保存面板 SSL 配置失败"),
  });

  const legacyAgentAuthHosts = trpc.system.legacyAgentAuthHosts.useQuery(undefined, { refetchOnWindowFocus: false });

  const revealPanelSslKeyMutation = trpc.system.revealPanelSslKey.useMutation({
    onSuccess: (result) => {
      if (!result.keyPem) {
        toast.info("没有已保存的私钥");
        return;
      }
      setPanelSslKeyPem(result.keyPem);
    },
    onError: (err) => toast.error(err.message || "读取私钥失败"),
  });

  const generatePanelSelfSignedMutation = trpc.system.generatePanelSelfSignedCertificate.useMutation({
    onSuccess: (result) => {
      setPanelSslMode("path");
      setPanelSslCertPath(result.certPath);
      setPanelSslKeyPath(result.keyPath);
      utils.system.getSettings.invalidate();
      toast.success("自签证书已生成并填入路径");
    },
    onError: (err) => toast.error(err.message || "生成自签证书失败"),
  });

  /*
    存一组系统设置。返回「存成了没有」：卡片上的保存按钮不看它，玫瑰主题下的贴底保存栏一项一项存，
    要知道这一项成没成再决定存不存下一项。失败的报错由 updateSettingsMutation 自己弹，这里不会 reject。
  */
  const saveSystemSettings = (
    key: SystemSettingsSaveKey,
    payload: Parameters<typeof updateSettingsMutation.mutate>[0],
    options?: { onSuccess?: () => unknown },
  ): Promise<boolean> => {
    setSavingSetting(key);
    return updateSettingsMutation.mutateAsync(payload).then(
      async () => {
        await options?.onSuccess?.();
        return true;
      },
      () => false,
    );
  };

  const isSavingSetting = (key: SystemSettingsSaveKey) => (
    savingSetting === key && updateSettingsMutation.isPending
  );
  const webPortManagement = settings?.webPortManagement;
  const webPortDisplay = Number(settings?.webPort || webPortManagement?.publicPort || 3000);
  const webContainerPort = Number(webPortManagement?.containerPort || webPortDisplay);
  const isDockerWebPort = !!webPortManagement?.docker;
  const webPortChangeDisabled = !settings?.webPortManagement?.enabled || updateWebPortMutation.isPending;
  const publicHostMonitorNormalizedPath = normalizePublicHostMonitorPathInput(publicHostMonitorPath) || "dev";
  const publicHostMonitorUrl = useMemo(() => {
    const base = (settings?.panelPublicUrl || mobileAuth.panelOrigin()).replace(/\/+$/, "");
    return base ? `${base}/${publicHostMonitorNormalizedPath}` : `/${publicHostMonitorNormalizedPath}`;
  }, [publicHostMonitorNormalizedPath, settings?.panelPublicUrl]);

  const handleSavePanelUrl = () => {
    const v = panelUrlInput.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      toast.error("面板公开地址必须以 http:// 或 https:// 开头");
      return false;
    }
    return saveSystemSettings("panelUrl", { panelPublicUrl: v });
  };

  const handleSaveLookingGlass = () => {
    return saveSystemSettings("networkTest", { lookingGlassUserEnabled }, {
      onSuccess: () => utils.system.publicInfo.invalidate(),
    });
  };

  const openWebPortConfirm = () => {
    if (!settings?.webPortManagement?.enabled) {
      toast.info(isDockerWebPort ? "Docker 部署的访问端口由宿主机端口映射管理，请在部署配置中修改。" : "当前环境不支持在后台修改 Web 端口。");
      return;
    }
    const port = Math.floor(Number(webPortInput));
    if (!isValidWebPort(webPortInput)) {
      toast.error("端口必须是 1-65535 的数字");
      return;
    }
    if (port === webPortDisplay) {
      toast.info("端口未变化");
      return;
    }
    setShowWebPortConfirm(true);
  };

  const confirmWebPortChange = () => {
    if (!isValidWebPort(webPortInput)) {
      toast.error("端口必须是 1-65535 的数字");
      return;
    }
    updateWebPortMutation.mutate({ port: Math.floor(Number(webPortInput)), confirmed: true });
  };
  const validatePanelSslDraft = () => {
    if (!panelSslEnabled) return true;
    if (panelSslMode === "path") {
      if (!panelSslCertPath.trim() || !panelSslKeyPath.trim()) {
        toast.error("开启面板 SSL 需要填写证书文件和私钥文件路径");
        return false;
      }
      return true;
    }
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(panelSslCertPem.trim())) {
      toast.error("证书内容不是有效的 PEM 证书");
      return false;
    }
    const keyPem = panelSslKeyPem.trim();
    if (!keyPem && !panelSslKeyPemSaved) {
      toast.error("请粘贴私钥 PEM");
      return false;
    }
    if (keyPem && !/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(keyPem)) {
      toast.error("私钥内容不是有效的 PEM 私钥");
      return false;
    }
    return true;
  };

  const openPanelSslConfirmV2 = () => {
    if (!validatePanelSslDraft()) return;
    setShowPanelSslConfirm(true);
  };

  const confirmPanelSslChangeV2 = () => {
    if (!validatePanelSslDraft()) return;
    updatePanelSslMutation.mutate({
      enabled: panelSslEnabled,
      mode: panelSslMode,
      certPath: panelSslCertPath.trim(),
      keyPath: panelSslKeyPath.trim(),
      certPem: panelSslCertPem.trim(),
      keyPem: panelSslKeyPem.trim(),
      confirmed: true,
    });
  };

  const handleGeneratePanelSelfSigned = () => {
    const hosts = [panelUrlInput].filter(Boolean);
    generatePanelSelfSignedMutation.mutate({ hosts, days: 825 });
  };

  const handleSaveRegistration = () => {
    return saveSystemSettings("registration", { registrationEnabled, authCaptchaEnabled, authCaptchaMode, telegramLoginEnabled, passwordResetEnabled }, {
      onSuccess: () => {
        void utils.system.publicInfo.invalidate();
        void utils.auth.emailConfig.invalidate();
        void utils.auth.needsCaptcha.invalidate();
        void utils.auth.passwordResetOptions.invalidate();
      },
    });
  };

  const handleSaveTwoFactor = () => {
    return saveSystemSettings("twoFactor", { twoFactorEnabled });
  };

  const handleSaveDdns = () => {
    const huaweicloudEndpoint = normalizeConfigUrl(ddnsHuaweiCloudEndpoint);
    const aliyunEndpoint = normalizeConfigUrl(ddnsAliyunEndpoint);
    if (huaweicloudEndpoint && !/^https?:\/\//i.test(huaweicloudEndpoint)) {
      toast.error("华为云 Endpoint 需要以 http:// 或 https:// 开头");
      return false;
    }
    if (aliyunEndpoint && !/^https?:\/\//i.test(aliyunEndpoint)) {
      toast.error("阿里云 Endpoint 需要以 http:// 或 https:// 开头");
      return false;
    }
    const ttl = normalizeTtl(ddnsTtl, Number(settings?.ddns?.ttl || 60));
    return saveSystemSettings("ddns", {
      ddns: {
        enabled: ddnsEnabled,
        provider: ddnsProvider,
        ttl,
        cloudflareZoneId: "",
        cloudflareApiToken: ddnsCloudflareApiToken.trim() || undefined,
        huaweicloudAccessKeyId: ddnsHuaweiCloudAccessKeyId,
        huaweicloudSecretKey: ddnsHuaweiCloudSecretKey.trim() || undefined,
        huaweicloudRegion: ddnsHuaweiCloudRegion,
        huaweicloudEndpoint,
        huaweicloudZoneId: ddnsHuaweiCloudZoneId,
        huaweicloudTtl: ttl,
        huaweicloudLine: ddnsHuaweiCloudLine,
        aliyunAccessKeyId: ddnsAliyunAccessKeyId,
        aliyunAccessKeySecret: ddnsAliyunAccessKeySecret.trim() || undefined,
        aliyunDomainName: ddnsAliyunDomainName,
        aliyunEndpoint,
        aliyunTtl: ttl,
        aliyunLine: ddnsAliyunLine,
        tencentcloudSecretId: ddnsTencentCloudSecretId,
        tencentcloudSecretKey: ddnsTencentCloudSecretKey.trim() || undefined,
        tencentcloudDomainName: ddnsTencentCloudDomainName,
        tencentcloudTtl: ttl,
        tencentcloudRecordLine: ddnsTencentCloudRecordLine,
        tencentcloudRecordLineId: ddnsTencentCloudRecordLineId,
        webhookUrl: ddnsWebhookUrl,
        webhookMethod: ddnsWebhookMethod,
        webhookHeaders: ddnsWebhookHeaders.trim() || undefined,
        clearWebhookHeaders: ddnsWebhookHeadersClear && !ddnsWebhookHeaders.trim() ? true : undefined,
        ruleEntryDomainSuffix: ruleEntryDomainSuffix.trim(),
      },
    }, {
      onSuccess: () => {
        setDdnsWebhookHeaders("");
        setDdnsWebhookHeadersClear(false);
        setDdnsCloudflareApiToken("");
        setDdnsHuaweiCloudSecretKey("");
        setDdnsAliyunAccessKeySecret("");
        setDdnsTencentCloudSecretKey("");
      },
    });
  };

  const handleSavePublicHostMonitor = () => {
    const path = normalizePublicHostMonitorPathInput(publicHostMonitorPath) || "dev";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(path)) {
      toast.error("主机监控面板路径只能包含小写字母、数字、短横线或下划线，且不能超过 64 个字符");
      return false;
    }
    return saveSystemSettings("hostMonitor", {
      publicHostMonitor: {
        enabled: publicHostMonitorEnabled,
        path,
        title: publicHostMonitorTitle.trim(),
      },
    }, {
      onSuccess: () => {
        setPublicHostMonitorPath(path);
        setPublicHostMonitorTitle(publicHostMonitorTitle.trim());
        utils.system.getSettings.invalidate();
        utils.system.publicInfo.invalidate();
      },
    });
  };

  const handleSaveSessionPolicy = () => {
    return saveSystemSettings("sessionPolicy", { allowMultiDeviceLogin, loginNewDeviceNotify });
  };

  const handleSaveEntryBridge = () => {
    const raw = ruleSwitchBridgeHours.trim();
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 0 || value > MAX_RULE_SWITCH_BRIDGE_HOURS) {
      toast.error(`请输入 0 到 ${MAX_RULE_SWITCH_BRIDGE_HOURS} 之间的整数小时`);
      return false;
    }
    return saveSystemSettings("entryBridge", { ruleSwitchBridgeHours: value });
  };

  const handleSavePortAccessLimits = () => {
    return saveSystemSettings("portAccessLimits", { portAccessLimitsEnabled });
  };

  const handleSaveLinkWizard = () => {
    return saveSystemSettings("linkWizard", { linkWizardEnabled });
  };

  const resetForwardProtocolDraft = () => {
    setForwardProtocols(normalizeForwardProtocolSettings(settings?.forwardProtocols));
  };

  const openForwardProtocolDialog = () => {
    resetForwardProtocolDraft();
    setShowForwardProtocolDialog(true);
  };

  const closeForwardProtocolDialog = () => {
    resetForwardProtocolDraft();
    setShowForwardProtocolDialog(false);
  };

  const handleSaveForwardProtocols = () => {
    saveSystemSettings(
      "forwardProtocols",
      { forwardProtocols },
      { onSuccess: () => setShowForwardProtocolDialog(false) },
    );
  };

  const resetSidebarMenuDraft = () => {
    setSidebarMenu(normalizeSidebarMenuSettings({
      ...settings?.sidebarMenu,
      plugins: settings?.pluginsEnabled === true,
    }));
  };

  const openSidebarMenuDialog = () => {
    resetSidebarMenuDraft();
    setShowSidebarMenuDialog(true);
  };

  const closeSidebarMenuDialog = () => {
    resetSidebarMenuDraft();
    setShowSidebarMenuDialog(false);
  };

  const handleSaveSidebarMenu = () => {
    const nextSidebarMenu = normalizeSidebarMenuSettings(sidebarMenu);
    saveSystemSettings(
      "sidebarMenu",
      { sidebarMenu: nextSidebarMenu, pluginsEnabled: nextSidebarMenu.plugins },
      {
        onSuccess: () => {
          setShowSidebarMenuDialog(false);
          utils.system.getSettings.invalidate();
          utils.system.publicInfo.invalidate();
        },
      },
    );
  };

  const handleSaveAgentAuth = () => {
    return saveSystemSettings("agentAuth", { agentLegacyAuthRejected });
  };

  const handleSaveAgentInstall = () => {
    const inputUrl = normalizeConfigUrl(githubAcceleratorUrlInput);
    const acceleratorUrl = normalizeGithubAcceleratorUrl(inputUrl);
    if (inputUrl && !acceleratorUrl) {
      toast.error("GitHub 加速地址必须是 HTTP(S) 基础地址，且不能包含查询参数或锚点");
      return false;
    }
    return saveSystemSettings("agentInstall", {
      githubAccelerator: {
        enabled: githubAcceleratorEnabled,
        url: acceleratorUrl,
        panelUpdateEnabled: githubAcceleratorPanelUpdateEnabled,
      },
      agentPreferPanelInstall,
    }, {
      onSuccess: async () => {
        await Promise.all([
          utils.system.upgradeStatus.invalidate(),
          utils.system.checkUpdate.invalidate(),
        ]);
        await refetchUpgradeStatus();
      },
    });
  };

  /*
    玫瑰主题下的贴底保存栏（components/settings/SaveDock.tsx）：每张卡登记「有没有改动、怎么存」。
    有没有改动 = 表单现在的值和服务端存的值比；服务端的值按 loadFromSettings 同样的规矩取。
    端口和 SSL 要倒计时确认、会重启面板，协议和菜单在弹窗里改 —— 这几张不登记，保留自己的按钮。
  */
  const resetSystemDraft = () => { if (settings) loadFromSettings(settings); };
  const savedHostMonitor = settings?.publicHostMonitor;
  const ddnsDraft = [
    ddnsEnabled, ddnsProvider, ddnsTtl, ddnsCloudflareApiToken, ddnsHuaweiCloudAccessKeyId, ddnsHuaweiCloudSecretKey,
    ddnsHuaweiCloudRegion, ddnsHuaweiCloudEndpoint, ddnsHuaweiCloudZoneId, ddnsHuaweiCloudLine, ddnsAliyunAccessKeyId,
    ddnsAliyunAccessKeySecret, ddnsAliyunDomainName, ddnsAliyunEndpoint, ddnsAliyunLine, ddnsTencentCloudSecretId,
    ddnsTencentCloudSecretKey, ddnsTencentCloudDomainName, ddnsTencentCloudRecordLine, ddnsTencentCloudRecordLineId,
    ddnsWebhookUrl, ddnsWebhookMethod, ddnsWebhookHeaders, ddnsWebhookHeadersClear, ruleEntryDomainSuffix,
  ];
  const ddnsSaved = settings ? [
    !!settings.ddns?.enabled,
    isDdnsProvider(settings.ddns?.provider) ? settings.ddns.provider : "disabled",
    String(settings.ddns?.ttl || settings.ddns?.huaweicloudTtl || settings.ddns?.aliyunTtl || settings.ddns?.tencentcloudTtl || 60),
    "", settings.ddns?.huaweicloudAccessKeyId || "", "",
    settings.ddns?.huaweicloudRegion || "cn-north-4", settings.ddns?.huaweicloudEndpoint || "", settings.ddns?.huaweicloudZoneId || "",
    settings.ddns?.huaweicloudLine || "default_view", settings.ddns?.aliyunAccessKeyId || "",
    "", settings.ddns?.aliyunDomainName || "", settings.ddns?.aliyunEndpoint || "https://alidns.aliyuncs.com", settings.ddns?.aliyunLine || "default",
    settings.ddns?.tencentcloudSecretId || "", "", settings.ddns?.tencentcloudDomainName || "",
    settings.ddns?.tencentcloudRecordLine || "默认", settings.ddns?.tencentcloudRecordLineId || "",
    settings.ddns?.webhookUrl || "",
    (settings.ddns?.webhookMethod === "PUT" || settings.ddns?.webhookMethod === "GET") ? settings.ddns.webhookMethod : "POST",
    settings.ddns?.webhookHeaders || "", false, settings.ddns?.ruleEntryDomainSuffix || "",
  ] : ddnsDraft;
  const systemDockItems: Array<{ id: SystemSettingsSaveKey; label: string; dirty: boolean; save: () => Promise<boolean> | boolean }> = [
    { id: "panelUrl", label: "面板地址", dirty: !!settings && panelUrlInput !== (settings.panelPublicUrl || ""), save: handleSavePanelUrl },
    { id: "networkTest", label: "网络测试", dirty: !!settings && lookingGlassUserEnabled !== (settings.lookingGlassUserEnabled ?? true), save: handleSaveLookingGlass },
    { id: "entryBridge", label: "换线过渡", dirty: !!settings && ruleSwitchBridgeHours !== String(normalizeRuleSwitchBridgeHours((settings as any).ruleSwitchBridgeHours)), save: handleSaveEntryBridge },
    { id: "portAccessLimits", label: "接入限制", dirty: !!settings && portAccessLimitsEnabled !== !!(settings as any).portAccessLimitsEnabled, save: handleSavePortAccessLimits },
    { id: "linkWizard", label: "新建向导", dirty: !!settings && linkWizardEnabled !== !!(settings as any).linkWizardEnabled, save: handleSaveLinkWizard },
    { id: "registration", label: "注册", dirty: !!settings && (registrationEnabled !== (settings.registrationEnabled ?? true) || authCaptchaEnabled !== (settings.authCaptchaEnabled ?? true) || authCaptchaMode !== normalizeAuthCaptchaMode(settings.authCaptchaMode) || telegramLoginEnabled !== (settings.telegramLoginEnabled !== false) || passwordResetEnabled !== (settings.passwordResetEnabled ?? true)), save: handleSaveRegistration },
    { id: "twoFactor", label: "双重验证", dirty: !!settings && twoFactorEnabled !== !!settings.twoFactorEnabled, save: handleSaveTwoFactor },
    { id: "ddns", label: "DDNS", dirty: JSON.stringify(ddnsDraft) !== JSON.stringify(ddnsSaved), save: handleSaveDdns },
    {
      id: "hostMonitor",
      label: "公开主机监控",
      dirty: !!settings && (
        publicHostMonitorEnabled !== (savedHostMonitor ? !!savedHostMonitor.enabled : false)
        || publicHostMonitorPath !== (savedHostMonitor?.path || "dev")
        || publicHostMonitorTitle !== (savedHostMonitor?.title || "")
      ),
      save: handleSavePublicHostMonitor,
    },
    { id: "sessionPolicy", label: "登录设备", dirty: !!settings && (allowMultiDeviceLogin !== !!settings.allowMultiDeviceLogin || loginNewDeviceNotify !== (settings.loginNewDeviceNotify !== false)), save: handleSaveSessionPolicy },
    {
      id: "agentInstall",
      label: "Agent 安装",
      dirty: !!settings && (
        githubAcceleratorEnabled !== !!settings.githubAccelerator?.enabled
        || githubAcceleratorPanelUpdateEnabled !== !!settings.githubAccelerator?.panelUpdateEnabled
        || githubAcceleratorUrlInput !== (settings.githubAccelerator?.url || "")
        || agentPreferPanelInstall !== !!settings.agentPreferPanelInstall
      ),
      save: handleSaveAgentInstall,
    },
    {
      id: "agentAuth",
      label: "Agent 认证",
      dirty: !!settings && agentLegacyAuthRejected !== !!(settings as any).agentLegacyAuthRejected,
      save: handleSaveAgentAuth,
    },
  ];
  for (const item of systemDockItems) {
    // 列表是固定的九项、顺序不变，所以在循环里调 hook 是安全的
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useSaveDockItem({ ...item, id: `system.${item.id}`, pending: isSavingSetting(item.id), reset: resetSystemDraft });
  }

  const setForwardProtocolEnabled = (key: keyof ForwardProtocolSettings, enabled: boolean) => {
    setForwardProtocols((prev) => ({ ...prev, [key]: enabled }));
  };

  const setSidebarMenuEnabled = (key: SidebarMenuKey, enabled: boolean) => {
    setSidebarMenu((prev) => ({ ...prev, [key]: enabled }));
  };

  const copyTextWithToast = async (text: string) => {
    /*
      走共享实现。原来这里自己拼 textarea 挂到 document.body 上 ——
      而这个复制按钮在弹窗里，弹窗有焦点陷阱，会把焦点抢回去。
      共享那份专门把临时元素挂在打开着的弹窗内，就是为了这个。
    */
    if (await copyTextToClipboard(text)) toast.success("已复制到剪贴板");
    else toast.error(clipboardNeedsManualCopy() ? "当前是 http 访问，浏览器限制了剪贴板，请手动选中复制" : "复制失败，请手动复制");
  };

  const startUpgradeMutation = trpc.system.startUpgrade.useMutation({
    onSuccess: async (result) => {
      if (result?.pendingReason) {
        toast.info(result.pendingReason);
      } else {
        toast.success("升级任务已启动");
      }
      await refetchUpgradeStatus();
    },
    onError: (err) => toast.error(err.message || "启动升级失败"),
  });

  const startRollbackMutation = trpc.system.startVersionRollback.useMutation({
    onSuccess: async (result) => {
      if ((result as any)?.pendingReason) {
        toast.info((result as any).pendingReason);
      } else if ((result as any)?.type === "agent") {
        toast.success(`Agent 回退任务已下发 ${((result as any).requested || 0)} 台，实时推送 ${((result as any).pushed || 0)} 台`);
      } else {
        toast.success("面板回退任务已启动");
      }
      setShowRollbackDialog(false);
      await refetchUpgradeStatus();
      utils.hosts.list.invalidate();
      utils.hosts.options.invalidate();
      utils.hosts.listPage.invalidate();
    },
    onError: (err) => toast.error(err.message || "启动回退失败"),
  });

  const refreshRollbackVersions = async () => {
    await utils.system.rollbackVersions.fetch({ force: true });
    await rollbackVersionsQuery.refetch();
  };

  const openRollbackDialog = async () => {
    setRollbackType("panel");
    setSelectedRollbackVersion("");
    setShowRollbackDialog(true);
    try {
      await refreshRollbackVersions();
    } catch {
      // The dialog will render the query error.
    }
  };

  const handleCheckUpdate = async () => {
    const now = Date.now();
    const cooldownMs = 60 * 1000;
    const waitMs = cooldownMs - (now - lastPanelUpdateCheck.current);
    if (waitMs > 0) {
      toast.info(`请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
      return;
    }
    try {
      setCheckingUpdate(true);
      lastPanelUpdateCheck.current = now;
      await utils.system.checkUpdate.fetch({ force: true });
      await refetchUpgradeStatus();
      toast.success("版本检查完成");
    } catch (err: any) {
      toast.error(err?.message || "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const updateInfo = upgradeStatus?.update;
  const upgradeEnabled = !!upgradeStatus?.upgradeEnabled;
  const isDockerDeployment = !!upgradeStatus?.docker || !!settings?.upgrade?.docker;
  const panelUpdateAccelerator = panelUpdateGithubAccelerator({
    enabled: githubAcceleratorEnabled,
    panelUpdateEnabled: githubAcceleratorPanelUpdateEnabled,
    url: githubAcceleratorUrlInput,
  });
  const manualPanelUpgradeCommands = ([
    ["本地部署", "local"],
    ["Docker 部署", "docker"],
  ] as const).map(([label, deployment]) => ({
    label,
    command: buildPanelInstallerCommand({
      deployment,
      action: "upgrade",
      accelerator: panelUpdateAccelerator,
    }),
  }));
  const dockerPanelUpgradeCommand =
    upgradeStatus?.manualUpgradeCommand ||
    settings?.upgrade?.manualUpgradeCommand ||
    manualPanelUpgradeCommands[1].command;
  const canShowDockerUpgradeScript =
    isDockerDeployment &&
    !!updateInfo?.latestVersion &&
    (updateInfo.hasUpdate || (!!updateInfo.pendingReason && !updateInfo.error));
  const canStartPanelUpgrade =
    isDockerDeployment ? canShowDockerUpgradeScript : !!updateInfo?.hasUpdate;
  const rollbackPanelVersions = rollbackVersionsQuery.data?.panelVersions || [];
  const rollbackAgentVersions = rollbackVersionsQuery.data?.agentVersions || [];
  const selectedRollbackTarget = rollbackType === "panel"
    ? rollbackPanelVersions.find((item: any) => item.panelVersion === selectedRollbackVersion)
    : rollbackAgentVersions.find((item: any) => item.agentVersion === selectedRollbackVersion);
  const selectedRollbackPanelCommand = rollbackType === "panel" && selectedRollbackVersion
    ? panelVersionCommand(
        upgradeStatus?.manualUpgradeCommand || settings?.upgrade?.manualUpgradeCommand || manualPanelUpgradeCommands[isDockerDeployment ? 1 : 0].command,
        selectedRollbackVersion,
      )
    : "";
  const canRunPanelRollback = rollbackType !== "panel" || (!!upgradeEnabled && !isDockerDeployment);
  const androidApkDownloadUrl = settings?.androidApkDownloadUrl || "";
  const iosIpaDownloadUrl = (settings as any)?.iosIpaDownloadUrl || "";
  const contactLinks: Array<{
    label: string;
    url: string;
    icon: typeof Github;
    iconClassName: string;
    description?: string;
  }> = [
    {
      label: "GitHub 仓库",
      url: settings?.repoUrl || "#",
      icon: Github,
      iconClassName: "",
    },
    ...(settings?.telegramBotUrl ? [{
      label: "Telegram 双向消息机器人",
      url: settings.telegramBotUrl,
      icon: Send,
      iconClassName: "text-primary",
    }] : []),
    ...(androidApkDownloadUrl ? [{
      label: "Android APK 下载",
      url: androidApkDownloadUrl,
      icon: Download,
      iconClassName: "text-[var(--fx-healthy-text)]",
    }] : []),
    ...(iosIpaDownloadUrl ? [{
      label: "iOS IPA 下载",
      // 和面板同一个 Release：面板升到哪一版，这里就是那一版构建的 NEX 安装包。
      url: iosIpaDownloadUrl,
      icon: Download,
      iconClassName: "text-[var(--fx-healthy-text)]",
      description: "iPhone / iPad · 需自行签名后安装",
    }] : []),
  ];
  const isUpgradeRunning = upgradeStatus?.job.status === "running";
  const upgradeProgress = getPanelUpgradeProgress(upgradeStatus?.job, {
    now: upgradeClock,
    elapsedMs: isUpgradeRunning ? null : (upgradeStatus?.elapsedMs ?? null),
    disconnected: isUpgradeRunning && upgradeStatusUnreachable,
  });
  useEffect(() => {
    if (!isUpgradeRunning) return;
    setUpgradeClock(Date.now());
    const timer = window.setInterval(() => setUpgradeClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isUpgradeRunning]);
  useEffect(() => {
    if (!isUpgradeRunning) return;
    // 手机锁屏 / 切走再回来立刻拉一次状态，不等下一个轮询周期。
    const wake = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refetchUpgradeStatus();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [isUpgradeRunning, refetchUpgradeStatus]);
  const upgradeErrorLogs = (upgradeStatus?.job?.logs || []).slice(-80).join("\n");
  const directProtocolEnabledCount = directForwardProtocolKeys.filter((key) => forwardProtocols[key]).length;
  const tunnelProtocolEnabledCount = tunnelForwardProtocolKeys.filter((key) => forwardProtocols[key]).length;
  const sidebarMenuEnabledCount = SIDEBAR_MENU_KEYS.filter((key) => sidebarMenu[key]).length;
  const panelSslPathActive = panelSslMode === "path";
  const panelSslPathConfigured = !!panelSslCertPath.trim() && !!panelSslKeyPath.trim();
  const panelSslPemConfigured = !!panelSslCertPem.trim() && (!!panelSslKeyPem.trim() || panelSslKeyPemSaved);

  useEffect(() => {
    if (!canShowDockerUpgradeScript || !updateInfo?.latestVersion) return;
    if (shownDockerUpgradeVersion.current === updateInfo.latestVersion) return;
    shownDockerUpgradeVersion.current = updateInfo.latestVersion;
    setShowDockerUpgradeScript(true);
  }, [canShowDockerUpgradeScript, updateInfo?.latestVersion]);

  if (isLoading) {
    return (
      <DataSectionLoading label="正在加载系统设置" minHeight="min-h-[220px]" />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 @[58rem]:grid-cols-2 [&>*]:min-w-0">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="h-4 w-4 text-primary" />
              网络测试
            </CardTitle>
            <CardDescription>
              配置普通用户是否可见网络测试入口。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow
                asLabel
                label="普通用户可见网络测试"
                description="关闭后侧边栏入口和接口都会对普通用户禁用。"
                control={<Checkbox aria-label="普通用户可见网络测试" checked={lookingGlassUserEnabled} onCheckedChange={setLookingGlassUserEnabled} />}
              />
            </SettingList>
            {/* 保存放右下角：这一页别的卡片都是这个位置，只有这一张在左边。 */}
            <div className="flex justify-end">
              <Button data-dock-save onClick={handleSaveLookingGlass} disabled={isSavingSetting("networkTest")}>
                保存
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" />
                转发协议总开关
              </CardTitle>
              <CardDescription>
                控制用户可用的转发协议。
              </CardDescription>
            </div>
            <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={openForwardProtocolDialog}>
              <Settings2 className="h-4 w-4" />
              管理协议开关
            </Button>
          </CardHeader>
          <CardContent>
            {/*
              原来是三个小框各放一个数（全部 / 端口转发 / 隧道）。「全部」就是后两个相加，
              单独占一格不多说任何事；剩下两个是「这一类开了几个」，和别的设置一样写成行。
            */}
            <SettingList>
              <SettingRow label="端口转发" control={<EnabledCount enabled={directProtocolEnabledCount} total={directForwardProtocolKeys.length} />} />
              <SettingRow label="隧道协议" control={<EnabledCount enabled={tunnelProtocolEnabledCount} total={tunnelForwardProtocolKeys.length} />} />
            </SettingList>
          </CardContent>
        </Card>
      </div>
      {/* 换隧道后旧入口的临时桥接（shared/ruleEntryBridge）。单独一张卡，不和协议开关挤在一起。 */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MoveRight className="h-4 w-4 text-primary" />
            换隧道旧入口桥接
          </CardTitle>
          <CardDescription>
            规则换到别的入口后，旧入口的老端口继续把流量转到新入口，这么多小时后自动撤掉；填 0 关闭。
            规则开了专属入口域名时（DNS 几分钟内就跟过去）1 小时足够；没有域名的话，这段时间内没刷新订阅的客户端会连不上，建议调长。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <FormField className="space-y-2 sm:max-w-[16rem]">
              <Label htmlFor="rule-switch-bridge-hours">保留时长（小时）</Label>
              <Input
                id="rule-switch-bridge-hours"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_RULE_SWITCH_BRIDGE_HOURS}
                step={1}
                value={ruleSwitchBridgeHours}
                onChange={(e) => setRuleSwitchBridgeHours(e.target.value)}
              />
            </FormField>
            <Button data-dock-save onClick={handleSaveEntryBridge} disabled={isSavingSetting("entryBridge")}>
              {isSavingSetting("entryBridge") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
      {/* 普通端口转发的单 IP 接入限制（server/portAccessLimits.ts），默认关，隧道规则一直照限。 */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-primary" />
            普通转发接入限制
          </CardTitle>
          <CardDescription>
            隧道规则一直按用户的「单 IP 接入限制」执行；普通端口转发默认不限。
            打开后普通转发也限制每个来源 IP 的 TCP 并发连接数（需要 Agent 2.2.229 及以上），只拦新连接，已建立的连接和转发进程不受影响。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="普通转发也执行单 IP 接入限制"
              description="套餐默认每个 IP 最多 10 条连接，打开前请确认用户的限制值合适。"
              control={<Checkbox aria-label="普通转发也执行单 IP 接入限制" checked={portAccessLimitsEnabled} onCheckedChange={(checked) => setPortAccessLimitsEnabled(checked === true)} />}
            />
          </SettingList>
          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSavePortAccessLimits} disabled={isSavingSetting("portAccessLimits")}>
              {isSavingSetting("portAccessLimits") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
      {/* 链路管理「线路总览」里的「按目标新建」向导，默认关（features/links/LinkWizardDialog.tsx）。 */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Route className="h-4 w-4 text-primary" />
            按目标新建向导
          </CardTitle>
          <CardDescription>
            打开后，链路管理的「线路概览」页签右上角多一个醒目的「按目标新建」：选想要什么（稳定 / 多人一起快 / 单条连接也要快）和多出来的机器在哪一段，
            面板推荐该建哪一种，并打开预填好的新建框。不开也能用：每一页「新建链路」旁边的「向导」打开的是同一个。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="显示「按目标新建」"
              description="只影响界面，不改任何已有的线路。"
              control={<Checkbox aria-label="显示「按目标新建」" checked={linkWizardEnabled} onCheckedChange={(checked) => setLinkWizardEnabled(checked === true)} />}
            />
          </SettingList>
          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSaveLinkWizard} disabled={isSavingSetting("linkWizard")}>
              {isSavingSetting("linkWizard") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 @[58rem]:grid-cols-2">
        {/* 面板公开访问地址 */}
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              面板公开访问地址
            </CardTitle>
            <CardDescription>
              Agent 安装和回调使用此地址。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="例如：https://forwardx.example.com 或 http://1.2.3.4:3000"
                value={panelUrlInput}
                onChange={(e) => setPanelUrlInput(e.target.value)}
                className="flex-1"
              />
              <Button
                data-dock-save
                onClick={handleSavePanelUrl}
                disabled={isSavingSetting("panelUrl")}
              >
                保存
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              留空使用当前访问地址。需以 http:// 或 https:// 开头。
            </p>
            <p className="text-xs leading-relaxed text-[var(--fx-warn-text)]">
              反向代理或 Docker 部署请填写外部可访问的面板地址，否则 Agent 可能无法回连。
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="h-4 w-4 text-primary" />
              Web 服务监听端口
            </CardTitle>
            <CardDescription>
              {isDockerWebPort ? "Docker 部署的宿主机访问端口由端口映射管理，容器内固定监听 3000。" : "修改本地部署面板的 Web 访问端口。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input aria-label="Web 服务监听端口"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={webPortInput}
                onChange={(e) => setWebPortInput(e.target.value.replace(/\D/g, "").slice(0, 5))}
                disabled={!settings?.webPortManagement?.enabled}
                className="flex-1"
              />
              <Button
                onClick={openWebPortConfirm}
                disabled={webPortChangeDisabled}
                variant={isDockerWebPort ? "outline" : "default"}
              >
                {isDockerWebPort ? "不可修改" : "修改端口"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isDockerWebPort
                ? `宿主机端口：${webPortDisplay} → 容器端口：${webContainerPort}。`
                : `当前监听端口：${webPortDisplay}。修改后服务会重启，请使用新端口访问后台。`}
            </p>
            {!settings?.webPortManagement?.enabled && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{isDockerWebPort ? "Docker 部署端口由映射管理" : "当前环境不支持后台修改端口"}</AlertTitle>
                <AlertDescription>
                  {isDockerWebPort
                    ? "请在部署配置中修改宿主机端口映射。"
                    : "请在服务环境变量或启动脚本中修改监听端口。"}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card @[58rem]:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-primary" />
              面板 SSL 访问
            </CardTitle>
            <CardDescription>
              在当前端口启用 HTTPS。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow keepDescription
                asLabel
                label="启用 HTTPS"
                description={`当前协议：${settings?.panelSsl?.activeProtocol === "https" ? "HTTPS" : "HTTP"}，端口：${webPortDisplay}`}
                control={<Checkbox aria-label="启用 HTTPS" checked={panelSslEnabled} onCheckedChange={setPanelSslEnabled} />}
              />
              {/*
                证书来源：原来是两个并排的大框，各带徽标（当前使用 / 已保存备用 / 未配置）和
                「使用此来源」按钮，没选中的那个调成 80% 透明，上面再加一条「当前证书来源：…」
                的提示框 —— 同一件事（选哪一种）说了三遍，框套了三层。

                它就是二选一：一个分段控件，下面只摆选中那一种的字段。另一种填过的内容还在，
                切过去就看得见；在分段下面用一行字说它是「已保存备用」还是「未配置」。
              */}
              <SettingRow
                label="证书来源"
                description={panelSslEnabled ? "HTTPS 按选中的来源启动。" : "启用后按选中的来源启动。"}
              >
                <SegmentedControl
                  ariaLabel="证书来源"
                  className="grid grid-cols-2 gap-1"
                  value={panelSslMode}
                  options={[
                    { value: "path", label: "服务器文件路径" },
                    { value: "pem", label: "粘贴 PEM 内容" },
                  ] as const}
                  onChange={setPanelSslMode}
                />
                <p className="text-meta text-muted-foreground">
                  {panelSslPathActive
                    ? `读取服务器上的证书和私钥文件。PEM 内容：${panelSslPemConfigured ? "已保存备用" : "未配置"}。`
                    : `直接保存证书和私钥 PEM 内容。文件路径：${panelSslPathConfigured ? "已保存备用" : "未配置"}。`}
                </p>
                {panelSslPathActive ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="panel-ssl-cert-path">证书文件路径</Label>
                        <Input
                          id="panel-ssl-cert-path"
                          value={panelSslCertPath}
                          onChange={(e) => setPanelSslCertPath(e.target.value)}
                          placeholder="/data/certs/fullchain.pem"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="panel-ssl-key-path">私钥文件路径</Label>
                        <Input
                          id="panel-ssl-key-path"
                          value={panelSslKeyPath}
                          onChange={(e) => setPanelSslKeyPath(e.target.value)}
                          placeholder="/data/certs/privkey.pem"
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleGeneratePanelSelfSigned}
                      disabled={generatePanelSelfSignedMutation.isPending}
                    >
                      {generatePanelSelfSignedMutation.isPending ? "生成中..." : "生成自签证书"}
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="panel-ssl-cert-pem">证书 PEM</Label>
                      <Textarea
                        id="panel-ssl-cert-pem"
                        value={panelSslCertPem}
                        onChange={(e) => setPanelSslCertPem(e.target.value)}
                        placeholder="-----BEGIN CERTIFICATE-----"
                        className="min-h-44 resize-y font-mono text-xs leading-5"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex min-h-5 items-center justify-between gap-2">
                        <Label htmlFor="panel-ssl-key-pem" className="flex items-center gap-2">
                          私钥 PEM
                          {panelSslKeyPemSaved && <Badge variant="secondary">已配置</Badge>}
                        </Label>
                        {panelSslKeyPemSaved && !panelSslKeyPem.trim() && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => revealPanelSslKeyMutation.mutate()}
                            disabled={revealPanelSslKeyMutation.isPending}
                          >
                            {revealPanelSslKeyMutation.isPending ? "读取中..." : "查看"}
                          </Button>
                        )}
                      </div>
                      <Textarea
                        id="panel-ssl-key-pem"
                        value={panelSslKeyPem}
                        onChange={(e) => setPanelSslKeyPem(e.target.value)}
                        placeholder={panelSslKeyPemSaved ? "已配置，留空保持不变；粘贴新私钥即可替换" : "-----BEGIN PRIVATE KEY-----"}
                        className="min-h-44 resize-y font-mono text-xs leading-5"
                      />
                    </div>
                  </div>
                )}
              </SettingRow>
            </SettingList>
            <p className="text-xs text-muted-foreground">
              默认关闭。保存时会校验证书和私钥，配置生效需要重启面板；端口不变。
            </p>
            <div className="flex justify-end">
              <Button onClick={openPanelSslConfirmV2} disabled={updatePanelSslMutation.isPending || generatePanelSelfSignedMutation.isPending}>
                保存 SSL 配置
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showWebPortConfirm} onOpenChange={setShowWebPortConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--fx-warn-text)]" />
              确认修改 Web 端口
            </DialogTitle>
            <DialogDescription>
              即将把 Web 服务监听端口修改为 {webPortInput || "-"}，确认后服务会重启。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>请先确认安全组和防火墙已放行新端口</AlertTitle>
            <AlertDescription>
              如果新端口未放行，服务重启后可能无法通过浏览器访问后台。
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWebPortConfirm(false)} disabled={updateWebPortMutation.isPending}>
              取消
            </Button>
            <Button onClick={confirmWebPortChange} disabled={webPortCountdown > 0 || updateWebPortMutation.isPending}>
              {webPortCountdown > 0 ? `确认修改（${webPortCountdown}s）` : "确认并重启"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPanelSslConfirm} onOpenChange={setShowPanelSslConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--fx-warn-text)]" />
              确认修改面板 SSL
            </DialogTitle>
            <DialogDescription>
              确认后面板会重启，当前端口 {webPortDisplay} 将切换为 {panelSslEnabled ? "HTTPS" : "HTTP"} 访问。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>请确认访问地址和证书文件已准备好</AlertTitle>
            <AlertDescription>
              开启 SSL 后请使用 https:// 访问当前端口；关闭后请改回 http:// 访问当前端口。
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPanelSslConfirm(false)} disabled={updatePanelSslMutation.isPending}>
              取消
            </Button>
            <Button onClick={confirmPanelSslChangeV2} disabled={panelSslCountdown > 0 || updatePanelSslMutation.isPending}>
              {panelSslCountdown > 0 ? `确认修改（${panelSslCountdown}s）` : "确认并重启"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 @[58rem]:grid-cols-2">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-4 w-4 text-primary" />
              注册与登录
            </CardTitle>
            <CardDescription>
              控制新用户自助注册，以及登录页的人机验证、找回密码和 Telegram 登录。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow
                asLabel
                label="开放注册"
                description="关闭后仅管理员可添加用户。"
                control={<Checkbox aria-label="开放注册" checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />}
              />
              <SettingRow
                asLabel
                label="登录 / 注册人机验证"
                description="默认开启。只走 HTTP、浏览器跑不了验证组件时可以关掉；关掉后密码校验、登录失败限流和双重验证照旧。"
                control={<Checkbox aria-label="登录 / 注册人机验证" checked={authCaptchaEnabled} onCheckedChange={setAuthCaptchaEnabled} />}
              />
              {/*
                验证方式（上游 2.3.286）：服务端只认选中的那一种，另一种的答案按验证失败算、挑战也不发
                （server/authCaptchaMode.ts）。登录、注册、忘记密码三处都跟着它。
              */}
              <SettingRow
                label="人机验证方式"
                description={authCaptchaMode === "image"
                  ? "图片验证码：看图填字符，不依赖浏览器跑验证脚本，老浏览器、只走 HTTP 的环境也能用。"
                  : "点击验证：点一下，浏览器在后台算一小段工作量证明，不用看图打字。"}
                control={(
                  <SegmentedControl<AuthCaptchaMode>
                    ariaLabel="人机验证方式"
                    className="grid grid-cols-2 gap-1"
                    optionClassName="px-2.5"
                    disabled={!authCaptchaEnabled}
                    value={authCaptchaMode}
                    options={AUTH_CAPTCHA_MODES.map((value) => ({ value, label: AUTH_CAPTCHA_MODE_LABELS[value] }))}
                    onChange={setAuthCaptchaMode}
                  />
                )}
              />
              <SettingRow
                asLabel
                label="Telegram 登录"
                description="默认开启。关掉后登录页不再显示 Telegram 登录，机器人发的网页登录链接、WebApp 自动登录、App 里的 Telegram 登录都不能用；机器人通知和账号绑定照旧。"
                control={<Checkbox aria-label="Telegram 登录" checked={telegramLoginEnabled} onCheckedChange={setTelegramLoginEnabled} />}
              />
              <SettingRow
                asLabel
                label="登录页「忘记密码」"
                description="默认开启。用户填用户名或邮箱，一次性重置链接发到他已验证的邮箱、已绑定的 Telegram / Discord（30 分钟有效）。需要先配好面板公开访问地址和至少一个发送渠道；账号没有找回方式时，页面提示联系管理员。"
                control={<Checkbox aria-label="登录页忘记密码" checked={passwordResetEnabled} onCheckedChange={setPasswordResetEnabled} />}
              />
            </SettingList>
            <div className="flex justify-end">
              <Button data-dock-save onClick={handleSaveRegistration} disabled={isSavingSetting("registration")}>
                保存注册与登录设置
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-4 w-4 text-primary" />
              双重验证
            </CardTitle>
            <CardDescription>
              账号可绑定 2FA 动态验证码。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow
                asLabel
                label="启用 2FA 软件支持"
                description="关闭后隐藏绑定入口。"
                control={<Checkbox aria-label="启用 2FA 软件支持" checked={twoFactorEnabled} onCheckedChange={setTwoFactorEnabled} />}
              />
            </SettingList>
            <div className="flex justify-end">
              <Button data-dock-save onClick={handleSaveTwoFactor} disabled={isSavingSetting("twoFactor")}>
                保存双重验证设置
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <GoogleLoginSettingsCard />

      <OidcLoginSettingsCard />

      <DiscordSettingsCard />

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4 text-primary" />
            DDNS 服务商
          </CardTitle>
          <CardDescription>
            转发组切换时同步更新域名。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="启用 DDNS"
              description="关闭后不更新域名。"
              control={<Checkbox aria-label="启用 DDNS" checked={ddnsEnabled} onCheckedChange={setDdnsEnabled} />}
            />
            <SettingRow
              label="服务商"
              description={(
                <>
                  选择用于同步域名的 DDNS 服务。
                  <a href={ddnsProviderGuideUrl(ddnsProvider)} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline">
                    配置教程
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </>
              )}
              control={(
                <Select value={ddnsProvider} onValueChange={(v) => setDdnsProvider(v as any)}>
                  <SelectTrigger aria-label="DDNS 服务商" className="w-40 sm:w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disabled">不使用</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare</SelectItem>
                    <SelectItem value="huaweicloud">华为云 DNS</SelectItem>
                    <SelectItem value="aliyun">阿里云 DNS</SelectItem>
                    <SelectItem value="tencentcloud">腾讯云 DNSPod</SelectItem>
                    <SelectItem value="webhook">自定义 Webhook</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </SettingList>

          <FormField className="space-y-2">
            <Label>TTL</Label>
            <Input
              value={ddnsTtl}
              onChange={(e) => setDdnsTtl(e.target.value.replace(/\D/g, "").slice(0, 5))}
              placeholder="60"
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground">
              TTL 范围：60-86400 秒，默认 60 秒；入口组故障切换最迟在一个 TTL 后被客户端看到。阿里云 / DNSPod 免费版最低 600 秒，设得更低时会自动按 600 秒提交。Webhook 会原样传递该值。
            </p>
          </FormField>

          <FormField className="space-y-2">
            <Label>规则专属域名后缀</Label>
            <Input
              value={ruleEntryDomainSuffix}
              onChange={(e) => setRuleEntryDomainSuffix(e.target.value)}
              placeholder="留空不启用，例如 node.example.com"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              填写后，绑定了订阅节点的规则各自获得一个 r&lt;规则ID&gt;.后缀 的域名，订阅里的节点地址改用它；规则换隧道或换入口主机时只改解析，客户端不用刷新订阅。后缀必须在上面服务商已托管的域名（区域）下；需要启用 DDNS 才生效，清空后会删除这些记录并改回入口地址。
            </p>
          </FormField>

          {ddnsProvider === "cloudflare" && (
            <div className="space-y-2">
              <FormField className="space-y-2">
                <Label>API Token</Label>
                <PasswordInput
                  value={ddnsCloudflareApiToken}
                  onChange={(e) => setDdnsCloudflareApiToken(e.target.value)}
                  placeholder={settings?.ddns?.cloudflareTokenMasked || "需要 Zone:Read + DNS:Edit 权限"}
                />
                <p className="text-xs text-muted-foreground">自动识别 Zone；Token 留空时保留原值。</p>
              </FormField>
            </div>
          )}

          {ddnsProvider === "huaweicloud" && (
            <div className="space-y-3">
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>Access Key ID</Label>
                  <Input value={ddnsHuaweiCloudAccessKeyId} onChange={(e) => setDdnsHuaweiCloudAccessKeyId(e.target.value)} placeholder="华为云 AK" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>Secret Access Key</Label>
                  <PasswordInput
                    value={ddnsHuaweiCloudSecretKey}
                    onChange={(e) => setDdnsHuaweiCloudSecretKey(e.target.value)}
                    placeholder={settings?.ddns?.huaweicloudSecretKeyMasked || "留空保留已保存密钥"}
                  />
                </FormField>
              </div>
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>公网 Zone ID</Label>
                  <Input value={ddnsHuaweiCloudZoneId} onChange={(e) => setDdnsHuaweiCloudZoneId(e.target.value)} placeholder="公网域名 Zone ID" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>区域</Label>
                  <Input value={ddnsHuaweiCloudRegion} onChange={(e) => setDdnsHuaweiCloudRegion(e.target.value)} placeholder="cn-north-4" />
                </FormField>
              </div>
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>默认线路</Label>
                  <Input value={ddnsHuaweiCloudLine} onChange={(e) => setDdnsHuaweiCloudLine(e.target.value)} placeholder="default_view" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input value={ddnsHuaweiCloudEndpoint} onChange={(e) => setDdnsHuaweiCloudEndpoint(e.target.value)} placeholder="留空使用区域默认 Endpoint" />
                </FormField>
              </div>
            </div>
          )}

          {ddnsProvider === "aliyun" && (
            <div className="space-y-3">
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>AccessKey ID</Label>
                  <Input value={ddnsAliyunAccessKeyId} onChange={(e) => setDdnsAliyunAccessKeyId(e.target.value)} placeholder="阿里云 AccessKey ID" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>AccessKey Secret</Label>
                  <PasswordInput
                    value={ddnsAliyunAccessKeySecret}
                    onChange={(e) => setDdnsAliyunAccessKeySecret(e.target.value)}
                    placeholder={settings?.ddns?.aliyunAccessKeySecretMasked || "留空保留已保存密钥"}
                  />
                </FormField>
              </div>
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>主域名</Label>
                  <Input value={ddnsAliyunDomainName} onChange={(e) => setDdnsAliyunDomainName(e.target.value)} placeholder="example.com" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input value={ddnsAliyunEndpoint} onChange={(e) => setDdnsAliyunEndpoint(e.target.value)} placeholder="https://alidns.aliyuncs.com" />
                </FormField>
              </div>
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>默认线路</Label>
                  <Input value={ddnsAliyunLine} onChange={(e) => setDdnsAliyunLine(e.target.value)} placeholder="default" />
                </FormField>
              </div>
            </div>
          )}

          {ddnsProvider === "tencentcloud" && (
            <div className="space-y-3">
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>SecretId</Label>
                  <Input value={ddnsTencentCloudSecretId} onChange={(e) => setDdnsTencentCloudSecretId(e.target.value)} placeholder="腾讯云 SecretId" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>SecretKey</Label>
                  <PasswordInput
                    value={ddnsTencentCloudSecretKey}
                    onChange={(e) => setDdnsTencentCloudSecretKey(e.target.value)}
                    placeholder={settings?.ddns?.tencentcloudSecretKeyMasked || "留空保留已保存密钥"}
                  />
                </FormField>
              </div>
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>主域名</Label>
                  <Input value={ddnsTencentCloudDomainName} onChange={(e) => setDdnsTencentCloudDomainName(e.target.value)} placeholder="example.com" />
                </FormField>
              </div>
              <div className="grid gap-3 @[42rem]:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>默认线路名称</Label>
                  <Input value={ddnsTencentCloudRecordLine} onChange={(e) => setDdnsTencentCloudRecordLine(e.target.value)} placeholder="默认" />
                </FormField>
                <FormField className="space-y-2">
                  <Label>默认线路 ID</Label>
                  <Input value={ddnsTencentCloudRecordLineId} onChange={(e) => setDdnsTencentCloudRecordLineId(e.target.value)} placeholder="可留空" />
                </FormField>
              </div>
            </div>
          )}

          {ddnsProvider === "webhook" && (
            <div className="space-y-3">
              <div className="grid gap-3 @[42rem]:grid-cols-[160px_minmax(0,1fr)]">
                <FormField className="space-y-2">
                  <Label>请求方法</Label>
                  <Select value={ddnsWebhookMethod} onValueChange={(v) => setDdnsWebhookMethod(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="GET">GET</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField className="space-y-2">
                  <Label>Webhook URL</Label>
                  <Input
                    value={ddnsWebhookUrl}
                    onChange={(e) => setDdnsWebhookUrl(e.target.value)}
                    placeholder="https://ddns.example.com/update?domain={{domain}}&value={{value}}"
                  />
                </FormField>
              </div>
              <FormField className="space-y-2">
                <div className="flex min-h-5 items-center justify-between gap-2">
                  <Label className="flex items-center gap-2">
                    请求头
                    {!!settings?.ddns?.webhookHeadersMasked && !ddnsWebhookHeadersClear && <Badge variant="secondary">已配置</Badge>}
                  </Label>
                  {!!settings?.ddns?.webhookHeadersMasked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => {
                        setDdnsWebhookHeadersClear((current) => !current);
                        setDdnsWebhookHeaders("");
                      }}
                    >
                      {ddnsWebhookHeadersClear ? "撤销清除" : "清除"}
                    </Button>
                  )}
                </div>
                <Textarea
                  value={ddnsWebhookHeaders}
                  onChange={(e) => {
                    setDdnsWebhookHeaders(e.target.value);
                    if (e.target.value.trim()) setDdnsWebhookHeadersClear(false);
                  }}
                  placeholder={ddnsWebhookHeadersClear
                    ? "保存后清除已保存的请求头"
                    : settings?.ddns?.webhookHeadersMasked
                      ? `${settings.ddns.webhookHeadersMasked}\n（已保存，留空保持不变；填写则整体替换）`
                      : '{"Authorization":"Bearer xxx"}'}
                  className="min-h-20 font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">支持 JSON 或每行一个 Header。已保存的内容不再显示原文。</p>
              </FormField>
            </div>
          )}

          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSaveDdns} disabled={isSavingSetting("ddns")}>
              {isSavingSetting("ddns") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("ddns") ? "保存中..." : "保存 DDNS 配置"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 记录管理用的是已保存的腾讯云凭据，所以按已保存的服务商判断，不看表单里还没存的选择 */}
      {settings?.ddns?.provider === "tencentcloud" && <DnspodRecordsCard />}

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Monitor className="h-4 w-4 text-primary" />
            主机监控配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="允许免登录查看主机监控"
              description="打开后，知道下面访问地址的人不用登录就能看主机状态。"
              control={<Checkbox aria-label="允许免登录查看主机监控" checked={publicHostMonitorEnabled} onCheckedChange={setPublicHostMonitorEnabled} />}
            />
          </SettingList>

          <div className="grid gap-3 @[42rem]:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
            <FormField className="space-y-2 @[42rem]:col-span-2">
              <Label>展示标题</Label>
              <Input
                value={publicHostMonitorTitle}
                onChange={(e) => setPublicHostMonitorTitle(e.target.value.slice(0, 80))}
                placeholder="留空默认使用站点标题 + 主机监控"
                maxLength={80}
              />
            </FormField>
            <FormField className="space-y-2">
              <Label>主机监控面板路径</Label>
              <Input
                value={publicHostMonitorPath}
                onChange={(e) => setPublicHostMonitorPath(e.target.value)}
                placeholder="dev"
              />
              <p className="text-xs text-muted-foreground">
                支持字母、数字、短横线和下划线。
              </p>
            </FormField>
            <FormField className="space-y-2">
              <Label>访问地址</Label>
              <div className="flex min-w-0 gap-2">
                <Input value={publicHostMonitorUrl} readOnly className="font-mono text-xs" />
                <Button type="button" variant="outline" size="icon" title="打开主机监控面板" asChild>
                  <a href={publicHostMonitorUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </FormField>
          </div>

          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSavePublicHostMonitor} disabled={isSavingSetting("hostMonitor")}>
              {isSavingSetting("hostMonitor") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("hostMonitor") ? "保存中..." : "保存主机监控配置"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 登录会话、左侧导航栏两张单行卡并成一张（标准布局重构工作包五） */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            会话与导航
          </CardTitle>
          <CardDescription>
            同一账户多设备在线的策略，以及左侧导航栏常用入口是否展示。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="允许多设备在线"
              description="关闭时后登录的设备会立即接管，正在使用的旧会话将退出；仅保留 Cookie 但未在使用的设备不会阻止新登录。"
              control={<Checkbox aria-label="允许多设备在线" checked={allowMultiDeviceLogin} onCheckedChange={setAllowMultiDeviceLogin} />}
            />
            <SettingRow
              asLabel
              label="新设备登录提醒"
              description="账号在没见过的设备或网络上登录时，用邮件和 Telegram 提醒本人；管理员账号还会记进事件时间线。每人每天最多 5 次。"
              control={<Checkbox aria-label="新设备登录提醒" checked={loginNewDeviceNotify} onCheckedChange={(value) => setLoginNewDeviceNotify(value === true)} />}
            />
            <SettingRow
              label="左侧导航栏常用入口"
              description="控制左侧导航栏常用入口是否展示。"
              control={(
                <span className="flex items-center gap-2">
                  <EnabledCount enabled={sidebarMenuEnabledCount} total={SIDEBAR_MENU_KEYS.length} />
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={openSidebarMenuDialog}>
                    <PanelLeft className="h-4 w-4" />
                    管理
                  </Button>
                </span>
              )}
            />
          </SettingList>
          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSaveSessionPolicy} disabled={isSavingSetting("sessionPolicy")}>
              {isSavingSetting("sessionPolicy") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("sessionPolicy") ? "保存中..." : "保存登录会话配置"}
            </Button>
          </div>
        </CardContent>
      </Card>


      <Dialog
        open={showForwardProtocolDialog}
        onOpenChange={(open) => {
          if (open) {
            openForwardProtocolDialog();
          } else {
            closeForwardProtocolDialog();
          }
        }}
      >
        <DialogContent className="flex max-h-[calc(100svh-1.5rem)] w-[calc(100vw-0.75rem)] max-w-[42rem] flex-col gap-3 overflow-hidden p-3 sm:max-h-[92svh] sm:w-full sm:max-w-3xl sm:p-6">
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              转发协议总开关
            </DialogTitle>
            <DialogDescription>
              开启或关闭可用协议。
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 overflow-y-auto overscroll-contain px-1 pb-1">
            <div className="grid gap-3 min-[360px]:grid-cols-2">
              <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
                <div>
                  <p className="text-sm font-medium">端口转发</p>
                  <p className="text-xs text-muted-foreground">端口转发工具开关。</p>
                </div>
                <div className="flex flex-col gap-2">
                  {directForwardProtocolKeys.map((key) => (
                    <div
                      key={key}
                      className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/40 bg-background/60 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm">{FORWARD_PROTOCOL_LABELS[key]}</span>
                      <Checkbox aria-label="端口转发" className="shrink-0" checked={forwardProtocols[key]} onCheckedChange={(checked) => setForwardProtocolEnabled(key, checked)} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
                <div>
                  <p className="text-sm font-medium">隧道协议</p>
                  <p className="text-xs text-muted-foreground">隧道模式开关。</p>
                </div>
                <div className="flex flex-col gap-2">
                  {tunnelForwardProtocolKeys.map((key) => (
                    <div
                      key={key}
                      className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/40 bg-background/60 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm">{FORWARD_PROTOCOL_LABELS[key]}</span>
                      <Checkbox aria-label="隧道协议" className="shrink-0" checked={forwardProtocols[key]} onCheckedChange={(checked) => setForwardProtocolEnabled(key, checked)} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/40 pt-3 sm:border-0 sm:pt-0">
            <Button variant="outline" onClick={closeForwardProtocolDialog}>
              取消
            </Button>
            <Button onClick={handleSaveForwardProtocols} disabled={isSavingSetting("forwardProtocols")}>
              保存协议开关
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showSidebarMenuDialog}
        onOpenChange={(open) => {
          if (open) {
            openSidebarMenuDialog();
          } else {
            closeSidebarMenuDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PanelLeft className="h-5 w-5 text-primary" />
              左侧导航栏菜单展示设置
            </DialogTitle>
            <DialogDescription>
              关闭后对应入口不再显示在左侧导航栏中，插件入口也在这里统一控制。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            {SIDEBAR_MENU_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2"
              >
                <span className="text-sm">{SIDEBAR_MENU_LABELS[key]}</span>
                <Checkbox aria-label={SIDEBAR_MENU_LABELS[key]} checked={sidebarMenu[key]} onCheckedChange={(checked) => setSidebarMenuEnabled(key, checked)} />
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={closeSidebarMenuDialog}>
              取消
            </Button>
            <Button onClick={handleSaveSidebarMenu} disabled={isSavingSetting("sidebarMenu")}>
              {isSavingSetting("sidebarMenu") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("sidebarMenu") ? "保存中..." : "保存菜单开关"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 @[58rem]:grid-cols-2 [&>*]:min-w-0">
        {/* 版本升级 */}
        <Card className="border-border bg-card">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <Rocket className="h-4 w-4 text-primary" />
                版本升级
              </CardTitle>
              <CardDescription>
                检查并升级 NEX。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow label="当前面板版本" control={<span className="font-mono text-secondary-type">v{upgradeStatus?.currentVersion || settings?.version}</span>} />
              <SettingRow label="当前 Agent 目标版本" control={<span className="font-mono text-secondary-type">v{upgradeStatus?.currentAgentVersion || settings?.agentVersion || "-"}</span>} />
              <SettingRow
                label="开源许可"
                description="NEX 按 AGPL-3.0 发布。对外提供服务时，需要让使用者能拿到对应版本的源代码。"
                control={
                  <a href="https://github.com/zhongyizhu11-jpg/NEX" target="_blank" rel="noreferrer" className="text-secondary-type text-primary underline-offset-4 hover:underline">
                    源代码与许可证
                  </a>
                }
              />
              <SettingRow
                asLabel
                label="自动检查更新"
                description="开启后定期检查面板和 Agent 更新。"
                control={(
                <OptimisticSwitch aria-label="自动检查更新"
                  checked={updateAutoCheckEnabled}
                  onCheckedChangeAsync={(checked) => updateAutoCheckMutation.mutateAsync({ updateAutoCheckEnabled: checked })}
                  onToggleSuccess={(checked) => {
                    setUpdateAutoCheckEnabled(checked);
                    utils.system.getSettings.invalidate();
                    utils.system.publicInfo.invalidate();
                    toast.success(`自动检查更新已${checked ? "开启" : "关闭"}`);
                  }}
                  onToggleError={(error) => toast.error(error instanceof Error ? error.message : "自动检查更新失败")}
                />
                )}
              />
            </SettingList>

          {updateInfo?.error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>检查更新失败</AlertTitle>
              <AlertDescription>{updateInfo.error}</AlertDescription>
            </Alert>
          )}

          {!upgradeEnabled && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{isDockerDeployment ? "Docker 部署请使用一键升级脚本" : "当前环境尚未启用一键升级"}</AlertTitle>
              <AlertDescription>
                {isDockerDeployment
                  ? "检查到新版本后可复制脚本到服务器执行，脚本会覆盖原有 NEX 容器。"
                  : <>配置 <code>FORWARDX_UPGRADE_COMMAND</code> 后可一键升级。</>}
              </AlertDescription>
            </Alert>
          )}

          {updateInfo?.hasUpdate && (
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Rocket className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-primary">发现新版本 {updateInfo.latestVersion}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      来源：{updateInfo.source === "release" ? "GitHub Release" : updateInfo.source === "tag" ? "GitHub Tag" : updateInfo.source === "main" ? "main 分支" : "GitHub"}
                      {updateInfo.publishedAt ? `，发布时间：${new Date(updateInfo.publishedAt).toLocaleString()}` : ""}
                      {updateInfo.latestAgentVersion ? `，Agent 目标：v${updateInfo.latestAgentVersion}` : ""}
                    </p>
                  </div>
                </div>
                <Badge className="w-fit">可升级</Badge>
              </div>
            </div>
          )}

          {updateInfo?.pendingReason && !updateInfo.error && (!updateInfo.hasUpdate || updateInfo.deployable === false) && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>新版本正在准备中</AlertTitle>
              <AlertDescription>{updateInfo.pendingReason}</AlertDescription>
            </Alert>
          )}

          {updateInfo && !updateInfo.error && !updateInfo.pendingReason && !updateInfo.hasUpdate && (
            <p className="text-meta text-muted-foreground">
              当前已是最新版本，上次检查时间：{new Date(updateInfo.checkedAt).toLocaleString()}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleCheckUpdate}
              disabled={checkingUpdate || isUpgradeRunning}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${checkingUpdate ? "forwardx-icon-spin" : ""}`} />
              检查更新
            </Button>
            <Button
              onClick={() => {
                if (!updateInfo?.latestVersion) {
                  toast.error("请先检查更新");
                  return;
                }
                if (isDockerDeployment) {
                  setShowDockerUpgradeScript(true);
                  return;
                }
                if (!upgradeEnabled) {
                  toast.error("未配置升级命令，无法自动升级");
                  return;
                }
                setShowUpgradeConfirm(true);
              }}
              disabled={!canStartPanelUpgrade || (!upgradeEnabled && !isDockerDeployment) || isUpgradeRunning || startUpgradeMutation.isPending}
              className="gap-2"
            >
              <Rocket className="h-4 w-4" />
              {isDockerDeployment ? "查看升级脚本" : "升级并重启"}
            </Button>
            <Button
              variant="outline"
              onClick={openRollbackDialog}
              disabled={isUpgradeRunning || startRollbackMutation.isPending}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              版本回退
            </Button>
          </div>

          {upgradeStatus?.job && upgradeStatus.job.status !== "idle" && (
            <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    upgradeStatus.job.status === "error"
                      ? "bg-destructive/10 text-destructive"
                      : upgradeStatus.job.status === "waiting_assets"
                        ? "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)]"
                      : upgradeStatus.job.status === "success"
                        ? "bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]"
                        : "bg-primary/10 text-primary"
                  }`}>
                    {upgradeStatus.job.status === "error" ? (
                      <AlertTriangle className="h-5 w-5" />
                    ) : upgradeStatus.job.status === "waiting_assets" ? (
                      <RefreshCw className="h-5 w-5" />
                    ) : upgradeStatus.job.status === "success" ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <Rocket className="h-5 w-5 animate-pulse" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">
                      {upgradeStatus.job.status === "success"
                        ? (upgradeStatus.job.mode === "rollback" ? "回退成功" : "升级成功")
                        : upgradeStatus.job.status === "waiting_assets"
                          ? "发布资产构建中"
                        : upgradeStatus.job.status === "error"
                          ? (upgradeStatus.job.mode === "rollback" ? "回退出现异常" : "升级出现异常")
                          : (upgradeStatus.job.mode === "rollback" ? "正在回退" : "正在升级")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {upgradeStatus.job.status === "success"
                        ? (upgradeStatus.restarted
                          ? `${upgradeProgress.label}，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`
                          : `已完成 ${upgradeStatus.job.targetVersion || ""} ${upgradeStatus.job.mode === "rollback" ? "回退" : "升级"}，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`)
                        : upgradeStatus.job.status === "waiting_assets"
                          ? "GitHub Actions 仍在生成面板安装包或镜像，请稍后重新检查更新"
                        : upgradeStatus.job.status === "error"
                          ? `${upgradeStatus.job.mode === "rollback" ? "回退" : "升级"}未完成，请查看下方异常信息`
                          : upgradeProgress.label}
                    </p>
                  </div>
                </div>
                <Badge variant={upgradeStatus.job.status === "error" ? "destructive" : "outline"} className={`w-fit ${upgradeStatus.job.status === "waiting_assets" ? "border-[color-mix(in_srgb,var(--fx-warn)_30%,transparent)] text-[var(--fx-warn-text)]" : ""}`}>
                  {upgradeStatus.job.targetVersion}
                </Badge>
              </div>

              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0">{upgradeProgress.label}</span>
                  <span className="shrink-0 tabular-nums">{upgradeProgress.percent}%</span>
                </div>
                {upgradeProgress.detail && (
                  <p className="text-xs tabular-nums text-muted-foreground">{upgradeProgress.detail}</p>
                )}
                <Progress value={upgradeProgress.percent} className="h-2" />
                <div className={`grid gap-2 ${upgradeProgress.steps.length === 5 ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
                  {upgradeProgress.steps.map((step) => (
                    <div
                      key={step.label}
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        step.done
                          ? "border-[color-mix(in_srgb,var(--fx-healthy)_25%,transparent)] bg-[var(--fx-healthy-soft)] text-[var(--fx-healthy-text)]"
                          : step.active
                            ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border/40 bg-background/40 text-muted-foreground"
                      }`}
                    >
                      {step.label}
                    </div>
                  ))}
                </div>
              </div>

              {upgradeStatus.job.status === "waiting_assets" && (
                <div className="mt-4 space-y-2">
                  {upgradeStatus.job.error && (
                    <Alert>
                      <RefreshCw className="h-4 w-4" />
                      <AlertTitle>等待发布资产</AlertTitle>
                      <AlertDescription>{upgradeStatus.job.error}</AlertDescription>
                    </Alert>
                  )}
                  <pre className="max-h-52 overflow-auto rounded-lg border border-[color-mix(in_srgb,var(--fx-warn)_25%,transparent)] bg-[color-mix(in_srgb,var(--fx-warn)_5%,transparent)] p-3 text-xs leading-relaxed text-muted-foreground">
                    {upgradeErrorLogs || "正在等待 GitHub Actions 构建发布资产"}
                  </pre>
                </div>
              )}

              {upgradeStatus.job.status === "error" && (
                <div className="mt-4 space-y-2">
                  {upgradeStatus.job.error && (
                    <p className="text-xs font-medium text-destructive">{upgradeStatus.job.error}</p>
                  )}
                  <pre className="max-h-64 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
                    {upgradeErrorLogs || "暂无异常日志"}
                  </pre>
                  <div className="rounded-lg border border-destructive/25 bg-background/80 p-3 text-xs">
                    <p className="font-medium text-destructive">自动任务失败时，可在服务器执行以下命令：</p>
                    <div className="mt-2 space-y-2">
                      {manualPanelUpgradeCommands.map((item) => (
                        <div key={item.label} className="space-y-1">
                          <span className="text-muted-foreground">{item.label}</span>
                          <code className="block overflow-x-auto rounded border bg-muted/30 p-2 font-mono text-[11px] text-foreground">
                            {item.command}
                          </code>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* 项目地址、使用教程、联系方式原来是单独一张「开源与联系」卡，和这里的版本号是一回事，并过来（标准布局重构工作包五） */}
          <SettingList>
            {contactLinks.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.label}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fx-list-row group flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <Icon className={`h-4 w-4 shrink-0 ${item.iconClassName}`} aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-secondary-type font-medium text-foreground group-hover:underline">{item.label}</span>
                    <span className="truncate font-mono text-meta text-muted-foreground">{item.url}</span>
                    {item.description && <span className="text-meta text-muted-foreground">{item.description}</span>}
                  </span>
                  <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </a>
              );
            })}
            <SettingRow label="Android APP" control={<span className="font-mono text-secondary-type">v{settings?.androidAppVersion}</span>} />
          </SettingList>
        </CardContent>
      </Card>
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Github className="h-4 w-4 text-primary" />
            GitHub 下载加速
          </CardTitle>
          <CardDescription>
            配置 Agent 安装、升级与面板更新访问 GitHub 的方式。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="启用 GitHub 加速地址"
              description="开启并填写地址后，GitHub 真实地址会拼接在加速地址后面。"
              control={<Checkbox aria-label="启用 GitHub 加速地址" checked={githubAcceleratorEnabled} onCheckedChange={setGithubAcceleratorEnabled} />}
            />
            <SettingRow
              asLabel
              label="优先连接面板安装 Agent"
              description="开启后 Agent 程序先从面板下载，失败后回退 GitHub。安装脚本总是先从面板拉；主机连不上 GitHub 时会自动走面板。"
              control={<Checkbox aria-label="优先连接面板安装 Agent" checked={agentPreferPanelInstall} onCheckedChange={setAgentPreferPanelInstall} />}
            />
            <SettingRow
              asLabel
              label="面板更新使用加速站"
              description="版本检查、Release 安装包、版本回退和升级脚本优先使用加速地址，失败时自动回退直连。"
              control={<Checkbox aria-label="面板更新使用加速站" checked={githubAcceleratorPanelUpdateEnabled} onCheckedChange={setGithubAcceleratorPanelUpdateEnabled} />}
            />
          </SettingList>
          <FormField className="space-y-2">
            <Label>GitHub 加速地址</Label>
            <Input
              value={githubAcceleratorUrlInput}
              onChange={(e) => setGithubAcceleratorUrlInput(e.target.value)}
              placeholder={githubAcceleratorUrlPlaceholder}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              格式示例：https://mirror.example.com。未填写或未开启对应开关时使用直连 GitHub。
            </p>
          </FormField>
          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSaveAgentInstall} disabled={isSavingSetting("agentInstall")}>
              保存 GitHub 下载配置
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Agent 认证
          </CardTitle>
          <CardDescription>
            现在的 Agent 每个请求都带签名；很老的 Agent 还在请求头里直接发明文 Token。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              asLabel
              label="拒绝旧式 Agent 认证"
              description={legacyAgentAuthHosts.data?.length
                ? `最近还有 ${legacyAgentAuthHosts.data.length} 台主机在用旧式认证：${legacyAgentAuthHosts.data.slice(0, 5).map((item) => item.name).join("、")}${legacyAgentAuthHosts.data.length > 5 ? " 等" : ""}。打开后它们会连不上面板，请先升级这些主机的 Agent。`
                : "打开后只接受签名认证，还在发明文 Token 的旧 Agent 会连不上面板。面板重启以来没有主机用过旧式认证。"}
              control={<Checkbox aria-label="拒绝旧式 Agent 认证" checked={agentLegacyAuthRejected} onCheckedChange={(checked) => setAgentLegacyAuthRejected(checked === true)} />}
            />
          </SettingList>
          <div className="flex justify-end">
            <Button data-dock-save onClick={handleSaveAgentAuth} disabled={isSavingSetting("agentAuth")}>
              {isSavingSetting("agentAuth") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("agentAuth") ? "保存中..." : "保存 Agent 认证配置"}
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>

      <Dialog open={showUpgradeConfirm} onOpenChange={setShowUpgradeConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              确认升级并重启
            </DialogTitle>
            <DialogDescription>
              即将升级到 {updateInfo?.latestVersion}。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/40 bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">当前版本</span>
              <code>v{upgradeStatus?.currentVersion || settings?.version}</code>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-muted-foreground">目标版本</span>
              <code>{updateInfo?.latestVersion}</code>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowUpgradeConfirm(false)}>
              取消
            </Button>
            <Button
              className="gap-2"
              disabled={startUpgradeMutation.isPending || isUpgradeRunning}
              onClick={() => {
                if (!updateInfo?.latestVersion) return;
                setShowUpgradeConfirm(false);
                startUpgradeMutation.mutate({ targetVersion: updateInfo.latestVersion });
              }}
            >
              <Rocket className="h-4 w-4" />
              确认升级
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRollbackDialog} onOpenChange={setShowRollbackDialog}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              版本回退
            </DialogTitle>
            <DialogDescription>
              选择最近 5 个以内的可回退版本。
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={rollbackType}
            onValueChange={(value) => {
              setRollbackType(value === "agent" ? "agent" : "panel");
              setSelectedRollbackVersion("");
            }}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="panel">面板</TabsTrigger>
              <TabsTrigger value="agent">Agent</TabsTrigger>
            </TabsList>

            {rollbackVersionsQuery.data?.error && (
              <Alert variant="destructive" className="mt-4">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>获取版本失败</AlertTitle>
                <AlertDescription>{rollbackVersionsQuery.data.error}</AlertDescription>
              </Alert>
            )}

            <TabsContent value="panel" className="mt-4 space-y-4">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前面板版本</span>
                  <code>v{rollbackVersionsQuery.data?.currentPanelVersion || upgradeStatus?.currentVersion || settings?.version}</code>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前兼容 Agent</span>
                  <code>v{rollbackVersionsQuery.data?.currentAgentVersion || settings?.agentVersion || "-"}</code>
                </div>
              </div>

              <FormField className="space-y-2">
                <Label>回退到面板版本</Label>
                <Select
                  value={rollbackType === "panel" ? selectedRollbackVersion : ""}
                  onValueChange={setSelectedRollbackVersion}
                  disabled={rollbackVersionsQuery.isLoading || rollbackPanelVersions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rollbackVersionsQuery.isLoading ? "正在获取 GitHub 版本..." : "选择面板版本"} />
                  </SelectTrigger>
                  <SelectContent>
                    {rollbackPanelVersions.map((item: any) => (
                      <SelectItem key={item.panelVersion} value={item.panelVersion}>
                        v{item.panelVersion}{item.compatibleAgentVersion ? ` / Agent v${item.compatibleAgentVersion}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {rollbackPanelVersions.length === 0 && !rollbackVersionsQuery.isLoading && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>暂无可回退面板版本</AlertTitle>
                  <AlertDescription>未从 GitHub Release 获取到低于当前版本的最近 5 个版本。</AlertDescription>
                </Alert>
              )}

              {selectedRollbackTarget && (
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                  目标版本：v{(selectedRollbackTarget as any).panelVersion}
                  {(selectedRollbackTarget as any).publishedAt ? `，发布时间：${new Date((selectedRollbackTarget as any).publishedAt).toLocaleString()}` : ""}
                </div>
              )}

              {!canRunPanelRollback && selectedRollbackPanelCommand && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>当前环境请使用脚本回退</AlertTitle>
                  <AlertDescription>
                    后台未启用一键回退或当前为 Docker 部署，请在服务器执行下方命令。
                  </AlertDescription>
                </Alert>
              )}
              {!canRunPanelRollback && selectedRollbackPanelCommand && (
                <code className="block max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                  {selectedRollbackPanelCommand}
                </code>
              )}
            </TabsContent>

            <TabsContent value="agent" className="mt-4 space-y-4">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前面板内置 Agent</span>
                  <code>v{rollbackVersionsQuery.data?.currentAgentVersion || settings?.agentVersion || "-"}</code>
                </div>
              </div>

              <FormField className="space-y-2">
                <Label>回退到 Agent 版本</Label>
                <Select
                  value={rollbackType === "agent" ? selectedRollbackVersion : ""}
                  onValueChange={setSelectedRollbackVersion}
                  disabled={rollbackVersionsQuery.isLoading || rollbackAgentVersions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rollbackVersionsQuery.isLoading ? "正在获取 GitHub 版本..." : "选择 Agent 版本"} />
                  </SelectTrigger>
                  <SelectContent>
                    {rollbackAgentVersions.map((item: any) => (
                      <SelectItem key={`${item.agentVersion}:${item.panelVersion}`} value={item.agentVersion}>
                        Agent v{item.agentVersion} / Release v{item.panelVersion}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              {rollbackAgentVersions.length === 0 && !rollbackVersionsQuery.isLoading && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>暂无可回退 Agent 版本</AlertTitle>
                  <AlertDescription>未从最近 5 个面板 Release 中获取到低于当前 Agent 的版本。</AlertDescription>
                </Alert>
              )}

              {selectedRollbackTarget && (
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                  将下发 Agent v{(selectedRollbackTarget as any).agentVersion}，资产来源 Release v{(selectedRollbackTarget as any).panelVersion}。
                </div>
              )}
            </TabsContent>
          </Tabs>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowRollbackDialog(false)}>
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => refreshRollbackVersions()}
              disabled={rollbackVersionsQuery.isFetching}
            >
              {rollbackVersionsQuery.isFetching ? "刷新中..." : "刷新版本"}
            </Button>
            <Button
              className="gap-2"
              disabled={
                rollbackVersionsQuery.isLoading ||
                !selectedRollbackVersion ||
                startRollbackMutation.isPending ||
                isUpgradeRunning
              }
              onClick={() => {
                if (!selectedRollbackVersion) return;
                if (rollbackType === "panel" && !canRunPanelRollback) {
                  copyTextWithToast(selectedRollbackPanelCommand);
                  return;
                }
                startRollbackMutation.mutate({ type: rollbackType, targetVersion: selectedRollbackVersion });
              }}
            >
              <RefreshCw className={`h-4 w-4 ${startRollbackMutation.isPending ? "forwardx-icon-spin" : ""}`} />
              {rollbackType === "panel" && !canRunPanelRollback ? "复制回退脚本" : "确认回退"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDockerUpgradeScript} onOpenChange={setShowDockerUpgradeScript}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              Docker 一键升级脚本
            </DialogTitle>
            <DialogDescription>
              检测到新版本 {updateInfo?.latestVersion || ""}，请在服务器执行以下命令升级 Docker 部署。
            </DialogDescription>
          </DialogHeader>
          {updateInfo?.pendingReason && !updateInfo.error && updateInfo.deployable === false && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Docker 镜像可能仍在构建</AlertTitle>
              <AlertDescription>{updateInfo.pendingReason}</AlertDescription>
            </Alert>
          )}
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>升级会重建原有 NEX 容器</AlertTitle>
            <AlertDescription>
              脚本会复用当前部署目录的 .env 配置，只重建容器，不删除 Docker 数据卷；原有数据库和 /data 数据会保留。
            </AlertDescription>
          </Alert>
          <code className="block max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {dockerPanelUpgradeCommand}
          </code>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDockerUpgradeScript(false)}>
              关闭
            </Button>
            <Button className="gap-2" onClick={() => copyTextWithToast(dockerPanelUpgradeCommand)}>
              <Copy className="h-4 w-4" />
              复制脚本
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
