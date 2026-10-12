import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import * as db from "../../db";
import { maskIdentifier } from "../helpers";
import { createLoginSession } from "../auth";
import { getSetting } from "../../repositories/settingsRepository";
import {
  consumePasskeyChallenge,
  defaultPasskeyName,
  deletePasskey,
  findPasskeyByCredentialId,
  insertPasskey,
  issuePasskeyChallenge,
  listUserPasskeys,
  MAX_CREDENTIAL_ID_LENGTH,
  MAX_PASSKEYS_PER_USER,
  passkeyUserHandle,
  PASSKEY_CHALLENGE_TTL_MS,
  recordPasskeyUse,
  renamePasskey,
  resolveRelyingParty,
} from "../../ops/passkeys";
import { SUPPORTED_COSE_ALGS, verifyAuthenticationResponse, verifyRegistrationResponse, WebAuthnError } from "../../ops/webauthn";
import { recordPanelEvent } from "../../ops/panelEvents";

/*
  trpc.ops.passkeys.* —— 个人资料 › 通行密钥 和 登录页「用通行密钥登录」（#12）。

  登录用的是「可发现凭据」：用户不用填用户名，浏览器列出这个域名下的通行密钥，
  选一个、按指纹 / 面容，交回凭据 ID 和签名，我们按凭据 ID 找到人。
  登录成功走和密码登录同一个 createLoginSession：cookie、单设备策略、维护模式、
  停用账户的检查完全一样。通行密钥本身就是「持有设备 + 生物识别」两个因素，所以不再要 2FA。
*/

const base64url = z.string().max(64 * 1024).regex(/^[A-Za-z0-9_-]*={0,2}$/, "数据格式不对");

const registrationCredential = z.object({
  id: z.string().min(1).max(2048),
  rawId: z.string().max(2048).optional(),
  type: z.string().max(32).optional(),
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
});

const authenticationCredential = z.object({
  id: z.string().min(1).max(2048),
  rawId: z.string().max(2048).optional(),
  type: z.string().max(32).optional(),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: z.string().max(1024).nullable().optional(),
  }),
});

const nameSchema = z.string().trim().min(1, "请填写名字").max(64, "名字最多 64 个字");

async function relyingPartyFor(ctx: any, fallbackOrigin?: string) {
  const req = ctx.req;
  const origin = String(req.headers?.origin || fallbackOrigin || "");
  const panelPublicUrl = await getSetting("panelPublicUrl").catch(() => null);
  return resolveRelyingParty(origin, [req.headers?.host, req.headers?.["x-forwarded-host"]], panelPublicUrl);
}

/** WebAuthn 的错误是给人看的话；其余的原样抛（数据库错误等）。 */
async function asUserError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WebAuthnError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    throw error;
  }
}

function requestIp(ctx: any) {
  return String(ctx.req?.ip || ctx.req?.socket?.remoteAddress || "unknown");
}

export const passkeysRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const items = await listUserPasskeys(ctx.user.id);
    return items.map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt, transports: item.transports }));
  }),

  rename: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), name: nameSchema }))
    .mutation(async ({ input, ctx }) => {
      if (!(await renamePasskey(ctx.user.id, input.id, input.name))) throw new TRPCError({ code: "NOT_FOUND", message: "通行密钥不存在" });
      return { success: true as const };
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const existing = (await listUserPasskeys(ctx.user.id)).find((item) => item.id === input.id);
      if (!existing || !(await deletePasskey(ctx.user.id, input.id))) throw new TRPCError({ code: "NOT_FOUND", message: "通行密钥不存在" });
      void recordPanelEvent({
        kind: "account.passkey_removed",
        level: "info",
        userId: ctx.user.id,
        message: `${ctx.user.name || ctx.user.username} 删除了通行密钥「${existing.name}」`,
      });
      return { success: true as const };
    }),

  registrationOptions: protectedProcedure
    .input(z.object({ origin: z.string().max(512).optional() }).optional())
    .mutation(async ({ input, ctx }) => asUserError(async () => {
      const existing = await listUserPasskeys(ctx.user.id);
      if (existing.length >= MAX_PASSKEYS_PER_USER) throw new WebAuthnError(`通行密钥最多 ${MAX_PASSKEYS_PER_USER} 个，请先删除不用的`);
      const rp = await relyingPartyFor(ctx, input?.origin);
      const { challengeId, challenge } = issuePasskeyChallenge({ purpose: "register", userId: ctx.user.id, origin: rp.origin, rpId: rp.rpId });
      return {
        challengeId,
        publicKey: {
          rp: { id: rp.rpId, name: "NEX" },
          user: { id: passkeyUserHandle(ctx.user.id), name: ctx.user.username, displayName: ctx.user.name || ctx.user.username },
          challenge,
          pubKeyCredParams: SUPPORTED_COSE_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
          timeout: PASSKEY_CHALLENGE_TTL_MS,
          attestation: "none" as const,
          authenticatorSelection: { residentKey: "required" as const, requireResidentKey: true, userVerification: "preferred" as const },
          excludeCredentials: existing.map((item) => ({ type: "public-key" as const, id: item.credentialId, transports: item.transports })),
        },
      };
    })),

  finishRegistration: protectedProcedure
    .input(z.object({ challengeId: z.string().min(8).max(64), name: z.string().trim().max(64).optional(), credential: registrationCredential }))
    .mutation(async ({ input, ctx }) => asUserError(async () => {
      const pending = consumePasskeyChallenge(input.challengeId, "register");
      if (pending.userId !== ctx.user.id) throw new WebAuthnError("通行密钥请求已过期，请重试");
      const verified = verifyRegistrationResponse(input.credential, { challenge: pending.challenge, origin: pending.origin, rpId: pending.rpId });
      if (verified.credentialId.length > MAX_CREDENTIAL_ID_LENGTH) throw new WebAuthnError("这个认证器的凭据太长，暂不支持");
      if (await findPasskeyByCredentialId(verified.credentialId)) throw new WebAuthnError("这个通行密钥已经添加过了");
      const name = (input.name || "").trim() || defaultPasskeyName(ctx.req.headers?.["user-agent"]);
      const id = await insertPasskey({
        userId: ctx.user.id,
        name: name.slice(0, 64),
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        alg: verified.alg,
        signCount: verified.signCount,
        transports: (input.credential.response.transports || []).filter((item) => /^[a-z-]{1,32}$/.test(item)),
      });
      void recordPanelEvent({
        kind: "account.passkey_added",
        level: "info",
        userId: ctx.user.id,
        message: `${ctx.user.name || ctx.user.username} 添加了通行密钥「${name}」`,
      });
      console.info(`[Passkeys] added id=${id} userId=${ctx.user.id} alg=${verified.alg}`);
      return { id, name };
    })),

  loginOptions: publicProcedure
    .input(z.object({ origin: z.string().max(512).optional() }).optional())
    .mutation(async ({ input, ctx }) => asUserError(async () => {
      const rp = await relyingPartyFor(ctx, input?.origin);
      const { challengeId, challenge } = issuePasskeyChallenge({ purpose: "login", userId: null, origin: rp.origin, rpId: rp.rpId });
      return {
        challengeId,
        publicKey: { challenge, rpId: rp.rpId, timeout: PASSKEY_CHALLENGE_TTL_MS, userVerification: "preferred" as const, allowCredentials: [] as never[] },
      };
    })),

  finishLogin: publicProcedure
    .input(z.object({ challengeId: z.string().min(8).max(64), credential: authenticationCredential }))
    .mutation(async ({ input, ctx }) => {
      const ip = requestIp(ctx);
      const { user, passkey } = await asUserError(async () => {
        const pending = consumePasskeyChallenge(input.challengeId, "login");
        const passkey = await findPasskeyByCredentialId(input.credential.id);
        if (!passkey) throw new WebAuthnError("这个通行密钥没有绑定任何账号，可能已被删除");
        const result = verifyAuthenticationResponse(input.credential, { challenge: pending.challenge, origin: pending.origin, rpId: pending.rpId }, passkey);
        const user = await db.getUserById(passkey.userId);
        if (!user) throw new WebAuthnError("这个通行密钥对应的账号已不存在");
        await recordPasskeyUse(passkey.id, result.signCount);
        return { user, passkey };
      }).catch((error) => {
        console.warn(`[Auth] Passkey login failed ip=${ip}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
      const session = await createLoginSession(ctx, user, false);
      console.info(`[Auth] Passkey login success userId=${user.id} username=${maskIdentifier(user.username)} ip=${ip}`);
      void recordPanelEvent({
        kind: "account.login",
        level: "info",
        userId: user.id,
        message: `${user.name || user.username} 用通行密钥「${passkey.name}」登录`,
        data: { method: "passkey", ip },
      });
      return session;
    }),
});
