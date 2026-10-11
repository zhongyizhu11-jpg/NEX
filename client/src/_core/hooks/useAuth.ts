import { trpc } from "@/lib/trpc";
import { mobileAuth } from "@/lib/mobileAuth";
import { clearPersistedQueryCache } from "@/lib/queryPersistence";

export function useAuth() {
  const { data: user, isLoading: loading } = trpc.auth.me.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      clearPersistedQueryCache();
      mobileAuth.clear();
      window.location.href = "/login";
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
