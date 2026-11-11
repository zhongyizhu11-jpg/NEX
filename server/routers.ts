import { systemRouter } from "./_core/systemRouter";
import { paymentRouter } from "./payment";
import { router } from "./_core/trpc";
import { agentTokensRouter } from "./routers/agentTokens";
import { announcementsRouter } from "./routers/announcements";
import { authRouter } from "./routers/auth";
import { billingRouter } from "./routers/billing";
import { dashboardRouter } from "./routers/dashboard";
import { diagnosticsRouter } from "./routers/diagnostics";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { hostsRouter } from "./routers/hosts";
import { lookingGlassRouter } from "./routers/lookingGlass";
import { lineDiagnosticsRouter } from "./routers/lineDiagnostics";
import { nodePoolsRouter } from "./routers/nodePools";
import { plansRouter } from "./routers/plans";
import { referralRouter } from "./routers/referral";
import { pluginsRouter } from "./routers/plugins";
import { proxyInboundsRouter } from "./routers/proxyInbounds";
import { proxySubscriptionsRouter } from "./routers/proxySubscriptions";
import { rulesRouter } from "./routers/rules";
import { setupRouter } from "./routers/setup";
import { telegramRouter } from "./routers/telegram";
import { ticketsRouter } from "./routers/tickets";
import { trafficBillingRouter } from "./routers/trafficBilling";
import { tunnelsRouter } from "./routers/tunnels";
import { tlsInboundsRouter } from "./routers/tlsInbounds";
import { usersRouter } from "./routers/users";
import { opsRouter } from "./routers/ops";
import { ipChangeRouter } from "./routers/ipChange";
import { googleAuthRouter } from "./routers/googleAuth";
import { topologyRouter } from "./routers/topology";
import { discordAuthRouter } from "./routers/discordAuth";
import { netProfileRouter } from "./routers/netProfile";
import { agentRuntimeRouter } from "./routers/agentRuntime";
import { uiThemesRouter } from "./routers/uiThemes";
import { dnsRecordsRouter } from "./routers/dnsRecords";
import { hostAgentRouter } from "./routers/hostAgent";

export const appRouter = router({
  system: systemRouter,
  setup: setupRouter,
  payment: paymentRouter,
  billing: billingRouter,
  plans: plansRouter,
  referral: referralRouter,
  plugins: pluginsRouter,
  auth: authRouter,
  dashboard: dashboardRouter,
  users: usersRouter,
  hosts: hostsRouter,
  // 主机的 Agent 连接与保护（独立面板地址、流量阈值关机、本机资源告警、安装实例），见 routers/hostAgent.ts
  hostAgent: hostAgentRouter,
  lookingGlass: lookingGlassRouter,
  lineDiagnostics: lineDiagnosticsRouter,
  nodePools: nodePoolsRouter,
  diagnostics: diagnosticsRouter,
  rules: rulesRouter,
  forwardGroups: forwardGroupsRouter,
  tunnels: tunnelsRouter,
  telegram: telegramRouter,
  trafficBilling: trafficBillingRouter,
  agentTokens: agentTokensRouter,
  proxyInbounds: proxyInboundsRouter,
  tlsInbounds: tlsInboundsRouter,
  proxySubscriptions: proxySubscriptionsRouter,
  announcements: announcementsRouter,
  tickets: ticketsRouter,
  ops: opsRouter,
  ipChange: ipChangeRouter,
  googleAuth: googleAuthRouter,
  topology: topologyRouter,
  discordAuth: discordAuthRouter,
  netProfile: netProfileRouter,
  agentRuntime: agentRuntimeRouter,
  uiThemes: uiThemesRouter,
  dnsRecords: dnsRecordsRouter,
});

export type AppRouter = typeof appRouter;
