/*
  Azure 虚拟机：新建一个公共 IP 资源，把 VM 主网卡主 IP 配置的 publicIPAddress 指向它，再按需删除旧的。

  流程：客户端凭据流 POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
  （scope https://management.azure.com/.default）→ ARM：
  GET virtualMachines/{vm}（networkProfile.networkInterfaces 里 primary 的那块）→ GET 网卡
  （ipConfigurations 里 primary 的那个）→ GET 旧公共 IP（SKU、zones、地址）→
  PUT publicIPAddresses/{新名字}（Standard / Static / IPv4，沿用旧 IP 的 zones）→ 跟 Azure-AsyncOperation 到 Succeeded →
  PUT 网卡（整份 GET 回来的网卡，只改 publicIPAddress.id）→ 跟 Azure-AsyncOperation →
  要求释放时 DELETE 旧公共 IP。
  Basic SKU 公共 IP 已于 2025-09-30 退役，新建一律 Standard；Standard 默认拒绝入站，网卡或子网必须有放行的 NSG。

  参考：
  - https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
  - https://learn.microsoft.com/rest/api/compute/virtual-machines/get?view=rest-compute-2024-07-01
  - https://learn.microsoft.com/rest/api/virtualnetwork/network-interfaces/get?view=rest-virtualnetwork-2024-05-01
  - https://learn.microsoft.com/rest/api/virtualnetwork/network-interfaces/create-or-update?view=rest-virtualnetwork-2024-05-01
  - https://learn.microsoft.com/rest/api/virtualnetwork/public-ip-addresses/create-or-update?view=rest-virtualnetwork-2024-05-01
  - https://learn.microsoft.com/rest/api/virtualnetwork/public-ip-addresses/delete?view=rest-virtualnetwork-2024-05-01
  - https://learn.microsoft.com/azure/azure-resource-manager/management/async-operations
  - https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-basic-upgrade-guidance
*/
import {
  REGION_PATTERN,
  appendToError,
  assertIp,
  bestEffort,
  defineProvider,
  httpRequest,
  httpStatusError,
  ipOrNull,
  markAmbiguous,
  optionalPattern,
  pollUntil,
  requirePattern,
  resourceSuffix,
  truncate,
  type HttpResponse,
} from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "Azure";
const ARM = "https://management.azure.com";
const COMPUTE_API = "2024-07-01";
const NETWORK_API = "2024-05-01";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { ctx: IpChangeContext; token: string; subscriptionId: string; resourceGroup: string; vmName: string };

async function getToken(ctx: IpChangeContext, tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const resp = await httpRequest(ctx, {
    label: `${LABEL} 登录`,
    method: "POST",
    url: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://management.azure.com/.default",
      grant_type: "client_credentials",
    }).toString(),
  });
  if (resp.status === 200 && typeof resp.json?.access_token === "string") return resp.json.access_token;
  const detail = [resp.json?.error, String(resp.json?.error_description || "").split("\r\n")[0]].filter(Boolean).join("：") || truncate(resp.text, 200);
  if (resp.status === 400 || resp.status === 401) {
    throw new IpChangeProviderError(`${LABEL}：租户 ID / 客户端 ID / 客户端密码不正确或已过期（${detail}）`, { retryable: false });
  }
  throw httpStatusError(`${LABEL} 登录`, resp.status, detail);
}

function assertArmUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== "management.azure.com") {
    throw new IpChangeProviderError(`${LABEL}：拒绝访问非 ARM 地址 ${parsed.host}`, { retryable: false, ambiguous: true });
  }
  return parsed.href;
}

async function arm(c: Ctx, method: string, url: string, body?: unknown, mutating = false): Promise<HttpResponse> {
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method}`,
    method,
    url: assertArmUrl(url),
    headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp;
  const code = String(resp.json?.error?.code || "");
  const detail = code ? `${code}${resp.json?.error?.message ? `：${resp.json.error.message}` : ""}` : truncate(resp.text, 200);
  if (resp.status === 401) throw new IpChangeProviderError(`${LABEL}：访问令牌无效（${detail}）`, { retryable: false });
  if (resp.status === 403) throw new IpChangeProviderError(`${LABEL}：服务主体权限不足（需要「网络参与者」+ 读取 VM）（${detail}）`, { retryable: false });
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：资源不存在，请确认订阅、资源组和 VM 名（${detail}）`, { retryable: false });
  if (resp.status === 409 || resp.status === 429) throw new IpChangeProviderError(`${LABEL} ${method} 冲突或被限流（${detail}）`, { retryable: true });
  throw httpStatusError(`${LABEL} ${method}`, resp.status, detail, { mutating });
}

/** 跟 ARM 长时间操作：优先 Azure-AsyncOperation，其次 Location（202）。 */
async function waitAsync(c: Ctx, resp: HttpResponse, what: string) {
  const asyncUrl = resp.headers.get("azure-asyncoperation");
  const location = resp.headers.get("location");
  if (asyncUrl) {
    const result = await pollUntil(c.ctx, `${LABEL} ${what}`, async () => {
      const got = await arm(c, "GET", asyncUrl);
      const status = String(got.json?.status || "");
      if (status === "Succeeded") return got.json;
      if (status === "Failed" || status === "Canceled") {
        const err = got.json?.error;
        throw new IpChangeProviderError(`${LABEL}：${what}失败（${[err?.code, err?.message].filter(Boolean).join("：") || status}）`, { retryable: false });
      }
      return null;
    });
    return result;
  }
  if (resp.status === 202 && location) {
    await pollUntil(c.ctx, `${LABEL} ${what}`, async () => {
      const got = await arm(c, "GET", location);
      return got.status === 202 ? null : got;
    });
  }
  return null;
}

const nicConfigs = (nic: any): any[] => (Array.isArray(nic?.properties?.ipConfigurations) ? nic.properties.ipConfigurations : []);
const primaryConfigIndex = (nic: any) => {
  const configs = nicConfigs(nic);
  const index = configs.findIndex((item) => item?.properties?.primary);
  return index >= 0 ? index : configs.length ? 0 : -1;
};

async function locate(c: Ctx) {
  const vmUrl = `${ARM}/subscriptions/${c.subscriptionId}/resourceGroups/${encodeURIComponent(c.resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(c.vmName)}?api-version=${COMPUTE_API}`;
  const vm = (await arm(c, "GET", vmUrl)).json;
  const refs: any[] = Array.isArray(vm?.properties?.networkProfile?.networkInterfaces) ? vm.properties.networkProfile.networkInterfaces : [];
  const ref = refs.find((item) => item?.properties?.primary) || refs[0];
  if (!ref?.id) throw new IpChangeProviderError(`${LABEL}：VM 没有网卡`, { retryable: false });
  const nicUrl = `${ARM}${ref.id}?api-version=${NETWORK_API}`;
  const nic = (await arm(c, "GET", nicUrl)).json;
  const index = primaryConfigIndex(nic);
  if (index < 0) throw new IpChangeProviderError(`${LABEL}：网卡没有 IP 配置`, { retryable: false });
  const pipId: string | null = nicConfigs(nic)[index]?.properties?.publicIPAddress?.id || null;
  const pip = pipId ? (await arm(c, "GET", `${ARM}${pipId}?api-version=${NETWORK_API}`)).json : null;
  return { vm, nic, nicUrl, index, pipId, pip, publicIp: ipOrNull(pip?.properties?.ipAddress) };
}

async function open(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Promise<Ctx> {
  const tenantId = requirePattern(credentials, "tenantId", "租户 ID", /^([0-9a-f-]{36}|[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/i, "GUID 或 xxx.onmicrosoft.com");
  const clientId = requirePattern(credentials, "clientId", "客户端（应用）ID", GUID, "GUID 格式");
  const clientSecret = requirePattern(credentials, "clientSecret", "客户端密码", /^\S{8,256}$/, "长度不对或含空白");
  const subscriptionId = requirePattern(credentials, "subscriptionId", "订阅 ID", GUID, "GUID 格式");
  const resourceGroup = requirePattern(target, "resourceGroup", "资源组", /^[-\w._()]{1,90}$/, "字母数字及 -_.()");
  const vmName = requirePattern(target, "vmName", "VM 名", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "VM 资源名称");
  const token = await getToken(ctx, tenantId, clientId, clientSecret);
  return { ctx, token, subscriptionId, resourceGroup, vmName };
}

export const azureVmProvider = defineProvider({
  id: "azure-vm",
  label: "Azure 虚拟机",
  docsHint:
    "Entra ID → 应用注册 → 新建应用并创建客户端密码；在订阅或资源组的「访问控制(IAM)」里给它分配「网络参与者」和「虚拟机参与者」（或读取 VM + 写公共 IP / 网卡）。新 IP 是 Standard 静态公共 IP，需要 NSG 放行入站。",
  credentialFields: [
    { key: "tenantId", label: "租户 ID", type: "text", required: true, placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
    { key: "clientId", label: "客户端（应用）ID", type: "text", required: true },
    { key: "clientSecret", label: "客户端密码", type: "password", required: true },
    { key: "subscriptionId", label: "订阅 ID", type: "text", required: true },
  ],
  targetFields: [
    { key: "resourceGroup", label: "资源组", type: "text", required: true },
    { key: "vmName", label: "VM 名", type: "text", required: true },
    { key: "location", label: "地域", type: "text", placeholder: "默认与 VM 相同，如 japaneast" },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    return { currentIp: (await locate(await open(credentials, target, ctx))).publicIp };
  },

  async getCurrentIp(credentials, target, ctx) {
    return (await locate(await open(credentials, target, ctx))).publicIp;
  },

  async changeIp(credentials, target, ctx, options) {
    const c = await open(credentials, target, ctx);
    const found = await locate(c);
    const oldIp = found.publicIp;
    const location = optionalPattern(target, "location", "地域", REGION_PATTERN, "如 japaneast") || String(found.pip?.location || found.vm?.location || "");
    if (!location) throw new IpChangeProviderError(`${LABEL}：无法确定地域，请填写「地域」`, { retryable: false });
    const notes: string[] = [];
    const oldSku = String(found.pip?.sku?.name || "");
    const zones: string[] | undefined = Array.isArray(found.pip?.zones) && found.pip.zones.length ? found.pip.zones : Array.isArray(found.vm?.zones) && found.vm.zones.length ? found.vm.zones : undefined;

    const newName = `nex-${c.vmName}-${resourceSuffix(ctx)}`.slice(0, 80);
    const newId = `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.Network/publicIPAddresses/${newName}`;
    const newUrl = `${ARM}/subscriptions/${c.subscriptionId}/resourceGroups/${encodeURIComponent(c.resourceGroup)}/providers/Microsoft.Network/publicIPAddresses/${newName}?api-version=${NETWORK_API}`;
    const deleteNew = () => bestEffort(ctx, `${LABEL}：删除新建的公共 IP ${newName}`, async () => waitAsync(c, await arm(c, "DELETE", newUrl, undefined, true), "删除新公共 IP"));

    let newIp: string;
    try {
      const created = await arm(
        c,
        "PUT",
        newUrl,
        {
          location,
          sku: { name: "Standard", tier: "Regional" },
          ...(zones ? { zones } : {}),
          properties: { publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4" },
          tags: { "created-by": "nex-ip-change" },
        },
        true,
      );
      await waitAsync(c, created, "创建公共 IP");
      const got = (await arm(c, "GET", newUrl)).json;
      newIp = assertIp(got?.properties?.ipAddress, `${LABEL} 新公共 IP `);
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw appendToError(error, `公共 IP ${newName} 可能已经创建，请到门户检查，闲置的请删除`);
      }
      const ok = await deleteNew();
      throw appendToError(error, ok ? `已删除新建的公共 IP ${newName}` : `新建的公共 IP ${newName} 删除失败，请到门户手动删除`);
    }
    ctx.log(`${LABEL}：已创建公共 IP ${newName}（${newIp}）`);

    const nicBody = JSON.parse(JSON.stringify(found.nic));
    nicBody.properties.ipConfigurations[found.index].properties.publicIPAddress = { id: newId };
    try {
      await waitAsync(c, await arm(c, "PUT", found.nicUrl, nicBody, true), "更新网卡");
    } catch (error) {
      if (error instanceof IpChangeProviderError && error.options.ambiguous) {
        throw markAmbiguous(error, `网卡是否已切到新公共 IP ${newIp} 未知，请到门户确认；未使用的公共 IP ${newName} 请手动删除`);
      }
      const ok = await deleteNew();
      throw appendToError(error, ok ? `网卡未改动，已删除新建的公共 IP ${newName}` : `网卡未改动；新建的公共 IP ${newName} 删除失败，请到门户手动删除`);
    }

    const check = await locate(c);
    if (String(check.pipId || "").toLowerCase() !== newId.toLowerCase()) {
      throw new IpChangeProviderError(`${LABEL}：网卡更新完成但公共 IP 不是新建的 ${newName}，请到门户确认`, { retryable: false, ambiguous: true });
    }

    let releasedOldIp = false;
    if (found.pipId) {
      if (options.releaseOldIp) {
        try {
          await waitAsync(c, await arm(c, "DELETE", `${ARM}${found.pipId}?api-version=${NETWORK_API}`, undefined, true), "删除旧公共 IP");
          releasedOldIp = true;
          notes.push(`已删除旧公共 IP ${String(found.pip?.name || found.pipId)}（${oldIp || "无地址"}）`);
        } catch (error) {
          notes.push(`旧公共 IP ${String(found.pip?.name || found.pipId)} 删除失败，请到门户手动删除：${(error as Error).message}`);
        }
      } else {
        notes.push(`旧公共 IP ${String(found.pip?.name || found.pipId)}（${oldIp || "无地址"}）已解除关联但仍保留，Standard 静态 IP 闲置也计费`);
      }
    }
    if (oldSku && oldSku !== "Standard") notes.push(`旧 IP 是 ${oldSku} SKU，新 IP 是 Standard：Standard 默认拒绝入站，请确认网卡 / 子网的 NSG 放行了转发端口`);
    notes.push(`新 IP ${newIp} 是 Standard 静态公共 IP（${newName}）`);
    return { oldIp, newIp, ipRole: "primary", releasedOldIp, notes };
  },
});
