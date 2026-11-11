import type { Request, Response, Router } from "express";
import { getAgentHostIdentityFromRequest } from "./agentAuth";

/*
  Agent 管理用的小接口。

  POST /api/agent/panel-url-probe（经 /api/sync 加密）：Agent 收到新的面板地址后，先用自己的 Token 对新地址
  发这一条。能回一个用同一 Token 加密的成功信封，就说明新地址通、而且后面确实是认得这个 Token 的面板，
  Agent 才切过去并写进配置（agent/panel_url_switch.go）。这条什么都不改，只回主机 id。
*/
export function registerAgentManagementRoutes(router: Router) {
  router.post("/api/agent/panel-url-probe", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostIdentityFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      res.json({ success: true, panelUrlProbe: true, hostId: Number(host.id) });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
