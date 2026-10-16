export type IpChangeProviderId =
  | "aws-ec2" | "aws-lightsail" | "aliyun-ecs" | "tencent-cvm" | "huawei-ecs" | "volcengine-ecs"
  | "gcp-gce" | "oci" | "azure-vm" | "digitalocean" | "hetzner" | "vultr" | "aws-sb" | "webhook";

export type IpChangeFieldDef = {
  key: string;
  label: string;
  type: "text" | "password" | "textarea" | "select";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
};

/** 凭据（云账号级别），键由 credentialFields 定义 */
export type IpChangeCredentials = Record<string, string>;
/** 目标（主机级别：地域、实例 ID 等），键由 targetFields 定义 */
export type IpChangeTarget = Record<string, string>;

export type IpChangeContext = {
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  signal?: AbortSignal;
};

export type IpChangeResult = {
  oldIp: string | null;
  newIp: string;
  /** primary：实例自己的公网 IP 变了（Agent 会自己上报）；entry：只是多了一个入口 IP，面板需要把入口地址 / DNS 改成它 */
  ipRole: "primary" | "entry";
  releasedOldIp: boolean;
  notes: string[];
};

export class IpChangeProviderError extends Error {
  /** retryable：稍后重试可能成功；ambiguous：请求可能已经生效，不要盲目重发，先查状态 */
  constructor(message: string, readonly options: { retryable: boolean; ambiguous?: boolean } = { retryable: false }) {
    super(message);
    this.name = "IpChangeProviderError";
  }
}

export interface IpChangeProvider {
  id: IpChangeProviderId;
  label: string;
  /** 一句话：去哪拿凭据、需要什么权限 */
  docsHint: string;
  credentialFields: IpChangeFieldDef[];
  targetFields: IpChangeFieldDef[];
  /** 换 IP 期间实例会关机 / 断网 */
  requiresDowntime: boolean;
  /** 校验凭据 + 目标，返回当前公网 IP；失败抛 IpChangeProviderError */
  testCredentials(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Promise<{ currentIp: string | null }>;
  getCurrentIp(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Promise<string | null>;
  changeIp(
    credentials: IpChangeCredentials,
    target: IpChangeTarget,
    ctx: IpChangeContext,
    options: { releaseOldIp: boolean },
  ): Promise<IpChangeResult>;
}
