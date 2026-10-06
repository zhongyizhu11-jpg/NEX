import fs from "fs";
import net from "net";
import path from "path";
import tls from "tls";
import crypto from "crypto";
import { spawn } from "child_process";
import type { ServerOptions } from "https";
import { ENV } from "./env";
import { getAllSettings } from "./repositories/settingsRepository";

export type PanelSslSettings = {
  enabled: boolean;
  mode: "path" | "pem";
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
};

export type PanelSslRuntimeConfig = {
  enabled: boolean;
  settings: PanelSslSettings;
  options?: ServerOptions;
  error?: string;
};

export type GeneratedPanelSslCertificate = {
  certPath: string;
  keyPath: string;
  hosts: string[];
  days: number;
};

export function readPanelSslSettings(all: Record<string, string | null | undefined>): PanelSslSettings {
  const storedEnabled = all.panelSslEnabled;
  const mode = all.panelSslMode === "pem" ? "pem" : "path";
  return {
    enabled: storedEnabled === undefined || storedEnabled === null
      ? ENV.panelSslEnabled
      : storedEnabled === "true",
    mode,
    certPath: String(all.panelSslCertPath ?? ENV.panelSslCertPath ?? "").trim(),
    keyPath: String(all.panelSslKeyPath ?? ENV.panelSslKeyPath ?? "").trim(),
    certPem: String(all.panelSslCertPem ?? "").trim(),
    keyPem: String(all.panelSslKeyPem ?? "").trim(),
  };
}

function normalizePem(value: string) {
  return `${String(value || "").trim()}\n`;
}

function validatePanelSslPem(settings: PanelSslSettings): ServerOptions {
  const certText = normalizePem(settings.certPem);
  const keyText = normalizePem(settings.keyPem);
  if (!settings.certPem || !settings.keyPem) {
    throw new Error("粘贴证书模式下必须填写证书内容和私钥内容");
  }
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(certText)) {
    throw new Error("证书内容不是有效的 PEM 证书");
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(keyText)) {
    throw new Error("私钥内容不是有效的 PEM 私钥");
  }

  try {
    tls.createSecureContext({ cert: certText, key: keyText });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`证书或私钥校验失败：${message}`);
  }
  return { cert: certText, key: keyText };
}

export async function validatePanelSslConfig(settings: PanelSslSettings): Promise<ServerOptions | null> {
  if (!settings.enabled) return null;
  if (settings.mode === "pem") return validatePanelSslPem(settings);

  if (!settings.certPath || !settings.keyPath) {
    throw new Error("开启面板 SSL 后必须填写证书文件和私钥文件路径");
  }

  let cert: Buffer;
  let key: Buffer;
  try {
    [cert, key] = await Promise.all([
      fs.promises.readFile(settings.certPath),
      fs.promises.readFile(settings.keyPath),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`证书或私钥文件读取失败：${message}`);
  }

  try {
    tls.createSecureContext({ cert, key });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`证书或私钥校验失败：${message}`);
  }

  return { cert, key };
}

function normalizeSelfSignedHost(value: string) {
  let host = String(value || "").trim();
  if (!host) return "";
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  host = host.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "");
  if (!host) return "";
  if (net.isIP(host)) return host;
  if (host.includes(":")) return "";
  if (host.length > 253) return "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)) return "";
  if (host.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))) return "";
  return host.toLowerCase();
}

function defaultPanelSslCertDir() {
  const configured = String(process.env.FORWARDX_PANEL_SSL_CERT_DIR || "").trim();
  if (configured) return configured;
  if (process.platform === "win32") return path.resolve(process.cwd(), "data", "certs");
  return path.join(path.dirname(ENV.sqlitePath || "/data/forwardx.db"), "certs");
}

function runOpenSsl(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("openssl 执行超时"));
    }, 15000);

    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") reject(new Error("系统未安装 openssl，无法自动生成自签证书"));
      else reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat(chunks).toString("utf8").trim();
      reject(new Error(output || `openssl exited with code ${code}`));
    });
  });
}

export async function generateSelfSignedPanelSslCertificate(inputHosts: string[] = [], days = 825): Promise<GeneratedPanelSslCertificate> {
  const hostSet = new Set<string>();
  for (const host of inputHosts) {
    const normalized = normalizeSelfSignedHost(host);
    if (normalized) hostSet.add(normalized);
  }
  hostSet.add("localhost");
  hostSet.add("127.0.0.1");

  const hosts = Array.from(hostSet).slice(0, 20);
  const san = hosts.map((host) => (net.isIP(host) ? `IP:${host}` : `DNS:${host}`)).join(",");
  const cn = (hosts.find((host) => !net.isIP(host)) || "NEX Panel").replace(/[\/\\]/g, "-").slice(0, 64);
  const normalizedDays = Math.min(3650, Math.max(1, Math.floor(Number(days) || 825)));
  const certDir = defaultPanelSslCertDir();
  await fs.promises.mkdir(certDir, { recursive: true });

  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tempCertPath = path.join(certDir, `.panel-selfsigned-${suffix}.crt`);
  const tempKeyPath = path.join(certDir, `.panel-selfsigned-${suffix}.key`);
  const certPath = path.join(certDir, "panel-selfsigned.crt");
  const keyPath = path.join(certDir, "panel-selfsigned.key");

  try {
    await runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      String(normalizedDays),
      "-subj",
      `/CN=${cn}`,
      "-addext",
      `subjectAltName=${san}`,
      "-keyout",
      tempKeyPath,
      "-out",
      tempCertPath,
    ]);
    await validatePanelSslConfig({
      enabled: true,
      mode: "path",
      certPath: tempCertPath,
      keyPath: tempKeyPath,
      certPem: "",
      keyPem: "",
    });
    await fs.promises.rm(certPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(keyPath, { force: true }).catch(() => undefined);
    await fs.promises.rename(tempCertPath, certPath);
    await fs.promises.rename(tempKeyPath, keyPath);
    await fs.promises.chmod(keyPath, 0o600).catch(() => undefined);
    return { certPath, keyPath, hosts, days: normalizedDays };
  } finally {
    await fs.promises.rm(tempCertPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(tempKeyPath, { force: true }).catch(() => undefined);
  }
}

export async function loadPanelSslRuntimeConfig(): Promise<PanelSslRuntimeConfig> {
  let all: Record<string, string | null | undefined> = {};
  try {
    all = await getAllSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PanelSSL] Settings unavailable: ${message}; using environment SSL settings only`);
  }
  const settings = readPanelSslSettings(all);
  if (!settings.enabled) return { enabled: false, settings };

  try {
    const options = await validatePanelSslConfig(settings);
    return { enabled: true, settings, options: options || undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PanelSSL] ${message}; falling back to HTTP`);
    return { enabled: false, settings, error: message };
  }
}

/** 证书文件多久检查一次变动（只 stat，不读内容）。 */
export const PANEL_SSL_RELOAD_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** 文件没变也至少多久重读一次。 */
export const PANEL_SSL_FORCE_RELOAD_INTERVAL_MS = 60 * 60 * 1000;
/** 证书剩这么多天就开始在日志里提醒。 */
export const PANEL_SSL_EXPIRY_WARNING_DAYS = 14;
const PANEL_SSL_EXPIRY_WARNING_REPEAT_MS = 24 * 60 * 60 * 1000;

type SecureContextTarget = { setSecureContext(options: tls.SecureContextOptions): void };

/** 证书链里第一张证书的到期时间（毫秒）；解析不出来返回 null。 */
export function panelSslCertificateExpiresAt(cert: unknown): number | null {
  if (typeof cert !== "string" && !Buffer.isBuffer(cert)) return null;
  try {
    const expiresAt = Date.parse(new crypto.X509Certificate(cert).validTo);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

/**
 * 面板 HTTPS 证书热更新。
 *
 * 原来证书文件只在启动时读一次：certbot / acme.sh 按时把新证书写到同一个路径，
 * 面板却一直拿着内存里那份旧的，直到某天旧证书过期、浏览器和 Agent 一起连不上，
 * 而重启一下又「好了」—— 典型的查不出原因。
 *
 * 做法：每 5 分钟 stat 一次证书和私钥，mtime/大小变了就重读；没变也每小时重读一次
 * （防某些部署方式改了内容却不改 mtime）。新文件读不出来、或证书和私钥对不上时
 * **继续用旧的**，只记警告 —— 续签写到一半（证书写了、私钥还没写）时正好撞上检查
 * 是常有的事，这时候换上去就是把面板自己弄挂。证书剩 14 天以内每天在日志里提醒一次。
 *
 * 只处理「文件路径」模式；「粘贴 PEM」模式的内容存在设置里，改它要走设置页，
 * 这里只做到期提醒。
 */
export function createPanelSslReloader(
  target: SecureContextTarget,
  settings: PanelSslSettings,
  initial: ServerOptions | undefined,
  options: { now?: () => number; logger?: Pick<typeof console, "info" | "warn"> } = {},
) {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const watchFiles = settings.mode === "path" && !!settings.certPath && !!settings.keyPath;
  let lastSignature = "";
  let lastLoadedAt = now();
  let lastExpiryWarningAt = Number.NEGATIVE_INFINITY;
  let certExpiresAt = panelSslCertificateExpiresAt(initial?.cert);

  const fileSignature = async () => {
    const [cert, key] = await Promise.all([
      fs.promises.stat(settings.certPath),
      fs.promises.stat(settings.keyPath),
    ]);
    return `${cert.mtimeMs}:${cert.size}:${key.mtimeMs}:${key.size}`;
  };

  const warnIfExpiringSoon = () => {
    if (certExpiresAt === null) return;
    const current = now();
    const daysLeft = (certExpiresAt - current) / (24 * 60 * 60 * 1000);
    if (daysLeft > PANEL_SSL_EXPIRY_WARNING_DAYS) return;
    if (current - lastExpiryWarningAt < PANEL_SSL_EXPIRY_WARNING_REPEAT_MS) return;
    lastExpiryWarningAt = current;
    const when = new Date(certExpiresAt).toISOString();
    logger.warn(daysLeft <= 0
      ? `[PanelSSL] 面板 HTTPS 证书已于 ${when} 过期，请尽快续签（续签后无需重启，面板会自动加载新证书）`
      : `[PanelSSL] 面板 HTTPS 证书将在 ${Math.ceil(daysLeft)} 天后（${when}）过期，请检查自动续签`);
  };

  /** 检查一次；返回这次做了什么，便于测试和排查。 */
  const check = async (): Promise<"reloaded" | "unchanged" | "failed"> => {
    if (!watchFiles) {
      warnIfExpiringSoon();
      return "unchanged";
    }
    let signature: string;
    try {
      signature = await fileSignature();
    } catch (error) {
      logger.warn(`[PanelSSL] 证书文件检查失败，继续使用当前证书：${error instanceof Error ? error.message : String(error)}`);
      warnIfExpiringSoon();
      return "failed";
    }
    if (!lastSignature) lastSignature = signature;
    const due = signature !== lastSignature || now() - lastLoadedAt >= PANEL_SSL_FORCE_RELOAD_INTERVAL_MS;
    if (!due) {
      warnIfExpiringSoon();
      return "unchanged";
    }
    try {
      const next = await validatePanelSslConfig(settings);
      if (!next) return "unchanged";
      target.setSecureContext({ cert: next.cert, key: next.key } as tls.SecureContextOptions);
      const changed = signature !== lastSignature;
      lastSignature = signature;
      lastLoadedAt = now();
      certExpiresAt = panelSslCertificateExpiresAt(next.cert);
      if (changed) logger.info("[PanelSSL] 证书文件已更新，已加载新证书");
      warnIfExpiringSoon();
      return "reloaded";
    } catch (error) {
      // 不更新 lastSignature：下一次检查还会再试，直到新文件完整可用。
      logger.warn(`[PanelSSL] 新证书加载失败，继续使用当前证书：${error instanceof Error ? error.message : String(error)}`);
      warnIfExpiringSoon();
      return "failed";
    }
  };

  return { check };
}

/** 启动证书热更新定时器（index.ts 在创建 HTTPS 服务后调用）。 */
export function startPanelSslAutoReload(target: SecureContextTarget, config: PanelSslRuntimeConfig) {
  if (!config.enabled || !config.options) return null;
  const reloader = createPanelSslReloader(target, config.settings, config.options);
  // 先查一次：启动时就快过期的证书，立刻在日志里说出来。
  void reloader.check();
  const timer = setInterval(() => { void reloader.check(); }, PANEL_SSL_RELOAD_CHECK_INTERVAL_MS);
  timer.unref?.();
  return { check: reloader.check, stop: () => clearInterval(timer) };
}
