import crypto from "crypto";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";

type GostAuth = {
  username: string;
  password: string;
};

type GostComponent = {
  type: "forward" | "relay";
  auth?: GostAuth;
  metadata?: Record<string, unknown>;
};

function relayComponent(username: string, passwordSeed: string): GostComponent {
  return {
    type: "relay",
    auth: {
      username,
      password: crypto.createHash("sha256").update(passwordSeed).digest("hex"),
    },
    metadata: { nodelay: true },
  };
}

export function planGostTunnelHopRelay(input: {
  tunnelId: number;
  secretSeed: string;
}): GostComponent {
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  return relayComponent(
    `fwx-hop-${tunnelId}`,
    `forwardx-gost-hop-relay:v1|${String(input.secretSeed || "")}|${tunnelId}`,
  );
}

export type GostTunnelRuleProtocolPlan = {
  protocol: "tcp" | "udp" | "both";
  /**
   * 入口这一侧的 gost 服务要不要带 forwarder 目标。relay 隧道里「出口拨哪儿」是入口在请求里说的，所以恒为 true ——
   * 它只说明这件事，不能拿来当「这条规则用不用某个功能」的开关（2.3.539 的出口组就是被一句
   * `if (entryNeedsTarget) continue` 整个关掉的）。
   */
  entryNeedsTarget: boolean;
  chainConnector: GostComponent;
  exitHandler: GostComponent;
  exitTargetDialType: "tcp" | "udp" | null;
};

export function planGostTunnelRuleProtocol(input: {
  protocol: unknown;
  tunnelId: number;
  ruleId: number;
  secretSeed: string;
}): GostTunnelRuleProtocolPlan {
  const protocol = normalizeForwardRuleProtocol(input.protocol, "tcp");
  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  const ruleId = Math.max(0, Math.trunc(Number(input.ruleId) || 0));
  const component = relayComponent(
    `fwx-${tunnelId}-${ruleId}`,
    `forwardx-gost-relay:v1|${String(input.secretSeed || "")}|${tunnelId}|${ruleId}`,
  );

  return {
    protocol,
    entryNeedsTarget: true,
    chainConnector: component,
    exitHandler: component,
    exitTargetDialType: null,
  };
}
