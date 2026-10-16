import { aliyunEcsProvider } from "./aliyunEcs";
import { awsEc2Provider } from "./awsEc2";
import { awsLightsailProvider } from "./awsLightsail";
import { awsSbProvider } from "./awsSb";
import { azureVmProvider } from "./azureVm";
import { digitaloceanProvider } from "./digitalocean";
import { gcpGceProvider } from "./gcpGce";
import { hetznerProvider } from "./hetzner";
import { huaweiEcsProvider } from "./huaweiEcs";
import { ociProvider } from "./oci";
import { tencentCvmProvider } from "./tencentCvm";
import type { IpChangeProvider } from "./types";
import { volcengineEcsProvider } from "./volcengineEcs";
import { vultrProvider } from "./vultr";
import { webhookProvider } from "./webhook";

export * from "./types";

export const IP_CHANGE_PROVIDERS: IpChangeProvider[] = [
  awsEc2Provider,
  awsLightsailProvider,
  aliyunEcsProvider,
  tencentCvmProvider,
  huaweiEcsProvider,
  volcengineEcsProvider,
  gcpGceProvider,
  ociProvider,
  azureVmProvider,
  digitaloceanProvider,
  hetznerProvider,
  vultrProvider,
  awsSbProvider,
  webhookProvider,
];

export function getIpChangeProvider(id: string): IpChangeProvider | undefined {
  return IP_CHANGE_PROVIDERS.find((provider) => provider.id === id);
}
