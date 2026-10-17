/*
  删主机时「离线主机上还有待清理的规则」的二次确认（见 server/hostDeletion.ts）。

  服务端遇到这种情况回 PRECONDITION_FAILED：面板确认不了机器上的监听已经停了，要用户明确同意才删。
  前端弹 NEX 自己的确认框，同意后带 confirmOfflineCleanup 再删一次。在线主机正在清理时回 CONFLICT，
  那种只提示稍后再试，不给「仍然删除」。
*/

export function hostDeleteNeedsOfflineConfirmation(error: unknown) {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return code === "PRECONDITION_FAILED";
}

export function offlineCleanupConfirmOptions(hostName: string | null | undefined, serverMessage: string) {
  const name = String(hostName || "").trim();
  return {
    title: name ? `「${name}」离线，仍要删除？` : "主机离线，仍要删除？",
    description: `${serverMessage}。`,
    confirmText: "仍然删除",
    tone: "destructive" as const,
  };
}
