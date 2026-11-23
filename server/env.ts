import crypto from "crypto";
import fs from "fs";
import path from "path";

/*
  旧版 docker-compose.yml / .env.example 把 JWT_SECRET 默认成了示例值，照抄部署的面板全都用同一把
  公开的签名密钥，任何人都能伪造登录 Cookie。这些示例值一律当作「没配置」，改走下面自动生成并持久化
  的密钥（用过示例值的部署升级后已登录会话会失效一次，需要重新登录）。
*/
const PLACEHOLDER_JWT_SECRETS = new Set([
  "change-me-to-a-random-string",
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "your-secret",
  "your-secret-key",
  "your-jwt-secret",
  "your_jwt_secret",
  "jwt-secret",
  "jwt_secret",
  "secret",
]);

export function isPlaceholderJwtSecret(value: unknown) {
  return PLACEHOLDER_JWT_SECRETS.has(String(value ?? "").trim().toLowerCase());
}

export function readOrCreateCookieSecret(env: NodeJS.ProcessEnv = process.env) {
  const envSecret = String(env.JWT_SECRET || "").trim();
  if (envSecret && !isPlaceholderJwtSecret(envSecret)) return envSecret;
  if (envSecret) {
    console.warn("[Security] JWT_SECRET is set to a well-known placeholder value; ignoring it and using a generated persistent secret instead. Existing sessions signed with the placeholder must log in again.");
  }

  const configuredPath = String(env.FORWARDX_JWT_SECRET_PATH || "").trim();
  const defaultDataDir = process.platform === "win32" ? path.resolve(process.cwd(), "data") : "/data";
  const sqliteDir = path.dirname(String(env.SQLITE_PATH || path.join(defaultDataDir, "forwardx.db")));
  const candidates = [
    configuredPath,
    path.join(sqliteDir, "jwt.secret"),
    path.resolve(process.cwd(), "data", "jwt.secret"),
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
      if (existing.length >= 32) return existing;
      const generated = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
      console.warn(`[Security] JWT_SECRET is not set; generated persistent cookie secret at ${filePath}`);
      return generated;
    } catch {
      // Try the next candidate path.
    }
  }

  console.warn("[Security] JWT_SECRET is not set and no writable secret path was found; using an in-memory cookie secret.");
  return crypto.randomBytes(32).toString("hex");
}

function readIntEnv(names: string[], fallback: number, min: number, max: number) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) return Math.max(min, Math.min(max, value));
  }
  return fallback;
}

/**
 * 面板的数据目录：Docker 里是数据卷 /data，本地安装是 $APP_DIR/data（装机脚本把 SQLITE_PATH 指到那里）。
 * 以 SQLITE_PATH 所在目录为准 —— jwt.secret、日志、Agent 二进制缓存都该和数据库放一起，容器重建不丢。
 */
export function panelDataDir(env: NodeJS.ProcessEnv = process.env) {
  const sqlitePath = String(env.SQLITE_PATH || "").trim();
  const dir = sqlitePath ? path.dirname(path.resolve(sqlitePath)) : process.platform === "win32" ? path.resolve(process.cwd(), "data") : "/data";
  return canonicalPath(dir);
}

/**
 * 把路径里的符号链接解掉（macOS 的 /var/folders 其实是 /private/var/folders）：目录还不存在时解到最近的
 * 已存在祖先，再把剩下的接回去。缓存路径和 process.cwd() 之类的真实路径比对时才不会一个带 /private 一个不带。
 */
export function canonicalPath(target: string) {
  const resolved = path.resolve(target);
  const pending: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

export const ENV = {
  cookieSecret: readOrCreateCookieSecret(),
  mysqlUrl: process.env.MYSQL_URL ?? "",
  mysqlHost: process.env.MYSQL_HOST ?? "",
  mysqlPort: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
  mysqlUser: process.env.MYSQL_USER ?? "",
  mysqlPassword: process.env.MYSQL_PASSWORD ?? "",
  mysqlDatabase: process.env.MYSQL_DATABASE ?? "",
  mysqlSsl: process.env.MYSQL_SSL === "true",
  mysqlConfigPath: process.env.MYSQL_CONFIG_PATH ?? "/data/mysql.json",
  postgresUrl: process.env.POSTGRES_URL ?? process.env.POSTGRESQL_URL ?? process.env.PG_URL ?? "",
  postgresHost: process.env.POSTGRES_HOST ?? process.env.POSTGRESQL_HOST ?? process.env.PGHOST ?? "",
  postgresPort: Number.parseInt(process.env.POSTGRES_PORT || process.env.POSTGRESQL_PORT || process.env.PGPORT || "5432", 10),
  postgresUser: process.env.POSTGRES_USER ?? process.env.POSTGRESQL_USER ?? process.env.PGUSER ?? "",
  postgresPassword: process.env.POSTGRES_PASSWORD ?? process.env.POSTGRESQL_PASSWORD ?? process.env.PGPASSWORD ?? "",
  postgresDatabase: process.env.POSTGRES_DATABASE ?? process.env.POSTGRESQL_DATABASE ?? process.env.PGDATABASE ?? "",
  postgresSsl: process.env.POSTGRES_SSL === "true" || process.env.POSTGRESQL_SSL === "true" || process.env.PGSSL === "true",
  databaseType: process.env.DATABASE_TYPE ?? process.env.DB_TYPE ?? "",
  databaseConfigPath: process.env.DATABASE_CONFIG_PATH ?? process.env.DB_CONFIG_PATH ?? "/data/database.json",
  sqlitePath: process.env.SQLITE_PATH ?? "/data/forwardx.db",
  port: Number.parseInt(process.env.PORT || "9810", 10),
  publicPort: readIntEnv(["FORWARDX_PUBLIC_PORT", "FORWARDX_EXTERNAL_PORT"], 0, 1, 65535),
  portConfigPath: process.env.FORWARDX_PORT_CONFIG_PATH ?? "",
  portManagement: process.env.FORWARDX_PORT_MANAGEMENT ?? "",
  panelSslEnabled: process.env.FORWARDX_PANEL_SSL_ENABLED === "true",
  panelSslCertPath: process.env.FORWARDX_PANEL_SSL_CERT_PATH ?? "",
  panelSslKeyPath: process.env.FORWARDX_PANEL_SSL_KEY_PATH ?? "",
  // Only trusted reverse proxies may supply X-Forwarded-* client metadata.
  // Keep loopback-only as the secure default; Docker/reverse-proxy deployments
  // can explicitly set FORWARDX_TRUST_PROXY to their proxy subnet or hop count.
  trustProxy: process.env.FORWARDX_TRUST_PROXY ?? "loopback",
  // 额外放行的浏览器来源（CSRF 防护，见 server/_core/csrf.ts）：面板自己的域名和手机 App 源默认就放行，
  // 只有把面板 API 嵌进别的站点时才需要填，逗号分隔，如 https://ops.example.com,https://status.example.com。
  trustedOrigins: process.env.FORWARDX_TRUSTED_ORIGINS ?? "",
  // 管理后台一键升级命令。为空时只允许检查更新，不执行升级。
  // 执行时会注入 FORWARDX_TARGET_VERSION / FORWARDX_CURRENT_VERSION / FORWARDX_REPO_URL。
  upgradeCommand: process.env.FORWARDX_UPGRADE_COMMAND ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramBotPolling: process.env.TELEGRAM_BOT_POLLING !== "false",
  isProduction: process.env.NODE_ENV === "production",
};
