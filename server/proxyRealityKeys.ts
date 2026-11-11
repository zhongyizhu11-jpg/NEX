/**
 * 落地入站要用到的随机凭据。
 *
 * 单独放在服务端：REALITY 的私钥绝不能经过浏览器，所以生成只发生在这一侧，
 * shared/proxyInbound.ts 只接收结果。也正因为如此，这里不能挪进 shared —— 那边
 * 客户端也会 import，碰不得 node:crypto。
 */

import crypto from "node:crypto";

export type RealityKeyPair = {
  /** 只写进落地机的入站配置 */
  privateKey: string;
  /** 发给客户端 */
  publicKey: string;
};

/** X25519 的裸密钥是 32 字节。DER 里它固定在末尾，其余是算法标识的前缀。 */
const X25519_KEY_BYTES = 32;

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 生成一对 REALITY 密钥。
 *
 * 格式与 `sing-box generate reality-keypair` 一致：X25519 的 32 字节裸密钥，
 * base64url 且不带补位。Node 原生就能算，不必为了一对密钥往落地机跑一趟 ——
 * 那样既慢，又意味着私钥要在网络上走一遍。
 */
export function generateRealityKeyPair(): RealityKeyPair {
  const pair = crypto.generateKeyPairSync("x25519");
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const publicRaw = publicDer.subarray(-X25519_KEY_BYTES);
  const privateRaw = privateDer.subarray(-X25519_KEY_BYTES);
  // DER 的长度是固定的，取不到 32 字节说明 Node 换了编码，宁可当场炸也不要
  // 悄悄发一对截断的密钥出去 —— 那会变成一个握不上手却查不出原因的节点。
  if (publicRaw.length !== X25519_KEY_BYTES || privateRaw.length !== X25519_KEY_BYTES) {
    throw new Error("生成 REALITY 密钥失败：X25519 密钥长度异常");
  }
  return { privateKey: base64url(privateRaw), publicKey: base64url(publicRaw) };
}

/** REALITY 的 short-id：4 字节十六进制，落在协议允许的 0 到 8 字节区间内。 */
export function generateRealityShortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** 入站用的随机密码。22 个 base64url 字符，约 128 位熵。 */
export function generateProxyInboundPassword(): string {
  return base64url(crypto.randomBytes(16));
}

/** Shadowsocks 2022 与 AnyTLS 的密码要求是定长的 base64，跟随加密方式的密钥长度。 */
export function generateProxyInboundPsk(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64");
}

export function generateProxyInboundUuid(): string {
  return crypto.randomUUID();
}

/**
 * Mieru 的用户名。mita 的用户表整台机器共用、不分端口，用户名必须在整台机器上唯一，
 * 所以用随机串而不是人名；「nex」开头方便在 mita 的日志里认出是面板发的。
 * 64 位随机，同一台机器上撞车的概率可以忽略（buildMitaHostPlan 撞了也只跳过那一个）。
 */
export function generateMieruUsername(): string {
  return `nex${crypto.randomBytes(8).toString("hex")}`;
}
