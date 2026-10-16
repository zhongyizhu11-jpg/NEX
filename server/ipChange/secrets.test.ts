import assert from "node:assert/strict";
import test from "node:test";

import {
  IpChangeSecretError,
  createCredentialCipher,
  isSecretCredentialField,
  maskIpChangeCredentials,
  maskIpChangeSecret,
  mergeIpChangeCredentials,
} from "./secrets";
import type { IpChangeFieldDef } from "./providers";

const fields: IpChangeFieldDef[] = [
  { key: "accessKeyId", label: "Access Key ID", type: "text", required: true },
  { key: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
  { key: "privateKey", label: "私钥", type: "textarea" },
  { key: "region", label: "地域", type: "select", options: [{ value: "ap-east-1", label: "香港" }] },
];

test("凭据加密后落库的是密文，用同一把密钥解得回来", () => {
  const cipher = createCredentialCipher("panel-secret-a".repeat(4));
  const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const stored = cipher.encrypt(credentials);
  assert.match(stored, /^enc:v1:/);
  assert.doesNotMatch(stored, /wJalrXUtnFEMI|AKIAEXAMPLE/);
  assert.deepEqual(cipher.decrypt(stored), credentials);
  // 每次加密的 IV 不同，同样的内容密文不同
  assert.notEqual(cipher.encrypt(credentials), stored);
  assert.deepEqual(cipher.decrypt(""), {});
});

test("换了密钥（例如迁移到新服务器）解不开，报的是让人重新填写的错", () => {
  const stored = createCredentialCipher("panel-secret-a".repeat(4)).encrypt({ token: "abc" });
  const other = createCredentialCipher("panel-secret-b".repeat(4));
  assert.throws(() => other.decrypt(stored), (error: unknown) => error instanceof IpChangeSecretError && /重新填写/.test((error as Error).message));
  // 被篡改的密文也解不开（GCM 认证）
  const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => createCredentialCipher("panel-secret-a".repeat(4)).decrypt(tampered), IpChangeSecretError);
  assert.throws(() => other.decrypt("plain-json"), IpChangeSecretError);
});

test("密钥类字段只回打码后的样子，普通字段原样", () => {
  assert.equal(maskIpChangeSecret(""), "");
  assert.equal(maskIpChangeSecret("short"), "******");
  assert.equal(maskIpChangeSecret("wJalrXUtnFEMIKEY"), "wJa******KEY");
  assert.equal(isSecretCredentialField("secretAccessKey", fields), true);
  assert.equal(isSecretCredentialField("privateKey", fields), true);
  assert.equal(isSecretCredentialField("accessKeyId", fields), false);
  // 不认识的字段（云厂商下线了、字段改名了）一律打码
  assert.equal(isSecretCredentialField("unknown", fields), true);
  assert.equal(isSecretCredentialField("anything", null), true);
  const masked = maskIpChangeCredentials({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMIKEY",
    privateKey: "-----BEGIN KEY-----abc-----END KEY-----",
    region: "ap-east-1",
  }, fields);
  assert.deepEqual(masked, {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "wJa******KEY",
    privateKey: "---******---",
    region: "ap-east-1",
  });
});

test("保存时原样提交打码值 = 保留原值；改了就用新值；空串清掉；没提交的保留", () => {
  const existing = { accessKeyId: "AKIAOLD", secretAccessKey: "wJalrXUtnFEMIKEY", privateKey: "-----BEGIN KEY-----abc-----END KEY-----" };
  const masked = maskIpChangeCredentials(existing, fields);
  assert.deepEqual(mergeIpChangeCredentials(existing, masked, fields), existing);
  assert.deepEqual(
    mergeIpChangeCredentials(existing, { ...masked, accessKeyId: "AKIANEW", secretAccessKey: "brand-new-secret-value" }, fields),
    { ...existing, accessKeyId: "AKIANEW", secretAccessKey: "brand-new-secret-value" },
  );
  assert.deepEqual(mergeIpChangeCredentials(existing, { privateKey: "" }, fields), { accessKeyId: "AKIAOLD", secretAccessKey: "wJalrXUtnFEMIKEY" });
  assert.deepEqual(mergeIpChangeCredentials(existing, {}, fields), existing);
  // 普通字段刚好等于「打码样式」的字符串也照常写入（普通字段本来就不打码）
  assert.equal(mergeIpChangeCredentials({ accessKeyId: "AKIAOLD-LONGER" }, { accessKeyId: "AKI******GER" }, fields).accessKeyId, "AKI******GER");
});
