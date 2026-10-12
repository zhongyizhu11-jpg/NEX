import type { Request, Response, Router } from "express";
import { getAgentHostFromRequest } from "../agentAuth";
import { handleAgentExtRound } from "./agentExt";
import "./agentExtModules";

/** POST /api/agent/ext —— 见 agentExt.ts。路径在 AGENT_TUNNEL_PATHS 里，所以和心跳一样走加密信封。 */
export function registerAgentExtRoutes(agentRouter: Router) {
  agentRouter.post("/api/agent/ext", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const reply = await handleAgentExtRound(host as any, req.body);
      res.json(reply);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
