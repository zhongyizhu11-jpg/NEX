import { ChevronRight, LogOut, Moon, Search, Sun } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import {
  GroupedList,
  ListRow,
  ListSection,
} from "@/components/ios/GroupedList";
import { useMobileNav } from "@/components/ios/navigationContext";

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
  const groups: { name: string; items: typeof nav.overflow }[] = [];
  for (const item of nav.overflow) {
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

      <ListSection header="偏好">
        <ListRow
          icon={<Search className="h-5 w-5" aria-hidden="true" />}
          label="搜索功能"
          onSelect={nav.onOpenSearch}
        />
        <ListRow
          icon={
            nav.theme.isDark ? (
              <Moon className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Sun className="h-5 w-5" aria-hidden="true" />
            )
          }
          label="深色外观"
          /*
              开关行不画箭头（GroupedList 自己挡住了）：一行里不能既是入口
              又是开关，否则用户不知道点哪儿。
            */
          trailing={
            <button
              type="button"
              role="switch"
              aria-checked={nav.theme.isDark}
              aria-label="深色外观"
              onClick={nav.theme.toggle}
              className="fx-ios-switch"
            >
              <span className="fx-ios-switch-knob" />
            </button>
          }
        />
      </ListSection>

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
