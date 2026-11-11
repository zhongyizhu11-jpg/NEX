/*
  网络拓扑手动标注的存取（表见 server/ops/topologyManualTables.ts，合并进图见 shared/topologyManual.ts）。
  每个账号只读写自己的那几行；所有写操作都只动这两张表，不碰任何转发配置。
*/
import {
  formatTopologyManualRef,
  parseTopologyManualRef,
  TOPOLOGY_MANUAL_LIMITS,
  type TopologyManualLinkRow,
  type TopologyManualNodeRow,
} from "../shared/topologyManual";
import { executeRaw, insertAndGetId, queryRaw, quoteDbIdentifier, rawAffectedRows } from "./dbRuntime";

const q = quoteDbIdentifier;
const NODES = "topology_manual_nodes";
const LINKS = "topology_manual_links";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clean(value: unknown, max: number) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function cleanCountry(value: unknown) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export class TopologyManualError extends Error {}

export async function listTopologyManual(userId: number): Promise<{ nodes: TopologyManualNodeRow[]; links: TopologyManualLinkRow[] }> {
  const [nodes, links] = await Promise.all([
    queryRaw<any>(`SELECT ${q("id")}, ${q("label")}, ${q("note")}, ${q("country")} FROM ${q(NODES)} WHERE ${q("userId")} = ? ORDER BY ${q("id")} ASC`, [userId]).catch(() => []),
    queryRaw<any>(`SELECT ${q("id")}, ${q("fromRef")}, ${q("toRef")}, ${q("label")}, ${q("note")} FROM ${q(LINKS)} WHERE ${q("userId")} = ? ORDER BY ${q("id")} ASC`, [userId]).catch(() => []),
  ]);
  return {
    nodes: nodes.map((row) => ({ id: Number(row.id), label: String(row.label || ""), note: row.note ? String(row.note) : null, country: cleanCountry(row.country) })),
    links: links.map((row) => ({ id: Number(row.id), fromRef: String(row.fromRef || ""), toRef: String(row.toRef || ""), label: row.label ? String(row.label) : null, note: row.note ? String(row.note) : null })),
  };
}

async function countRows(table: string, userId: number) {
  const rows = await queryRaw<any>(`SELECT COUNT(*) AS ${q("count")} FROM ${q(table)} WHERE ${q("userId")} = ?`, [userId]);
  return Number(rows[0]?.count) || 0;
}

export type TopologyManualNodeInput = { label: string; note?: string | null; country?: string | null };

export async function createTopologyManualNode(userId: number, input: TopologyManualNodeInput) {
  const label = clean(input.label, TOPOLOGY_MANUAL_LIMITS.label);
  if (!label) throw new TopologyManualError("请填写节点名称");
  if (await countRows(NODES, userId) >= TOPOLOGY_MANUAL_LIMITS.nodes) throw new TopologyManualError(`最多标注 ${TOPOLOGY_MANUAL_LIMITS.nodes} 个外部节点`);
  const now = nowSec();
  return insertAndGetId(NODES, { userId, label, note: clean(input.note, TOPOLOGY_MANUAL_LIMITS.note), country: cleanCountry(input.country), createdAt: now, updatedAt: now });
}

export async function updateTopologyManualNode(userId: number, id: number, input: TopologyManualNodeInput) {
  const label = clean(input.label, TOPOLOGY_MANUAL_LIMITS.label);
  if (!label) throw new TopologyManualError("请填写节点名称");
  const affected = rawAffectedRows(await executeRaw(
    `UPDATE ${q(NODES)} SET ${q("label")} = ?, ${q("note")} = ?, ${q("country")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ? AND ${q("userId")} = ?`,
    [label, clean(input.note, TOPOLOGY_MANUAL_LIMITS.note), cleanCountry(input.country), nowSec(), id, userId],
  ));
  if (affected === 0) throw new TopologyManualError("节点不存在");
}

/** 删节点时连着它的线一起删。 */
export async function deleteTopologyManualNode(userId: number, id: number) {
  const ref = `manual:${id}`;
  await executeRaw(`DELETE FROM ${q(LINKS)} WHERE ${q("userId")} = ? AND (${q("fromRef")} = ? OR ${q("toRef")} = ?)`, [userId, ref, ref]);
  const affected = rawAffectedRows(await executeRaw(`DELETE FROM ${q(NODES)} WHERE ${q("id")} = ? AND ${q("userId")} = ?`, [id, userId]));
  if (affected === 0) throw new TopologyManualError("节点不存在");
}

export type TopologyManualLinkInput = { fromRef: string; toRef: string; label?: string | null; note?: string | null };

/**
 * 加一条线。两头至少一头是自己画的外部节点（不然就是在两台主机之间画假线，拓扑上会和真的转发混在一起）；
 * 主机那头由调用方检查过访问权限（canUseHost）。
 */
export async function createTopologyManualLink(userId: number, input: TopologyManualLinkInput, canUseHost: (hostId: number) => Promise<boolean>) {
  const from = parseTopologyManualRef(input.fromRef);
  const to = parseTopologyManualRef(input.toRef);
  if (!from || !to) throw new TopologyManualError("连线的端点无效");
  if (formatTopologyManualRef(from) === formatTopologyManualRef(to)) throw new TopologyManualError("两头不能是同一个节点");
  if (from.type !== "manual" && to.type !== "manual") throw new TopologyManualError("至少一头要是手动标注的外部节点");
  const own = new Set((await listTopologyManual(userId)).nodes.map((node) => node.id));
  for (const ref of [from, to]) {
    if (ref.type === "manual" && !own.has(ref.id)) throw new TopologyManualError("外部节点不存在");
    if (ref.type === "host" && !(await canUseHost(ref.id))) throw new TopologyManualError("主机不存在或无权使用");
  }
  if (await countRows(LINKS, userId) >= TOPOLOGY_MANUAL_LIMITS.links) throw new TopologyManualError(`最多标注 ${TOPOLOGY_MANUAL_LIMITS.links} 条连线`);
  const now = nowSec();
  return insertAndGetId(LINKS, {
    userId,
    fromRef: formatTopologyManualRef(from),
    toRef: formatTopologyManualRef(to),
    label: clean(input.label, TOPOLOGY_MANUAL_LIMITS.label),
    note: clean(input.note, TOPOLOGY_MANUAL_LIMITS.note),
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteTopologyManualLink(userId: number, id: number) {
  const affected = rawAffectedRows(await executeRaw(`DELETE FROM ${q(LINKS)} WHERE ${q("id")} = ? AND ${q("userId")} = ?`, [id, userId]));
  if (affected === 0) throw new TopologyManualError("连线不存在");
}

/** 删用户时一起删（server/repositories/userRepository 的删除流程调用；表缺了不拦）。 */
export async function deleteTopologyManualForUser(userId: number) {
  await executeRaw(`DELETE FROM ${q(LINKS)} WHERE ${q("userId")} = ?`, [userId]).catch(() => undefined);
  await executeRaw(`DELETE FROM ${q(NODES)} WHERE ${q("userId")} = ?`, [userId]).catch(() => undefined);
}
