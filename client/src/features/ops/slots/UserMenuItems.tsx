import { useOpsFeatures } from "../useOpsFeatures";
import UserOnlineIpsMenuItem from "../online/UserOnlineIpsMenuItem";

/** 用户管理每一行 ··· 菜单里，运维功能多出来的几项。 */
export default function OpsUserMenuItems({ user }: { user: any }) {
  if (!useOpsFeatures()) return null;
  return <UserOnlineIpsMenuItem user={user} />;
}
