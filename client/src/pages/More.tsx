import { ChevronRight, LogOut } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import {
  GroupedList,
  ListRow,
  ListSection,
} from "@/components/ios/GroupedList";
import { useMobileNav } from "@/components/ios/navigationContext";
import { settingsGroups, settingsTabItems } from "./settingsSections";

/**
 * 「更多」页。
 *
 * 它是标签栏第五格点进来的地方，也是**抽屉的替代品** —— 所以它必须是完整的：
 * 凡是侧边栏上有的，这里都要找得到。少一项，那一项在手机上就等于不存在了。
 *
 * 形态是 iOS 分组列表：一组一块白，组上面一行小标题。功能多正是它擅长的场合，
 * 加一项就是多一行，不像横向标签条加到第七个就开始滚动。
 */
export default function MorePage() {
  /*
    内容必须是单独一个组件。

    context 是按树的位置取的，而 MorePage 是 DashboardLayout 的**父**节点 ——
    在 MorePage 体内调 useMobileNav() 拿到的永远是 null（第一版实测手机上
    「更多」页显示的是桌面端那句兜底文案）。把内容拆成子组件，它才真的在
    Provider 里面。
  */
  return (
    <DashboardLayout>
      <WorkspaceHeader title="更多" />
      <MoreContent />
    </DashboardLayout>
  );
}

function MoreContent() {
  const nav = useMobileNav();

  if (!nav) {
    /*
      桌面端没有标签栏，也就没有「更多」这个概念 —— 直接说清楚，不要画一个
      空列表让人以为自己权限不够。
    */
    return (
      <p className="py-8 text-center text-secondary-type text-muted-foreground">
        「更多」是手机端的功能入口。在这个宽度上，左侧边栏已经列出了全部功能。
      </p>
    );
  }

  /*
    按 group 分块，保持 DashboardLayout 给的顺序 —— 侧边栏什么顺序，这里就
    什么顺序，不要在这里重新排一遍。
  */
  /*
    系统设置不再是一行入口，它的八个分区（通用 / 通知 / 维护）直接列在下面（2026-10-21 用户要的）：
    手机上少点一层；「偏好」那一组（搜索、深色外观）去掉 —— 顶栏上就有搜索和调色盘。
  */
  const canOpenSettings = nav.overflow.some((item) => item.path === "/settings");
  const groups: { name: string; items: typeof nav.overflow }[] = [];
  for (const item of nav.overflow) {
    if (item.path === "/settings") continue;
    const name = item.group || "功能";
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(item);
    else groups.push({ name, items: [item] });
  }

  return (
    <GroupedList className="pb-2">
      <ListSection header="账户">
        <ListRow
          icon={nav.account.avatar}
          label={nav.account.name}
          detail={nav.account.detail}
          onSelect={() =>
            nav.navigate({
              path: "/profile",
              label: "个人资料",
              icon: ChevronRight,
            })
          }
        />
      </ListSection>

      {groups.map((group) => (
        <ListSection key={group.name} header={group.name}>
          {group.items.map((item) => (
            <ListRow
              key={item.path}
              icon={<item.icon className="h-5 w-5" aria-hidden="true" />}
              label={item.label}
              detail={item.badge ? `${item.badge} 张待处理` : undefined}
              onSelect={() => nav.navigate(item)}
            />
          ))}
        </ListSection>
      ))}

      {canOpenSettings ? settingsGroups.map((group) => (
        <ListSection key={`settings-${group.key}`} header={group.header}>
          {group.items.map((value) => {
            const item = settingsTabItems.find((tab) => tab.value === value);
            if (!item) return null;
            const Icon = item.icon;
            return (
              <ListRow
                key={value}
                icon={<Icon className="h-5 w-5" aria-hidden="true" />}
                label={item.label}
                onSelect={() => nav.navigate({ path: `/settings?tab=${value}`, label: item.label, icon: Icon })}
              />
            );
          })}
        </ListSection>
      )) : null}

      <ListSection>
        <ListRow
          icon={<LogOut className="h-5 w-5" aria-hidden="true" />}
          label={<span className="text-[var(--fx-down)]">退出登录</span>}
          onSelect={nav.onLogout}
        />
      </ListSection>
    </GroupedList>
  );
}
