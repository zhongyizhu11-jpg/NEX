/*
  浏览器这一侧的通行密钥（#12）：把服务端给的选项（字节都是 base64url 字符串）换成
  navigator.credentials 要的 ArrayBuffer，再把结果换回字符串交给服务端。

  能不能用通行密钥，三个条件缺一不可：
  · 浏览器支持 WebAuthn（window.PublicKeyCredential）；
  · 安全上下文 —— https，或者 localhost；用 http://IP 打开的面板浏览器直接不给用；
  · 不在 NEX App 里：App 是 WebView，系统通行密钥绑在面板域名上，App 的源不是那个域名。
*/
import { mobileAuth } from "@/lib/mobileAuth";

export function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PasskeyAvailability =
  | { usable: true }
  | { usable: false; reason: "native" | "insecure" | "unsupported" };

export function passkeyAvailability(): PasskeyAvailability {
  if (typeof window === "undefined") return { usable: false, reason: "unsupported" };
  if (mobileAuth.isNative) return { usable: false, reason: "native" };
  if (!window.isSecureContext) return { usable: false, reason: "insecure" };
  if (typeof window.PublicKeyCredential === "undefined" || !navigator.credentials) return { usable: false, reason: "unsupported" };
  return { usable: true };
}

export const PASSKEY_INSECURE_MESSAGE = "通行密钥需要 HTTPS 访问面板";

/** 浏览器抛的 DOMException → 一句人话。 */
export function passkeyErrorMessage(error: unknown, fallback: string) {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return "已取消，或者等太久超时了";
  if (name === "InvalidStateError") return "这台设备上已经有这个账号的通行密钥了";
  if (name === "SecurityError") return "当前地址不能使用通行密钥，请用面板的域名通过 HTTPS 打开";
  if (name === "NotSupportedError") return "这台设备不支持通行密钥";
  const message = (error as { message?: string } | null)?.message;
  return message || fallback;
}

type ServerCreationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout: number;
  attestation: "none";
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
};

type ServerRequestOptions = {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
  allowCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
};

export async function createPasskeyCredential(options: ServerCreationOptions) {
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: base64urlToBuffer(options.challenge),
      user: { ...options.user, id: base64urlToBuffer(options.user.id) },
      excludeCredentials: options.excludeCredentials.map((item) => ({
        type: "public-key" as const,
        id: base64urlToBuffer(item.id),
        transports: item.transports as AuthenticatorTransport[] | undefined,
      })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("没有拿到通行密钥");
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports,
    },
  };
}

export async function getPasskeyAssertion(options: ServerRequestOptions) {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: base64urlToBuffer(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: options.allowCredentials.map((item) => ({ type: "public-key" as const, id: base64urlToBuffer(item.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("没有拿到通行密钥");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
    },
  };
}
