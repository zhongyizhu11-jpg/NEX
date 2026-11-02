import express from "express";
import type { IncomingHttpHeaders } from "http";
import { COOKIE_NAME } from "../shared/const";

/*
  JSON 请求体的大小上限（P1-5）。

  以前全站一个 express.json({ limit: "10mb" })，而且排在鉴权之前：谁都能对登录接口
  POST 10MB 的 JSON，面板先把它整个读进来解析一遍。现在默认 1MB，只有确实要传大东西的
  几条路给 10MB（和原来一样，不降不升）：

  · Agent 上报（/api/agent/*、/api/sync）：规则多的机器，流量、连接、诊断、支持包结果会很大；
  · tRPC 里的插件包上传（base64）、插件设置和用法（白名单这类大文本）、面板备份导入、
    设置里的背景图和 Logo（data URL）。

  这几条也只有带着凭据（Authorization 头或登录 cookie）时才放大：真正鉴权在后面，
  这里只是不让完全匿名的请求白白占 10MB。
  tRPC 的批量请求路径是 /api/trpc/a.b,c.d：只要其中一个过程在名单里就按大上限解析。
  大上限的解析器挂在全局那个前面，body-parser 解析过一次就不会再解析第二次。
*/
export const DEFAULT_JSON_BODY_LIMIT = "1mb";
export const LARGE_JSON_BODY_LIMIT = "10mb";

const LARGE_BODY_PATH_PREFIXES = ["/api/agent/", "/api/sync"];

export const LARGE_BODY_TRPC_PROCEDURES = new Set([
  "plugins.installFromUpload",
  "plugins.saveSetting",
  "plugins.saveSettings",
  "plugins.saveUsage",
  "plugins.runAction",
  "system.importPanelBackup",
  "system.updateSettings",
]);

/** tRPC 请求路径（相对 /api/trpc 或带前缀都行）里的过程名。 */
export function trpcProceduresFromPath(pathname: string) {
  const path = String(pathname || "").replace(/^\/api\/trpc/, "").replace(/^\/+/, "");
  if (!path) return [];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // 解不开就按原样比，最多是落到 1MB 的默认上限。
  }
  return decoded.split(",").map((item) => item.trim()).filter(Boolean);
}

function hasCredentials(headers: IncomingHttpHeaders) {
  if (String(headers.authorization || "").trim()) return true;
  return String(headers.cookie || "").includes(`${COOKIE_NAME}=`);
}

export function needsLargeJsonBody(pathname: string, headers: IncomingHttpHeaders = {}) {
  const path = String(pathname || "");
  const largePath = LARGE_BODY_PATH_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))
    || (path.startsWith("/api/trpc/") && trpcProceduresFromPath(path).some((procedure) => LARGE_BODY_TRPC_PROCEDURES.has(procedure)));
  return largePath && hasCredentials(headers);
}

export function installJsonBodyParsers(app: express.Express) {
  const largeJson = express.json({ limit: LARGE_JSON_BODY_LIMIT });
  app.use((req, res, next) => {
    if (!needsLargeJsonBody(req.path, req.headers)) return next();
    largeJson(req, res, next);
  });
  app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
}
