import { systemRouter } from "./_core/systemRouter";
import { paymentRouter } from "./payment";
import { router } from "./_core/trpc";
import { agentTokensRouter } from "./routers/agentTokens";
import { announcementsRouter } from "./routers/announcements";
import { authRouter } from "./routers/auth";
import { billingRouter } from "./routers/billing";
import { dashboardRouter } from "./routers/dashboard";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { hostsRouter } from "./routers/hosts";
import { lookingGlassRouter } from "./routers/lookingGlass";
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
import { discordAuthRouter } from "./routers/discordAuth";

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
  lookingGlass: lookingGlassRouter,
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
  discordAuth: discordAuthRouter,
});

export type AppRouter = typeof appRouter;
