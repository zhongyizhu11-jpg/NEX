import { useOpsFeatures } from "../useOpsFeatures";
import InboundCompatibility from "../proxy/InboundCompatibility";

/** 代理入站卡片 / 行上，第五套主题多出来的客户端兼容提示。 */
export default function OpsProxyInboundExtras({ inbound }: { inbound: any }) {
  if (!useOpsFeatures() || !inbound) return null;
  return <InboundCompatibility inbound={inbound} />;
}
