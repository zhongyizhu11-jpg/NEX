import { useAuth } from "@/_core/hooks/useAuth";

/*
  精简布局（个人资料 › 界面 › 精简布局）：每个账号自己的开关，默认关，只改这个账号看到的界面。
  打开后：链路管理 4 个分类、规则框 3 个页签、主机页 2 个页签、规则卡片一行、侧栏分组、
  诊断问题优先……具体见各处用到这个 hook 的地方。数据和功能一样，只是摆法不同。
*/
export function useCompactLayout(): boolean {
  const { user } = useAuth();
  return (user as any)?.compactLayout === true || (user as any)?.compactLayout === 1;
}
