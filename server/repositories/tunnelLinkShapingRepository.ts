import { and, eq, inArray } from "drizzle-orm";
import { tunnelLinkShaping, type TunnelLinkShaping } from "../../drizzle/schema";
import { getDb, nowDate } from "../dbRuntime";

/*
  FXP 报上来的链路整形状态（forwardx-fxp/link_shaper.go）：每条隧道、每台成员主机、
  每个方向一行。自动模式学到的限速点也在这里，心跳下发配置时作为提示值还给 FXP，
  换机器、重装都不用重学。
*/

export type TunnelLinkShapingReport = {
  direction: string;
  mode: string;
  state: string;
  rateMbps: number;
  learnedMbps: number;
  lossPct: number;
};

const LINK_SHAPING_DIRECTIONS = new Set(["up", "down"]);
const LINK_SHAPING_MODES = new Set(["auto", "manual", "off"]);
const LINK_SHAPING_STATES = new Set(["off", "watching", "shaping", "paused"]);
const LINK_MBPS_MAX = 1_000_000;

function clampMbps(value: unknown) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(LINK_MBPS_MAX, parsed);
}

/** 把一份上报收敛到合法值；方向不认识的丢掉。 */
export function normalizeTunnelLinkShapingReport(input: any): TunnelLinkShapingReport | null {
  const direction = String(input?.direction || "").trim().toLowerCase();
  if (!LINK_SHAPING_DIRECTIONS.has(direction)) return null;
  const mode = String(input?.mode || "").trim().toLowerCase();
  const state = String(input?.state || "").trim().toLowerCase();
  const loss = Number(input?.lossPct);
  return {
    direction,
    mode: LINK_SHAPING_MODES.has(mode) ? mode : "off",
    state: LINK_SHAPING_STATES.has(state) ? state : "off",
    rateMbps: clampMbps(input?.rateMbps),
    learnedMbps: clampMbps(input?.learnedMbps),
    lossPct: Number.isFinite(loss) && loss > 0 ? Math.min(100, loss) : 0,
  };
}

export async function recordTunnelLinkShaping(tunnelId: number, hostId: number, role: string, reports: TunnelLinkShapingReport[]) {
  const db = await getDb();
  if (!db) return 0;
  const safeRole = ["entry", "exit", "relay"].includes(role) ? role : "entry";
  let saved = 0;
  for (const report of reports) {
    const values = {
      role: safeRole,
      mode: report.mode,
      state: report.state,
      rateMbps: report.rateMbps,
      learnedMbps: report.learnedMbps,
      lossPermille: Math.round(report.lossPct * 10),
      updatedAt: nowDate(),
    };
    const existing = await db
      .select({ id: tunnelLinkShaping.id })
      .from(tunnelLinkShaping)
      .where(and(eq(tunnelLinkShaping.tunnelId, tunnelId), eq(tunnelLinkShaping.hostId, hostId), eq(tunnelLinkShaping.direction, report.direction)))
      .limit(1);
    if (existing.length > 0) {
      await db.update(tunnelLinkShaping).set(values).where(eq(tunnelLinkShaping.id, Number(existing[0].id)));
    } else {
      await db.insert(tunnelLinkShaping).values({ tunnelId, hostId, direction: report.direction, ...values });
    }
    saved += 1;
  }
  return saved;
}

export async function listTunnelLinkShapingByTunnelIds(tunnelIds: number[]): Promise<TunnelLinkShaping[]> {
  const ids = Array.from(new Set(tunnelIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)));
  if (ids.length === 0) return [];
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tunnelLinkShaping).where(inArray(tunnelLinkShaping.tunnelId, ids)) as Promise<TunnelLinkShaping[]>;
}

export async function listTunnelLinkShapingByHost(hostId: number): Promise<TunnelLinkShaping[]> {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tunnelLinkShaping).where(eq(tunnelLinkShaping.hostId, id)) as Promise<TunnelLinkShaping[]>;
}

/** 自动模式的提示值：这台主机上每条隧道两个方向学到的限速点。 */
export async function tunnelLinkShapingHintsByHost(hostId: number) {
  const hints = new Map<number, { up: number; down: number }>();
  for (const row of await listTunnelLinkShapingByHost(hostId)) {
    const learned = clampMbps((row as any).learnedMbps);
    if (learned <= 0) continue;
    const tunnelId = Number((row as any).tunnelId);
    const current = hints.get(tunnelId) || { up: 0, down: 0 };
    if ((row as any).direction === "up") current.up = learned;
    if ((row as any).direction === "down") current.down = learned;
    hints.set(tunnelId, current);
  }
  return hints;
}

export async function deleteTunnelLinkShapingByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(tunnelLinkShaping).where(eq(tunnelLinkShaping.tunnelId, Number(tunnelId)));
}
