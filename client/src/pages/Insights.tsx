import { Activity, Ban, Globe2, ShieldAlert, Users2 } from "lucide-react";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { useUrlTab } from "@/hooks/useUrlTab";
import { useOpsFeatures } from "@/features/ops/useOpsFeatures";
import OnlineIpsTab from "@/features/ops/online/OnlineIpsTab";
import EventsTab from "@/features/ops/events/EventsTab";
import SecurityTab from "@/features/ops/security/SecurityTab";
import BlockedIpsTab from "@/features/ops/firewall/BlockedIpsTab";
import CountryRuleTab from "@/features/ops/firewall/CountryRuleTab";
import NotFound from "@/pages/NotFound";

/*
  监控（第五套主题「朱砂」专属，借鉴 Rosélune 的 Monitor + Access 两页）：
  谁在连、发生了什么、机器安不安全、挡了谁。一页五个分段，每段一个独立组件，
  各自在 client/src/features/ops/ 里。别的主题下这一页不存在（侧栏没有入口，直接打开是 404）。
*/
const INSIGHTS_TABS = ["online", "events", "security", "blocked", "countries"] as const;
type InsightsTab = typeof INSIGHTS_TABS[number];

const INSIGHTS_TAB_ITEMS: SlidingTabItem<InsightsTab>[] = [
  { value: "online", label: "在线 IP", icon: Users2 },
  { value: "events", label: "事件", icon: Activity },
  { value: "security", label: "安全巡检", icon: ShieldAlert },
  { value: "blocked", label: "IP 封禁", icon: Ban },
  { value: "countries", label: "地区规则", icon: Globe2 },
];

export default function InsightsPage() {
  const enabled = useOpsFeatures();
  const [activeTab, setActiveTab] = useUrlTab<InsightsTab>({
    values: INSIGHTS_TABS,
    defaultValue: "online",
    storageKey: "forwardx.insights.tab",
  });
  if (!enabled) return <NotFound />;
  return (
    <div className="space-y-6">
      <WorkspaceHeader title="监控" description="谁在连、从哪里来、发生了什么，以及哪些连接被挡在外面。" />
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as InsightsTab)}>
        <SlidingTabsList items={INSIGHTS_TAB_ITEMS} activeValue={activeTab} ariaLabel="监控" minItemWidthRem={6.5} />
        <TabsContent value="online" className="mt-4"><OnlineIpsTab /></TabsContent>
        <TabsContent value="events" className="mt-4"><EventsTab /></TabsContent>
        <TabsContent value="security" className="mt-4"><SecurityTab /></TabsContent>
        <TabsContent value="blocked" className="mt-4"><BlockedIpsTab /></TabsContent>
        <TabsContent value="countries" className="mt-4"><CountryRuleTab /></TabsContent>
      </Tabs>
    </div>
  );
}
