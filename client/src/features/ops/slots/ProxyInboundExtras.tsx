import { useOpsFeatures } from "../useOpsFeatures";
import { InboundCompatibilityDialog } from "../proxy/InboundCompatibility";

/** 代理入站「客户端兼容」对话框（运维功能）。节点行 ⋯ 菜单里的「客户端兼容」打开它。 */
export default function OpsInboundCompatibilityDialog({ inbound, onClose }: { inbound: any | null; onClose: () => void }) {
  if (!useOpsFeatures()) return null;
  return <InboundCompatibilityDialog inbound={inbound} onClose={onClose} />;
}
