import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { apiTokenPolicyError } from "./ops/apiTokenPolicy";
import {
  buildOpenApiDocument,
  OPENAPI_TRPC_PREFIX,
  openApiAccessOf,
  zodToOpenApiSchema,
  type OpenApiProcedure,
} from "./openApi";
import { appRouter } from "./routers";

type Json = Record<string, any>;

const procedures = appRouter._def.procedures as unknown as Record<string, OpenApiProcedure>;
const built = buildOpenApiDocument(procedures);
const doc = built.document as Json;

/*
  故意不在文档里的过程。现在一个都没有：令牌调不了的过程也列出来，只是标着「API 令牌：不可用」
  （x-nex-api-token.allowed = false），这样看文档的人知道它存在、为什么调不了。
  以后真有要藏的，加到这里并写明原因 —— 否则下面的对账测试会红。
*/
const DELIBERATELY_EXCLUDED = new Set<string>();

function operationOf(path: string): { method: string; operation: Json } {
  const item = doc.paths[`${OPENAPI_TRPC_PREFIX}/${path}`];
  assert.ok(item, `文档里没有 ${path}`);
  const methods = Object.keys(item);
  assert.equal(methods.length, 1, `${path} 应该只有一个方法`);
  return { method: methods[0], operation: item[methods[0]] };
}

function inputSchemaOf(path: string): Json {
  const { method, operation } = operationOf(path);
  const envelope = method === "get"
    ? operation.parameters[0].content["application/json"].schema
    : operation.requestBody.content["application/json"].schema;
  assert.deepEqual(envelope.required, ["json"]);
  assert.deepEqual(envelope.properties.meta, { $ref: "#/components/schemas/SuperjsonMeta" });
  return envelope.properties.json;
}

// ---------- 最小的 OpenAPI 3.1 结构校验（不为此加依赖） ----------

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const PATH_ITEM_KEYS = new Set([...HTTP_METHODS, "summary", "description", "parameters", "servers", "$ref"]);
const PARAMETER_LOCATIONS = new Set(["query", "header", "path", "cookie"]);
const SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: any = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

/** 返回发现的问题；空数组 = 结构上是一份合法的 OpenAPI 3.1 文档。 */
function validateOpenApi31(root: Json): string[] {
  const problems: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) problems.push(message);
  };
  const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

  check(typeof root.openapi === "string" && /^3\.1\.\d+$/.test(root.openapi), "openapi 版本要是 3.1.x");
  check(isObject(root.info) && typeof root.info.title === "string" && root.info.title && typeof root.info.version === "string" && root.info.version, "info.title / info.version 必填");
  check(isObject(root.paths) || isObject(root.components) || isObject(root.webhooks), "paths / components / webhooks 至少要有一个");
  if (root.servers !== undefined) {
    check(Array.isArray(root.servers) && root.servers.every((server: Json) => isObject(server) && typeof server.url === "string"), "servers[].url 必填");
  }

  const schemes = isObject(root.components?.securitySchemes) ? root.components.securitySchemes : {};
  for (const [name, scheme] of Object.entries(schemes) as Array<[string, Json]>) {
    check(["apiKey", "http", "mutualTLS", "oauth2", "openIdConnect"].includes(scheme.type), `securitySchemes.${name}.type 不认识`);
    if (scheme.type === "http") check(typeof scheme.scheme === "string", `securitySchemes.${name} 缺 scheme`);
    if (scheme.type === "apiKey") check(typeof scheme.name === "string" && ["query", "header", "cookie"].includes(scheme.in), `securitySchemes.${name} 缺 name / in`);
  }
  const checkSecurity = (security: unknown, where: string) => {
    if (security === undefined) return;
    check(Array.isArray(security), `${where}.security 要是数组`);
    for (const requirement of (Array.isArray(security) ? security : []) as Json[]) {
      check(isObject(requirement), `${where}.security 的每一项要是对象`);
      for (const [name, scopes] of Object.entries(requirement)) {
        check(name in schemes, `${where}.security 引用了没定义的 ${name}`);
        check(Array.isArray(scopes), `${where}.security.${name} 要是数组`);
      }
    }
  };
  checkSecurity(root.security, "文档");

  const declaredTags = new Set<string>();
  for (const tag of (root.tags || []) as Json[]) {
    check(typeof tag.name === "string" && tag.name, "tags[].name 必填");
    check(!declaredTags.has(tag.name), `tag 重复：${tag.name}`);
    declaredTags.add(tag.name);
  }

  const checkContent = (content: unknown, where: string) => {
    check(isObject(content) && Object.keys(content).length > 0, `${where}.content 要是非空对象`);
    for (const [mediaType, media] of Object.entries(isObject(content) ? content : {}) as Array<[string, Json]>) {
      check(/^[\w*+.-]+\/[\w*+.-]+/.test(mediaType), `${where} 的媒体类型不对：${mediaType}`);
      check(isObject(media), `${where}.content.${mediaType} 要是对象`);
    }
  };
  const checkResponse = (response: Json, where: string) => {
    if (typeof response.$ref === "string") return;
    check(typeof response.description === "string", `${where} 缺 description`);
    if (response.content !== undefined) checkContent(response.content, where);
  };

  const operationIds = new Set<string>();
  for (const [route, item] of Object.entries((root.paths || {}) as Json)) {
    check(route.startsWith("/"), `路径要以 / 开头：${route}`);
    check(isObject(item), `${route} 要是对象`);
    for (const [key, operation] of Object.entries(item as Json) as Array<[string, Json]>) {
      check(PATH_ITEM_KEYS.has(key), `${route} 里有不认识的键 ${key}`);
      if (!HTTP_METHODS.has(key)) continue;
      const where = `${key.toUpperCase()} ${route}`;
      check(isObject(operation.responses) && Object.keys(operation.responses).length > 0, `${where} 缺 responses`);
      for (const [status, response] of Object.entries((operation.responses || {}) as Json)) {
        check(status === "default" || /^[1-5](\d\d|XX)$/.test(status), `${where} 的响应码不对：${status}`);
        checkResponse(response as Json, `${where} ${status}`);
      }
      if (operation.operationId !== undefined) {
        check(typeof operation.operationId === "string" && operation.operationId, `${where} 的 operationId 要是非空字符串`);
        check(!operationIds.has(operation.operationId), `operationId 重复：${operation.operationId}`);
        operationIds.add(operation.operationId);
      }
      for (const tag of (operation.tags || []) as string[]) check(declaredTags.has(tag), `${where} 用了没声明的 tag ${tag}`);
      const seenParameters = new Set<string>();
      for (const parameter of (operation.parameters || []) as Json[]) {
        check(typeof parameter.name === "string" && PARAMETER_LOCATIONS.has(parameter.in), `${where} 的参数缺 name / in`);
        check((parameter.schema !== undefined) !== (parameter.content !== undefined), `${where} 的参数 ${parameter.name} 要有 schema 或 content 其中一个`);
        if (parameter.content !== undefined) {
          checkContent(parameter.content, `${where} 参数 ${parameter.name}`);
          check(Object.keys(parameter.content).length === 1, `${where} 参数 ${parameter.name} 的 content 只能有一种媒体类型`);
        }
        if (parameter.in === "path") check(parameter.required === true, `${where} 的路径参数必须 required`);
        const identity = `${parameter.in}:${parameter.name}`;
        check(!seenParameters.has(identity), `${where} 的参数重复：${identity}`);
        seenParameters.add(identity);
      }
      if (operation.requestBody !== undefined) checkContent(operation.requestBody.content, `${where} requestBody`);
      checkSecurity(operation.security, where);
    }
  }
  for (const [name, response] of Object.entries((root.components?.responses || {}) as Json)) checkResponse(response as Json, `components.responses.${name}`);

  // 整份文档里的每个 $ref 都指得到东西；每个 type 都是 JSON Schema 认识的
  const walk = (value: unknown, where: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${where}[${index}]`));
      return;
    }
    if (!isObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref") {
        check(typeof item === "string" && resolvePointer(root, item as string) !== undefined, `${where} 的 $ref 指不到东西：${String(item)}`);
      } else if (key === "type" && (typeof item === "string" || Array.isArray(item)) && /schema|properties|items|anyOf|oneOf|allOf|json/.test(where)) {
        for (const type of Array.isArray(item) ? item : [item]) check(SCHEMA_TYPES.has(type as string), `${where} 的 type 不认识：${String(type)}`);
      }
      walk(item, `${where}.${key}`);
    }
  };
  walk(root, "#");
  return problems;
}

// ---------- 测试 ----------

test("路由里的每个过程都在文档里：查询是 GET，修改是 POST，没有多出来的", () => {
  const names = Object.keys(procedures);
  assert.ok(names.length > 500, `只读到 ${names.length} 个过程`);
  for (const name of names) {
    if (DELIBERATELY_EXCLUDED.has(name)) {
      assert.equal(doc.paths[`${OPENAPI_TRPC_PREFIX}/${name}`], undefined, `${name} 在排除名单里却出现了`);
      continue;
    }
    const { method, operation } = operationOf(name);
    const type = String(procedures[name]._def.type);
    assert.equal(method, type === "query" ? "get" : "post", name);
    assert.equal(operation["x-nex-procedure"], name);
    assert.equal(operation["x-nex-type"], type);
  }
  for (const excluded of DELIBERATELY_EXCLUDED) assert.ok(procedures[excluded], `排除名单里的 ${excluded} 已经不存在了`);
  assert.equal(Object.keys(doc.paths).length, names.length - DELIBERATELY_EXCLUDED.size);
  assert.deepEqual([...built.procedures].sort(), names.filter((name) => !DELIBERATELY_EXCLUDED.has(name)).sort());
});

test("整份文档过得了 OpenAPI 3.1 的基本结构校验，能原样序列化", () => {
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(validateOpenApi31(doc), []);
  const text = JSON.stringify(doc);
  assert.deepEqual(JSON.parse(text), doc, "没有 undefined、函数这类 JSON 存不下的东西");
  // 加上面板地址（出口路由会补）也是合法的
  assert.deepEqual(validateOpenApi31({ ...doc, servers: [{ url: "https://panel.example.com" }] }), []);
});

test("校验器自己不是摆设：坏文档查得出来", () => {
  const broken = JSON.parse(JSON.stringify(doc)) as Json;
  broken.openapi = "3.0.3";
  const route = `${OPENAPI_TRPC_PREFIX}/rules.listPage`;
  delete broken.paths[route].get.responses;
  broken.paths[`${OPENAPI_TRPC_PREFIX}/hosts.getById`].get.parameters[0].content["application/json"].schema = { $ref: "#/components/schemas/Nope" };
  broken.paths[`${OPENAPI_TRPC_PREFIX}/auth.me`].get.security = [{ nope: [] }];
  const problems = validateOpenApi31(broken);
  assert.ok(problems.some((problem) => problem.includes("3.1.x")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.includes("缺 responses")));
  assert.ok(problems.some((problem) => problem.includes("指不到东西")));
  assert.ok(problems.some((problem) => problem.includes("没定义的 nope")));
});

test("抽查查询：ops.events.list 是 GET，input 可以不带，limit 是 1 到 100 的整数", () => {
  const { method, operation } = operationOf("ops.events.list");
  assert.equal(method, "get");
  assert.equal(operation.parameters.length, 1);
  assert.equal(operation.parameters[0].name, "input");
  assert.equal(operation.parameters[0].in, "query");
  assert.equal(operation.parameters[0].required, false, "入参整个可选");
  const schema = inputSchemaOf("ops.events.list");
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties.limit, { default: 50, type: "integer", minimum: 1, maximum: 100 });
  assert.deepEqual(schema.properties.minLevel.enum, ["all", "warn"]);
  assert.equal(operation["x-nex-access"], "admin");
  assert.deepEqual(operation["x-nex-api-token"], { module: "monitoring", moduleLabel: "监控与事件", alwaysAllowed: false, allowed: true, minScope: "read" });
  assert.match(operation.description, /权限：管理员/);
  assert.match(operation.description, /只读令牌就行/);
  assert.equal(operation.responses["200"].$ref, "#/components/responses/Success");
  assert.equal(operation.responses.default.$ref, "#/components/responses/Error");
});

test("抽查查询：hosts.getById 必须带 input，id 必填", () => {
  const { method, operation } = operationOf("hosts.getById");
  assert.equal(method, "get");
  assert.equal(operation.parameters[0].required, true);
  const schema = inputSchemaOf("hosts.getById");
  assert.deepEqual(schema.required, ["id"]);
  assert.equal(schema.properties.id.type, "number");
});

test("抽查修改：ops.apiTokens.create 是 POST，请求体必填，scope 是枚举；令牌调不了、只认会话", () => {
  const { method, operation } = operationOf("ops.apiTokens.create");
  assert.equal(method, "post");
  assert.equal(operation.requestBody.required, true);
  assert.equal(operation.parameters, undefined);
  const schema = inputSchemaOf("ops.apiTokens.create");
  assert.ok(schema.required.includes("name"));
  assert.deepEqual(schema.properties.scope.enum, ["read", "full"]);
  assert.equal(operation["x-nex-api-token"].allowed, false);
  assert.equal(operation["x-nex-api-token"].minScope, null);
  assert.match(operation.description, /API 令牌：不可用/);
  assert.deepEqual(operation.security, [{ sessionCookie: [] }]);
});

test("抽查修改：rules.toggle 要「完全」令牌，归转发规则模块；auth.login 不用登录", () => {
  const toggle = operationOf("rules.toggle");
  assert.equal(toggle.method, "post");
  assert.equal(toggle.operation["x-nex-access"], "user");
  assert.deepEqual(toggle.operation["x-nex-api-token"], { module: "rules", moduleLabel: "转发规则", alwaysAllowed: false, allowed: true, minScope: "full" });
  assert.equal(toggle.operation.security, undefined, "用文档顶层的默认：令牌或会话");
  assert.deepEqual(doc.security, [{ apiToken: [] }, { sessionCookie: [] }]);

  const login = operationOf("auth.login");
  assert.equal(login.method, "post");
  assert.equal(login.operation["x-nex-access"], "public");
  assert.deepEqual(login.operation.security[0], {}, "可以匿名");
  assert.equal(login.operation["x-nex-api-token"].alwaysAllowed, true);
  assert.ok(inputSchemaOf("auth.login").required.includes("password"));

  // 没有入参的过程：GET 不带参数，POST 不带请求体
  assert.equal(operationOf("auth.me").operation.parameters, undefined);
  assert.equal(operationOf("auth.logout").operation.requestBody, undefined);
});

test("每个过程的令牌标注和线上拦请求的策略一致", () => {
  for (const name of built.procedures) {
    const { operation } = operationOf(name);
    const type = operation["x-nex-type"];
    const token = operation["x-nex-api-token"];
    assert.equal(token.allowed, apiTokenPolicyError("full", name, type, null) === null, name);
    if (token.allowed) {
      assert.equal(token.minScope, type === "query" ? "read" : "full", name);
      assert.equal(apiTokenPolicyError(token.minScope, name, type, token.module ? [token.module] : null), null, name);
    } else {
      assert.ok(!(operation.security as Json[]).some((item) => "apiToken" in item), `${name} 的 security 里不该有令牌`);
    }
    assert.ok(["public", "user", "admin"].includes(operation["x-nex-access"]), name);
  }
  // 权限档位是从过程挂的中间件上认出来的
  const sample = router({
    open: publicProcedure.query(() => 1),
    mine: protectedProcedure.query(() => 1),
    root: adminProcedure.input(z.object({ id: z.number() })).mutation(() => 1),
  })._def.procedures as unknown as Record<string, OpenApiProcedure>;
  assert.deepEqual([openApiAccessOf(sample.open), openApiAccessOf(sample.mine), openApiAccessOf(sample.root)], ["public", "user", "admin"]);
});

test("文档如实写了线上格式：信封、错误、认证", () => {
  const { components } = doc;
  assert.deepEqual(components.securitySchemes.apiToken.type, "http");
  assert.deepEqual(components.securitySchemes.apiToken.scheme, "bearer");
  assert.equal(components.securitySchemes.sessionCookie.in, "cookie");
  assert.equal(components.securitySchemes.sessionCookie.name, "app_session_id");
  // 成功：{"result":{"data":{"json": …}}}
  assert.deepEqual(components.schemas.TrpcSuccess.required, ["result"]);
  assert.ok(components.schemas.TrpcSuccess.properties.result.properties.data.properties.json);
  // 失败：{"error":{"json":{"message","code","data":{"code","httpStatus",…}}}}
  const error = components.schemas.TrpcError.properties.error.properties.json;
  assert.deepEqual(error.required, ["message", "code", "data"]);
  assert.deepEqual(Object.keys(error.properties.data.properties), ["code", "httpStatus", "path", "zodError"]);
  for (const text of ["/api/trpc/<路径>?input=", "Authorization: Bearer nex_", "{\"json\": 入参}", "Retry-After", "只读"]) {
    assert.ok(doc.info.description.includes(text), `说明里没有提到 ${text}`);
  }
  assert.equal(doc.servers, undefined, "面板地址由出口路由按请求补上");
});

test("转不成 JSON Schema 的类型降级处理：不抛错，在描述里写明", () => {
  const schema = z.object({
    name: z.string().refine((value) => value.length > 2),
    at: z.date(),
    count: z.string().transform((value) => Number(value)),
    loose: z.preprocess((value) => String(value), z.string()),
    big: z.bigint().optional(),
    custom: z.custom<string>(() => true),
    table: z.map(z.string(), z.number()).optional(),
  }).refine((value) => !!value);
  const converted = zodToOpenApiSchema(schema);
  const properties = converted.schema.properties as Json;
  assert.equal(properties.name.type, "string");
  assert.match(properties.name.description, /自定义校验/);
  assert.deepEqual([properties.at.type, properties.at.format], ["string", "date-time"]);
  assert.match(properties.at.description, /meta\.values/);
  assert.equal(properties.count.type, "string", "transform 取转换前的输入");
  assert.match(properties.count.description, /转换/);
  assert.match(properties.loose.description, /转换/);
  assert.match(properties.big.description, /BigInt.*按任意值处理/);
  assert.match(properties.custom.description, /按任意值处理/);
  assert.match(properties.table.description, /Map.*按任意值处理/);
  assert.match(String(converted.schema.description), /自定义校验/, "对象整体的 refine 也标出来");
  assert.ok(converted.notes.length >= 4);
  assert.equal(JSON.stringify(converted.schema).includes("$schema"), false);

  // 不是 zod 的校验器、转换时直接抛错的 schema：只留说明，不抛
  assert.match(String(zodToOpenApiSchema((value: unknown) => value).schema.description), /不是 zod/);
  const throwing = z.object({ inner: z.lazy((): z.ZodString => { throw new Error("boom"); }) });
  const failed = zodToOpenApiSchema(throwing);
  assert.match(String(failed.schema.description), /转不成 JSON Schema（boom）/);
  assert.equal(failed.notes.length, 1);

  // 放进文档里：降级的过程照常出现，说明写进描述和 x-nex-schema-notes
  const sample = router({
    odd: adminProcedure.input(schema).mutation(() => true),
    fine: publicProcedure.input(z.object({ id: z.number().int() })).query(() => true),
  })._def.procedures as unknown as Record<string, OpenApiProcedure>;
  const result = buildOpenApiDocument(sample, { version: "test" });
  assert.deepEqual(validateOpenApi31(result.document as Json), []);
  assert.deepEqual(Object.keys(result.degraded), ["odd"]);
  const odd = (result.document as Json).paths[`${OPENAPI_TRPC_PREFIX}/odd`].post;
  assert.match(odd.description, /入参说明/);
  assert.ok(odd["x-nex-schema-notes"].length >= 4);
  assert.equal((result.document as Json).paths[`${OPENAPI_TRPC_PREFIX}/fine`].get["x-nex-schema-notes"], undefined);
});

test("真实路由里用了 refine / 日期的过程都标了出来", () => {
  const degraded = Object.keys(built.degraded);
  assert.ok(degraded.length > 0, "路由里本来就有带 refine 的入参");
  for (const name of degraded) {
    const { operation } = operationOf(name);
    assert.deepEqual(operation["x-nex-schema-notes"], built.degraded[name]);
    assert.match(operation.description, /入参说明/);
  }
});

test("递归的 schema：引用改写成文档里的绝对路径，都指得到", () => {
  type Node = { name: string; children?: Node[] };
  const node: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string(), children: z.array(node).optional() }));
  const sample = router({
    tree: publicProcedure.input(node).query(() => true),
    forest: publicProcedure.input(z.object({ roots: z.array(node) })).mutation(() => true),
  })._def.procedures as unknown as Record<string, OpenApiProcedure>;
  const result = buildOpenApiDocument(sample, { version: "test" });
  const document = result.document as Json;
  assert.deepEqual(validateOpenApi31(document), []);
  const text = JSON.stringify(document);
  assert.equal(text.includes('"#/$defs/'), false);
  assert.equal(text.includes('"$ref":"#"'), false);
  assert.ok(Object.keys(document.components.schemas).some((name) => name.startsWith("tree.input")));
  assert.ok(Object.keys(document.components.schemas).some((name) => name.startsWith("forest.input")));
});
