import { useOpsFeatures } from "../useOpsFeatures";
import UserOnlineIpsMenuItem from "../online/UserOnlineIpsMenuItem";
import { UserTrafficHistoryMenuItem } from "@/components/users/UserTrafficHistory";

/** 用户管理每一行 ··· 菜单里，运维功能多出来的几项。 */
export default function OpsUserMenuItems({ user }: { user: any }) {
  // 「流量历史」不算运维功能、不看开关；对话框挂在用户管理页上（UserTrafficHistoryDialogHost）
  if (!useOpsFeatures()) return <UserTrafficHistoryMenuItem user={user} />;
  return (
    <>
      <UserOnlineIpsMenuItem user={user} />
      <UserTrafficHistoryMenuItem user={user} />
    </>
  );
}
