/*
  面板接口文档（OpenAPI 3.1）的生成器。出口是 GET /api/openapi.json（server/openApiRoute.ts）。

  ── 为什么是「生成」而不是「写」 ──
  面板的接口全是 tRPC 过程，六百来个，还在不停地加。手写清单一定会落后，落后的文档比没有文档更坑人。
  这里遍历真实的路由对象（appRouter._def.procedures）：过程是查询还是修改、入参的 zod schema、
  挂的是哪一档权限中间件，都从对象上读；令牌能不能调、归哪个模块，直接问 apiTokenPolicy
  （和线上拦请求的是同一个函数）。以后加了过程，文档自动多一条，不用记得来这里补。

  ── 文档描述的是线上真实的样子 ──
  不发明一套 REST 外壳。tRPC 走 HTTP 就是：
    查询  GET  /api/trpc/<路径>?input=<URL 编码的 {"json": 入参}>
    修改  POST /api/trpc/<路径>           请求体 {"json": 入参}
    成功  {"result": {"data": {"json": 返回值, "meta": …}}}
    失败  {"error": {"json": {"message", "code", "data": {"code", "httpStatus", "path", "zodError"}}}}
  外面那层 {"json": …, "meta": …} 是 superjson 的信封：json 里是普通 JSON，Date / undefined / bigint
  这类 JSON 表达不了的值在 meta.values 里按路径标出来。

  ── 转不成 JSON Schema 的类型 ──
  zod 里的 refine、transform、自定义类型没有 JSON Schema 对应物。不能因为一个过程用了 refine 就让
  整份文档生成失败：能表达的部分照常输出，表达不了的那一处降级成「任意值」，并在描述里写明原因；
  整个 schema 都转不了（极少见）就只留一句说明。降级过的过程在 x-nex-schema-notes 里列着。

  这个文件只管「把过程表变成文档」，不碰 HTTP、不缓存（缓存在 openApiRoute.ts）。
*/
import { z } from "zod";
import { COOKIE_NAME, TRPC_MAX_BATCH_SIZE } from "../shared/const";
import {
  API_TOKEN_ALWAYS_ALLOWED_PREFIXES,
  API_TOKEN_MODULE_DETAILS,
  API_TOKEN_MODULE_LABELS,
  API_TOKEN_MODULES,
  apiTokenModuleOfPath,
  type ApiTokenModule,
} from "../shared/apiTokenModules";
import { operationAuditModule, operationAuditModuleLabel } from "../shared/operationAudit";
import { APP_VERSION } from "../shared/versions";
import { adminProcedure, protectedProcedure } from "./_core/trpc";
import { apiTokenPolicyError } from "./ops/apiTokenPolicy";

type JsonObject = Record<string, unknown>;

/** 用到的那几样过程内部字段（tRPC 11 的 _def）。只读，不依赖 tRPC 的私有类型。 */
export type OpenApiProcedure = {
  _def: {
    type?: unknown;
    inputs?: readonly unknown[];
    output?: unknown;
    middlewares?: readonly unknown[];
  };
};

export type OpenApiAccess = "public" | "user" | "admin";

export type OpenApiTokenAccess = {
  /** 令牌能不能调（不管哪种令牌）。false = 只能在网页上操作。 */
  allowed: boolean;
  /** 最低要哪种令牌：read = 只读令牌就行；full = 要「完全」令牌；null = 令牌调不了。 */
  minScope: "read" | "full" | null;
  /** 归哪个权限模块；null = 没归模块（勾了模块的令牌调不了，除非 alwaysAllowed）。 */
  module: ApiTokenModule | null;
  moduleLabel: string | null;
  /** 勾了模块的令牌也照样能调（auth.*）。 */
  alwaysAllowed: boolean;
};

export type OpenApiBuildResult = {
  document: JsonObject;
  /** 出现在文档里的过程路径（测试拿它和路由对账）。 */
  procedures: string[];
  /** 入参 schema 有降级的过程 → 降级说明。 */
  degraded: Record<string, string[]>;
};

export const OPENAPI_VERSION = "3.1.0";
export const OPENAPI_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const OPENAPI_TRPC_PREFIX = "/api/trpc";

const ACCESS_LABELS: Record<OpenApiAccess, string> = {
  public: "不用登录",
  user: "登录用户",
  admin: "管理员",
};

const NOTE_REFINE = "服务端另有自定义校验（refine），JSON Schema 表达不出来，以接口返回的报错为准";
const NOTE_TRANSFORM = "服务端会先转换这个值（transform / preprocess），这里描述的是转换前能接受的输入";
const NOTE_DATE = "日期：json 里写 ISO 8601 字符串，并在信封的 meta.values 里把这个字段标成 [\"Date\"]（superjson）";

// ---------- 权限档位：看过程挂了哪个中间件 ----------

function lastMiddleware(procedure: unknown): unknown {
  const middlewares = (procedure as OpenApiProcedure)._def?.middlewares;
  return middlewares && middlewares.length > 0 ? middlewares[middlewares.length - 1] : undefined;
}

/*
  adminProcedure / protectedProcedure 各自在公共中间件后面多挂一个「要管理员」/「要登录」的检查，
  过程是从它们 .input().query() 派生出来的，中间件数组里带着同一个函数对象 —— 按对象身份认，
  不靠名字也不靠源码。过程体里自己再判断角色的（少数 protectedProcedure 里看 role）认不出来，
  所以这一栏是「至少要这个身份」。
*/
const ADMIN_GUARD = lastMiddleware(adminProcedure);
const USER_GUARD = lastMiddleware(protectedProcedure);

export function openApiAccessOf(procedure: OpenApiProcedure): OpenApiAccess {
  const middlewares = procedure._def.middlewares || [];
  if (ADMIN_GUARD && middlewares.includes(ADMIN_GUARD)) return "admin";
  if (USER_GUARD && middlewares.includes(USER_GUARD)) return "user";
  return "public";
}

/** 令牌能不能调这个过程 —— 直接问线上拦请求的那个函数，不另抄一份名单。 */
export function openApiTokenAccessOf(path: string, type: string): OpenApiTokenAccess {
  const module = apiTokenModuleOfPath(path);
  const alwaysAllowed = API_TOKEN_ALWAYS_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
  const base = { module, moduleLabel: module ? API_TOKEN_MODULE_LABELS[module] : null, alwaysAllowed };
  if (apiTokenPolicyError("full", path, type, null)) return { ...base, allowed: false, minScope: null };
  return { ...base, allowed: true, minScope: apiTokenPolicyError("read", path, type, null) ? "full" : "read" };
}

// ---------- zod → JSON Schema（带降级） ----------

type ZodInternals = {
  def?: {
    type?: string;
    checks?: ReadonlyArray<{ _zod?: { def?: { check?: string } } }>;
    in?: { _zod?: ZodInternals };
    out?: { _zod?: ZodInternals };
  };
  optin?: string;
};

function internalsOf(schema: unknown): ZodInternals {
  return ((schema as { _zod?: ZodInternals } | null)?._zod) || {};
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function appendDescription(target: JsonObject, note: string) {
  const current = typeof target.description === "string" ? target.description : "";
  if (current.includes(note)) return;
  target.description = current ? `${current}（${note}）` : note;
}

export type ConvertedSchema = { schema: JsonObject; defs: Record<string, JsonObject>; notes: string[] };

/**
 * 一个 zod schema → JSON Schema（draft 2020-12，按「输入」的形状：默认值可以不传、transform 取转换前）。
 * 永远不抛：表达不了的局部按任意值处理并写明原因；整个转不了返回一个只有说明的空 schema。
 */
export function zodToOpenApiSchema(schema: unknown): ConvertedSchema {
  const notes = new Set<string>();
  if (!isZodSchema(schema)) {
    const note = "入参校验不是 zod schema，生成不了结构说明";
    return { schema: { description: note }, defs: {}, notes: [note] };
  }
  try {
    const converted = z.toJSONSchema(schema, {
      io: "input",
      target: "draft-2020-12",
      unrepresentable: ({ zodSchema, message }) => {
        const type = internalsOf(zodSchema).def?.type;
        if (type === "date") {
          notes.add(NOTE_DATE);
          return { type: "string", format: "date-time", description: NOTE_DATE };
        }
        if (type === "transform") {
          notes.add(NOTE_TRANSFORM);
          return { description: NOTE_TRANSFORM };
        }
        const reason = `${String(message).replace(/ cannot be represented in JSON Schema$/, "")} 类型 JSON Schema 表达不了，按任意值处理`;
        notes.add(reason);
        return { description: reason };
      },
      override: ({ zodSchema, jsonSchema }) => {
        const def = internalsOf(zodSchema).def;
        if (!def) return;
        if (def.checks?.some((check) => check?._zod?.def?.check === "custom")) {
          notes.add(NOTE_REFINE);
          appendDescription(jsonSchema as JsonObject, NOTE_REFINE);
        }
        if (def.type === "pipe" && (internalsOf(def.out).def?.type === "transform" || internalsOf(def.in).def?.type === "transform")) {
          notes.add(NOTE_TRANSFORM);
          appendDescription(jsonSchema as JsonObject, NOTE_TRANSFORM);
        }
      },
    }) as JsonObject;
    const { $schema: _dialect, $defs, ...rest } = converted;
    return { schema: rest, defs: ($defs as Record<string, JsonObject> | undefined) || {}, notes: [...notes] };
  } catch (error) {
    const note = `入参 schema 转不成 JSON Schema（${error instanceof Error ? error.message : String(error)}），按任意值处理`;
    return { schema: { description: note }, defs: {}, notes: [note] };
  }
}

/** 入参能不能整个不传（schema 接受 undefined）。 */
function acceptsUndefined(schema: unknown): boolean {
  if (!isZodSchema(schema)) return true;
  try {
    return schema.safeParse(undefined).success;
  } catch {
    // 异步校验不能同步跑：退回看 zod 自己标的「输入可省」
    return internalsOf(schema).optin === "optional";
  }
}

/*
  zod 遇到递归或带 id 的 schema 会生成 $defs + {"$ref": "#/$defs/x"}（以及指回根的 "#"）。
  这些引用是相对「这一个 schema」的，原样嵌进 OpenAPI 文档里就指错了地方（"#" 成了整份文档）。
  把 $defs 搬到 components.schemas、引用改成绝对路径；指回根的把根也登记成一个组件。
*/
function rewriteRefs(value: unknown, map: (ref: string) => string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, map));
  if (!value || typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (key === "$ref" && typeof item === "string") {
      out[key] = map(item) ?? item;
    } else {
      out[key] = rewriteRefs(item, map);
    }
  }
  return out;
}

function containsRef(value: unknown, target: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRef(item, target));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as JsonObject).some(([key, item]) => (key === "$ref" ? item === target : containsRef(item, target)));
}

function componentName(text: string) {
  return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 把一个转换结果安进文档：返回可以直接内嵌的 schema，需要的组件写进 components。 */
function embedSchema(converted: ConvertedSchema, name: string, components: Record<string, JsonObject>): JsonObject {
  const selfReferential = containsRef(converted.schema, "#") || Object.values(converted.defs).some((def) => containsRef(def, "#"));
  const hasDefs = Object.keys(converted.defs).length > 0;
  if (!selfReferential && !hasDefs) return converted.schema;
  const rootName = componentName(name);
  const map = (ref: string) => {
    if (ref === "#") return `#/components/schemas/${rootName}`;
    if (ref.startsWith("#/$defs/")) return `#/components/schemas/${componentName(`${name}.${ref.slice(8)}`)}`;
    return null;
  };
  for (const [key, def] of Object.entries(converted.defs)) {
    components[componentName(`${name}.${key}`)] = rewriteRefs(def, map) as JsonObject;
  }
  const root = rewriteRefs(converted.schema, map) as JsonObject;
  if (!selfReferential) return root;
  components[rootName] = root;
  return { $ref: `#/components/schemas/${rootName}` };
}

// ---------- 文档 ----------

function operationIdOf(path: string) {
  return path.replace(/[^A-Za-z0-9]+/g, "_");
}

function tokenSentence(token: OpenApiTokenAccess) {
  if (!token.allowed) return "API 令牌：不可用，只能在网页上操作。";
  const scope = token.minScope === "read" ? "可用，只读令牌就行" : "可用，需要「完全」令牌";
  const module = token.alwaysAllowed
    ? "不受模块限制"
    : token.module
      ? `模块「${token.moduleLabel}」（${token.module}）`
      : "没有归到模块，勾了模块的令牌调不了";
  return `API 令牌：${scope}；${module}。`;
}

function envelopeSchema(inner: JsonObject, required: boolean): JsonObject {
  return {
    type: "object",
    ...(required ? { required: ["json"] } : {}),
    properties: {
      json: inner,
      meta: { $ref: "#/components/schemas/SuperjsonMeta" },
    },
  };
}

function successResponse(output: JsonObject | null): JsonObject {
  if (!output) return { $ref: "#/components/responses/Success" };
  return {
    description: "成功。返回值在 result.data.json 里。",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["result"],
          properties: { result: { type: "object", required: ["data"], properties: { data: envelopeSchema(output, false) } } },
        },
      },
    },
  };
}

function infoDescription() {
  const moduleLines = API_TOKEN_MODULES.map((module) => `- \`${module}\` ${API_TOKEN_MODULE_LABELS[module]}：${API_TOKEN_MODULE_DETAILS[module]}`);
  return [
    "NEX 面板的全部接口。这份文档由面板从真实的 tRPC 路由生成，版本和你正在用的面板一致。",
    "",
    "## 怎么调",
    "",
    "接口是 tRPC over HTTP，带 superjson 信封：",
    "",
    `- **查询**：\`GET ${OPENAPI_TRPC_PREFIX}/<路径>?input=<URL 编码的 JSON>\`，JSON 是 \`{"json": 入参}\`；没有入参就不带 \`input\`。`,
    `- **修改**：\`POST ${OPENAPI_TRPC_PREFIX}/<路径>\`，请求体 \`{"json": 入参}\`；没有入参可以不带请求体。`,
    "  不管带不带请求体，`Content-Type: application/json` 都要有，否则回 415。查询只能 GET、修改只能 POST，用错了回 405。",
    "- **成功**：`{\"result\": {\"data\": {\"json\": 返回值}}}`。",
    "- **失败**：HTTP 状态码非 2xx，`{\"error\": {\"json\": {\"message\": \"给人看的原因\", \"code\": -32600, \"data\": {\"code\": \"BAD_REQUEST\", \"httpStatus\": 400, \"path\": \"rules.update\"}}}}`。",
    "  判断错误类型看 HTTP 状态码或 `data.code`，`message` 是给人看的。",
    "- `meta`：JSON 表达不了的值（日期、undefined、bigint）在 `meta.values` 里按字段路径标出来，例如 `{\"createdAt\": [\"Date\"]}`，",
    "  这时 `json.createdAt` 是 ISO 8601 字符串。入参里有日期字段时也要这样标。",
    `- 批量（\`?batch=1\`，一次最多 ${TRPC_MAX_BATCH_SIZE} 个调用）是面板网页自己用的，脚本一次调一个过程就好。`,
    "",
    "```bash",
    `curl -H 'Authorization: Bearer nex_…' --get '<面板地址>${OPENAPI_TRPC_PREFIX}/rules.listPage' \\`,
    "  --data-urlencode 'input={\"json\":{\"page\":1,\"pageSize\":20}}'",
    "```",
    "",
    "## 认证",
    "",
    "- **API 令牌**（给脚本用）：`Authorization: Bearer nex_…`。在面板「设置 › 进阶 › API 令牌」里创建，明文只显示一次。",
    "  权限和令牌的主人一样，另外：「只读」令牌只能调查询；任何令牌都碰不到账号本身和高危操作（改密码、双重验证、",
    "  令牌管理、备份迁移、插件安装等，文档里标着「API 令牌：不可用」）；令牌可以只开放部分模块。",
    `- **浏览器会话**：登录后的 Cookie \`${COOKIE_NAME}\`，网页自己用。`,
    "",
    "每个接口的描述里写着：至少要什么身份（不用登录 / 登录用户 / 管理员）、令牌能不能调、归哪个模块。",
    "机器可读的同一份信息在 `x-nex-access`、`x-nex-api-token` 里。",
    "",
    "## 令牌模块",
    "",
    ...moduleLines,
    "",
    "## 限流",
    "",
    "面板开了接口限流时，超了回 429，带 `Retry-After`（秒）。",
  ].join("\n");
}

function baseComponents(): { schemas: Record<string, JsonObject>; responses: JsonObject; securitySchemes: JsonObject } {
  return {
    securitySchemes: {
      apiToken: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "nex_ + 40 位字母数字",
        description: "个人 API 令牌：`Authorization: Bearer nex_…`。在面板「设置 › 进阶 › API 令牌」里创建。",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: COOKIE_NAME,
        description: "浏览器登录会话（auth.login 成功后由面板写入）。",
      },
    },
    schemas: {
      SuperjsonMeta: {
        type: "object",
        description: "superjson 的附加信息：json 里表达不了的值按字段路径标类型，例如 {\"values\": {\"createdAt\": [\"Date\"]}}；整个值是 undefined 时是 {\"values\": [\"undefined\"]}。没有这类值时不出现。",
        properties: {
          values: { description: "字段路径 → 类型标记。" },
          referentialEqualities: { description: "同一个对象在多处出现时的引用关系。" },
          v: { type: "integer", description: "superjson 的格式版本，响应里会带；请求里不用写。" },
        },
      },
      TrpcError: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["json"],
            properties: {
              json: {
                type: "object",
                required: ["message", "code", "data"],
                properties: {
                  message: { type: "string", description: "给人看的原因（中文）。入参校验失败时是「字段: 原因」。" },
                  code: { type: "integer", description: "JSON-RPC 风格的错误号，例如 -32600。判断错误类型请看 data.code。" },
                  data: {
                    type: "object",
                    required: ["code", "httpStatus"],
                    properties: {
                      code: {
                        type: "string",
                        description: "错误类型。",
                        examples: ["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "METHOD_NOT_SUPPORTED", "CONFLICT", "UNSUPPORTED_MEDIA_TYPE", "TOO_MANY_REQUESTS", "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE"],
                      },
                      httpStatus: { type: "integer", description: "和响应的 HTTP 状态码一致。" },
                      path: { type: "string", description: "出错的过程路径。" },
                      zodError: {
                        description: "入参校验失败时的逐字段错误（formErrors / fieldErrors），别的错误是 null。",
                        anyOf: [
                          {
                            type: "object",
                            properties: {
                              formErrors: { type: "array", items: { type: "string" } },
                              fieldErrors: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
                            },
                          },
                          { type: "null" },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      TrpcSuccess: {
        type: "object",
        required: ["result"],
        properties: {
          result: {
            type: "object",
            required: ["data"],
            properties: {
              data: {
                type: "object",
                properties: {
                  json: { description: "过程的返回值。路由里没有声明返回类型，结构以实际返回为准。" },
                  meta: { $ref: "#/components/schemas/SuperjsonMeta" },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      Success: {
        description: "成功。返回值在 result.data.json 里。",
        content: { "application/json": { schema: { $ref: "#/components/schemas/TrpcSuccess" } } },
      },
      Error: {
        description: [
          "失败。常见的状态码：",
          "400 入参不对（BAD_REQUEST）；401 没登录或令牌无效（UNAUTHORIZED）；",
          "403 没有权限、只读令牌做修改、令牌不能调这个过程（FORBIDDEN）；404 过程或资源不存在（NOT_FOUND）；",
          "405 查询用了 POST 或修改用了 GET（METHOD_NOT_SUPPORTED）；415 POST 没带 Content-Type: application/json（UNSUPPORTED_MEDIA_TYPE）；",
          "429 被限流（TOO_MANY_REQUESTS，带 Retry-After）；500 面板内部错误，或业务上不允许（message 里是原因）；503 数据库不可用或正在维护。",
        ].join(""),
        content: { "application/json": { schema: { $ref: "#/components/schemas/TrpcError" } } },
      },
    },
  };
}

/**
 * 过程表 → OpenAPI 3.1 文档。procedures 传 appRouter._def.procedures（路径 → 过程）。
 * 不带 servers：面板地址每个请求可能不一样，由出口路由补上。
 */
export function buildOpenApiDocument(procedures: Record<string, OpenApiProcedure>, options: { version?: string } = {}): OpenApiBuildResult {
  const components = baseComponents();
  const paths: Record<string, JsonObject> = {};
  const tags = new Map<string, JsonObject>();
  const degraded: Record<string, string[]> = {};
  const listed: string[] = [];

  for (const path of Object.keys(procedures).sort()) {
    const procedure = procedures[path];
    const type = String(procedure?._def?.type || "");
    // 订阅（WebSocket / SSE）不是普通的 HTTP 请求；面板现在没有，有了也不该伪装成 GET
    if (type !== "query" && type !== "mutation") continue;
    listed.push(path);

    const access = openApiAccessOf(procedure);
    const token = openApiTokenAccessOf(path, type);
    const tag = operationAuditModule(path);
    if (!tags.has(tag)) {
      const tagModule = apiTokenModuleOfPath(`${tag}.`);
      const label = operationAuditModuleLabel(tag);
      tags.set(tag, {
        name: tag,
        description: `${label === tag ? "" : `${label}。`}${tagModule ? `令牌模块：${API_TOKEN_MODULE_LABELS[tagModule]}（${tagModule}）。` : ""}` || tag,
      });
    }

    const inputs = procedure._def.inputs || [];
    const converted = inputs.map((input) => zodToOpenApiSchema(input));
    const notes = [...new Set(converted.flatMap((item) => item.notes))];
    if (notes.length > 0) degraded[path] = notes;
    const embedded = converted.map((item, index) => embedSchema(item, `${path}.input${converted.length > 1 ? index + 1 : ""}`, components.schemas));
    const inputSchema: JsonObject | null = embedded.length === 0 ? null : embedded.length === 1 ? embedded[0] : { allOf: embedded };
    const inputRequired = inputs.length > 0 && !inputs.every((input) => acceptsUndefined(input));

    const output = procedure._def.output ? zodToOpenApiSchema(procedure._def.output) : null;
    const outputSchema = output ? embedSchema(output, `${path}.output`, components.schemas) : null;

    const description = [
      `权限：${ACCESS_LABELS[access]}。${tokenSentence(token)}`,
      ...(notes.length > 0 ? [`入参说明：${notes.join("；")}。`] : []),
    ].join("\n\n");

    const operation: JsonObject = {
      operationId: operationIdOf(path),
      tags: [tag],
      summary: path,
      description,
      "x-nex-procedure": path,
      "x-nex-type": type,
      "x-nex-access": access,
      "x-nex-api-token": token,
      ...(notes.length > 0 ? { "x-nex-schema-notes": notes } : {}),
    };

    if (inputSchema) {
      const envelope = envelopeSchema(inputSchema, true);
      if (type === "query") {
        operation.parameters = [{
          name: "input",
          in: "query",
          required: inputRequired,
          description: `URL 编码的 JSON：{"json": 入参}。${inputRequired ? "" : "入参可以整个不传，这时不带 input。"}`,
          content: { "application/json": { schema: envelope } },
        }];
      } else {
        operation.requestBody = {
          required: inputRequired,
          description: `{"json": 入参}，要带 Content-Type: application/json。${inputRequired ? "" : "入参可以整个不传，这时不带请求体（Content-Type 照样要带）。"}`,
          content: { "application/json": { schema: envelope } },
        };
      }
    }

    operation.responses = { "200": successResponse(outputSchema), default: { $ref: "#/components/responses/Error" } };

    // 默认（文档顶层）是「令牌或会话」；令牌调不了的去掉令牌，不用登录的加一个空项表示可以匿名
    if (!token.allowed || access === "public") {
      operation.security = [
        ...(access === "public" ? [{}] : []),
        ...(token.allowed ? [{ apiToken: [] }] : []),
        { sessionCookie: [] },
      ];
    }

    paths[`${OPENAPI_TRPC_PREFIX}/${path}`] = { [type === "query" ? "get" : "post"]: operation };
  }

  const document: JsonObject = {
    openapi: OPENAPI_VERSION,
    jsonSchemaDialect: OPENAPI_JSON_SCHEMA_DIALECT,
    info: {
      title: "NEX 面板 API",
      version: options.version || APP_VERSION,
      description: infoDescription(),
    },
    security: [{ apiToken: [] }, { sessionCookie: [] }],
    tags: [...tags.values()],
    paths,
    components,
  };
  return { document, procedures: listed, degraded };
}
