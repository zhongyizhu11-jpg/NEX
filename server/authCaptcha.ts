import { createHash, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import * as svgCaptcha from "svg-captcha";
import Cap from "@cap.js/server";
import { Router, type Request, type Response } from "express";
import { setBoundedMapValue } from "./boundedCache";
import { ipRateLimitScope } from "./ipRateLimitScope";
import { clientIp } from "./clientIp";
import { captchaChallengeAllowed, readAuthCaptchaMode } from "./authCaptchaMode";
import { noteSharedStateError, registerSharedStateCleanup, sharedStateMode } from "./sharedState";
import { SharedCounter } from "./sharedStateCounter";
import { SqlCaptchaChallengeStore } from "./sharedStateStore";

/*
  多实例（server/sharedState.ts 判断为 db 模式）时验证码的状态放库里（auth_captcha_challenges 和
  auth_attempt_counters），各实例共享：

    · 点击验证（Cap.js）：挑战、兑换出的令牌、以及本层「这枚挑战 / 令牌是发给哪个 IP、什么用途」的绑定
      都是库里的行。Cap.js 4 支持自定义 storage 钩子，钩子按当前模式写内存或写库。挑战在 A 实例签发、
      在 B 实例兑换、在 C 实例登录都行；用一次就删（DELETE 看影响行数），两个实例同时用同一枚只有一个成功。
    · 「失败几次后要验证码」的计数经 SharedCounter 共享（和登录锁定一样：同步判断、异步写库）。
    · 图片验证码：签发时也写一行进库（答案存摘要），但 verifyChallenge 是同步接口（authCaptchaMode.ts 的
      verifyAuthCaptcha 不 await 它），同步只能看本进程内存 —— 在别的实例签发的图片挑战本实例认不出来。
      异步版 verifyChallengeShared 查库，调用方改成 await 它之后图片模式也能跨实例；在那之前图片模式
      多实例部署要给登录接口配粘性路由，或者用点击验证。
  SQLite 部署永远是内存模式，和以前一样。
*/

export const LOGIN_CAPTCHA_FAILURE_THRESHOLD = 3;
/**
 * 同一个账户不管从哪来，累计失败到这个数就要验证码。
 *
 * 按「IP + 账户」计数时，换一个来源地址就是新的额度：有一段 /64 或者一堆肉鸡的人可以
 * 对管理员账户无限次免验证码地猜密码。这里只强制验证码、不锁账户 —— 锁账户会被别人
 * 拿来把真正的主人锁在门外。
 */
export const LOGIN_CAPTCHA_ACCOUNT_FAILURE_THRESHOLD = 10;
export const LOGIN_CAPTCHA_REQUIREMENT_TTL_MS = 15 * 60 * 1000;
export const CAPTCHA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CAPTCHA_REFRESH_WINDOW_MS = 60 * 1000;
export const CAPTCHA_REFRESH_MAX_PER_WINDOW = 6;

const CAPTCHA_MAX_CHALLENGES = 5_000;
const CAP_MAX_CHALLENGES = 5_000;
const CAP_MAX_TOKENS = 5_000;
const CAPTCHA_MAX_RATE_LIMIT_KEYS = 50_000;
const CAPTCHA_CHARACTERS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type CaptchaPurpose = "login" | "register";

type SvgCaptchaGenerator = (options?: svgCaptcha.ConfigObject) => svgCaptcha.CaptchaObj;

interface CaptchaChallengeEntry {
  answer: string;
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

interface CapChallengeEntry {
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

interface CapTokenEntry {
  expiresAt: number;
  ip: string;
  purpose: CaptchaPurpose;
}

/*
  Cap.js 的存储钩子：内存模式写本进程的两个 Map（以前是 Cap 自带的 config.state），db 模式写库。
  每次调用看当前模式 —— 别的实例起来 / 停掉时模式会变。给了钩子之后 Cap 不再碰 config.state。
  deleteExpired 在 db 模式是空操作：库里的行由持有租约的实例统一清（registerSharedStateCleanup）。
*/
type CapChallengeData = { challenge: { c: number; s: number; d: number }; expires: number };
const capMemoryChallenges = new Map<string, CapChallengeData>();
const capMemoryTokens = new Map<string, number>();
const CAP_ROW_CHALLENGE = "cap";
const CAP_ROW_TOKEN = "cap-token";
/** 本层的绑定行（哪个 IP、什么用途）：挑战和兑换出的令牌各一种。 */
const CAP_ROW_CHALLENGE_BINDING = "cap-bind";
const CAP_ROW_TOKEN_BINDING = "cap-token-bind";
const IMAGE_ROW = "image";
/** 过期多久之后才删库里的行：签发实例和清理实例的时钟差留点余量。 */
const CHALLENGE_ROW_PRUNE_GRACE_MS = 60_000;

let challengeStore: SqlCaptchaChallengeStore | null = null;

function sharedChallengeStore() {
  if (!challengeStore) challengeStore = new SqlCaptchaChallengeStore();
  return challengeStore;
}

/** 测试用：换掉写库的那一层（传 null 恢复）。 */
export function setAuthCaptchaSharedStoreForTests(store: SqlCaptchaChallengeStore | null) {
  challengeStore = store;
}

/** 库里存令牌 / 挑战 id 的摘要：谁能读库都不该直接拿到能用的令牌。 */
function rowId(token: string) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function pruneCapMemory(now: number) {
  for (const [token, entry] of capMemoryChallenges) {
    if (entry.expires <= now) capMemoryChallenges.delete(token);
  }
  for (const [token, expires] of capMemoryTokens) {
    if (expires <= now) capMemoryTokens.delete(token);
  }
  while (capMemoryChallenges.size > CAP_MAX_CHALLENGES) {
    const oldest = capMemoryChallenges.keys().next().value;
    if (!oldest) break;
    capMemoryChallenges.delete(oldest);
  }
  while (capMemoryTokens.size > CAP_MAX_TOKENS) {
    const oldest = capMemoryTokens.keys().next().value;
    if (!oldest) break;
    capMemoryTokens.delete(oldest);
  }
}

function createCapServer() {
  return new Cap({
    noFSState: true,
    storage: {
      challenges: {
        store: async (token, data) => {
          if (sharedStateMode() === "db") {
            await sharedChallengeStore().put({ kind: CAP_ROW_CHALLENGE, id: token, ip: null, purpose: null, data: JSON.stringify(data), expiresAt: data.expires });
            return;
          }
          pruneCapMemory(Date.now());
          capMemoryChallenges.set(token, data);
        },
        read: async (token) => {
          if (sharedStateMode() === "db") {
            const row = await sharedChallengeStore().get(CAP_ROW_CHALLENGE, token);
            if (!row?.data) return null;
            try {
              return JSON.parse(row.data) as CapChallengeData;
            } catch {
              return null;
            }
          }
          return capMemoryChallenges.get(token) ?? null;
        },
        delete: async (token) => {
          if (sharedStateMode() === "db") await sharedChallengeStore().remove(CAP_ROW_CHALLENGE, token);
          capMemoryChallenges.delete(token);
        },
        deleteExpired: async () => { pruneCapMemory(Date.now()); },
      },
      tokens: {
        store: async (key, expires) => {
          if (sharedStateMode() === "db") {
            await sharedChallengeStore().put({ kind: CAP_ROW_TOKEN, id: key, ip: null, purpose: null, data: null, expiresAt: expires });
            return;
          }
          pruneCapMemory(Date.now());
          capMemoryTokens.set(key, expires);
        },
        get: async (key) => {
          if (sharedStateMode() === "db") return (await sharedChallengeStore().get(CAP_ROW_TOKEN, key))?.expiresAt ?? null;
          return capMemoryTokens.get(key) ?? null;
        },
        delete: async (key) => {
          if (sharedStateMode() === "db") await sharedChallengeStore().remove(CAP_ROW_TOKEN, key);
          capMemoryTokens.delete(key);
        },
        deleteExpired: async () => { pruneCapMemory(Date.now()); },
      },
    },
  });
}

const capServer = createCapServer();

registerSharedStateCleanup("auth_captcha_challenges", () => sharedChallengeStore().prune(CHALLENGE_ROW_PRUNE_GRACE_MS));

interface CaptchaServiceOptions {
  challengeTtlMs?: number;
  requirementTtlMs?: number;
  failureThreshold?: number;
  refreshWindowMs?: number;
  refreshMaxPerWindow?: number;
  maxChallenges?: number;
  maxRateLimitKeys?: number;
  svgGenerator?: SvgCaptchaGenerator;
}

export class CaptchaRefreshRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("CAPTCHA_REFRESH_RATE_LIMITED");
    this.name = "CaptchaRefreshRateLimitError";
  }
}

function normalizeIp(ip: string) {
  // IPv6 按 /64 归并，见 ipRateLimitScope。
  return ipRateLimitScope(ip);
}

function normalizeUsername(username: string) {
  return String(username || "").trim().toLowerCase();
}

function normalizeAnswer(answer: string | number) {
  return String(answer).replace(/\s+/g, "").toUpperCase();
}

function answersEqual(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export class AuthCaptchaService {
  private readonly challenges = new Map<string, CaptchaChallengeEntry>();
  private readonly capChallenges = new Map<string, CapChallengeEntry>();
  private readonly capTokens = new Map<string, CapTokenEntry>();
  private readonly loginFailures: SharedCounter;
  private readonly accountLoginFailures: SharedCounter;
  private readonly refreshTimestamps = new Map<string, number[]>();
  /** db 模式下的刷新额度（内存模式还是上面的时间戳列表，见 sharedStateCounter.ts）。 */
  private readonly sharedRefreshBudget: SharedCounter;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly challengeTtlMs: number;
  private readonly requirementTtlMs: number;
  private readonly failureThreshold: number;
  private readonly refreshWindowMs: number;
  private readonly refreshMaxPerWindow: number;
  private readonly maxChallenges: number;
  private readonly maxRateLimitKeys: number;
  private readonly svgGenerator: SvgCaptchaGenerator;
  private readonly cap: Cap = capServer;

  constructor(options: CaptchaServiceOptions = {}) {
    this.challengeTtlMs = options.challengeTtlMs ?? CAPTCHA_CHALLENGE_TTL_MS;
    this.requirementTtlMs = options.requirementTtlMs ?? LOGIN_CAPTCHA_REQUIREMENT_TTL_MS;
    this.failureThreshold = options.failureThreshold ?? LOGIN_CAPTCHA_FAILURE_THRESHOLD;
    this.refreshWindowMs = options.refreshWindowMs ?? CAPTCHA_REFRESH_WINDOW_MS;
    this.refreshMaxPerWindow = options.refreshMaxPerWindow ?? CAPTCHA_REFRESH_MAX_PER_WINDOW;
    this.maxChallenges = options.maxChallenges ?? CAPTCHA_MAX_CHALLENGES;
    this.maxRateLimitKeys = options.maxRateLimitKeys ?? CAPTCHA_MAX_RATE_LIMIT_KEYS;
    this.svgGenerator = options.svgGenerator ?? svgCaptcha.create;
    // Cap's default file-backed token store is not appropriate for a panel
    // process and can leave state in the working directory. The business
    // layer below binds all tokens to IP and purpose and bounds that state.
    // 失败计数「最近一次失败后 requirementTtlMs 内再失败就累加」：anchor = last。
    this.loginFailures = new SharedCounter({ scope: "captcha-pair", windowMs: this.requirementTtlMs, anchor: "last", maxKeys: this.maxRateLimitKeys });
    this.accountLoginFailures = new SharedCounter({ scope: "captcha-account", windowMs: this.requirementTtlMs, anchor: "last", maxKeys: this.maxRateLimitKeys });
    this.sharedRefreshBudget = new SharedCounter({ scope: "captcha-refresh", windowMs: this.refreshWindowMs, anchor: "first", maxKeys: this.maxRateLimitKeys });
  }

  private shared() {
    return sharedStateMode() === "db";
  }

  /** 异步写库的任务记一下，测试里好等它们回来；失败只记日志（验证码不能因为库抖一下就发不出）。 */
  private track(promise: Promise<unknown>, where: string) {
    const task = promise.catch((error) => noteSharedStateError(where, error));
    this.pending.add(task);
    void task.finally(() => { this.pending.delete(task); });
  }

  /** 测试用：等在途的写库都回来。 */
  async flushSharedWrites() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    await Promise.all([this.loginFailures.flush(), this.accountLoginFailures.flush(), this.sharedRefreshBudget.flush()]);
  }

  private loginKey(ip: string, username: string) {
    return `${normalizeIp(ip)}:${normalizeUsername(username)}`;
  }

  private consumeRefreshSlot(ip: string, now: number) {
    const key = normalizeIp(ip);
    if (this.shared()) {
      const entry = this.sharedRefreshBudget.state(key, now);
      if (entry && entry.count >= this.refreshMaxPerWindow) {
        throw new CaptchaRefreshRateLimitError(Math.max(1, Math.ceil((entry.firstAt + this.refreshWindowMs - now) / 1000)));
      }
      this.sharedRefreshBudget.bump(key, now);
      return;
    }
    const cutoff = now - this.refreshWindowMs;
    const active = (this.refreshTimestamps.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (active.length >= this.refreshMaxPerWindow) {
      const retryAfterMs = active[0] + this.refreshWindowMs - now;
      setBoundedMapValue(this.refreshTimestamps, key, active, this.maxRateLimitKeys);
      throw new CaptchaRefreshRateLimitError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
    }
    active.push(now);
    setBoundedMapValue(this.refreshTimestamps, key, active, this.maxRateLimitKeys);
  }

  private pruneChallenges(now: number) {
    if (this.challenges.size < this.maxChallenges) return;
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    while (this.challenges.size >= this.maxChallenges) {
      const oldestId = this.challenges.keys().next().value;
      if (!oldestId) break;
      this.challenges.delete(oldestId);
    }
  }

  private storeChallenge(input: {
    answer: string | number;
    ip: string;
    purpose: CaptchaPurpose;
    now: number;
  }) {
    this.pruneChallenges(input.now);
    const captchaId = nanoid(20);
    const entry: CaptchaChallengeEntry = {
      answer: normalizeAnswer(input.answer),
      expiresAt: input.now + this.challengeTtlMs,
      ip: normalizeIp(input.ip),
      purpose: input.purpose,
    };
    this.challenges.set(captchaId, entry);
    if (this.shared()) {
      // 也写一行进库（答案存摘要），verifyChallengeShared 在别的实例上能认出来。
      this.track(sharedChallengeStore().put({
        kind: IMAGE_ROW, id: rowId(captchaId), ip: entry.ip, purpose: entry.purpose, data: rowId(entry.answer), expiresAt: entry.expiresAt,
      }), "captcha image put");
    }
    return captchaId;
  }

  createImageChallenge(ip: string, purpose: CaptchaPurpose, now = Date.now()) {
    this.consumeRefreshSlot(ip, now);
    const generated = this.svgGenerator({
      size: 5,
      width: 190,
      height: 56,
      fontSize: 44,
      charPreset: CAPTCHA_CHARACTERS,
      noise: 3,
      color: true,
      background: "#f8fafc",
    });
    const captchaId = this.storeChallenge({ answer: generated.text, ip, purpose, now });
    return {
      captchaId,
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(generated.data, "utf8").toString("base64")}`,
      expiresInSeconds: Math.floor(this.challengeTtlMs / 1000),
    };
  }

  async createCapChallenge(ip: string, purpose: CaptchaPurpose, now = Date.now()) {
    this.consumeRefreshSlot(ip, now);
    this.pruneCapState(now);
    const result = await this.cap.createChallenge({
      // A short PoW keeps the interaction to one click while still making
      // high-volume automated requests expensive.
      challengeCount: 5,
      challengeSize: 32,
      challengeDifficulty: 3,
      expiresMs: this.challengeTtlMs,
    });
    if (!result.token) throw new Error("CAPTCHA_CHALLENGE_UNAVAILABLE");
    if (this.shared()) {
      await sharedChallengeStore().put({ kind: CAP_ROW_CHALLENGE_BINDING, id: rowId(result.token), ip: normalizeIp(ip), purpose, data: null, expiresAt: result.expires });
      return result;
    }
    setBoundedMapValue(this.capChallenges, result.token, {
      expiresAt: result.expires,
      ip: normalizeIp(ip),
      purpose,
    }, CAP_MAX_CHALLENGES);
    return result;
  }

  async redeemCapChallenge(
    ip: string,
    purpose: CaptchaPurpose,
    token: string,
    solutions: number[],
    now = Date.now(),
  ) {
    this.pruneCapState(now);
    const shared = this.shared();
    // db 模式：绑定行读出来就删（删到了才算拿到），别的实例同时兑换同一枚拿不到。
    const challenge = shared ? await sharedChallengeStore().consume(CAP_ROW_CHALLENGE_BINDING, rowId(token)) : this.capChallenges.get(token);
    if (!challenge || challenge.expiresAt <= now || challenge.ip !== normalizeIp(ip) || challenge.purpose !== purpose) {
      return { success: false as const, message: "CAPTCHA_INVALID" };
    }
    // Cap consumes challenges on redemption, including invalid solutions.
    this.capChallenges.delete(token);
    const result = await this.cap.redeemChallenge({ token, solutions });
    if (!result.success || !result.token || !result.expires) return result;
    if (shared) {
      await sharedChallengeStore().put({ kind: CAP_ROW_TOKEN_BINDING, id: rowId(result.token), ip: normalizeIp(ip), purpose, data: null, expiresAt: result.expires });
      return result;
    }
    setBoundedMapValue(this.capTokens, result.token, {
      expiresAt: result.expires,
      ip: normalizeIp(ip),
      purpose,
    }, CAP_MAX_TOKENS);
    return result;
  }

  async verifyCapToken(
    ip: string,
    purpose: CaptchaPurpose,
    token: string,
    now = Date.now(),
  ) {
    this.pruneCapState(now);
    const entry = this.shared() ? await sharedChallengeStore().consume(CAP_ROW_TOKEN_BINDING, rowId(token)) : this.capTokens.get(token);
    if (!entry || entry.expiresAt <= now || entry.ip !== normalizeIp(ip) || entry.purpose !== purpose) return false;
    // Remove before awaiting validation so a concurrent login cannot consume
    // the same token twice. A failed validation is intentionally non-reusable.
    this.capTokens.delete(token);
    const result = await this.cap.validateToken(token);
    return result.success;
  }

  private pruneCapState(now: number) {
    for (const [token, entry] of this.capChallenges) {
      if (entry.expiresAt <= now) this.capChallenges.delete(token);
    }
    for (const [token, entry] of this.capTokens) {
      if (entry.expiresAt <= now) this.capTokens.delete(token);
    }
    pruneCapMemory(now);
  }

  verifyChallenge(
    captchaId: string,
    answer: string | number,
    ip: string,
    purpose: CaptchaPurpose,
    now = Date.now(),
  ) {
    const challenge = this.challenges.get(captchaId);
    if (!challenge) return false;
    this.challenges.delete(captchaId);
    if (this.shared()) this.track(sharedChallengeStore().remove(IMAGE_ROW, rowId(captchaId)), "captcha image remove");
    if (challenge.expiresAt <= now) return false;
    if (challenge.ip !== normalizeIp(ip)) return false;
    if (challenge.purpose !== purpose) return false;
    return answersEqual(challenge.answer, normalizeAnswer(answer));
  }

  /**
   * verifyChallenge 的跨实例版：db 模式去库里取出来并删掉（删到了才算拿到）再比答案，内存模式就是 verifyChallenge。
   * 同步的调用方改成 await 这个之后图片模式也能跨实例。
   */
  async verifyChallengeShared(
    captchaId: string,
    answer: string | number,
    ip: string,
    purpose: CaptchaPurpose,
    now = Date.now(),
  ) {
    if (!this.shared()) return this.verifyChallenge(captchaId, answer, ip, purpose, now);
    // db 模式下库是唯一的真相：签发实例内存里那份也只是缓存，别的实例用过之后这里不能再认。
    this.challenges.delete(captchaId);
    const row = await sharedChallengeStore().consume(IMAGE_ROW, rowId(captchaId));
    if (!row || row.expiresAt <= now || row.ip !== normalizeIp(ip) || row.purpose !== purpose || !row.data) return false;
    return answersEqual(row.data, rowId(normalizeAnswer(answer)));
  }

  recordLoginFailure(ip: string, username: string, now = Date.now()) {
    this.loginFailures.bump(this.loginKey(ip, username), now);
    const account = normalizeUsername(username);
    if (account) this.accountLoginFailures.bump(account, now);
  }

  requiresLoginCaptcha(ip: string, username: string, now = Date.now()) {
    if ((this.loginFailures.state(this.loginKey(ip, username), now)?.count ?? 0) >= this.failureThreshold) return true;
    const account = normalizeUsername(username);
    return !!account && (this.accountLoginFailures.state(account, now)?.count ?? 0) >= LOGIN_CAPTCHA_ACCOUNT_FAILURE_THRESHOLD;
  }

  clearLoginCaptchaRequirement(ip: string, username: string) {
    this.loginFailures.clear(this.loginKey(ip, username));
    // 登录成功才会走到这里：账户确实是本人在用，账户级的计数一并清掉。
    this.accountLoginFailures.clear(normalizeUsername(username));
  }

  pruneExpired(now = Date.now()) {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    this.loginFailures.prune(now);
    this.accountLoginFailures.prune(now);
    this.sharedRefreshBudget.prune(now);
    const cutoff = now - this.refreshWindowMs;
    for (const [key, timestamps] of this.refreshTimestamps) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      // Updating an existing key keeps the live Map iterator finite. The bounded
      // setter deletes/reinserts it, which would make this loop revisit it forever.
      if (active.length > 0) this.refreshTimestamps.set(key, active);
      else this.refreshTimestamps.delete(key);
    }
    this.pruneCapState(now);
  }

  stateSizesForTest() {
    return {
      challenges: this.challenges.size,
      loginFailures: this.loginFailures.size,
      refreshTimestamps: this.refreshTimestamps.size,
      capChallenges: this.capChallenges.size,
      capTokens: this.capTokens.size,
    };
  }

  clearForTest() {
    this.challenges.clear();
    this.loginFailures.clearAll();
    this.accountLoginFailures.clearAll();
    this.sharedRefreshBudget.clearAll();
    this.refreshTimestamps.clear();
    this.capChallenges.clear();
    this.capTokens.clear();
    capMemoryChallenges.clear();
    capMemoryTokens.clear();
  }
}

export const authCaptcha = new AuthCaptchaService();

function requestIp(req: Request) {
  return clientIp(req, "unknown");
}

function capPurpose(value: unknown): CaptchaPurpose | null {
  return value === "login" || value === "register" ? value : null;
}

/**
 * Self-hosted Cap.js HTTP API used by the login/register widget. The Cap
 * protocol itself is deliberately kept separate from tRPC because the widget
 * posts directly to /challenge and /redeem.
 */
export const authCapRouter = Router();

/*
  管理员选了图片验证码（shared/authCaptchaMode.ts）时，Cap 的挑战和兑换都不开：
  登录 / 注册反正只认图片答案，再发 Cap 挑战只是给脚本白送一条可刷的路。
  读设置失败就按默认的点击验证放行 —— 这一步挡不住也不该挡住正常的点击验证。
*/
async function capRouteAllowed(res: Response) {
  const mode = await readAuthCaptchaMode().catch(() => "click" as const);
  if (captchaChallengeAllowed(mode, "cap")) return true;
  res.status(409).json({ success: false, error: "CAPTCHA_MODE_MISMATCH" });
  return false;
}

authCapRouter.post("/api/auth/cap/:purpose/challenge", async (req: Request, res: Response) => {
  const purpose = capPurpose(req.params.purpose);
  if (!purpose) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  if (!(await capRouteAllowed(res))) return;
  try {
    const challenge = await authCaptcha.createCapChallenge(requestIp(req), purpose);
    res.setHeader("Cache-Control", "no-store");
    res.json(challenge);
  } catch (error) {
    if (error instanceof CaptchaRefreshRateLimitError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      res.status(429).json({ success: false, error: "CAPTCHA_REFRESH_RATE_LIMITED" });
      return;
    }
    console.warn(`[Auth] Cap challenge failed ip=${requestIp(req)}`, error);
    res.status(503).json({ success: false, error: "CAPTCHA_CHALLENGE_UNAVAILABLE" });
  }
});

authCapRouter.post("/api/auth/cap/:purpose/redeem", async (req: Request, res: Response) => {
  const purpose = capPurpose(req.params.purpose);
  if (!purpose) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  if (!(await capRouteAllowed(res))) return;
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const solutions = req.body?.solutions;
  // Challenge tokens are randomHex(25) in Cap.js (50 hexadecimal chars).
  if (!/^[a-f0-9]{50}$/i.test(token)
    || !Array.isArray(solutions)
    || solutions.length < 1
    || solutions.length > 100
    || solutions.some((value: unknown) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    res.status(400).json({ success: false, error: "Invalid body" });
    return;
  }
  try {
    const result = await authCaptcha.redeemCapChallenge(requestIp(req), purpose, token, solutions);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.message || "CAPTCHA_INVALID" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    console.warn(`[Auth] Cap redeem failed ip=${requestIp(req)}`, error);
    res.status(400).json({ success: false, error: "CAPTCHA_INVALID" });
  }
});

const authCaptchaCleanupTimer = setInterval(() => authCaptcha.pruneExpired(), 5 * 60 * 1000);
authCaptchaCleanupTimer.unref?.();
