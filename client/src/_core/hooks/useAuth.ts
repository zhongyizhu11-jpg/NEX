import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { clearPersistedQueryCache } from "@/lib/queryPersistence";
import { userImpersonation } from "@/lib/userImpersonation";

export function useAuth() {
  const { data: user, isLoading: loading } = trpc.auth.me.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      // 代入窗口里的「退出」只结束这次代入：不清管理员的本机缓存、不去登录页。
      if (userImpersonation.isEntry()) {
        userImpersonation.finish();
        return;
      }
      clearPersistedQueryCache();
      mobileAuth.clear();
      window.location.href = "/login";
    },
    onError: () => {
      if (userImpersonation.isEntry()) userImpersonation.finish();
    },
  });

  const logout = () => {
    logoutMutation.mutate();
  };

  return {
    user: user ?? null,
    loading,
    logout,
  };
}
