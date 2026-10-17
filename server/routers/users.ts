import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { maskIdentifier } from "./helpers";
import { z } from "zod";
import * as db from "../db";
import { FORWARD_TYPES } from "../../shared/forwardTypes";
import { isValidAvatarValue } from "../../shared/avatar";
import { parseBillingExpiryInput } from "../../shared/billingTime";
import { ensureAdminOrSelf, refreshUserForwardEndpoints } from "./helpers";
import { clearLinkAccessScopeCache } from "../linkAccessView";
import { getEmailConfig, sendMail } from "../email";
import {
  resetUserTrafficCommand,
  setUserAccountEnabledCommand,
  setUserForwardAccessCommand,
} from "../services/userCommandService";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { reconcileUserRuleResourceAuthorization } from "../ruleResourceAuthorization";
import { pushAgentRefresh } from "../agentEvents";

const DISPLAY_NAME_MAX_LENGTH = 24;
// int 列（MySQL INT / PostgreSQL integer）能存的最大值；计数类上限写库前在入口挡住。
const INT32_MAX = 2_147_483_647;

function actorLabel(ctx: { user?: { id: number; username?: string } | null }) {
  return ctx.user ? `adminId=${ctx.user.id}` : "adminId=unknown";
}

export const usersRouter = router({
    list: adminProcedure.query(async () => {
      return db.getAllUsers();
    }),
    options: adminProcedure.query(async () => {
      return db.getUserOptions();
    }),
    listPage: adminProcedure
      .input(z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(12),
      }))
      .query(async ({ input }) => {
        return db.getUsersPage(input);
      }),
    summary: adminProcedure.query(async () => {
      const [counts, stats] = await Promise.all([
        db.getUserManagementCounts(),
        db.getDashboardStats(),
      ]);
      return {
        ...counts,
        totalRules: stats.totalRules,
        activeRules: stats.activeRules,
        totalTrafficIn: stats.totalTrafficIn,
        totalTrafficOut: stats.totalTrafficOut,
      };
    }),
    create: adminProcedure
      .input(z.object({
        username: z.string().min(1).max(64),
        password: z.string().min(6),
        name: z.string().trim().max(DISPLAY_NAME_MAX_LENGTH).optional(),
        email: z.string().email().optional(),
        canAddRules: z.boolean().default(false),
        allowProxySubscription: z.boolean().default(false),
      }))
      .mutation(async ({ input, ctx }) => {
        const existing = await db.getUserByUsername(input.username);
        if (existing) {
          console.warn(`[Users] Create user rejected duplicate username=${maskIdentifier(input.username)} ${actorLabel(ctx)}`);
          throw new Error("用户名已存在");
        }
        // 安全限制：通过后台创建的用户一律为普通用户，不允许创建新管理员
        const id = await db.createUser({
          ...input,
          role: "user",
          // 与编辑页同一条规则：转发都不让开，订阅只会给出一堆连不通的死节点。
          /**
           * 订阅权限不再绑在转发权限上。
           *
           * 以前绑着是因为订阅只能由转发规则汇聚而成 —— 没转发就是一张空订阅。
           * 有了自建落地节点之后不成立了：一个用户可以零转发，只靠自己主机上的
           * 落地节点出订阅（直连条目根本不经过中转）。两种权限现在各给各的。
           */
          allowProxySubscription: input.allowProxySubscription,
        });
        console.info(`[Users] Created user userId=${id} username=${maskIdentifier(input.username)} ${actorLabel(ctx)}`);
        return { id };
      }),
    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ input, ctx }) => {
        // 安全限制：不允许提升用户为管理员，也不允许修改已有管理员的角色
        if (input.role === "admin") {
          console.warn(`[Users] Role update rejected userId=${input.userId} requestedRole=admin ${actorLabel(ctx)}`);
          throw new Error("出于安全考虑，不允许将用户提升为管理员");
        }
        const target = await db.getUserById(input.userId);
        if (target?.role === "admin") {
          console.warn(`[Users] Role update rejected target is admin userId=${input.userId} ${actorLabel(ctx)}`);
          throw new Error("不允许修改管理员账户的角色");
        }
        await db.updateUserRole(input.userId, input.role);
        await db.setUserForwardAccess(input.userId, false);
        await refreshUserForwardEndpoints(input.userId, "user-role-updated");
        console.info(`[Users] Updated role userId=${input.userId} role=${input.role} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    resetPassword: adminProcedure
      .input(z.object({
        userId: z.number(),
        username: z.string().trim().min(1).max(64).optional(),
        name: z.string().trim().max(DISPLAY_NAME_MAX_LENGTH).nullable().optional(),
        avatar: z.string().max(90 * 1024).optional(),
        newPassword: z.string().max(128).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        if (!target) throw new Error("用户不存在");
        const username = input.username?.trim();
        if (username && username !== target.username) {
          const existing = await db.getUserByUsername(username);
          if (existing && existing.id !== input.userId) throw new Error("账号已存在");
        }
        const password = input.newPassword?.trim() || "";
        if (password && password.length < 6) throw new Error("密码至少6个字符");
        if (input.avatar !== undefined && !isValidAvatarValue(input.avatar)) throw new Error("头像格式不支持或超过 50K");
        if (!username && input.name === undefined && input.avatar === undefined && !password) throw new Error("没有需要保存的修改");
        await db.updateUserAccount(input.userId, {
          username,
          name: input.name,
          avatar: input.avatar,
          password: password || undefined,
        });
        console.info(`[Users] Updated account userId=${input.userId} usernameChanged=${!!username && username !== target.username} passwordChanged=${!!password} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    updateAvatar: protectedProcedure
      .input(z.object({
        userId: z.number().optional(),
        avatar: z.string().max(90 * 1024),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = input.userId ?? ctx.user.id;
        ensureAdminOrSelf(ctx, userId);
        if (!isValidAvatarValue(input.avatar)) throw new Error("头像格式不支持或超过 50K");
        const target = await db.getUserById(userId);
        if (!target) throw new Error("用户不存在");
        const quota = await db.updateUserAvatarWithQuota(userId, input.avatar, { actorRole: ctx.user.role, countQuota: userId === ctx.user.id });
        console.info(`[Users] Updated avatar userId=${userId} ${actorLabel(ctx)}`);
        return { success: true, quota };
      }),
    randomAvatar: protectedProcedure
      .input(z.object({ userId: z.number().optional() }).optional())
      .mutation(async ({ input, ctx }) => {
        const userId = input?.userId ?? ctx.user.id;
        ensureAdminOrSelf(ctx, userId);
        const target = await db.getUserById(userId);
        if (!target) throw new Error("用户不存在");
        const result = await db.updateUserAvatarRandomWithQuota(userId, { actorRole: ctx.user.role, countQuota: userId === ctx.user.id });
        console.info(`[Users] Randomized avatar userId=${userId} ${actorLabel(ctx)}`);
        return { success: true, ...result };
      }),
    avatarQuota: protectedProcedure
      .input(z.object({ userId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => {
        const userId = input?.userId ?? ctx.user.id;
        ensureAdminOrSelf(ctx, userId);
        return db.getUserAvatarQuota(userId);
      }),
    delete: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        if (input.userId === ctx.user.id) throw new Error("不能删除当前登录账户");
        const target = await db.getUserById(input.userId);
        if (!target) throw new Error("用户不存在");
        // 他名下的隧道、转发组、主机可能还承载着别人的规则，不能跟着人一起删，也不能留成无主的行。
        const owned = await db.getUserOwnedInfrastructureCounts(input.userId);
        const ownedParts = [
          owned.tunnels > 0 ? `${owned.tunnels} 条隧道` : "",
          owned.forwardGroups > 0 ? `${owned.forwardGroups} 个转发组` : "",
          owned.hosts > 0 ? `${owned.hosts} 台主机` : "",
        ].filter(Boolean);
        if (ownedParts.length > 0) {
          throw new Error(`该用户名下还有 ${ownedParts.join("、")}，请先转移给其他用户或删除后再删除该用户`);
        }
        // 他的规则走和手动删除一样的流程：先结算流量、标记待删除、通知 Agent 停掉。
        // 直接删人的话这些规则会留在机器上没人管，端口也一直占着。
        // 动态引入：rules.crud 和 rules 路由互相引用，静态引进来会改变模块初始化顺序。
        const { deleteForwardRuleForActor } = await import("./rules.crud");
        const adminActor = { id: ctx.user.id, role: "admin" };
        for (const ruleId of await db.getUserTopLevelForwardRuleIds(input.userId)) {
          await deleteForwardRuleForActor(adminActor, ruleId, { reasonPrefix: `user-${input.userId}-deleted` });
        }
        await db.deleteUserPermissions(input.userId);
        clearLinkAccessScopeCache();
        // 收凭据、收专属端口这些都焊在 deleteUser 里了 —— 顺序不能反（凭据按
        // sharedUserId 找，人删了就找不着），所以不该由每条删人路径各记一遍。
        const { hostIds: releasedHostIds } = await db.deleteUser(input.userId);
        for (const hostId of releasedHostIds) {
          pushAgentRefresh(hostId, `proxy-share-user-deleted-${input.userId}`, { urgent: true });
        }
        console.info(`[Users] Deleted user userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    removeTwoFactor: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        if (!target) throw new Error("用户不存在");
        if (!target.twoFactorEnabled && !target.twoFactorSecret) {
          return { success: true, removed: false };
        }
        await db.disableUserTwoFactor(input.userId);
        console.info(`[Users] Removed 2FA userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true, removed: true };
      }),
    /** 获取某用户的主机权限列表 */
    getHostPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        // 管理编辑页只展示管理员手动授权；套餐绑定资源在订阅管理中体现。
        return db.getUserAllowedHostIds(input.userId);
      }),
    /** 设置某用户的主机权限（全量替换） */
    setHostPermissions: adminProcedure
      .input(z.object({ userId: z.number(), hostIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        await withKeyedTaskLock(`user-resource-permissions:${input.userId}`, async () => {
          await db.setUserHostPermissions(input.userId, input.hostIds);
          clearLinkAccessScopeCache();
          await reconcileUserRuleResourceAuthorization(input.userId);
        });
        console.info(`[Users] Updated host permissions userId=${input.userId} count=${input.hostIds.length} ${actorLabel(ctx)}`);
        return { success: true };
      }),

    /**
     * 分享给这个用户的节点。
     *
     * 与主机/隧道权限的区别：那些是「能不能用这台机器建转发」，这个是
     * 「他的订阅里直接多出这几个节点」，不转让所有权，节点还是原主人的。
     */
    getProxyNodeShares: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        /**
         * 要的是「选项列表里该勾上哪几条」，不是他实际拿到的那几条 —— 多凭据
         * 入站上他拿的是自己那条派生节点，而列表里放的是代表整个端口的那条。
         * 直接返回前者的话选择框显示成一个都没选，管理员一保存就把他的凭据
         * 静默收走了。
         */
        return db.getProxyNodeShareSelectionForUser(input.userId);
      }),
    setProxyNodeShares: adminProcedure
      .input(z.object({ userId: z.number(), nodeIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        const label = String((target as any)?.username || (target as any)?.name || "").trim();
        let skipped: Awaited<ReturnType<typeof db.setProxyNodeSharesForUser>>["skipped"] = [];
        let sharedOwnerCredential: Array<{ nodeId: number; name: string }> = [];
        await withKeyedTaskLock(`user-resource-permissions:${input.userId}`, async () => {
          const result = await db.setProxyNodeSharesForUser(input.userId, input.nodeIds, { label });
          skipped = result.skipped;
          sharedOwnerCredential = result.sharedOwnerCredential || [];
          // 多凭据入站上分享/取消分享都改了那个端口的用户表，要重下发。
          for (const hostId of result.hostIds) pushAgentRefresh(hostId, `proxy-node-share-user-${input.userId}`, { urgent: true });
        });
        /**
         * 有没有订阅权限也一并告诉界面。
         *
         * 分享本身会写进去，但没有这个权限的人打不开订阅管理、也拿不到订阅地址 ——
         * 分享了等于没分享，而管理员从这个弹窗上完全看不出来。
         */
        const recipientCanUse = !!(target as any)?.allowProxySubscription || (target as any)?.role === "admin";
        console.info(`[Users] Updated proxy node shares userId=${input.userId} count=${input.nodeIds.length} skipped=${skipped.length} ${actorLabel(ctx)}`);
        return { success: true, skipped, recipientCanUse, sharedOwnerCredential };
      }),
    /** 可分享的节点清单。不含凭据，只够在选择框里认出是哪个节点。 */
    proxyNodeShareOptions: adminProcedure.query(async () => {
      return db.getProxyNodeShareOptions();
    }),

    getForwardGroupPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserManualAllowedForwardGroupIds(input.userId);
      }),
    setForwardGroupPermissions: adminProcedure
      .input(z.object({ userId: z.number(), forwardGroupIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        await withKeyedTaskLock(`user-resource-permissions:${input.userId}`, async () => {
          await db.setUserForwardGroupPermissions(input.userId, input.forwardGroupIds);
          clearLinkAccessScopeCache();
          await reconcileUserRuleResourceAuthorization(input.userId);
        });
        console.info(`[Users] Updated forward group permissions userId=${input.userId} count=${input.forwardGroupIds.length} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    /** 获取所有用户的主机权限映射 */
    allHostPermissions: adminProcedure.query(async () => {
      return db.getAllUserHostPermissions();
    }),
    getTrafficBillingPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserTrafficBillingPermissions(input.userId);
      }),
    setTrafficBillingPermissions: adminProcedure
      .input(z.object({
        userId: z.number(),
        hostIds: z.array(z.number()),
        tunnelIds: z.array(z.number()),
        forwardGroupIds: z.array(z.number()).optional().default([]),
      }))
      .mutation(async ({ input, ctx }) => {
        const recovery = await withKeyedTaskLock(`user-resource-permissions:${input.userId}`, async () => {
          await db.setUserTrafficBillingPermissions(input.userId, input.hostIds, input.tunnelIds, input.forwardGroupIds);
          clearLinkAccessScopeCache();
          const nextRecovery = await db.recoverUserForwardAccessIfEligible(input.userId);
          await reconcileUserRuleResourceAuthorization(input.userId);
          return nextRecovery;
        });
        if (recovery.restored) {
          await refreshUserForwardEndpoints(input.userId, "traffic-billing-permission-forward-restored");
        }
        console.info(`[Users] Updated traffic billing permissions userId=${input.userId} hosts=${input.hostIds.length} tunnels=${input.tunnelIds.length} forwardGroups=${input.forwardGroupIds.length} ${actorLabel(ctx)}`);
        return { success: true, forwardAccessRestored: recovery.restored };
      }),
    getTunnelPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        // 管理编辑页只展示管理员手动授权；套餐绑定资源在订阅管理中体现。
        return db.getUserAllowedTunnelIds(input.userId);
      }),
    setTunnelPermissions: adminProcedure
      .input(z.object({ userId: z.number(), tunnelIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        await withKeyedTaskLock(`user-resource-permissions:${input.userId}`, async () => {
          await db.setUserTunnelPermissions(input.userId, input.tunnelIds);
          clearLinkAccessScopeCache();
          await reconcileUserRuleResourceAuthorization(input.userId);
        });
        console.info(`[Users] Updated tunnel permissions userId=${input.userId} count=${input.tunnelIds.length} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    sendEmail: adminProcedure
      .input(z.object({
        userId: z.number(),
        subject: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(4000),
      }))
      .mutation(async ({ input, ctx }) => {
        const config = await getEmailConfig();
        if (!config.enabled) throw new Error("邮箱服务未启用");
        const user = await db.getUserById(input.userId);
        if (!user) throw new Error("用户不存在");
        if (!user.email || !user.emailVerified) throw new Error("该用户邮箱尚未验证，不能发送邮件");
        await sendMail({
          to: user.email,
          subject: input.subject.trim(),
          text: input.content.trim(),
          html: input.content.trim().replace(/\n/g, "<br />"),
        });
        console.info(`[Users] Sent email userId=${input.userId} subjectLength=${input.subject.trim().length} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    allTunnelPermissions: adminProcedure.query(async () => {
      return db.getAllUserTunnelPermissions();
    }),
    /** 获取某用户的规则数和端口数 */
    getUserQuotaUsage: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input, ctx }) => {
        ensureAdminOrSelf(ctx, input.userId);
        const [ruleCount, portCount] = await Promise.all([
          db.getUserRuleCount(input.userId),
          db.getUserPortCount(input.userId),
        ]);
        return { ruleCount, portCount };
      }),
    /** 更新用户流量管理和权限设置 */
    updateTrafficSettings: adminProcedure
      // 这些都落到整数列（int / bigint）：小数在 MySQL / PostgreSQL 上要么被截断要么报错，
      // 超过 int 上限直接写库失败。在入口挡成整数 + 上限，报清楚的校验错误。
      // 计数类上限统一用 int 列的上限而不是更小的「合理值」：已经存了大数的用户，
      // 表单每次保存都会原样回传，收得太紧会让管理员连别的设置都改不了。
      .input(z.object({
        userId: z.number(),
        trafficLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        gostRateLimitIn: z.number().int().min(0).max(1_000_000).optional(),
        gostRateLimitOut: z.number().int().min(0).max(1_000_000).optional(),
        /** 突发：峰值 Mbps 和能按峰值跑多少秒，0 = 不开（见 shared/forwardRateLimit.ts）。 */
        forwardBurstMbps: z.number().int().min(0).max(1_000_000).optional(),
        forwardBurstSeconds: z.number().int().min(0).max(3600).optional(),
        expiresAt: z.string().nullable().optional(), // ISO date string or null
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().int().min(1).max(31).optional(),
        canAddRules: z.boolean().optional(),
        displayRemark: z.string().trim().max(24).nullable().optional(),
        maxRules: z.number().int().min(0).max(INT32_MAX).optional(),
        /** 自建落地节点数上限，0 = 不限。与 maxRules 一样走 manual 那一列。 */
        maxProxyInbounds: z.number().int().min(0).max(INT32_MAX).optional(),
        /** 能自助加几台机器。0 = 跟随系统设置的全局上限，不是「不限」。 */
        maxSelfServiceHosts: z.number().int().min(0).max(10000).nullable().optional(),
        /** 订阅地址条数上限，0 = 不限。 */
        maxProxySubTokens: z.number().int().min(0).max(INT32_MAX).optional(),
        maxPorts: z.number().int().min(0).max(INT32_MAX).optional(),
        maxConnections: z.number().int().min(0).max(INT32_MAX).optional(),
        maxIPs: z.number().int().min(0).max(INT32_MAX).optional(),
        // 逗号分隔的转发方式列表；null 为全部允许
        allowedForwardTypes: z.string().nullable().optional(),
        allowForwardXTunnel: z.boolean().optional(),
        allowProxySubscription: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { userId, expiresAt, allowedForwardTypes, ...rest } = input;
        const data: any = { ...rest };
        if (data.trafficLimit !== undefined) {
          data.manualTrafficLimit = Math.max(0, Math.floor(Number(data.trafficLimit) || 0));
          delete data.trafficLimit;
        }
        if (data.gostRateLimitIn !== undefined) {
          data.manualGostRateLimitIn = Math.max(0, Math.floor(Number(data.gostRateLimitIn) || 0));
          delete data.gostRateLimitIn;
        }
        if (data.gostRateLimitOut !== undefined) {
          data.manualGostRateLimitOut = Math.max(0, Math.floor(Number(data.gostRateLimitOut) || 0));
          delete data.gostRateLimitOut;
        }
        if (data.maxProxySubTokens !== undefined) {
          data.manualMaxProxySubTokens = Math.max(0, Math.floor(Number(data.maxProxySubTokens) || 0));
          delete data.maxProxySubTokens;
        }
        if (data.maxProxyInbounds !== undefined) {
          data.manualMaxProxyInbounds = Math.max(0, Math.floor(Number(data.maxProxyInbounds) || 0));
          delete data.maxProxyInbounds;
        }
        if (data.maxRules !== undefined) {
          data.manualMaxRules = Math.max(0, Math.floor(Number(data.maxRules) || 0));
          delete data.maxRules;
        }
        if (data.maxPorts !== undefined) {
          data.manualMaxPorts = Math.max(0, Math.floor(Number(data.maxPorts) || 0));
          delete data.maxPorts;
        }
        if (data.maxConnections !== undefined) {
          data.manualMaxConnections = Math.max(0, Math.floor(Number(data.maxConnections) || 0));
          delete data.maxConnections;
        }
        if (data.maxIPs !== undefined) {
          data.manualMaxIPs = Math.max(0, Math.floor(Number(data.maxIPs) || 0));
          delete data.maxIPs;
        }
        if (expiresAt !== undefined) {
          // 表单传的是 YYYY-MM-DD：按计费时区当天零点，不能 new Date() 成 UTC 零点（跨时区会差一天）。
          const parsedExpiresAt = expiresAt ? parseBillingExpiryInput(expiresAt) : null;
          if (parsedExpiresAt === undefined) throw new Error("到期日期无效");
          data.manualExpiresAt = parsedExpiresAt;
        }
        if (allowedForwardTypes !== undefined) {
          // null 表示全部允许；空字符串表示全部禁用。
          const set = new Set((allowedForwardTypes ?? "").split(",").map(s => s.trim()).filter(Boolean));
          const valid = FORWARD_TYPES.filter(t => set.has(t));
          data.allowedForwardTypes = allowedForwardTypes === null || valid.length === FORWARD_TYPES.length ? null : valid.join(",");
        }
        if (input.displayRemark !== undefined) {
          data.displayRemark = input.displayRemark?.trim() || null;
        }
        // 客户端订阅是独立授权：不跟着转发权限自动开启，只按管理员的显式选择。
        if (input.allowProxySubscription !== undefined) {
          data.manualAllowProxySubscription = input.allowProxySubscription;
          delete data.allowProxySubscription;
        }
        if (input.canAddRules !== undefined) {
          data.manualCanAddRules = input.canAddRules;
          data.forwardAccessPauseReason = input.canAddRules ? null : "manual";
          data.manualAllowForwardXTunnel = input.canAddRules ? (data.allowForwardXTunnel ?? true) : false;
          // 停用转发时一并收回订阅：节点指向的转发已经停了，订阅只会给出死节点。
          if (!input.canAddRules) data.manualAllowProxySubscription = false;
          delete data.canAddRules;
          delete data.allowForwardXTunnel;
        }
        const shouldRefreshRuntime = ["manualGostRateLimitIn", "manualGostRateLimitOut", "forwardBurstMbps", "forwardBurstSeconds", "manualMaxConnections", "manualMaxIPs"].some((key) =>
          Object.prototype.hasOwnProperty.call(data, key)
        );
        await db.updateUserManualEntitlements(userId, data);
        if (shouldRefreshRuntime) {
          await refreshUserForwardEndpoints(userId, "user-runtime-limits-updated");
        }
        console.info(`[Users] Updated traffic settings userId=${userId} keys=${Object.keys(data).join(",") || "none"} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    setForwardAccess: adminProcedure
      .input(z.object({ userId: z.number(), enabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const result = await setUserForwardAccessCommand({ actor: ctx.user, targetUserId: input.userId, enabled: input.enabled });
        console.info(`[Users] Forward access ${input.enabled ? "enabled" : "disabled"} userId=${input.userId} effective=${result.canAddRules} ${actorLabel(ctx)}`);
        // 回真正的生效状态。界面拿它 patch 缓存、拿它说话 —— 原来回的是写死的
        // `{ success: true }`，客户端只好拿自己发出去的值去报「已开启」。
        return { success: true, canAddRules: result.canAddRules, pauseReason: result.pauseReason };
      }),
    setAccountEnabled: adminProcedure
      .input(z.object({ userId: z.number(), enabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const result = await setUserAccountEnabledCommand({ actor: ctx.user, targetUserId: input.userId, enabled: input.enabled });
        console.info(`[Users] Account ${input.enabled ? "enabled" : "disabled"} userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true, forwardAccessRestored: result.forwardAccessRestored };
      }),
    /** 手动重置用户流量 */
    resetTraffic: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const result = await resetUserTrafficCommand({ actor: ctx.user, targetUserId: input.userId });
        console.info(`[Users] Reset traffic userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true, forwardAccessRestored: result.forwardAccessRestored };
      }),
  });
