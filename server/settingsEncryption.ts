/*
  系统设置里密钥类值的落库加密（批次 1 第 1 项）。

  ── 怎么加密 ──
  和云账号凭据（server/ipChange/secrets.ts）同一套：AES-256-GCM，密钥由面板的 Cookie 签名密钥
  （ENV.cookieSecret：JWT_SECRET 环境变量，没配就是数据目录下自动生成并持久化的 jwt.secret）经 HKDF
  派生，专用一个 info。选它是因为它**不在数据库里**：库被拖走、数据库文件被复制走时，拿到的只是密文。

  ── 对调用方透明 ──
  settingsRepository 的 getSetting / getAllSettings / getSettingsByPrefix 读出来就是明文，setSetting 写进去
  自动加密，别的代码一行不用改。哪些键加密见 server/settingsSecretKeys.ts。
  读的时候不看名单、只看前缀：名单以后删掉某个键，库里已经加密的值照样读得出来。
  没加密的老值（升级前存的）原样返回；启动时 encryptPlaintextSecretSettings 把它们一次性加密掉。

  ── 换机器 ──
  面板备份导出 / 异地备份 / 结构化迁移导出的是**解密后**的值（备份文件本身用备份密码加密），导入时
  setSetting 再用新面板的密钥加密，所以换服务器照常可用。SQLite 快速迁移搬的是整个数据库文件：
  导出时先把副本里的这些值解成明文、导入后再加密一遍（见 server/migration.ts）。
  解不开的情况只剩一种：数据库文件被直接拷到另一台机器、而两边的 JWT_SECRET（jwt.secret）不同。
  这时不报错，那一项当作空值，设置页提示「需要重新填写」—— 和云账号凭据同一个约定。
*/
import { ENV } from "./env";
import { createStringCipher, isSealedSecret, type StringCipher } from "./ipChange/secrets";
import { isSecretSettingKey, secretSettingLabel } from "./settingsSecretKeys";

const SETTINGS_CIPHER_INFO = "system-settings-secrets-v1";

/** 启动时把老明文加密一遍，做完记这个键（值是完成时间），之后不再整表扫。 */
export const SETTINGS_SECRETS_MIGRATION_KEY = "settingsSecretsEncryptedV1";

let cipherInstance: StringCipher | null = null;
let cipherSecretOverride: string | null = null;

function settingsCipher() {
  return (cipherInstance ||= createStringCipher(cipherSecretOverride ?? ENV.cookieSecret, SETTINGS_CIPHER_INFO));
}

/** 测试用：换一把密钥（模拟「迁到另一台面板」）。传 null 恢复用面板密钥。 */
export function setSettingsCipherSecretForTests(secret: string | null) {
  cipherSecretOverride = secret;
  cipherInstance = null;
  undecryptable.clear();
}

/** 解不开的键（只在内存里记，设置页拿去提示「需要重新填写」）。重新保存一次就从这里消失。 */
const undecryptable = new Set<string>();

export function isEncryptedSettingValue(value: unknown) {
  return isSealedSecret(value);
}

/** 写库前：密钥类键的非空值加密；已经是密文的不再套一层；其余原样。 */
export function encodeSettingValueForStorage(key: string, value: string | null): string | null {
  if (value === null || value === undefined) {
    undecryptable.delete(key);
    return value;
  }
  if (!isSecretSettingKey(key)) return value;
  undecryptable.delete(key);
  if (value === "" || isSealedSecret(value)) return value;
  return settingsCipher().encrypt(value);
}

/** 读库后：带前缀的解密；解不开返回空串并记下来（只打一次日志）；不带前缀的原样返回。 */
export function decodeStoredSettingValue(key: string, value: string | null): string | null {
  if (value === null || value === undefined || !isSealedSecret(value)) return value ?? null;
  try {
    const plain = settingsCipher().decrypt(value);
    undecryptable.delete(key);
    return plain;
  } catch {
    if (!undecryptable.has(key)) {
      undecryptable.add(key);
      console.warn(`[Settings] 设置 ${key} 无法解密（面板密钥 JWT_SECRET / jwt.secret 变过，例如数据库被拷到了新服务器），按空值处理，需要在设置页重新填写`);
    }
    return "";
  }
}

/** 解不开的那几项，给设置页看的中文名。 */
export function undecryptableSecretSettingLabels(): string[] {
  return Array.from(undecryptable).sort().map(secretSettingLabel);
}

/**
 * 一批原始行（导出、快速迁移副本用）：密钥类值换成明文。改的是传进来的行的副本，不动原对象。
 * 解不开的值导出成空串 —— 原样带走的话新面板也解不开，还会一直报。
 */
export function decryptSettingRowsForExport<T extends { key?: unknown; value?: unknown }>(rows: T[]): T[] {
  return rows.map((row) => {
    const value = row?.value;
    if (typeof value !== "string" || !isSealedSecret(value)) return row;
    return { ...row, value: decodeStoredSettingValue(String(row.key || ""), value) };
  });
}

/**
 * 把库里还是明文的密钥类值加密掉。读、写都走调用方给的函数（settingsRepository 传自己的原始读写进来，
 * 这个文件不碰数据库）。返回加密了几项。重复跑无害：已经是密文的跳过。
 */
export async function encryptPlaintextSecretSettings(io: {
  readRaw(keys: string[]): Promise<Array<{ key: string; value: string | null }>>;
  writeRaw(key: string, value: string): Promise<void>;
}, keys: Iterable<string>): Promise<number> {
  const rows = await io.readRaw(Array.from(keys));
  let count = 0;
  for (const row of rows) {
    const value = row.value;
    if (typeof value !== "string" || value === "" || isSealedSecret(value)) continue;
    await io.writeRaw(row.key, settingsCipher().encrypt(value));
    count += 1;
  }
  return count;
}
