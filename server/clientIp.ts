/*
  取请求方 IP，全站一个口径。

  用 req.ip：它按面板的 trust proxy 设置解析 X-Forwarded-For；直接读这个头的话谁都能写一个假 IP。
  面板监听在 :: 上时，IPv4 客户端的地址是 ::ffff:1.2.3.4 这种映射写法，这里统一还原成 1.2.3.4 ——
  原来只有个别地方去掉了前缀，同一个客户端在审计、会话设备、限流里记成两种写法。
  限流键另外还要过一遍 ipRateLimitScope（IPv6 按 /64 归并），它本来就认这两种写法。
*/

type RequestLike = {
  ip?: string | null;
  socket?: { remoteAddress?: string | null } | null;
};

export function clientIp(req: RequestLike | null | undefined, fallback = ""): string {
  const raw = String(req?.ip || req?.socket?.remoteAddress || "").trim();
  const ip = raw.replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, "");
  return ip || fallback;
}
