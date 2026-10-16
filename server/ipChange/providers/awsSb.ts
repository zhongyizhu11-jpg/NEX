/*
  AWS 小助理（aws.sb）：第三方 AWS 账号管理服务，替用户调用 AWS 换 IP。

  接口（https://api.aws.sb，鉴权头 X-Auth-Token，可选 X-Share-Group-Token；X-Account-Id、X-Region-Name 选账号和地域）：
  - EC2：GET /ec2-instances/{id}（ipAddress）；PATCH /ec2-instances/{id}/ip-address {static, gfw_blocked_check}
  - Lightsail：GET /lightsail-instances/{name}（ip_address）；PATCH /lightsail-instances/{name}/ip-address {static}
  - 任务：PATCH 返回 {tag, status}；POST /filter-tasks {tags: [tag]} 查任务状态
  轮询：任务 error → 失败；任务完成后 60 秒内 IP 仍未变化 → 失败；整体上限 10 分钟。

  文档：没有找到人写的文档页，但服务公开了 FastAPI 生成的 OpenAPI：https://api.aws.sb/openapi.json
  已核对：上述路径、方法、四个请求头、PATCH 请求体字段（EC2 还有 cidr_blocks / gfw_blocked_check_port，未使用）、
  filter-tasks 的 {tags: string[]} 请求体。响应体在 OpenAPI 里是空 schema，所以 ipAddress / ip_address / tag / status
  这些字段名按需求描述实现，并兼容 data / task 包一层的写法。错误按 FastAPI 习惯读 {"detail": …}。
*/
import {
  appendToError,
  assertIp,
  defineProvider,
  httpRequest,
  httpStatusError,
  ipOrNull,
  optionalChoice,
  pollUntil,
  readField,
  requirePattern,
  REGION_HINT,
  REGION_PATTERN,
  truncate,
} from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeCredentials, type IpChangeTarget } from "./types";

const LABEL = "AWS 小助理";
const API = "https://api.aws.sb";
const POLL_INTERVAL_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const SETTLE_AFTER_FINISH_MS = 60_000;
const FAILED = new Set(["error", "failed", "failure"]);
const FINISHED = new Set(["finished", "success", "succeeded", "done", "completed"]);

type Ctx = {
  ctx: IpChangeContext;
  token: string;
  shareToken: string;
  accountId: string;
  region: string;
  kind: "ec2" | "lightsail";
  instanceId: string;
  static: boolean;
};

function detailOf(body: any, text: string): string {
  const detail = body?.detail ?? body?.message ?? body?.error;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item: any) => item?.msg || JSON.stringify(item)).join("；");
  return truncate(text, 200);
}

async function sb(c: Ctx, method: string, path: string, body?: unknown, mutating = false): Promise<any> {
  const headers: Record<string, string> = { "X-Auth-Token": c.token, "X-Account-Id": c.accountId, "X-Region-Name": c.region, Accept: "application/json" };
  if (c.shareToken) headers["X-Share-Group-Token"] = c.shareToken;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await httpRequest(c.ctx, {
    label: `${LABEL} ${method} ${path}`,
    method,
    url: `${API}${path}`,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    mutating,
  });
  if (resp.status >= 200 && resp.status < 300) return resp.json ?? {};
  const detail = detailOf(resp.json, resp.text);
  if (resp.status === 401 || resp.status === 403) throw new IpChangeProviderError(`${LABEL}：令牌无效或无权访问该账号（${detail}）`, { retryable: false });
  if (resp.status === 404) throw new IpChangeProviderError(`${LABEL}：找不到实例，请确认账号、地域和实例（${detail}）`, { retryable: false });
  throw httpStatusError(`${LABEL} ${method} ${path}`, resp.status, detail, { mutating });
}

const unwrap = (body: any) => (body && typeof body === "object" && body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body);

function instancePath(c: Ctx) {
  return c.kind === "ec2" ? `/ec2-instances/${encodeURIComponent(c.instanceId)}` : `/lightsail-instances/${encodeURIComponent(c.instanceId)}`;
}

async function readIp(c: Ctx): Promise<string | null> {
  const body = unwrap(await sb(c, "GET", instancePath(c)));
  return ipOrNull(c.kind === "ec2" ? body?.ipAddress ?? body?.ip_address ?? body?.publicIpAddress : body?.ip_address ?? body?.ipAddress ?? body?.publicIpAddress);
}

function open(credentials: IpChangeCredentials, target: IpChangeTarget, ctx: IpChangeContext): Ctx {
  const kind = optionalChoice(target, "instanceType", "实例类型", ["ec2", "lightsail"], "") as "ec2" | "lightsail" | "";
  if (!kind) throw new IpChangeProviderError("缺少「实例类型」", { retryable: false });
  return {
    ctx,
    token: requirePattern(credentials, "authToken", "API 令牌", /^\S{8,512}$/, "长度不对或含空白"),
    shareToken: readField(credentials, "shareGroupToken"),
    accountId: requirePattern(target, "accountId", "账号 ID", /^[A-Za-z0-9_-]{1,64}$/, "aws.sb 里的账号 ID"),
    region: requirePattern(target, "region", "地域", REGION_PATTERN, REGION_HINT),
    kind,
    instanceId:
      kind === "ec2"
        ? requirePattern(target, "instanceId", "实例 ID / 名称", /^i-[0-9a-f]{8,17}$/, "EC2 实例 ID，形如 i-0123456789abcdef0")
        : requirePattern(target, "instanceId", "实例 ID / 名称", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/, "Lightsail 实例名"),
    static: optionalChoice(target, "static", "使用静态 IP", ["yes", "no"], "no") === "yes",
  };
}

function findTask(body: any, tag: string): any {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.tasks) ? body.tasks : body && typeof body === "object" ? Object.values(body) : [];
  return list.find((item: any) => item && typeof item === "object" && String(item.tag ?? "") === tag) ?? (list.length === 1 ? list[0] : null);
}

export const awsSbProvider = defineProvider({
  id: "aws-sb",
  label: "AWS 小助理（aws.sb）",
  docsHint:
    "在 aws.sb 的个人设置里复制 API 令牌（共享组成员再填共享组令牌）；账号 ID 是 aws.sb 里绑定的 AWS 账号。由 aws.sb 代为换 IP，旧 IP 怎么处理由 aws.sb 决定。",
  credentialFields: [
    { key: "authToken", label: "API 令牌（X-Auth-Token）", type: "password", required: true },
    { key: "shareGroupToken", label: "共享组令牌（X-Share-Group-Token）", type: "password", help: "使用别人共享给你的账号时才需要" },
  ],
  targetFields: [
    {
      key: "instanceType",
      label: "实例类型",
      type: "select",
      required: true,
      options: [
        { value: "ec2", label: "EC2" },
        { value: "lightsail", label: "Lightsail" },
      ],
    },
    { key: "accountId", label: "账号 ID", type: "text", required: true },
    { key: "region", label: "地域", type: "text", required: true, placeholder: "ap-northeast-1" },
    { key: "instanceId", label: "实例 ID / 名称", type: "text", required: true, help: "EC2 填实例 ID（i-…），Lightsail 填实例名" },
    {
      key: "static",
      label: "使用静态 IP",
      type: "select",
      options: [
        { value: "no", label: "否：换成新的动态 IP（默认）" },
        { value: "yes", label: "是：换成新的静态 / 弹性 IP" },
      ],
    },
  ],
  requiresDowntime: false,

  async testCredentials(credentials, target, ctx) {
    return { currentIp: await readIp(open(credentials, target, ctx)) };
  },

  async getCurrentIp(credentials, target, ctx) {
    return readIp(open(credentials, target, ctx));
  },

  async changeIp(credentials, target, ctx, _options) {
    const c = open(credentials, target, ctx);
    const oldIp = await readIp(c);
    const payload = c.kind === "ec2" ? { static: c.static, gfw_blocked_check: false } : { static: c.static };
    const resp = unwrap(await sb(c, "PATCH", `${instancePath(c)}/ip-address`, payload, true));
    const task = resp?.task && typeof resp.task === "object" ? resp.task : resp;
    const tag = String(task?.tag ?? "");
    if (FAILED.has(String(task?.status ?? "").toLowerCase())) {
      throw new IpChangeProviderError(`${LABEL}：换 IP 任务失败（${truncate(String(task?.message || task?.error || task?.status))}）`, { retryable: false });
    }
    ctx.log(`${LABEL}：已提交换 IP 任务${tag ? ` ${tag}` : ""}，旧 IP ${oldIp || "（无）"}`);

    let finishedAtAttempt: number | null = FINISHED.has(String(task?.status ?? "").toLowerCase()) ? 0 : null;
    let attempt = 0;
    const settleAttempts = Math.ceil(SETTLE_AFTER_FINISH_MS / POLL_INTERVAL_MS);
    let newIp: string;
    try {
      newIp = await pollUntil(
        ctx,
        `${LABEL} 新 IP`,
        async () => {
          attempt += 1;
          if (tag && finishedAtAttempt === null) {
            const got = findTask(unwrap(await sb(c, "POST", "/filter-tasks", { tags: [tag] })), tag);
            const status = String(got?.status ?? "").toLowerCase();
            if (FAILED.has(status)) {
              throw new IpChangeProviderError(`${LABEL}：换 IP 任务失败（${truncate(String(got?.message || got?.error || got?.result || status))}）`, { retryable: false });
            }
            if (FINISHED.has(status)) finishedAtAttempt = attempt;
          }
          const ip = await readIp(c);
          if (ip && ip !== oldIp) return ip;
          if (finishedAtAttempt !== null && attempt - finishedAtAttempt >= settleAttempts) {
            throw new IpChangeProviderError(`${LABEL}：任务已完成，但 60 秒后实例 IP 仍是 ${ip || "（无）"}，没有变化`, { retryable: true, ambiguous: true });
          }
          return null;
        },
        { intervalMs: POLL_INTERVAL_MS, timeoutMs: TOTAL_TIMEOUT_MS },
      );
    } catch (error) {
      throw appendToError(error, "可到 aws.sb 控制台查看任务详情");
    }
    newIp = assertIp(newIp, `${LABEL} `);
    return {
      oldIp,
      newIp,
      ipRole: "primary",
      releasedOldIp: false,
      notes: [`由 aws.sb 完成换 IP（${c.kind === "ec2" ? "EC2" : "Lightsail"}${c.static ? "，静态 IP" : "，动态 IP"}）；旧 IP 是否释放由 aws.sb 处理`],
    };
  },
});

