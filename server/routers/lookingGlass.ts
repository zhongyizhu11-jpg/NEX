import { isPrivateOrReservedAddress } from "../../shared/ipAddress";
import dns from "dns";
import net from "net";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import {
  enqueueLookingGlassAgentTask,
  getLookingGlassAgentTaskStatus,
  hasActiveLookingGlassTask,
  IPERF3_CLIENT_MAX_SECONDS,
  IPERF3_CLIENT_MAX_STREAMS,
  IPERF3_CLIENT_UDP_MAX_MBPS,
  IPERF3_CLIENT_MIN_SECONDS,
  normalizeIperf3ClientOptions,
  type LookingGlassTaskStatus,
} from "../lookingGlassAgentTasks";
import {
  AUTO_IPERF3_SERVER_PORT,
  enqueueIperf3AgentTask,
  getIperf3Status,
  hasActiveIperf3Task,
  type Iperf3Status,
} from "../iperf3AgentTasks";
import { requireHostAccess, requireHostsAccess } from "./helpers";
import * as tunnelRepo from "../repositories/tunnelRepository";
import { getSegmentSpeedRun, startSegmentSpeedRun } from "../lineSegmentSpeed";
import { planPairSegments, type LineSegmentNode } from "../../shared/lineDiagnostics";
import { getHostEntryAddress } from "../../shared/hostEntryAddress";
import { isTunnelRelayAggregate, isTunnelRelayFailover } from "../../shared/tunnelRelay";
import { normalizeProbeAddressFamily, PROBE_ADDRESS_FAMILIES, probeFamilyNumber, type ProbeAddressFamily } from "../../shared/probeFamily";

/*
  iperf3 对拉（2.3.505）：选一条隧道（按它经过的机器拆段）或者两台机器，一段一段：下游开服务端、上游测正向 /
  反向 / 单条连接，测完关掉。跑法在 server/lineSegmentSpeed.ts，和线路组的「逐段测带宽」同一套。
*/
const PAIR_SECONDS = [5, 10, 20, 30] as const;
const PAIR_STREAMS = [1, 2, 4, 8, 16] as const;

/** 能对拉的隧道：自己的（管理员是全部），带跳点（入口、中转…、出口）和中转是不是并排的。 */
async function pairTunnels(ctx: { user: { id: number; role: string } }) {
  const tunnels = (await tunnelRepo.getTunnels(ctx.user.role === "admin" ? undefined : Number(ctx.user.id))) as any[];
  const hops = (await tunnelRepo.getTunnelHopsByTunnelIds(tunnels.map((tunnel) => Number(tunnel.id)))) as any[];
  return tunnels.map((tunnel) => {
    const own = hops.filter((hop) => Number(hop.tunnelId) === Number(tunnel.id));
    const hostIds = own.length >= 2
      ? own.map((hop) => Number(hop.hostId)).filter((id) => id > 0)
      : [Number(tunnel.entryHostId), Number(tunnel.exitHostId)].filter((id) => id > 0);
    return {
      id: Number(tunnel.id),
      name: String(tunnel.name || `隧道 ${tunnel.id}`),
      hostIds,
      parallelRelays: isTunnelRelayAggregate(tunnel, own) || isTunnelRelayFailover(tunnel, own),
    };
  }).filter((tunnel) => tunnel.hostIds.length >= 2);
}

const methodSchema = z.enum(["ping", "ping6", "traceroute", "traceroute6", "mtr", "mtr6", "tcp", "iperf3-client"]);

type LookingGlassMethod = z.infer<typeof methodSchema>;

async function assertNetworkTestAllowed(ctx: { user: { role: string } }) {
  if (ctx.user.role === "admin") return;
  const userEnabled = (await db.getSetting("lookingGlassUserEnabled")) !== "false";
  if (!userEnabled) {
    throw new TRPCError({ code: "FORBIDDEN", message: "管理员已关闭普通用户使用网络测试" });
  }
}

function getRequestIp(req: any) {
  const headerIp =
    String(req.headers?.["cf-connecting-ip"] || "").trim() ||
    String(req.headers?.["x-real-ip"] || "").trim() ||
    String(req.headers?.["x-forwarded-for"] || "").split(",")[0]?.trim();
  const raw = headerIp || String(req.ip || req.socket?.remoteAddress || "").trim() || "unknown";
  return raw.replace(/^::ffff:/, "");
}

function normalizeTarget(target: string) {
  const value = target.trim();
  if (!value || value.length > 253) throw new Error("请输入有效的目标地址");
  if (/[\s'"`<>|;&$\\]/.test(value)) throw new Error("目标地址包含不支持的字符");
  return value.replace(/^\[|\]$/g, "");
}

/** 认不出来的一律当内网拦下 —— 网络测试是拿用户的 Agent 主机去发包的。 */
function isPrivateAddress(address: string) {
  return isPrivateOrReservedAddress(address);
}

/**
 * 把目标解析成公网地址。TCPing 可以指定地址族（requestedFamily）：域名只取这一族的地址，
 * 没有就直接报错 —— 「仅 IPv6」却悄悄测了 IPv4，结果就是错的。目标是 IP 时地址族由地址决定。
 * 地址是面板解析好了下发的，所以老 Agent 也照样按这个地址族测。
 */
export async function resolvePublicTarget(target: string, method: LookingGlassMethod, requestedFamily: ProbeAddressFamily = "auto") {
  const tcpFamily = method === "tcp" ? probeFamilyNumber(normalizeProbeAddressFamily(requestedFamily, target)) : 0;
  const family = method.endsWith("6") ? 6 : method === "tcp" ? tcpFamily : method === "iperf3-client" ? 0 : 4;
  const literalFamily = net.isIP(target);
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = literalFamily
      ? [{ address: target, family: literalFamily }]
      : await dns.promises.lookup(target, { all: true, family, verbatim: true });
  } catch (error: any) {
    if (method.endsWith("6") || family === 6) {
      throw new Error(`目标 ${target} 没有可用 IPv6 地址，无法执行 IPv6 网络测试`);
    }
    if (family === 4) {
      throw new Error(`目标 ${target} 没有可用 IPv4 地址，无法执行 IPv4 网络测试`);
    }
    throw new Error(`目标 ${target} 无法解析：${error?.message || "DNS 查询失败"}`);
  }

  if (family !== 0 && !literalFamily) resolved = resolved.filter((entry) => entry.family === family);
  if (resolved.length === 0) throw new Error(family === 0 ? "目标无法解析" : `目标没有可用的 IPv${family} 地址`);
  const invalid = resolved.find((entry) => isPrivateAddress(entry.address));
  if (invalid) throw new Error(`目标解析到内网或保留地址，已拒绝执行：${invalid.address}`);

  const preferred = resolved.find((entry) => family === 0 || entry.family === family) || resolved[0];
  return {
    host: target,
    address: preferred.address,
    family: preferred.family,
    addresses: resolved.map((entry) => entry.address),
  };
}

function normalizeAgentPublicAddress(host: any) {
  const raw = String(host?.ipv4 || host?.ipv6 || host?.ip || host?.entryIp || "").trim();
  if (!raw || raw.toLowerCase() === "unknown") {
    throw new Error("该主机缺少可用于 iperf3 测试的公网地址");
  }

  let value = raw.replace(/^https?:\/\//i, "");
  value = value.split(/[/?#]/)[0].trim();
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  } else if (!net.isIP(value) && value.includes(":")) {
    value = value.split(":")[0];
  }
  if (!value || value.toLowerCase() === "unknown") {
    throw new Error("该主机缺少可用于 iperf3 测试的公网地址");
  }
  return value;
}

function hostHasIpv6(host: any) {
  const candidates = [host?.ipv6, host?.ip, host?.entryIp, host?.tunnelEntryIp]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates.some((value) => {
    let normalized = value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].trim();
    if (normalized.startsWith("[") && normalized.includes("]")) {
      normalized = normalized.slice(1, normalized.indexOf("]"));
    }
    return net.isIP(normalized) === 6;
  });
}

function decorateStatus(status: LookingGlassTaskStatus, host: any) {
  return {
    ...status,
    sourceHostId: Number(host.id),
    sourceHostName: String(host.name || `Host #${host.id}`),
  };
}

function decorateIperf3Status(status: Iperf3Status, host: any) {
  const address = normalizeAgentPublicAddress(host);
  const port = Number(status.port || AUTO_IPERF3_SERVER_PORT);
  const hasPort = port > 0;
  return {
    ...status,
    port,
    hostId: Number(host.id),
    hostName: String(host.name || `Host #${host.id}`),
    hostAddress: address,
    commands: {
      upload: hasPort ? `iperf3 -c ${address} -p ${port}` : "",
      download: hasPort ? `iperf3 -c ${address} -p ${port} -R` : "",
    },
  };
}

export const lookingGlassRouter = router({
  hosts: protectedProcedure.query(async ({ ctx }) => {
    await assertNetworkTestAllowed(ctx);
    if (ctx.user.role === "admin") return db.getHostOptions();
    const allowedHostIds = await db.getUserEffectiveAllowedHostIds(ctx.user.id);
    return db.getHostOptions(ctx.user.id, allowedHostIds, ctx.user.id);
  }),

  clientInfo: protectedProcedure.query(({ ctx }) => {
    return { ip: getRequestIp(ctx.req) };
  }),

  start: protectedProcedure
    .input(z.object({
      method: methodSchema,
      target: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).optional(),
      hostId: z.number().int().positive(),
      // TCPing 专用：目标是域名时只用这一族的地址（auto 照旧）。其他方法忽略。
      family: z.enum(PROBE_ADDRESS_FAMILIES).optional(),
      // iperf3 客户端专用；其他方法忽略。
      reverse: z.boolean().optional(),
      streams: z.number().int().min(1).max(IPERF3_CLIENT_MAX_STREAMS).optional(),
      seconds: z.number().int().min(IPERF3_CLIENT_MIN_SECONDS).max(IPERF3_CLIENT_MAX_SECONDS).optional(),
      udp: z.boolean().optional(),
      udpMbps: z.number().int().min(0).max(IPERF3_CLIENT_UDP_MAX_MBPS).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);

      const method = input.method;
      const target = normalizeTarget(input.target);
      const host = await requireHostAccess(ctx, input.hostId);
      if (hasActiveIperf3Task(input.hostId)) {
        throw new Error("该测试主机已有 iperf3 服务端测试正在执行，请停止或等待结束后再开始新的网络测试");
      }
      if (method.endsWith("6") && !hostHasIpv6(host)) {
        throw new Error(`测试主机「${(host as any).name || `Host #${input.hostId}`}」未检测到 IPv6 地址，无法执行 ${methodMetaLabel(method)} 测试`);
      }
      const tcpFamily = method === "tcp" ? normalizeProbeAddressFamily(input.family, target) : "auto";
      if (tcpFamily === "ipv6" && !hostHasIpv6(host)) {
        throw new Error(`测试主机「${(host as any).name || `Host #${input.hostId}`}」未检测到 IPv6 地址，无法执行 IPv6 TCPing`);
      }
      const resolved = await resolvePublicTarget(target, method, tcpFamily);
      /*
        iperf3 客户端：从这台 Agent 往目标上的 iperf3 服务端跑一次带宽测试。
        对端通常就是面板里另一台主机上一键开的 iperf3 服务端（默认端口同
        AUTO_IPERF3_SERVER_PORT）。它跑满 seconds 秒才出结果，时限单独算。
      */
      const iperf3 = method === "iperf3-client" ? normalizeIperf3ClientOptions(input) : null;
      const { task, status } = enqueueLookingGlassAgentTask(input.hostId, {
        method,
        target,
        resolvedAddress: resolved.address,
        resolvedAddresses: resolved.addresses,
        family: resolved.family,
        ...(method === "tcp" ? { port: input.port || 443 } : {}),
        ...(iperf3
          ? {
            port: input.port || AUTO_IPERF3_SERVER_PORT,
            reverse: iperf3.reverse,
            streams: iperf3.streams,
            seconds: iperf3.seconds,
            ...(iperf3.udp ? { udp: true, udpMbps: iperf3.udpMbps } : {}),
          }
          : {}),
      }, iperf3 ? iperf3.timeoutMs : undefined);
      pushAgentRefresh(input.hostId, "looking-glass");
      return decorateStatus({ ...status, taskId: task.taskId }, host);
    }),

  status: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      taskId: z.string().min(8).max(128),
    }))
    .query(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId);
      const status = getLookingGlassAgentTaskStatus(input.hostId, input.taskId);
      if (!status) {
        throw new TRPCError({ code: "NOT_FOUND", message: "网络测试任务不存在或已过期" });
      }
      return decorateStatus(status, host);
    }),

  /** 对拉能选的隧道（按经过的机器）。机器列表用 hosts。 */
  pairSpeedTunnels: protectedProcedure.query(async ({ ctx }) => {
    await assertNetworkTestAllowed(ctx);
    return pairTunnels(ctx);
  }),

  /** 开一轮 iperf3 对拉：tunnelId 和 fromHostId / toHostId 二选一。立刻返回进度，之后用 pairSpeedStatus 轮询。 */
  pairSpeedStart: protectedProcedure
    .input(z.object({
      tunnelId: z.number().int().positive().optional(),
      fromHostId: z.number().int().positive().optional(),
      toHostId: z.number().int().positive().optional(),
      seconds: z.number().int().refine((value) => (PAIR_SECONDS as readonly number[]).includes(value)).default(10),
      streams: z.number().int().refine((value) => (PAIR_STREAMS as readonly number[]).includes(value)).default(4),
      single: z.boolean().default(true),
    }).refine((value) => !!value.tunnelId !== !!(value.fromHostId && value.toHostId), { message: "选一条隧道，或者选两台机器" }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      let hopIds: number[];
      let parallelRelays = false;
      let title: string;
      let lockKey: string;
      if (input.tunnelId) {
        const tunnel = (await pairTunnels(ctx)).find((item) => item.id === input.tunnelId);
        if (!tunnel) throw new TRPCError({ code: "NOT_FOUND", message: "隧道不存在或不是你的" });
        hopIds = tunnel.hostIds;
        parallelRelays = tunnel.parallelRelays;
        title = `隧道 ${tunnel.name}`;
        lockKey = `tunnel:${tunnel.id}`;
      } else {
        if (input.fromHostId === input.toHostId) throw new Error("两头要选两台不同的机器");
        hopIds = [Number(input.fromHostId), Number(input.toHostId)];
        lockKey = `pair:${hopIds.join("-")}`;
        title = "";
      }
      const hosts = await requireHostsAccess(ctx, Array.from(new Set(hopIds))) as any[];
      const hostById = new Map<number, any>(hosts.map((host) => [Number(host.id), host]));
      const node = (hostId: number): LineSegmentNode => ({ hostId, name: String(hostById.get(hostId)?.name || `主机 ${hostId}`) });
      if (!title) title = `${node(hopIds[0]).name} → ${node(hopIds[1]).name}`;
      const plan = planPairSegments({ hops: hopIds.map(node), parallelRelays });
      for (const hostId of new Set(hopIds)) {
        const host = hostById.get(hostId);
        if (!String(host?.agentToken || "")) throw new Error(`「${host?.name || `主机 ${hostId}`}」没有绑定 Agent，没法在它上面跑 iperf3`);
      }
      const endpoints = plan.map((segment) => (segment.skipReason || segment.from.hostId === null || segment.to.hostId === null
        ? null
        : { fromHostId: segment.from.hostId, toHostId: segment.to.hostId, toAddress: getHostEntryAddress(hostById.get(segment.to.hostId)) }));
      return startSegmentSpeedRun({
        lockKey,
        title,
        userId: Number(ctx.user.id),
        allowPrivate: ctx.user.role === "admin",
        plan,
        endpoints,
        options: { seconds: input.seconds, streams: input.streams, single: input.single },
      }).view;
    }),

  pairSpeedStatus: protectedProcedure
    .input(z.object({ runId: z.string().min(8).max(64) }))
    .query(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const run = getSegmentSpeedRun(input.runId, ctx.user);
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "对拉任务不存在或已过期" });
      return run;
    }),

  iperf3Start: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      port: z.number().int().min(1).max(65535).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId) as any;
      if (!String(host?.agentToken || "")) throw new Error("该主机未绑定 Agent，无法启动 iperf3 服务端");
      if (hasActiveLookingGlassTask(input.hostId)) {
        throw new Error("该测试主机已有网络测试正在执行，请等待完成后再启动 iperf3 服务端");
      }
      normalizeAgentPublicAddress(host);
      const { status } = enqueueIperf3AgentTask(input.hostId, {
        op: "start",
        port: input.port,
      });
      pushAgentRefresh(input.hostId, "iperf3-start");
      return decorateIperf3Status(status, host);
    }),

  iperf3Stop: protectedProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId) as any;
      if (!String(host?.agentToken || "")) throw new Error("该主机未绑定 Agent，无法停止 iperf3 服务端");
      const current = getIperf3Status(input.hostId);
      const { status } = enqueueIperf3AgentTask(input.hostId, {
        op: "stop",
        port: current.port || AUTO_IPERF3_SERVER_PORT,
      });
      pushAgentRefresh(input.hostId, "iperf3-stop");
      return decorateIperf3Status(status, host);
    }),

  iperf3Status: protectedProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId) as any;
      return decorateIperf3Status(getIperf3Status(input.hostId), host);
    }),
});

function methodMetaLabel(method: LookingGlassMethod) {
  if (method === "ping6") return "Ping IPv6";
  if (method === "traceroute6") return "Traceroute IPv6";
  if (method === "mtr6") return "MTR IPv6";
  if (method === "iperf3-client") return "iperf3 客户端";
  return method;
}
