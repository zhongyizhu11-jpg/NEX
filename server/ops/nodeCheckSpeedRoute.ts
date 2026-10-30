import type { Request, Response, Router } from "express";
import { observedAgentAddress } from "../agentAddressState";
import { nodeCheckSpeedTokenHost } from "./nodeCheck";

/*
  面板自己当测速服务器（Agent 2.2.242 起）。Agent 测速先对 Cloudflare；国内机器到国外 80 / 443
  常常不通，连不上就改测到这里 —— 面板是 Agent 一定连得上的地址。形状照 Cloudflare 的：
    GET  /api/nodecheck/speed/meta         → { clientIp }
    GET  /api/nodecheck/speed/down?bytes=N → N 个零字节（最多 64 MB）
    POST /api/nodecheck/speed/up           → 读完丢掉，回 { bytes }
  认一次性口令（Authorization: Bearer <token>，排测速时随指令下发，测完即失效），不走 Agent 的
  加密信封：几十 MB 的流量没必要也不该过加密中间件。测到的是「这台机器 ↔ 面板」那条路，
  上限是面板服务器自己的带宽；结果里标 server = "panel"，界面上说清楚。
*/

const SPEED_DOWN_DEFAULT = 25 << 20;
const SPEED_DOWN_MAX = 64 << 20;
const SPEED_UP_MAX = 64 << 20;
const ZERO_CHUNK = Buffer.alloc(256 << 10);

function speedTokenFromRequest(req: Request) {
  const header = String(req.headers.authorization || "");
  if (/^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, "").trim();
  return String(req.query.t || "").trim();
}

function authorize(req: Request, res: Response): number | null {
  const hostId = nodeCheckSpeedTokenHost(speedTokenFromRequest(req));
  if (!hostId) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "没有正在跑的测速" });
    return null;
  }
  return hostId;
}

/** 往响应里写 total 个零字节，顾着背压；对方断开就停。 */
export function streamZeroBytes(res: Response, total: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = total;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    res.once("close", finish);
    res.once("error", finish);
    const pump = () => {
      while (remaining > 0 && !done) {
        const size = Math.min(remaining, ZERO_CHUNK.length);
        remaining -= size;
        const ok = res.write(size === ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, size));
        if (!ok) {
          res.once("drain", pump);
          return;
        }
      }
      if (!done) res.end(finish);
    };
    pump();
  });
}

export function registerNodeCheckSpeedRoutes(router: Router) {
  router.get("/api/nodecheck/speed/meta", (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ clientIp: observedAgentAddress(req), server: "panel" });
  });

  router.get("/api/nodecheck/speed/down", async (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    const requested = Number(req.query.bytes);
    const total = Number.isFinite(requested) && requested >= 0 ? Math.min(Math.floor(requested), SPEED_DOWN_MAX) : SPEED_DOWN_DEFAULT;
    // no-transform：别让 compression 把一串零压成几个字节，那就不是在测带宽了。
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(total));
    if (total === 0) {
      res.end();
      return;
    }
    await streamZeroBytes(res, total);
  });

  router.post("/api/nodecheck/speed/up", (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > SPEED_UP_MAX) {
      res.status(413).json({ error: `一次最多 ${SPEED_UP_MAX >> 20} MB` });
      return;
    }
    let bytes = 0;
    let replied = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SPEED_UP_MAX && !replied) {
        replied = true;
        res.status(413).json({ error: `一次最多 ${SPEED_UP_MAX >> 20} MB` });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (replied) return;
      replied = true;
      res.json({ ok: true, bytes });
    });
    req.on("error", () => {
      if (replied) return;
      replied = true;
      res.status(400).json({ error: "上传中断" });
    });
  });
}
