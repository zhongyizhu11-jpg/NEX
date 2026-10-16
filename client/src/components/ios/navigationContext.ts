import { createContext, useContext } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * 手机端导航的共享状态。
 *
 * 「更多」页需要的东西（没上标签栏的目的地、账户信息、主题、退出）全部由
 * DashboardLayout 算好 —— 它已经按权限过滤过一次，页面不该再算第二遍。
 * 算两遍的下场是两边不一致：侧边栏里没有的入口在「更多」里还点得到。
 *
 * 放在单独的文件里而不是 DashboardLayout 里，是为了断开循环引用：
 * More 页要渲染在 DashboardLayout 内部，不能反过来 import 它。
 */

export type MobileNavEntry = {
  path: string;
  label: string;
  icon: LucideIcon;
  /** 外链走 window.open，不走路由 */
  externalUrl?: string;
  /** 分组小标题，「更多」页按它分块 */
  group?: string;
  /** 待处理计数（工单管理），「更多」页在这一行上标出来 */
  badge?: number;
};

export type MobileNavContextValue = {
  /** 没上标签栏的目的地，已按权限过滤 */
  overflow: MobileNavEntry[];
  currentPath: string;
  navigate: (entry: MobileNavEntry) => void;
  account: {
    name: string;
    detail: string;
    /** 头像那一块直接给节点，省得把用户对象再传一遍 */
    avatar?: React.ReactNode;
  };
  theme: { isDark: boolean; toggle: () => void };
  onLogout: () => void;
  onOpenSearch: () => void;
};

export const MobileNavContext = createContext<MobileNavContextValue | null>(
  null,
);

export function useMobileNav() {
  return useContext(MobileNavContext);
}
