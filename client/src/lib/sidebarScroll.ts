/*
  侧栏滚动位置记忆（上游 2.3.285）。

  每个页面自己包一层 DashboardLayout，换页时整个外壳会重新挂载，侧栏滚动条就跳回顶部 ——
  菜单长的时候，点一下下面的入口，侧栏就弹回最上面。这里按「账号 + 侧栏形态」记住滚动位置，
  只在当前这次打开面板期间有效（不写本地存储）。
*/
export function createSidebarScrollMemory() {
  const offsets = new Map<string, number>();

  return (content: Pick<HTMLElement, "scrollTop">, key: string) => {
    const target = offsets.get(key) ?? 0;
    let restoring = true;
    const save = () => {
      // 菜单异步补齐之前 scrollTop 可能被夹小：还原完成前不拿它覆盖记住的位置。
      if (!restoring) offsets.set(key, content.scrollTop);
    };
    return {
      restore() {
        if (!restoring) return;
        content.scrollTop = target;
        restoring = Math.abs(content.scrollTop - target) > 1;
      },
      save,
      interrupt() {
        // 用户自己开始滚了，就以他为准，不再往回拉。
        restoring = false;
        save();
      },
    };
  };
}

export const rememberSidebarScroll = createSidebarScrollMemory();
