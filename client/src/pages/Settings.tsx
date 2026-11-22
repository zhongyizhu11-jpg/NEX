

import WorkspaceHeader from "@/components/WorkspaceHeader";

import { useAuth } from "@/_core/hooks/useAuth";
import { useUrlTab } from "@/hooks/useUrlTab";

import { settingsGroups, settingsTabDetail, settingsTabItems, settingsTabs, type SettingsTab } from "./settingsSections";
import DashboardLayout from "@/components/DashboardLayout";
import { EmailSettingsContent } from "./EmailSettings";

import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList } from "@/components/ui/sliding-tabs";
import { GroupedList, ListRow, ListSection } from "@/components/ios/GroupedList";

import { useIsMobile } from "@/hooks/useMobile";

import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";

import { cn } from "@/lib/utils";

import { ChevronLeft } from "lucide-react";
import { OpsAdvancedSettingsPane, OpsBackupExtraSections, OpsTelegramExtraSections, OpsWebhookSettingsPane } from "@/features/ops/slots/SettingsPanes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { useState, useEffect, lazy, Suspense } from "react";
import RouteFallback from "@/components/RouteFallback";
import { SaveDockBar, SaveDockProvider } from "@/components/settings/SaveDock";

import { useLocation } from "wouter";
const PanelLogsSection = lazy(() => import("@/components/settings/PanelLogsSection"));
const TelegramBotSettingsCard = lazy(() => import("@/components/settings/TelegramBotSettingsCard"));
const DeepSeekSettingsCard = lazy(() => import("@/components/settings/DeepSeekSettingsCard"));
const BackupRestoreSection = lazy(() => import("@/components/settings/BackupRestoreSection"));

const PersonalizationSettingsSection = lazy(() => import("@/components/settings/PersonalizationSettingsSection"));
const SystemInfoSection = lazy(() => import("@/components/settings/SystemInfoSection"));

const SETTINGS_TAB_STORAGE_KEY = "forwardx.settings.tab";

function isSettingsTab(tab: string | null): tab is SettingsTab {
  return !!tab && settingsTabs.includes(tab as SettingsTab);
}

function SettingsContent() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  /*
    系统设置是最后一个还在手写 tab 判定的页，而那份手写的是坏的。

    原来是 `useLocation()` 里 split("?") 取查询串 —— wouter 的那个值**只有路径**，
    问号后面的部分根本不在里面，于是 `/settings?tab=email` 永远落回「系统配置」。
    地址栏明明写着 email，页面却是系统配置；发链接给人说「去邮箱那个 tab 看一下」，
    对方点开看到的是另一屏。别的七个带 tab 的页上一版已经统一到 useUrlTab 了，
    这一页漏了，现在补上。
  */
  const isMobile = useIsMobile();
  /*
    手机上是否已经进到某个分区里。默认在索引，点一项才进去。

    桌面上这个状态不参与渲染 —— 那边永远是标签条，一次点到位。
  */
  // 从「更多」页带着 ?tab= 进来（More.tsx）就直接进那个分区，不先停在索引
  const [mobileSectionOpen, setMobileSectionOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("tab"));
  const [activeTab, setActiveTab] = useUrlTab<SettingsTab>({
    values: settingsTabs,
    defaultValue: "system",
    storageKey: SETTINGS_TAB_STORAGE_KEY,
  });
  useEffect(() => {
    if (user && user.role !== "admin") {
      setLocation("/");
    }
  }, [user, setLocation]);

  const handleTabChange = (tab: string) => {
    if (!isSettingsTab(tab)) return;
    setActiveTab(tab);
  };

  // 面板地址统一使用「系统配置」Tab 中配置的 panelPublicUrl；未配置时回退当前面板地址（App 里是登录时填的地址）
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const panelUrl = (systemSettings?.panelPublicUrl && systemSettings.panelPublicUrl.trim())
    || mobileAuth.panelOrigin();
  if (user?.role !== "admin") return null;

  const activeItem = settingsTabItems.find((tab) => tab.value === activeTab);
  const visibleSettingsTabItems = settingsTabItems;
  /*
    同一份分组画两个地方：手机上的索引页、宽屏左边的分区栏。两处的区别只在
    「选中的那一行要不要标出来、要不要箭头」—— 索引页点进去是下一层（画箭头），
    分区栏点了内容就在右边（不画箭头，标出正在看的那一项）。
  */
  const renderSectionNav = (mode: "index" | "rail") => (
    <GroupedList className={mode === "rail" ? "gap-[var(--fx-space-4)]" : undefined}>
      {settingsGroups.map((group) => (
        <ListSection key={group.key} header={group.header} footer={mode === "index" ? (group as { footer?: string }).footer : undefined}>
          {group.items.map((value) => {
            const item = visibleSettingsTabItems.find((tab) => tab.value === value);
            if (!item) return null;
            const Icon = item.icon;
            return (
              <ListRow
                key={value}
                icon={<Icon className="h-4 w-4" />}
                label={item.label}
                detail={mode === "index" ? settingsTabDetail[value] : undefined}
                selected={mode === "rail" && activeTab === value}
                chevron={mode === "index"}
                onSelect={() => {
                  handleTabChange(value);
                  if (mode === "index") setMobileSectionOpen(true);
                }}
              />
            );
          })}
        </ListSection>
      ))}
    </GroupedList>
  );

  return (
    /* fx-set-pearl：系统设置在所有主题下都照「珍珠」的卡片画（2026-11 用户要求），样式在 styles/overview-pearl.css */
    <div className="fx-set-pearl space-y-6">
      <WorkspaceHeader title="系统设置" description="配置面板、通知、外观与数据维护。" />
      {/*
        密钥类设置落库是加密的（server/settingsEncryption.ts），密钥是面板的 JWT_SECRET / jwt.secret。
        数据库文件被直接拷到另一台机器、两边密钥又不同时，这几项解不开：说清楚是哪几项、要重新填。
      */}
      {systemSettings && "undecryptableSecretSettings" in systemSettings && systemSettings.undecryptableSecretSettings.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>有 {systemSettings.undecryptableSecretSettings.length} 项设置需要重新填写</AlertTitle>
          <AlertDescription>
            {"面板密钥（JWT_SECRET / 数据目录下的 jwt.secret）和保存这些设置时不一样，例如数据库被直接拷到了新服务器，"
              + `下面几项已经读不出来，按空值处理：${systemSettings.undecryptableSecretSettings.join("、")}。`
              + "在对应的设置里重新填写保存即可；以后迁移面板请用「备份恢复」或「面板迁移」，不会再出现这个问题。"}
          </AlertDescription>
        </Alert>
      ) : null}

      {/*
        三种宽度，三种导航：

        - 手机：分组列表当索引，点一项进去，顶上一条「全部设置」回来。标签条在这一页
          已经到极限了（六项挤满一行，第七项就得滚动），而设置是只会越来越多的那种页面。
        - 中等宽度：顶部标签条，一次点到位。
        - 宽屏：左边一栏分区、右边内容（Master–Detail）。原来 1280 上标签条横跨整页，
          下面的卡片也横跨整页，一张「网络测试」卡片宽 470px 里只有一个复选框；而分组
          （「Telegram 和邮箱都是通知」）只有手机上看得见。左边这一栏把分组也带到桌面，
          右边的内容区收窄到一个表单该有的宽度。

        宽屏与否看的是**这一页自己有多宽**（容器查询），不是窗口多宽：侧栏收起来时，
        1024 的窗口里这一页也有 900 多像素，够放两栏；侧栏展开时 1152 的窗口里只剩 830，
        放两栏右边就窄了。按窗口宽度判断，这两种情况会各错一次。
      */}
      {isMobile && !mobileSectionOpen ? (
        renderSectionNav("index")
      ) : (
      <Tabs value={activeTab} onValueChange={handleTabChange} className="@container/settings">
        <div className="@min-[56rem]/settings:grid @min-[56rem]/settings:grid-cols-[14rem_minmax(0,1fr)] @min-[56rem]/settings:items-start @min-[56rem]/settings:gap-6">
          <nav aria-label="设置分区" className="hidden @min-[56rem]/settings:sticky @min-[56rem]/settings:top-8 @min-[56rem]/settings:block">
            {renderSectionNav("rail")}
          </nav>

          {/*
            右边这一栏自己也是一个容器：里面各分区原来按窗口宽度切的两列（lg:/xl:），
            都改成按这一栏的宽度切 —— 左边多了一栏之后，窗口 1280 时右边只有 700 多像素，
            还按窗口算的话，两张表单卡会被并排挤成两条 340px 的窄条。

            换算按「原来那个断点下，内容区实际有多宽」：侧栏展开时窗口 1024（lg）的内容区
            704px，有滚动条时实测 694 → @[42rem]（672）；窗口 1280（xl）约 960，有滚动条时
            945 左右 → @[58rem]（928）。门槛各往下留了一点，给滚动条：第一版按 704 整数卡，
            1024 上差 10px 没切成两列，排法和原来不一样了。所以没有左栏的那几种宽度下，
            各分区的排法和原来一样；有左栏时，右边 700 像素上表单字段仍然两列，整张卡片
            不再并排。
          */}
          <div className="@container min-w-0 space-y-4">
            {isMobile ? (
              /*
                进到某一分区之后给一条返回 —— 列表导航必须能回去，
                否则用户只能按浏览器后退，而那会连带退出整个设置页。
              */
              <button
                type="button"
                onClick={() => setMobileSectionOpen(false)}
                className="flex items-center gap-1 text-secondary-type text-[var(--fx-text-secondary)]"
              >
                <ChevronLeft className="h-4 w-4" />
                全部设置
              </button>
            ) : (
              <div className="@min-[56rem]/settings:hidden">
                <SlidingTabsList items={visibleSettingsTabItems} activeValue={activeTab} ariaLabel="系统设置" minItemWidthRem={7.5} />
              </div>
            )}

            {/*
              分区标题：手机上进到分区之后、宽屏右边那一栏的顶上。标签条那种宽度不画 ——
              选中的那一格已经写着是哪一项了。
            */}
            {activeItem ? (
              <div className={cn("min-w-0", isMobile ? "block" : "hidden @min-[56rem]/settings:block")}>
                <h2 className="fx-pane-title">{activeItem.label}</h2>
                <div data-fx-help="" className="mt-0.5 text-meta text-muted-foreground">{settingsTabDetail[activeTab]}</div>
              </div>
            ) : null}

            {/*
              fx-settings-pane：玫瑰主题下这几页改成「编号分节」（每张卡去掉框，变成 01、02… 一节一节往下，
              见 theme-rose.css），卡里各自的保存按钮交给底下那条贴底保存栏（SaveDockBar）。别的主题下不变。
            */}
            <SaveDockProvider>
              <TabsContent value="system" className="fx-settings-pane space-y-4">
                <Suspense fallback={<RouteFallback />}><SystemInfoSection /></Suspense>
              </TabsContent>

              <TabsContent value="telegram" className="fx-settings-pane space-y-4">
                <Suspense fallback={<RouteFallback />}><TelegramBotSettingsCard /></Suspense>
                <Suspense fallback={<RouteFallback />}><DeepSeekSettingsCard /></Suspense>
                <OpsTelegramExtraSections />
              </TabsContent>

              <TabsContent value="email" className="fx-settings-pane space-y-4">
                <EmailSettingsContent />
              </TabsContent>

              <TabsContent value="personalization" className="fx-settings-pane space-y-4">
                <Suspense fallback={<RouteFallback />}><PersonalizationSettingsSection /></Suspense>
              </TabsContent>

              <TabsContent value="backup" className="fx-settings-pane space-y-4">
                <Suspense fallback={<RouteFallback />}><BackupRestoreSection panelUrl={panelUrl} /></Suspense>
                <OpsBackupExtraSections />
              </TabsContent>

              <TabsContent value="logs" className="fx-settings-pane space-y-4">
                <Suspense fallback={<RouteFallback />}><PanelLogsSection /></Suspense>
              </TabsContent>

              <TabsContent value="advanced" className="fx-settings-pane space-y-4">
                <OpsAdvancedSettingsPane />
              </TabsContent>

              <TabsContent value="webhook" className="fx-settings-pane space-y-4">
                <OpsWebhookSettingsPane />
              </TabsContent>

              <SaveDockBar />
            </SaveDockProvider>
          </div>
        </div>
      </Tabs>
      )}

    </div>
  );
}

export default function Settings() {
  return (
    <DashboardLayout>
      <SettingsContent />
    </DashboardLayout>
  );
}
