import { createHash } from "node:crypto";

/*
  测试里替浏览器解 Cap 的工作量证明（和 @cap.js/widget 同一套伪随机数和 sha256 前缀规则）。
  authCaptcha.test.ts 和 authCaptchaMode.fixture.ts 共用，只给测试用。
*/
function capPrng(seed: string, length: number) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += (state >>> 0).toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

export function capSolutions(token: string, challenge: { c: number; s: number; d: number }) {
  return Array.from({ length: challenge.c }, (_, index) => {
    const salt = capPrng(`${token}${index + 1}`, challenge.s);
    const target = capPrng(`${token}${index + 1}d`, challenge.d);
    for (let nonce = 0; nonce < 2_000_000; nonce += 1) {
      const digest = createHash("sha256").update(`${salt}${nonce}`).digest("hex");
      if (digest.startsWith(target)) return nonce;
    }
    throw new Error("unable to solve Cap test challenge");
  });
}
