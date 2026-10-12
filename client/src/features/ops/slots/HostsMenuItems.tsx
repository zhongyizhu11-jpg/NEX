import { useOpsFeatures } from "../useOpsFeatures";
import RestartAllMenuItem from "../ops/RestartAllMenuItem";

/** 主机管理页头 ··· 菜单里，第五套主题多出来的几项（管理员才看得到这个菜单）。 */
export default function OpsHostsMenuItems() {
  if (!useOpsFeatures()) return null;
  return <RestartAllMenuItem />;
}
