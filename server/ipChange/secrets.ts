/*
  云账号凭据的落库加密和回显打码。

  ── 加密 ──
  AES-256-GCM，密钥由面板的 Cookie 签名密钥（ENV.cookieSecret：JWT_SECRET 环境变量，没配就是
  数据目录下自动生成并持久化的 jwt.secret）经 HKDF 派生，专用一个 info，和签 Cookie 的用途隔开。
  选它是因为它**不在数据库里**：库被拖走、异地备份文件泄露时，拿到的只是密文。
  它跨重启不变，切换数据库类型（SQLite → MySQL 等）时数据目录不变，也不受影响。

  代价：把面板迁到另一台机器（新机器上的 jwt.secret 不同）后旧密文解不开，需要重新填一次凭据；
  两边配置了同一个 JWT_SECRET 时不受影响。解不开时接口不报错，只标记「需要重新填写」。

  ── 打码 ──
  密钥类字段（password / textarea，以及不认识的字段）永远不回给浏览器，只回打码后的样子。
  保存时如果提交上来的值和打码后的样子一模一样，就当作「没改」，保留原值。
*/
import crypto from "node:crypto";
import type { IpChangeCredentials, IpChangeFieldDef } from "./providers";

const CIPHER = "aes-256-gcm";
const PREFIX = "enc:v1:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class IpChangeSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpChangeSecretError";
  }
}

/**
 * info 区分用途：默认是云账号凭据；别的模块复用这套加密时（例如转发规则的 Shadowsocks 出口链接，
 * server/ssEgress.ts）传自己的 info，派生出另一把密钥，两边的密文互相解不开。
 */
export function deriveIpChangeKey(secret: string, info = "cloud-credentials-v1") {
  if (!secret) throw new IpChangeSecretError("缺少加密密钥");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("nex-ip-change", "utf8"), Buffer.from(info, "utf8"), 32));
}

export type CredentialCipher = {
  encrypt(credentials: IpChangeCredentials): string;
  decrypt(stored: string | null | undefined): IpChangeCredentials;
};

/** AES-256-GCM 封一段字符串：PREFIX + base64(iv | tag | 密文)。 */
function sealString(key: Buffer, plaintext: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** sealString 的反操作；格式不对或密钥不对都抛错（调用方决定给人看哪句话）。 */
function openString(key: Buffer, stored: string) {
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** 这段文字是不是 sealString 封出来的（看前缀，不验证能不能解开）。 */
export function isSealedSecret(value: unknown) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function createCredentialCipher(secret: string, info?: string): CredentialCipher {
  const key = deriveIpChangeKey(secret, info);
  return {
    encrypt(credentials) {
      return sealString(key, JSON.stringify(credentials || {}));
    },
    decrypt(stored) {
      const text = String(stored || "");
      if (!text) return {};
      if (!isSealedSecret(text)) throw new IpChangeSecretError("凭据格式无法识别，请重新填写");
      try {
        return sanitizeCredentials(JSON.parse(openString(key, text)));
      } catch {
        throw new IpChangeSecretError("凭据无法解密（面板密钥变过，例如迁移到了新服务器），请重新填写");
      }
    },
  };
}

export type StringCipher = {
  encrypt(plaintext: string): string;
  /** 解不开抛 IpChangeSecretError；不带前缀的当明文原样返回（升级前存的老值）。 */
  decrypt(stored: string): string;
};

/**
 * 加密一段任意字符串（系统设置里的密钥类值，见 server/settingsEncryption.ts）。
 * 和凭据用同一套算法、同一个前缀，info 不同派生出另一把密钥。
 */
export function createStringCipher(secret: string, info: string): StringCipher {
  const key = deriveIpChangeKey(secret, info);
  return {
    encrypt(plaintext) {
      return sealString(key, String(plaintext ?? ""));
    },
    decrypt(stored) {
      const text = String(stored ?? "");
      if (!isSealedSecret(text)) return text;
      try {
        return openString(key, text);
      } catch {
        throw new IpChangeSecretError("无法解密（面板密钥变过，例如迁移到了新服务器），请重新填写");
      }
    },
  };
}

export function sanitizeCredentials(value: unknown): IpChangeCredentials {
  const out: IpChangeCredentials = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    if (raw === undefined || raw === null) continue;
    out[key] = String(raw).slice(0, 16_384);
  }
  return out;
}

const MASK = "******";

export function maskIpChangeSecret(value: string) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length < 12) return MASK;
  return `${text.slice(0, 3)}${MASK}${text.slice(-3)}`;
}

/** 这个字段要不要打码：password / textarea（私钥、服务账号 JSON 常放这里）和不认识的字段都打码。 */
export function isSecretCredentialField(key: string, fields: IpChangeFieldDef[] | null | undefined) {
  const field = fields?.find((item) => item.key === key);
  if (!field) return true;
  return field.type === "password" || field.type === "textarea";
}

export function maskIpChangeCredentials(credentials: IpChangeCredentials, fields: IpChangeFieldDef[] | null | undefined) {
  const out: IpChangeCredentials = {};
  for (const [key, value] of Object.entries(credentials || {})) {
    out[key] = isSecretCredentialField(key, fields) ? maskIpChangeSecret(value) : value;
  }
  return out;
}

/**
 * 编辑保存时合并：没提交的字段保留原值；提交上来的值等于原值打码后的样子，也保留原值（用户没动它）；
 * 其余照提交的值（空串 = 清掉）。
 */
export function mergeIpChangeCredentials(
  existing: IpChangeCredentials,
  incoming: Record<string, unknown> | null | undefined,
  fields: IpChangeFieldDef[] | null | undefined,
) {
  const merged: IpChangeCredentials = { ...existing };
  for (const [key, raw] of Object.entries(sanitizeCredentials(incoming))) {
    const current = existing[key];
    if (current !== undefined && isSecretCredentialField(key, fields) && raw === maskIpChangeSecret(current)) continue;
    if (raw === "") delete merged[key];
    else merged[key] = raw;
  }
  return merged;
}
