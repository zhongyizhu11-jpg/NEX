import "dotenv/config";
import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { agentRouter } from "./agentRoutes";
import { paymentCallbackRouter } from "./payment";
import { migrationRouter } from "./migration";
import { clientLogoRouter } from "./clientLogoRoute";
import { proxySubscriptionRouter } from "./proxySubscriptionRoute";
import { initDatabase } from "./db";
import { installPanelLogger } from "./_core/panelLogger";
import { loadPanelSslRuntimeConfig, startPanelSslAutoReload } from "./panelSsl";
import { startBackgroundServices } from "./backgroundServices";
import { initializePanelClock } from "./panelClock";
import { ENV } from "./env";
import { TRPC_MAX_BATCH_SIZE } from "../shared/const";
import { resolveTrustProxySetting } from "./trustProxy";
import { authCapRouter } from "./authCaptcha";
import { isAllowedMobileCorsOrigin } from "./mobileCors";

installPanelLogger();

const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function isPortAvailable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const onListening = () => {
      server.close(() => resolve(true));
    };
    if (host) server.listen(port, host, onListening);
    else server.listen(port, onListening);
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 9810, host?: string): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/*
  静态资源的两条规则，都是冲着手机上的「卡顿」来的：

  一、`/assets/` 下的文件名带内容哈希（Vite 打出来的 index-Cq9D8WfP.js 这种），内容一变名字
     就变，所以可以放心标成 immutable + 一年 —— 第二次打开面板时浏览器一个字节都不用再
     问服务器。原来 express.static 默认 max-age=0，每次切页每个包都要回源做一次 304 协商，
     手机上一次往返就是几十到几百毫秒，六七个包串起来就是那个「正在加载页面」。
  二、index.html 永远 no-cache：它是唯一会指向新哈希的入口，缓存住它等于升级后还在跑旧版。
  三、`/globe/`、`/wallpapers/` 是几 MB 的地球贴图和壁纸，文件名不带哈希，不能 immutable；
     给 7 天：平时不回源，过期后靠 ETag 做一次 304，升级换图最多晚几天生效。
*/
function serveStatic(app: express.Express) {
  const clientDist = path.resolve(serverDir, "../client/dist");
  app.use(
    "/assets",
    express.static(path.join(clientDist, "assets"), { immutable: true, maxAge: "1y", index: false, fallthrough: true }),
  );
  for (const directory of ["globe", "wallpapers"]) {
    app.use(
      `/${directory}`,
      express.static(path.join(clientDist, directory), { maxAge: "7d", index: false, fallthrough: true }),
    );
  }
  app.use(express.static(clientDist, { index: false }));
  app.get("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

/*
  gzip / brotli 压缩。

  面板直接用 Node 对外服务（Docker 镜像里没有 nginx），而 express.static 本身不压缩：
  主包 850 kB 的 JS 和 212 kB 的 CSS 原样发到手机上。压过之后是 269 kB + 30 kB —— 首屏
  少下 760 kB，这是「卡顿」里最大的一块。API 的 JSON 响应（主机列表、规则列表）也一起压。

  SSE 流（Agent 事件）不能压：压缩要攒够一个块才吐，事件会被卡在缓冲里。那条路由自己
  标了 no-transform，compression 会跳过它；这里再按 Content-Type 兜一次底。
*/
function installCompression(app: express.Express) {
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        const type = res.getHeader("Content-Type");
        if (typeof type === "string" && type.includes("text/event-stream")) return false;
        return compression.filter(req, res);
      },
    }),
  );
}

function installMobileCors(app: express.Express) {
  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    // 只放行 App 的固定源；带端口的 localhost 仅开发环境放行，见 mobileCors.ts。
    const allowed = isAllowedMobileCorsOrigin(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-forwardx-mobile,trpc-accept,x-trpc-source");
      // 预检结果缓存 10 分钟：App 的每个 tRPC 请求都带自定义头，不缓存就是每次先多一个 OPTIONS 往返
      res.setHeader("Access-Control-Max-Age", "600");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS" && allowed) {
      res.status(204).end();
      return;
    }
    next();
  });
}

function installSecurityHeaders(app: express.Express) {
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const customSidebarEmbed = String(req.query?.__forwardx_embed || "") === "1";
    const frameAncestors = customSidebarEmbed ? "'self'" : "'none'";
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Only a custom sidebar iframe may opt the panel's own pages into
    // same-origin framing. External sites still control their own
    // X-Frame-Options/CSP response headers.
    res.setHeader("X-Frame-Options", customSidebarEmbed ? "SAMEORIGIN" : "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; base-uri 'self'; frame-ancestors ${frameAncestors}; object-src 'none'; img-src 'self' data: blob: https: http:; font-src 'self' data:; style-src 'self' 'unsafe-inline' https://fastly.jsdelivr.net; script-src 'self' 'unsafe-inline' https://fastly.jsdelivr.net https://cdn.jsdelivr.net https://cubism.live2d.com; connect-src 'self' https: http: wss: ws:; worker-src 'self' blob:; child-src 'self' blob:; frame-src 'self' data: https: http:; media-src 'self' data: blob: https: http:`,
    );
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
}

async function startServer() {
  const startupStartedAt = Date.now();
  const runStartupStep = async <T>(name: string, work: () => Promise<T> | T) => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 2_000) {
        console.warn(`[Server] startup step slow step=${name} durationMs=${durationMs}`);
      }
    }
  };

  await runStartupStep("panel-clock", () => initializePanelClock());
  const databaseStatus = await runStartupStep("database", () => initDatabase());

  const app = express();
  app.set("trust proxy", resolveTrustProxySetting(ENV.trustProxy));
  const panelSsl = await runStartupStep("panel-ssl", () => loadPanelSslRuntimeConfig());
  const protocol = panelSsl.enabled ? "https" : "http";
  const httpsServer = panelSsl.enabled && panelSsl.options ? createHttpsServer(panelSsl.options, app) : null;
  const server = httpsServer ?? createHttpServer(app);
  // 续签后的证书文件自动热加载（不用重启面板），快过期时在日志里提醒。
  if (httpsServer) startPanelSslAutoReload(httpsServer, panelSsl);
  installSecurityHeaders(app);
  installCompression(app);

  // Payment webhooks need the original request body for signature verification.
  app.use(paymentCallbackRouter);
  // Plugin archives are accepted as base64 JSON and can expand beyond the 5 MB binary limit.
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  app.use(cookieParser());
  installMobileCors(app);
  app.use(authCapRouter);
  app.use(agentRouter);
  app.use(migrationRouter);
  app.use(proxySubscriptionRouter);
  app.use(clientLogoRouter);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // batch 内的调用并发执行，不设上限一个 HTTP 请求就能塞进成千上万次登录/验证码尝试。
      maxBatchSize: TRPC_MAX_BATCH_SIZE,
    }),
  );
  serveStatic(app);

  const preferredPort = Number.parseInt(process.env.PORT || "9810", 10);
  const isProduction = process.env.NODE_ENV === "production";
  const isDevPanel = process.env.FORWARDX_DEV_PANEL === "1";
  const listenHost = isDevPanel ? (process.env.FORWARDX_DEV_SERVER_HOST || "127.0.0.1") : undefined;
  const port = isProduction
    ? preferredPort
    : await runStartupStep("find-port", () => findAvailablePort(preferredPort, listenHost));

  if (isProduction && !(await isPortAvailable(preferredPort, listenHost))) {
    throw new Error(`Port ${preferredPort} is already in use`);
  }

  if (port !== preferredPort) {
    console.warn(`[Server] Port ${preferredPort} is busy, using port ${port} instead`);
  }

  const onListening = () => {
    console.info(`Server running on ${protocol}://localhost:${port}/`);
    console.info(
      `[Server] NEX panel started on ${protocol.toUpperCase()} port ${port}`
        + ` startupMs=${Date.now() - startupStartedAt} database=${databaseStatus.ready ? "ready" : "not-ready"}`,
    );
  };
  if (listenHost) server.listen(port, listenHost, onListening);
  else server.listen(port, onListening);

  if (databaseStatus.ready) {
    startBackgroundServices();
  } else {
    console.warn("[Server] Database is not ready; background tasks are paused until the database setup is fixed and the panel restarts");
  }
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
