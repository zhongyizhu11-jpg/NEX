import { useOpsFeatures } from "../useOpsFeatures";
import AgentRelaySection from "../relay/AgentRelaySection";
import ImportExistingSection from "../ops/ImportExistingSection";
import HostSecuritySection from "../security/HostSecuritySection";
import HostEventsSection from "../events/HostEventsSection";
import HostLogsSection from "../logs/HostLogsSection";

/** 主机详情弹窗底部，运维功能多出来的几节。只给管理员（isAdmin 由调用方判断）。 */
export default function OpsHostDetailExtraSections({ host, isAdmin }: { host: any; isAdmin: boolean }) {
  if (!useOpsFeatures() || !isAdmin || !host) return null;
  return (
    <>
      <HostSecuritySection host={host} />
      <AgentRelaySection host={host} />
      <ImportExistingSection host={host} />
      <HostEventsSection host={host} />
      <HostLogsSection host={host} />
    </>
  );
}
