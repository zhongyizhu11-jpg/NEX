import { isAgentVersionAtLeast } from "@shared/version";
import {
  HOST_PUBLIC_ADDRESS_LIST_AGENT_VERSION,
  hostAddressRows,
  hostPrimaryAddressOptions,
  hostPrimaryAddressWarnings,
  parseHostDetectedAddresses,
  type HostAddressFamily,
  type HostPrimaryAddressSource,
} from "@shared/hostPublicAddresses";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Select 的值不能是空串：「不指定」用这个占位
const AUTO = "__auto__";

/**
 * 编辑框里的「主 IP」（shared/hostPublicAddresses）：Agent 报了网卡上的多个公网地址时，
 * IPv4、IPv6 各挑一个当主 IP，规则、隧道、订阅、DDNS 都按它走。
 *
 * 不挑就跟今天一样用 Agent 上报的出口地址。挑过的地址从网卡上消失了照样用，只在下面提示 ——
 * 自动换一个等于悄悄改了所有规则的入口。手改了「Agent 检测 IP」时手改的优先，这里的选择先存着。
 */
export function HostPrimaryAddressPicker({
  host,
  primaryIpv4,
  primaryIpv6,
  onChange,
}: {
  host: HostPrimaryAddressSource & { agentVersion?: string | null };
  primaryIpv4: string;
  primaryIpv6: string;
  onChange: (family: HostAddressFamily, value: string) => void;
}) {
  const detected = parseHostDetectedAddresses(host?.detectedAddresses);
  if (!detected) {
    // 老 Agent 不报列表：只在确实是版本问题时说一句，别让人以为功能坏了
    if (host?.agentVersion && !isAgentVersionAtLeast(host.agentVersion, HOST_PUBLIC_ADDRESS_LIST_AGENT_VERSION)) {
      return (
        <p className="text-xs text-muted-foreground" data-host-primary-address-hint="">
          Agent 升级到 {HOST_PUBLIC_ADDRESS_LIST_AGENT_VERSION} 后会上报网卡上的全部公网 IP，多 IP 机器可以在这里选主 IP。
        </p>
      );
    }
    return null;
  }
  const draft = { ...host, primaryIpv4, primaryIpv6 };
  const rows = hostAddressRows(host);
  const warnings = hostPrimaryAddressWarnings(draft);
  // 只有一个候选、又没挑过的那一族不画：没得挑
  const families = (["ipv4", "ipv6"] as const).filter((family) => (
    hostPrimaryAddressOptions(draft, family).length > 1 || !!(family === "ipv4" ? primaryIpv4 : primaryIpv6)
  ));
  if (families.length === 0) return null;
  return (
    <div className="space-y-2" data-host-primary-address="">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {families.map((family) => {
          const label = family === "ipv4" ? "IPv4" : "IPv6";
          const value = (family === "ipv4" ? primaryIpv4 : primaryIpv6) || AUTO;
          const options = hostPrimaryAddressOptions(draft, family);
          const egress = family === "ipv4" ? detected.egressIpv4 : detected.egressIpv6;
          const listed = family === "ipv4" ? detected.ipv4 : detected.ipv6;
          return (
            <div key={family} className="min-w-0 space-y-1">
              <Label className="text-sm">主 {label}</Label>
              <Select value={value} onValueChange={(next) => onChange(family, next === AUTO ? "" : next)}>
                <SelectTrigger aria-label={`主 ${label}`} className="h-8 min-w-0 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>跟随 Agent 上报{egress ? `（${egress}）` : ""}</SelectItem>
                  {options.map((address) => {
                    const tags = [
                      address === egress ? "出口" : "",
                      listed.includes(address) ? "" : "未检测到",
                    ].filter(Boolean);
                    return (
                      <SelectItem key={address} value={address} className="font-mono">
                        {address}{tags.length ? `（${tags.join(" · ")}）` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        检测到 {rows.length} 个公网地址。主 IP 就是规则、隧道、订阅和 DDNS「仅主 IP」用的那个；不选跟以前一样用 Agent 的出口地址。
      </p>
      {warnings.map((warning) => (
        <p key={warning} className="text-xs text-[var(--fx-warn-text)]">{warning}</p>
      ))}
    </div>
  );
}
