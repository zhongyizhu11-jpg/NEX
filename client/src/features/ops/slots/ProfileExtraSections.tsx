import { useOpsFeatures } from "../useOpsFeatures";
import PasskeysSection from "../account/PasskeysSection";
import SessionsSection from "../account/SessionsSection";

/** 个人资料页，运维功能多出来的通行密钥和已登录设备。所有登录用户都有。 */
export default function OpsProfileExtraSections() {
  if (!useOpsFeatures()) return null;
  return (
    <>
      <PasskeysSection />
      <SessionsSection />
    </>
  );
}
