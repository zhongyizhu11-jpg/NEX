import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { NETPROFILE_MIN_AGENT_VERSION } from "../../shared/netProfile";
import {
  dnsblAddressForHost,
  getHostNetProfile,
  hostSupportsNetProfile,
  netProfileRunState,
  queryDnsblFromPanel,
  requestNetProfileRun,
  savePanelDnsbl,
} from "../ops/netProfile";
import { requireHostAccess } from "./helpers";

/*
  trpc.netProfile.* —— 主机详情里的「网络画像」。

  get       读最近一次的结果（能看这台主机的人都能看；运营商 / ASN 在主机行上，不在这里）
  recheck   重新检测（管理员）：Agent ≥ 2.2.225 叫 Agent 立刻测；更旧的 Agent 只能从面板查 DNSBL
*/
const hostIdInput = z.object({ hostId: z.number().int().positive() });

export const netProfileRouter = router({
  get: protectedProcedure.input(hostIdInput).query(async ({ ctx, input }) => {
    const host = await requireHostAccess(ctx, input.hostId);
    const stored = await getHostNetProfile(input.hostId);
    const run = netProfileRunState(input.hostId);
    return {
      supported: hostSupportsNetProfile(host as any),
      minAgentVersion: NETPROFILE_MIN_AGENT_VERSION,
      profile: stored.profile,
      history: stored.history,
      pending: run.pending,
      running: run.running,
      timedOut: run.timedOut,
    };
  }),

  recheck: adminProcedure
    .input(hostIdInput.extend({ mode: z.enum(["agent", "panelDnsbl"]).default("agent") }))
    .mutation(async ({ ctx, input }) => {
      const host = await requireHostAccess(ctx, input.hostId);
      if (input.mode === "agent") {
        if (!hostSupportsNetProfile(host as any)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `需要升级 Agent：主机侧检测要 Agent ${NETPROFILE_MIN_AGENT_VERSION} 以上` });
        }
        return { mode: "agent" as const, runId: requestNetProfileRun(input.hostId) };
      }
      const stored = await getHostNetProfile(input.hostId);
      const address = dnsblAddressForHost(host, stored.profile);
      if (!address) throw new TRPCError({ code: "BAD_REQUEST", message: "这台主机没有已知的公网 IPv4，查不了 DNSBL" });
      const dnsbl = await queryDnsblFromPanel(address);
      await savePanelDnsbl(input.hostId, address, dnsbl);
      return { mode: "panelDnsbl" as const, runId: null };
    }),
});
