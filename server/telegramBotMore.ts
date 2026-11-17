import * as db from "./db";
import { formatBytes } from "../shared/formatBytes";
import { escapeHtmlText as escapeHtml } from "../shared/htmlEscape";
import { runAsNestedProcedureCall } from "./_core/trpc";
import type { TrpcContext } from "./_core/context";

/*
  Telegram 机器人加的功能（2.3.538，用户：「把 TG 的操作功能多一点和权限弄大一点」）：

    🔗 链路       每条链路的出口在用 / 备用、到目标的延迟，「切到这条 / 交回自动」，管理员调出口顺序
    ⚙️ 规则       详情里多「改目标 / 改名 / 重启 / 删除」
    🖥 主机       维护模式开关、停用 / 启用这台上的全部规则，管理员一键升级所有过期 Agent
    👥 用户       加流量、调余额、换套餐、封禁 / 解封
    🛠 系统       开放注册、维护模式、商店开关、今天的收入和订单；生成兑换码 / 折扣码、发公告、重启全部 Agent
    ➕ 加主机     回复「名字 IP」就加好，直接给安装命令（普通用户按面板的自助上限）
    💳 续费       普通用户用余额续费 / 买套餐

  会断转发、动钱、影响所有人的操作（删除、封禁、停用全部、重启全部、开维护）都要再点一次确认。

  每个操作都通过面板自己的接口（appRouter.createCaller，身份是绑定的那个账户）去做：权限、校验、审计和在
  面板上点按钮完全一样 —— 普通用户能做的就是面板上他能做的，管理员才有的照旧只有管理员能做。

  回调数据都以 fx:x: 开头（Telegram 限 64 字节，写得短）。要用户打字回复的（新目标、新名字、余额）记一个
  5 分钟的「等回复」，下一条消息就当作回复。
*/

type Button = { text: string; callback_data?: string; url?: string };
type Keyboard = { inline_keyboard: Button[][] };
export type TelegramMoreIO = {
  edit: (text: string, keyboard?: Keyboard) => Promise<unknown>;
  send: (text: string, keyboard?: Keyboard) => Promise<unknown>;
};

const MENU_ROW: Button[] = [{ text: "🏠 返回菜单", callback_data: "fx:menu" }];
const PAGE_SIZE = 8;
const PENDING_TTL_MS = 5 * 60_000;

// 这里只读这几个字段：给个宽松的形状，比 any 清楚
type BotUser = { id: number | string; role?: string | null };
type TunnelRow = {
  id: number;
  name?: string | null;
  userId?: number | null;
  exitHostId?: number | null;
  exitGroupId?: number | null;
  balancePinHostId?: number | null;
  isEnabled?: unknown;
  isRunning?: unknown;
  loadBalanceExits?: Array<{ hostId?: number | null }> | null;
};
type HostRow = { id: number; name?: string | null; ip?: string | null; isOnline?: unknown; agentVersion?: string | null; userId?: number | null; maintenanceMode?: unknown };
type ExitStat = { hostId: number; rules: number; down: number; unstable: number; medianMs: number | null; jitterMs: number | null; slowerMs?: number | null; activeRules: number };
type ExitSummary = { how?: string | null; exits?: ExitStat[]; targetIssues?: unknown[] } | null;
type RuleRow = { id: number; name?: string | null; targetIp?: string | null; targetPort?: number | null; hostId?: number | null; isEnabled?: unknown; isForwardGroupTemplate?: unknown };
type PlanRow = { id: number; name: string; priceCents?: number | null; durationDays?: number | null; isActive?: unknown };
type SubRow = { id: number; planId: number; status?: string | null; expiresAt?: string | Date | null };
type MemberRow = { id: number; hostId?: number | null; memberType?: string | null; priority?: number | null; isEnabled?: unknown };
type UserRow = { id: number; accountEnabled?: unknown };

// ---------------------------------------------------------------- 调面板接口

async function callerFor(user: BotUser) {
  const { appRouter } = await import("./routers");
  const ctx = {
    req: {
      headers: { "x-request-id": `telegram-${Date.now()}`, "user-agent": "telegram-bot" },
      ip: "telegram",
      socket: { remoteAddress: "telegram" },
      originalUrl: "/telegram",
      protocol: "http",
    } as unknown as TrpcContext["req"],
    res: { clearCookie() {}, setHeader() {}, cookie() {} } as unknown as TrpcContext["res"],
    user: user as unknown as TrpcContext["user"],
    authSession: null,
    authFailureReason: null,
    apiToken: null,
    impersonation: null,
  } as TrpcContext;
  return appRouter.createCaller(ctx);
}

type Caller = Awaited<ReturnType<typeof callerFor>>;

async function call<T>(user: BotUser, fn: (caller: Caller) => Promise<T>): Promise<T> {
  const caller = await callerFor(user);
  return runAsNestedProcedureCall(() => fn(caller));
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `操作没成功：${escapeHtml(message || "未知错误")}`;
}

const isAdmin = (user: BotUser | null | undefined) => String(user?.role) === "admin";
const short = (value: unknown, length = 16) => {
  const text = String(value ?? "-");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};
const yuan = (cents: unknown) => `¥${((Number(cents) || 0) / 100).toFixed(2)}`;

// ---------------------------------------------------------------- 等回复

type PendingInput =
  | { kind: "rule_target"; ruleId: number; page: number }
  | { kind: "rule_name"; ruleId: number; page: number }
  | { kind: "user_balance"; userId: number; page: number }
  | { kind: "code_balance" }
  | { kind: "announce" }
  | { kind: "host_add" };

// 公告先存草稿，确认后再发（发出去所有人都能看到）
const announceDrafts = new Map<string, { title: string; content: string; expiresAt: number }>();

const pendingInputs = new Map<string, { input: PendingInput; expiresAt: number }>();
const pendingKey = (chatId: number | string, telegramId: number | string) => `${chatId}:${telegramId}`;

function startPending(chatId: number | string, telegramId: number | string, input: PendingInput) {
  pendingInputs.set(pendingKey(chatId, telegramId), { input, expiresAt: Date.now() + PENDING_TTL_MS });
}

export function clearTelegramMorePending(chatId: number | string, telegramId: number | string) {
  pendingInputs.delete(pendingKey(chatId, telegramId));
}

/** 有在等的回复就处理掉，返回 true；没有返回 false（交给原来的流程）。 */
export async function handleTelegramMoreReply(input: {
  chatId: number | string;
  telegramId: number | string;
  user: BotUser;
  text: string;
  io: TelegramMoreIO;
}): Promise<boolean> {
  const key = pendingKey(input.chatId, input.telegramId);
  const pending = pendingInputs.get(key);
  if (!pending) return false;
  pendingInputs.delete(key);
  if (pending.expiresAt < Date.now()) return false;
  const text = input.text.trim();
  if (text.startsWith("/")) return false;
  const item = pending.input;
  try {
    if (item.kind === "rule_target") {
      const parsed = parseTarget(text);
      if (!parsed) {
        await input.io.send("格式不对，要像 <code>1.2.3.4:443</code> 或 <code>example.com:8080</code>。再点一次「改目标」重来。", ruleBackKeyboard(item.ruleId, item.page));
        return true;
      }
      await call(input.user, (caller) => caller.rules.update({ id: item.ruleId, targetIp: parsed.host, targetPort: parsed.port }));
      await input.io.send(`规则 #${item.ruleId} 的目标改成了 <code>${escapeHtml(text)}</code>，正在重新下发。`, ruleBackKeyboard(item.ruleId, item.page));
      return true;
    }
    if (item.kind === "rule_name") {
      const name = text.slice(0, 128);
      await call(input.user, (caller) => caller.rules.update({ id: item.ruleId, name }));
      await input.io.send(`规则 #${item.ruleId} 改名为「${escapeHtml(name)}」。`, ruleBackKeyboard(item.ruleId, item.page));
      return true;
    }
    if (item.kind === "user_balance") {
      const match = text.replace(/\s+/g, "").replace(/元$/, "").match(/^([+\-=]?)(\d+(?:\.\d{1,2})?)$/);
      if (!match) {
        await input.io.send("格式不对：发 <code>+50</code> 加 50 元、<code>-20</code> 扣 20 元、<code>=100</code> 设成 100 元。", userBackKeyboard(item.userId, item.page));
        return true;
      }
      const cents = Math.round(Number(match[2]) * 100);
      const current = Number(await db.getUserBalance(item.userId)) || 0;
      const next = match[1] === "=" ? cents : match[1] === "-" ? current - cents : match[1] === "+" || match[1] === "" ? current + cents : current;
      if (next < 0) {
        await input.io.send(`余额不够扣：现在 ${yuan(current)}。`, userBackKeyboard(item.userId, item.page));
        return true;
      }
      if (match[1] === "+" || match[1] === "") {
        await call(input.user, (caller) => caller.billing.adminRecharge({ userId: item.userId, amountCents: cents, description: "Telegram 充值" }));
      } else {
        await call(input.user, (caller) => caller.billing.adminSetBalance({ userId: item.userId, balanceCents: next, description: "Telegram 调整余额" }));
      }
      await input.io.send(`用户 #${item.userId} 的余额：${yuan(current)} → <b>${yuan(next)}</b>`, userBackKeyboard(item.userId, item.page));
      return true;
    }
    if (item.kind === "code_balance") {
      const parsed = parseCodeRequest(text);
      if (!parsed) {
        await input.io.send("格式不对：发 <code>50</code> 生成 1 个 50 元的码，<code>50 10</code> 生成 10 个。", SYSTEM_BACK_KEYBOARD);
        return true;
      }
      const result = await call(input.user, (caller) => caller.billing.createRedemptionCodes({ type: "balance", amountCents: parsed.cents, count: parsed.count }));
      await input.io.send(codesText(`${yuan(parsed.cents)} 余额兑换码`, result.codes), CODES_KEYBOARD);
      return true;
    }
    if (item.kind === "announce") {
      const lines = text.split(/\r?\n/).map((line) => line.trim());
      const title = (lines.length > 1 ? lines[0] : text).slice(0, 60);
      const content = (lines.length > 1 ? lines.slice(1).join("\n").trim() : text) || title;
      announceDrafts.set(key, { title, content, expiresAt: Date.now() + PENDING_TTL_MS });
      await input.io.send(`<b>公告预览</b>\n\n<b>${escapeHtml(title)}</b>\n${escapeHtml(content)}\n\n发出去所有用户都能在面板看到。`, {
        inline_keyboard: [
          [{ text: "📢 发布", callback_data: "fx:x:any:0" }, { text: "📢 发布并推送 TG", callback_data: "fx:x:any:1" }],
          [{ text: "❌ 取消", callback_data: "fx:x:sys" }],
        ],
      });
      return true;
    }
    if (item.kind === "host_add") {
      const parsed = parseHostAdd(text);
      if (!parsed) {
        await input.io.send("格式不对：发 <code>名字 IP</code>，比如 <code>香港1 1.2.3.4</code>。", HOSTS_BACK_KEYBOARD);
        return true;
      }
      const created = await call(input.user, (caller) => caller.hosts.create({ name: parsed.name, ip: parsed.ip }));
      const view = await installCommandView(input.user, Number(created.id), 0, `✅ 已添加主机「${escapeHtml(parsed.name)}」（#${Number(created.id)}）。`);
      await input.io.send(view.text, view.keyboard);
      return true;
    }
  } catch (error) {
    await input.io.send(errorText(error), MENU_KEYBOARD);
    return true;
  }
  return false;
}

export function parseTarget(text: string): { host: string; port: number } | null {
  const value = text.trim();
  const bracket = value.match(/^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/);
  const plain = value.match(/^([a-zA-Z0-9][a-zA-Z0-9\-_.]*):(\d{1,5})$/);
  const match = bracket || plain;
  if (!match) return null;
  const port = Number(match[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: match[1], port };
}

/** 「50」→ 1 个 50 元；「50 10」「50x10」「50*10」→ 10 个。 */
export function parseCodeRequest(text: string): { cents: number; count: number } | null {
  const match = text.trim().replace(/元/g, "").match(/^(\d+(?:\.\d{1,2})?)(?:\s*[x×*\s]\s*(\d+)\s*个?)?$/i);
  if (!match) return null;
  const cents = Math.round(Number(match[1]) * 100);
  const count = match[2] ? Number(match[2]) : 1;
  if (!(cents > 0) || !(count >= 1 && count <= 100)) return null;
  return { cents, count };
}

/** 「名字 IP」：最后一段是 IP / 域名，前面都是名字。 */
export function parseHostAdd(text: string): { name: string; ip: string } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const ip = parts.pop() as string;
  const name = parts.join(" ").slice(0, 64);
  if (!/^[0-9a-zA-Z.:\-\[\]]+$/.test(ip) || !name) return null;
  return { name, ip: ip.replace(/^\[|\]$/g, "") };
}

function codesText(title: string, codes: string[]) {
  const list = codes.map((code) => `<code>${escapeHtml(code)}</code>`).join("\n");
  return `<b>✅ 生成了 ${codes.length} 个${escapeHtml(title)}</b>\n\n${list}\n\n点一下码就能复制。`;
}

const MENU_KEYBOARD: Keyboard = { inline_keyboard: [MENU_ROW] };
const SYSTEM_BACK_KEYBOARD: Keyboard = { inline_keyboard: [[{ text: "🛠 返回系统", callback_data: "fx:x:sys" }], MENU_ROW] };
const CODES_KEYBOARD: Keyboard = { inline_keyboard: [[{ text: "🎟 再生成", callback_data: "fx:x:gc" }, { text: "🛠 返回系统", callback_data: "fx:x:sys" }], MENU_ROW] };
const HOSTS_BACK_KEYBOARD: Keyboard = { inline_keyboard: [[{ text: "🖥 返回主机", callback_data: "fx:hosts:0" }], MENU_ROW] };

function ruleBackKeyboard(ruleId: number, page: number): Keyboard {
  return { inline_keyboard: [[{ text: "📄 返回规则详情", callback_data: `fx:rule:view:${ruleId}:${page}` }], MENU_ROW] };
}

function userBackKeyboard(userId: number, page: number): Keyboard {
  return { inline_keyboard: [[{ text: "👤 返回用户详情", callback_data: `fx:admin:user:${userId}:${page}` }], MENU_ROW] };
}

// ---------------------------------------------------------------- 给原来的页面加按钮

/** 规则详情多一组按钮（面板上这条规则能改的，这里就能改）。 */
export function telegramRuleExtraRows(rule: { id?: number | null } | null | undefined, page: number): Button[][] {
  const id = Number(rule?.id || 0);
  if (!id) return [];
  return [
    [
      { text: "✏️ 改目标", callback_data: `fx:x:rt:${id}:${page}` },
      { text: "🏷 改名", callback_data: `fx:x:rn:${id}:${page}` },
    ],
    [
      { text: "🔁 重启", callback_data: `fx:x:rr:${id}:${page}` },
      { text: "🗑 删除", callback_data: `fx:x:rd:${id}:${page}` },
    ],
  ];
}

/** 主机详情多一组按钮：维护模式、这台上的全部规则停 / 启（主人或管理员）。 */
export function telegramHostExtraRows(user: BotUser, host: HostRow | null | undefined, page: number): Button[][] {
  const id = Number(host?.id || 0);
  if (!id || (!isAdmin(user) && Number(host?.userId) !== Number(user?.id))) return [];
  const inMaintenance = host?.maintenanceMode === true || host?.maintenanceMode === 1;
  return [
    [{ text: inMaintenance ? "✅ 退出维护" : "🛠 进入维护", callback_data: `fx:x:hm:${id}:${inMaintenance ? 0 : 1}:${page}` }],
    [
      { text: "⏸ 停用全部规则", callback_data: `fx:x:hr:${id}:0:${page}` },
      { text: "▶️ 启用全部规则", callback_data: `fx:x:hr:${id}:1:${page}` },
    ],
    [{ text: "📋 安装命令", callback_data: `fx:x:hi:${id}:${page}` }],
  ];
}

/** 主机列表底下（管理员）：一键升级所有过期 Agent。 */
export function telegramHostsExtraRows(user: BotUser): Button[][] {
  const rows: Button[][] = [[{ text: "➕ 加主机", callback_data: "fx:x:ah" }]];
  if (isAdmin(user)) rows.push([{ text: "⬆️ 升级全部过期 Agent", callback_data: "fx:x:upall" }]);
  return rows;
}

/** 管理员看用户详情多一组按钮。 */
export function telegramUserExtraRows(target: UserRow | null | undefined, page: number): Button[][] {
  const id = Number(target?.id || 0);
  if (!id) return [];
  const enabled = target?.accountEnabled !== false && target?.accountEnabled !== 0;
  return [
    [
      { text: "➕ 加流量", callback_data: `fx:x:ut:${id}:${page}` },
      { text: "💰 调余额", callback_data: `fx:x:ub:${id}:${page}` },
    ],
    [
      { text: "📦 换套餐", callback_data: `fx:x:up:${id}:${page}` },
      { text: enabled ? "🚫 封禁账号" : "✅ 解封账号", callback_data: `fx:x:ua:${id}:${enabled ? 0 : 1}:${page}` },
    ],
  ];
}

/** 主菜单多的一行。 */
export function telegramMenuExtraRow(user: BotUser): Button[] {
  return isAdmin(user)
    ? [{ text: "🔗 链路", callback_data: "fx:x:links:0" }, { text: "🛠 系统", callback_data: "fx:x:sys" }]
    : [{ text: "🔗 链路", callback_data: "fx:x:links:0" }, { text: "💳 续费", callback_data: "fx:x:buy" }];
}

// ---------------------------------------------------------------- 链路

async function linksView(user: BotUser, page: number): Promise<{ text: string; keyboard: Keyboard }> {
  const tunnels = (await call(user, (caller) => caller.tunnels.list())) as unknown as TunnelRow[];
  const total = tunnels.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const items = tunnels.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const rows: Button[][] = items.map((tunnel) => {
    const exits = 1 + (Array.isArray(tunnel.loadBalanceExits) ? tunnel.loadBalanceExits.length : 0);
    const status = tunnel.isEnabled === false || tunnel.isEnabled === 0 ? "⚪" : tunnel.isRunning === false || tunnel.isRunning === 0 ? "🟠" : "🟢";
    return [{ text: `${status} ${short(tunnel.name, 18)}${exits > 1 ? ` · 出口 ×${exits}` : ""}`, callback_data: `fx:x:link:${tunnel.id}:${safePage}` }];
  });
  const nav: Button[] = [];
  if (safePage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `fx:x:links:${safePage - 1}` });
  if (safePage < pages - 1) nav.push({ text: "下一页 ➡️", callback_data: `fx:x:links:${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push(MENU_ROW);
  return {
    text: total === 0 ? "还没有可用的链路。" : `<b>链路</b> · 共 ${total} 条${pages > 1 ? `（第 ${safePage + 1}/${pages} 页）` : ""}\n\n点一条看出口和切换。`,
    keyboard: { inline_keyboard: rows },
  };
}

async function linkView(user: BotUser, tunnelId: number, page: number, notice = ""): Promise<{ text: string; keyboard: Keyboard }> {
  const back: Keyboard = { inline_keyboard: [[{ text: "🔗 返回链路列表", callback_data: `fx:x:links:${page}` }], MENU_ROW] };
  const tunnels = (await call(user, (caller) => caller.tunnels.list())) as unknown as TunnelRow[];
  const tunnel = tunnels.find((item) => Number(item.id) === tunnelId);
  if (!tunnel) return { text: "链路不存在或无权查看。", keyboard: back };
  const summary = await call(user, (caller) => caller.tunnels.exitTargets({ tunnelId })).catch(() => null) as unknown as ExitSummary;
  const exitIds: number[] = summary?.exits?.length
    ? summary.exits.map((item) => Number(item.hostId))
    : [Number(tunnel.exitHostId || 0), ...(Array.isArray(tunnel.loadBalanceExits) ? tunnel.loadBalanceExits.map((exit) => Number(exit?.hostId || 0)) : [])].filter((id) => id > 0);
  const hosts = (await db.getHostsByIds(exitIds)) as unknown as HostRow[];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const pinHostId = Number(tunnel.balancePinHostId || 0);
  const canPin = exitIds.length > 1 && (isAdmin(user) || Number(tunnel.userId) === Number(user.id));
  const canReorder = exitIds.length > 1 && isAdmin(user) && Number(tunnel.exitGroupId || 0) > 0;
  const lines = [`<b>${escapeHtml(tunnel.name || `链路 #${tunnel.id}`)}</b>`];
  if (notice) lines.push(notice);
  lines.push("");
  if (pinHostId > 0 && exitIds.includes(pinHostId)) lines.push(`📌 手动指定走 ${escapeHtml(hostById.get(pinHostId)?.name || `主机 ${pinHostId}`)}`);
  else if (summary?.how) lines.push(escapeHtml(summary.how));
  lines.push("");
  const statByHost = new Map<number, ExitStat>((summary?.exits || []).map((item) => [Number(item.hostId), item]));
  exitIds.forEach((hostId, index) => {
    const host = hostById.get(hostId);
    const stat = statByHost.get(hostId);
    const online = host && (host.isOnline === true || host.isOnline === 1);
    const tag = pinHostId === hostId ? "使用中 · 指定" : stat ? (stat.activeRules > 0 ? "在用" : stat.rules > 0 ? "备用" : "") : index === 0 ? "主" : "";
    const dot = !online ? "🔴" : (stat?.down ?? 0) > 0 ? "🔴" : (stat?.unstable ?? 0) > 0 || stat?.slowerMs != null ? "🟠" : "🟢";
    const target = !stat || stat.rules === 0 ? ""
      : stat.down > 0 ? "连不上目标"
        : [stat.medianMs != null ? `目标 ${Math.round(stat.medianMs)}ms` : "", stat.jitterMs != null ? `抖动 ${Math.round(stat.jitterMs)}ms` : "", stat.slowerMs != null ? `比平时慢 ${Math.round(stat.slowerMs)}ms` : ""].filter(Boolean).join(" · ");
    lines.push(`${dot} <b>${escapeHtml(host?.name || `主机 ${hostId}`)}</b>${tag ? ` · ${tag}` : ""}${online ? "" : " · 离线"}`);
    if (target) lines.push(`    ${escapeHtml(target)}`);
  });
  const issueCount = summary?.targetIssues?.length ?? 0;
  if (issueCount > 0) lines.push("", `⚠️ ${issueCount} 条规则的目标从每台出口都不通：问题在目标那边`);
  const rows: Button[][] = [];
  if (canPin) {
    const pinRow: Button[] = [];
    for (const hostId of exitIds) {
      if (hostId === pinHostId) continue;
      pinRow.push({ text: `📌 切到 ${short(hostById.get(hostId)?.name || hostId, 10)}`, callback_data: `fx:x:pin:${tunnelId}:${hostId}:${page}` });
      if (pinRow.length === 2) { rows.push([...pinRow]); pinRow.length = 0; }
    }
    if (pinRow.length) rows.push(pinRow);
    if (pinHostId > 0) rows.push([{ text: "🤖 交回自动", callback_data: `fx:x:pin:${tunnelId}:0:${page}` }]);
  }
  if (canReorder) {
    exitIds.forEach((hostId, index) => {
      const row: Button[] = [];
      if (index > 0) row.push({ text: `⬆️ ${short(hostById.get(hostId)?.name || hostId, 10)}`, callback_data: `fx:x:mv:${tunnelId}:${hostId}:u:${page}` });
      if (index < exitIds.length - 1) row.push({ text: `⬇️ ${short(hostById.get(hostId)?.name || hostId, 10)}`, callback_data: `fx:x:mv:${tunnelId}:${hostId}:d:${page}` });
      if (row.length) rows.push(row);
    });
  }
  rows.push([{ text: "🔄 刷新", callback_data: `fx:x:link:${tunnelId}:${page}` }, { text: "🔗 返回列表", callback_data: `fx:x:links:${page}` }]);
  rows.push(MENU_ROW);
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), keyboard: { inline_keyboard: rows } };
}

async function moveExit(user: BotUser, tunnelId: number, hostId: number, direction: "u" | "d") {
  const tunnel = await db.getTunnelById(tunnelId) as unknown as TunnelRow | null;
  const groupId = Number(tunnel?.exitGroupId || 0);
  if (!groupId) throw new Error("这条链路没用出口组，顺序在链路设置里改。");
  const group = await db.getForwardGroupById(groupId) as unknown as { members?: MemberRow[] } | null;
  const all = [...(group?.members || [])].sort((a, b) => Number(a?.priority || 0) - Number(b?.priority || 0));
  const enabledHosts = all.filter((member) => member?.memberType === "host" && member?.isEnabled !== false && member?.isEnabled !== 0);
  const index = enabledHosts.findIndex((member) => Number(member.hostId) === hostId);
  const target = index + (direction === "u" ? -1 : 1);
  if (index < 0 || target < 0 || target >= enabledHosts.length) return;
  const from = all.indexOf(enabledHosts[index]);
  const to = all.indexOf(enabledHosts[target]);
  [all[from], all[to]] = [all[to], all[from]];
  await call(user, (caller) => caller.forwardGroups.reorder({ groupId, memberIds: all.map((member) => Number(member.id)) }));
}

// ---------------------------------------------------------------- 系统（管理员）

async function systemView(user: BotUser, notice = ""): Promise<{ text: string; keyboard: Keyboard }> {
  const registration = (await db.getSetting("registrationEnabled")) !== "false";
  const store = (await db.getSetting("storeEnabled")) === "true";
  const maintenance = await call(user, (caller) => caller.ops.maintenance.get()).catch(() => ({ enabled: false })) as { enabled: boolean };
  const summary = await call(user, (caller) => caller.billing.summary()).catch(() => null) as unknown as Record<string, unknown> | null;
  const lines = ["<b>系统</b>"];
  if (notice) lines.push(notice);
  lines.push(
    "",
    `开放注册：${registration ? "开" : "关"}`,
    `商店：${store ? "开" : "关"}`,
    `维护模式：${maintenance.enabled ? "开（普通用户暂时用不了面板）" : "关"}`,
  );
  if (summary) {
    const pick = (...keys: string[]) => keys.map((key) => summary[key]).find((value) => value !== undefined && value !== null);
    const todayIncome = pick("todayIncomeCents", "todayRevenueCents", "incomeTodayCents");
    const todayOrders = pick("todayOrders", "todayOrderCount", "ordersToday");
    const totalBalance = pick("totalBalanceCents", "balanceTotalCents");
    lines.push("");
    if (todayIncome != null) lines.push(`今天收入：${yuan(todayIncome)}`);
    if (todayOrders != null) lines.push(`今天订单：${Number(todayOrders)} 笔`);
    if (totalBalance != null) lines.push(`用户余额合计：${yuan(totalBalance)}`);
  }
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: registration ? "🔒 关闭开放注册" : "🔓 开启开放注册", callback_data: `fx:x:reg:${registration ? 0 : 1}` }],
        [{ text: store ? "🛒 关闭商店" : "🛒 开启商店", callback_data: `fx:x:store:${store ? 0 : 1}` }],
        [{ text: maintenance.enabled ? "✅ 关闭维护模式" : "🛠 开启维护模式", callback_data: `fx:x:mt:${maintenance.enabled ? 0 : 1}` }],
        [{ text: "🎟 生成兑换码", callback_data: "fx:x:gc" }, { text: "🏷 生成折扣码", callback_data: "fx:x:dc" }],
        [{ text: "📢 发公告", callback_data: "fx:x:an" }, { text: "➕ 加主机", callback_data: "fx:x:ah" }],
        [{ text: "⬆️ 升级过期 Agent", callback_data: "fx:x:upall" }, { text: "🔄 重启全部 Agent", callback_data: "fx:x:ra" }],
        [{ text: "🔄 刷新", callback_data: "fx:x:sys" }],
        MENU_ROW,
      ],
    },
  };
}

const REDEEM_DAYS = [30, 90, 180, 365] as const;

async function codeMenuView(user: BotUser): Promise<{ text: string; keyboard: Keyboard }> {
  const plans = ((await call(user, (caller) => caller.plans.list()).catch(() => [])) as unknown as PlanRow[])
    .filter((plan) => plan.isActive !== false && plan.isActive !== 0);
  const rows: Button[][] = [
    [10, 30, 50, 100].map((amount) => ({ text: `¥${amount}`, callback_data: `fx:x:gcb:${amount * 100}` })),
    [{ text: "✏️ 其他金额 / 一次多个", callback_data: "fx:x:gcc" }],
  ];
  for (const plan of plans.slice(0, 6)) {
    const days = REDEEM_DAYS.find((value) => value === Number(plan.durationDays)) || 30;
    rows.push([{ text: `📦 ${short(plan.name, 14)} · ${days} 天`, callback_data: `fx:x:gcp:${plan.id}:${days}` }]);
  }
  rows.push([{ text: "🛠 返回系统", callback_data: "fx:x:sys" }]);
  return {
    text: "<b>生成兑换码</b>\n\n点金额生成 1 个余额码；点套餐生成 1 个套餐码。\n要一次生成多个，点「其他金额」。",
    keyboard: { inline_keyboard: rows },
  };
}

const DISCOUNTS: Array<{ label: string; data: string }> = [
  { label: "九五折", data: "p:5" }, { label: "九折", data: "p:10" }, { label: "八五折", data: "p:15" },
  { label: "八折", data: "p:20" }, { label: "减 ¥5", data: "a:500" }, { label: "减 ¥10", data: "a:1000" },
];

function discountMenuView(): { text: string; keyboard: Keyboard } {
  const rows: Button[][] = [];
  for (let i = 0; i < DISCOUNTS.length; i += 3) {
    rows.push(DISCOUNTS.slice(i, i + 3).map((item) => ({ text: item.label, callback_data: `fx:x:dcy:${item.data}` })));
  }
  rows.push([{ text: "🛠 返回系统", callback_data: "fx:x:sys" }]);
  return { text: "<b>生成折扣码</b>\n\n买所有套餐都能用，每个码只能用 1 次。", keyboard: { inline_keyboard: rows } };
}

async function installCommandView(user: BotUser, hostId: number, page: number, notice = ""): Promise<{ text: string; keyboard: Keyboard }> {
  const result = await call(user, (caller) => caller.hosts.agentInstallCommand({ hostId }));
  const lines = notice ? [notice, ""] : [];
  lines.push("<b>安装命令</b>（在这台机器上用 root 运行）");
  if (result.command) {
    lines.push("", `<code>${escapeHtml(result.command)}</code>`, "", "点一下命令就能复制。装好后主机会自动上线。");
  } else {
    lines.push("", "面板公开地址还没配，生成不了安装命令。去面板「系统设置」填上面板地址。");
  }
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: [[{ text: "🖥 主机详情", callback_data: `fx:host:${hostId}:${page}` }], MENU_ROW] },
  };
}

// ---------------------------------------------------------------- 续费 / 买套餐（普通用户）

async function buyView(user: BotUser, notice = ""): Promise<{ text: string; keyboard: Keyboard }> {
  const [plans, me, subs] = await Promise.all([
    call(user, (caller) => caller.plans.storeList()).catch(() => []) as unknown as Promise<PlanRow[]>,
    call(user, (caller) => caller.billing.me()).catch(() => ({ balanceCents: 0 })) as unknown as Promise<{ balanceCents?: number }>,
    call(user, (caller) => caller.plans.mySubscriptions()).catch(() => []) as unknown as Promise<SubRow[]>,
  ]);
  const lines = ["<b>续费 / 买套餐</b>"];
  if (notice) lines.push(notice);
  lines.push("", `余额：<b>${yuan(me?.balanceCents)}</b>`);
  const rows: Button[][] = [];
  const active = (subs || []).filter((sub) => String(sub?.status || "active") === "active");
  for (const sub of active.slice(0, 3)) {
    const plan = (plans || []).find((item) => Number(item.id) === Number(sub.planId));
    if (!plan) continue;
    lines.push(`当前：${escapeHtml(plan.name)}${sub.expiresAt ? ` · 到 ${escapeHtml(new Date(sub.expiresAt).toLocaleDateString("zh-CN"))}` : ""}`);
    rows.push([{ text: `🔁 续费 ${short(plan.name, 12)} ${yuan(plan.priceCents)}`, callback_data: `fx:x:bp:${plan.id}:${sub.id}` }]);
  }
  if (!plans || plans.length === 0) {
    lines.push("", "商店没开，或者还没有在卖的套餐。");
  } else {
    lines.push("", "在卖的套餐：");
    for (const plan of plans.slice(0, 8)) {
      lines.push(`· ${escapeHtml(plan.name)} · ${yuan(plan.priceCents)}${plan.durationDays ? ` / ${Number(plan.durationDays)} 天` : ""}`);
      rows.push([{ text: `🛒 买 ${short(plan.name, 14)} ${yuan(plan.priceCents)}`, callback_data: `fx:x:bp:${plan.id}:0` }]);
    }
  }
  lines.push("", "余额不够可以用「🎟 兑换」充值，或者去面板充值。");
  rows.push([{ text: "🎟 兑换", callback_data: "fx:redeem" }]);
  rows.push(MENU_ROW);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

// ---------------------------------------------------------------- 回调

/** fx:x: 开头的回调。处理了返回 true。 */
export async function handleTelegramMoreCallback(input: {
  data: string;
  chatId: number | string;
  telegramId: number | string;
  user: BotUser;
  io: TelegramMoreIO;
}): Promise<boolean> {
  const { data, user, io } = input;
  if (!data.startsWith("fx:x:")) return false;
  const parts = data.split(":").slice(2);
  const op = parts[0];
  const num = (index: number) => Number(parts[index] || 0);
  const adminOnly = async () => {
    if (isAdmin(user)) return true;
    await io.edit("这个只有管理员能用。", MENU_KEYBOARD);
    return false;
  };
  try {
    switch (op) {
      // 链路
      case "links": {
        const view = await linksView(user, num(1));
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "link": {
        const view = await linkView(user, num(1), num(2));
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "pin": {
        const hostId = num(2);
        await call(user, (caller) => caller.tunnels.setExitPin({ tunnelId: num(1), hostId: hostId > 0 ? hostId : null }));
        const view = await linkView(user, num(1), num(3), hostId > 0 ? "✅ 已手动指定，入口马上切过去。" : "✅ 已交回自动。");
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "mv": {
        if (!(await adminOnly())) return true;
        await moveExit(user, num(1), num(2), parts[3] === "u" ? "u" : "d");
        const view = await linkView(user, num(1), num(4), "✅ 顺序已调整（出口组里的顺序，用这个组的链路都跟着变）。");
        await io.edit(view.text, view.keyboard);
        return true;
      }

      // 规则
      case "rt":
      case "rn": {
        const ruleId = num(1);
        const rule = await call(user, (caller) => caller.rules.getById({ id: ruleId })).catch(() => null) as unknown as RuleRow | null;
        if (!rule) {
          await io.edit("规则不存在或无权修改。", MENU_KEYBOARD);
          return true;
        }
        startPending(input.chatId, input.telegramId, { kind: op === "rt" ? "rule_target" : "rule_name", ruleId, page: num(2) });
        await io.edit(op === "rt"
          ? `<b>改规则 #${ruleId} 的目标</b>\n\n现在：<code>${escapeHtml(`${rule.targetIp}:${rule.targetPort}`)}</code>\n\n直接回复新的目标，例如 <code>1.2.3.4:443</code>（5 分钟内有效）。`
          : `<b>给规则 #${ruleId} 改名</b>\n\n现在：${escapeHtml(rule.name || "-")}\n\n直接回复新名字（5 分钟内有效）。`, {
          inline_keyboard: [[{ text: "❌ 取消", callback_data: `fx:x:cancel:${ruleId}:${num(2)}` }]],
        });
        return true;
      }
      case "cancel": {
        clearTelegramMorePending(input.chatId, input.telegramId);
        const back = parts[1] === "gc" || parts[1] === "sys" ? SYSTEM_BACK_KEYBOARD : parts[1] === "hosts" ? HOSTS_BACK_KEYBOARD : ruleBackKeyboard(num(1), num(2));
        await io.edit("已取消。", back);
        return true;
      }
      case "rr": {
        await call(user, (caller) => caller.rules.restart({ id: num(1) }));
        await io.edit(`规则 #${num(1)} 正在重启，几秒后生效。`, ruleBackKeyboard(num(1), num(2)));
        return true;
      }
      case "rd": {
        const rule = await call(user, (caller) => caller.rules.getById({ id: num(1) })).catch(() => null) as unknown as RuleRow | null;
        if (!rule) {
          await io.edit("规则不存在或无权删除。", MENU_KEYBOARD);
          return true;
        }
        await io.edit(`<b>删除规则 #${num(1)}？</b>\n\n${escapeHtml(rule.name || "")}\n<code>${escapeHtml(`${rule.targetIp}:${rule.targetPort}`)}</code>\n\n删了就没了，端口会释放。`, {
          inline_keyboard: [
            [{ text: "🗑 确认删除", callback_data: `fx:x:rdy:${num(1)}:${num(2)}` }, { text: "❌ 不删", callback_data: `fx:rule:view:${num(1)}:${num(2)}` }],
          ],
        });
        return true;
      }
      case "rdy": {
        await call(user, (caller) => caller.rules.delete({ id: num(1) }));
        await io.edit(`规则 #${num(1)} 已删除。`, { inline_keyboard: [[{ text: "⚙️ 返回规则列表", callback_data: `fx:rules:${num(2)}` }], MENU_ROW] });
        return true;
      }

      // 主机
      case "hm": {
        const enabled = parts[2] === "1";
        await call(user, (caller) => caller.hosts.setMaintenance({ hostId: num(1), enabled, note: enabled ? "Telegram 设置" : null }));
        await io.edit(enabled ? `主机 #${num(1)} 进入维护：这段时间不发它的离线告警。` : `主机 #${num(1)} 退出维护。`, {
          inline_keyboard: [[{ text: "🖥 返回主机详情", callback_data: `fx:host:${num(1)}:${num(3)}` }], MENU_ROW],
        });
        return true;
      }
      case "hr": {
        const enable = parts[2] === "1";
        const rules = ((await call(user, (caller) => caller.rules.list())) as unknown as RuleRow[])
          .filter((rule) => Number(rule.hostId) === num(1) && !rule.isForwardGroupTemplate && (enable ? !rule.isEnabled : rule.isEnabled));
        await io.edit(rules.length === 0
          ? `这台上没有要${enable ? "启用" : "停用"}的规则。`
          : `<b>${enable ? "启用" : "停用"}主机 #${num(1)} 上的 ${rules.length} 条规则？</b>`, {
          inline_keyboard: [
            ...(rules.length > 0 ? [[{ text: `✅ 确认${enable ? "启用" : "停用"}`, callback_data: `fx:x:hry:${num(1)}:${enable ? 1 : 0}:${num(3)}` }]] : []),
            [{ text: "🖥 返回主机详情", callback_data: `fx:host:${num(1)}:${num(3)}` }],
          ],
        });
        return true;
      }
      case "hry": {
        const enable = parts[2] === "1";
        const rules = ((await call(user, (caller) => caller.rules.list())) as unknown as RuleRow[])
          .filter((rule) => Number(rule.hostId) === num(1) && !rule.isForwardGroupTemplate && (enable ? !rule.isEnabled : rule.isEnabled))
          .slice(0, 300);
        let done = 0;
        const failed: string[] = [];
        for (const rule of rules) {
          try {
            await call(user, (caller) => caller.rules.toggle({ id: Number(rule.id), isEnabled: enable }));
            done += 1;
          } catch (error) {
            failed.push(`#${rule.id} ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await io.edit([
          `已${enable ? "启用" : "停用"} ${done} 条规则。`,
          failed.length ? `没成功 ${failed.length} 条：\n${escapeHtml(failed.slice(0, 5).join("\n"))}` : "",
        ].filter(Boolean).join("\n\n"), { inline_keyboard: [[{ text: "🖥 返回主机详情", callback_data: `fx:host:${num(1)}:${num(3)}` }], MENU_ROW] });
        return true;
      }
      case "upall": {
        if (!(await adminOnly())) return true;
        const candidates = await call(user, (caller) => caller.hosts.upgradeCandidates({ search: "" }));
        const hosts = (await db.getHostsByIds(candidates.ids)) as unknown as HostRow[];
        const offline = Number(candidates.offlineItems || 0);
        await io.edit(hosts.length === 0
          ? `在线的 Agent 都是最新的。${offline ? `\n另有 ${offline} 台离线的没升级，上线后再来。` : ""}`
          : `<b>升级 ${hosts.length} 台主机的 Agent？</b>\n\n${escapeHtml(hosts.slice(0, 15).map((host) => `· ${host.name || host.ip}${host.agentVersion ? ` v${host.agentVersion}` : ""}`).join("\n"))}${hosts.length > 15 ? "\n…" : ""}${offline ? `\n\n另有 ${offline} 台离线的这次不升。` : ""}\n\n升级时每台上的转发会断几秒。`, {
          inline_keyboard: [
            ...(hosts.length > 0 ? [[{ text: "⬆️ 确认升级", callback_data: "fx:x:upally" }]] : []),
            MENU_ROW,
          ],
        });
        return true;
      }
      case "upally": {
        if (!(await adminOnly())) return true;
        const candidates = await call(user, (caller) => caller.hosts.upgradeCandidates({ search: "" }));
        const hostIds = candidates.ids.slice(0, 500);
        if (hostIds.length === 0) {
          await io.edit("在线的 Agent 都是最新的。", MENU_KEYBOARD);
          return true;
        }
        await call(user, (caller) => caller.hosts.requestAgentUpgradeMany({ hostIds }));
        await io.edit(`已通知 ${hostIds.length} 台主机升级 Agent，几分钟内陆续完成。`, MENU_KEYBOARD);
        return true;
      }

      // 用户（管理员）
      case "ut": {
        if (!(await adminOnly())) return true;
        await io.edit(`<b>给用户 #${num(1)} 加流量</b>\n\n加在当前套餐上，不改到期时间。`, {
          inline_keyboard: [
            [10, 50, 100].map((gb) => ({ text: `+${gb} GB`, callback_data: `fx:x:uta:${num(1)}:${gb}:${num(2)}` })),
            [200, 500, 1000].map((gb) => ({ text: `+${gb} GB`, callback_data: `fx:x:uta:${num(1)}:${gb}:${num(2)}` })),
            [{ text: "❌ 取消", callback_data: `fx:admin:user:${num(1)}:${num(2)}` }],
          ],
        });
        return true;
      }
      case "uta": {
        if (!(await adminOnly())) return true;
        const gb = num(2);
        await call(user, (caller) => caller.billing.adminAddTrafficAddon({ userId: num(1), trafficBytes: gb * 1024 ** 3, description: `Telegram 加 ${gb} GB` }));
        await io.edit(`已给用户 #${num(1)} 加 ${formatBytes(gb * 1024 ** 3)} 流量。`, userBackKeyboard(num(1), num(3)));
        return true;
      }
      case "ub": {
        if (!(await adminOnly())) return true;
        const balance = Number(await db.getUserBalance(num(1))) || 0;
        startPending(input.chatId, input.telegramId, { kind: "user_balance", userId: num(1), page: num(2) });
        await io.edit(`<b>调整用户 #${num(1)} 的余额</b>\n\n现在：${yuan(balance)}\n\n回复 <code>+50</code> 加 50 元、<code>-20</code> 扣 20 元、<code>=100</code> 设成 100 元（5 分钟内有效）。`, {
          inline_keyboard: [[{ text: "❌ 取消", callback_data: `fx:admin:user:${num(1)}:${num(2)}` }]],
        });
        return true;
      }
      case "up": {
        if (!(await adminOnly())) return true;
        const plans = (await db.listSubscriptionPlanOptions(true)) as unknown as PlanRow[];
        const rows: Button[][] = plans.filter((plan) => plan.isActive !== false).slice(0, 10)
          .map((plan) => [{ text: `${short(plan.name, 18)} · ${yuan(plan.priceCents)}`, callback_data: `fx:x:upa:${num(1)}:${plan.id}:${num(2)}` }]);
        rows.push([{ text: "❌ 取消", callback_data: `fx:admin:user:${num(1)}:${num(2)}` }]);
        await io.edit(plans.length ? `<b>给用户 #${num(1)} 换成哪个套餐？</b>\n\n按套餐默认的时长给，不扣用户余额。` : "还没有套餐。", { inline_keyboard: rows });
        return true;
      }
      case "upa": {
        if (!(await adminOnly())) return true;
        await call(user, (caller) => caller.plans.assign({ userId: num(1), planId: num(2) }));
        await io.edit(`已给用户 #${num(1)} 换上套餐 #${num(2)}。`, userBackKeyboard(num(1), num(3)));
        return true;
      }
      case "ua": {
        if (!(await adminOnly())) return true;
        const enabled = parts[2] === "1";
        if (!enabled && parts[4] !== "y") {
          await io.edit(`<b>封禁用户 #${num(1)}？</b>\n\n封禁后他登录不了面板、机器人，名下的转发全部停掉；解封后恢复。`, {
            inline_keyboard: [
              [{ text: "🚫 确认封禁", callback_data: `fx:x:ua:${num(1)}:0:${num(3)}:y` }, { text: "❌ 取消", callback_data: `fx:admin:user:${num(1)}:${num(3)}` }],
            ],
          });
          return true;
        }
        await call(user, (caller) => caller.users.setAccountEnabled({ userId: num(1), enabled }));
        await io.edit(enabled ? `用户 #${num(1)} 已解封。` : `用户 #${num(1)} 已封禁。`, userBackKeyboard(num(1), num(3)));
        return true;
      }

      // 系统（管理员）
      case "sys": {
        if (!(await adminOnly())) return true;
        const view = await systemView(user);
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "reg": {
        if (!(await adminOnly())) return true;
        await db.setSetting("registrationEnabled", parts[1] === "1" ? "true" : "false");
        const view = await systemView(user, parts[1] === "1" ? "✅ 已开启开放注册。" : "✅ 已关闭开放注册。");
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "store": {
        if (!(await adminOnly())) return true;
        await call(user, (caller) => caller.plans.setStoreEnabled({ enabled: parts[1] === "1" }));
        const view = await systemView(user, parts[1] === "1" ? "✅ 商店已开启。" : "✅ 商店已关闭。");
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "mt": {
        if (!(await adminOnly())) return true;
        const enable = parts[1] === "1";
        if (enable && parts[2] !== "y") {
          await io.edit("<b>开启维护模式？</b>\n\n普通用户暂时登录不了面板、改不了东西（转发照常在跑）；管理员不受影响。", {
            inline_keyboard: [[{ text: "🛠 确认开启", callback_data: "fx:x:mt:1:y" }, { text: "❌ 取消", callback_data: "fx:x:sys" }]],
          });
          return true;
        }
        await call(user, (caller) => caller.ops.maintenance.set({ enabled: enable }));
        const view = await systemView(user, enable ? "✅ 维护模式已开启。" : "✅ 维护模式已关闭。");
        await io.edit(view.text, view.keyboard);
        return true;
      }

      case "gc": {
        if (!(await adminOnly())) return true;
        const view = await codeMenuView(user);
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "gcb": {
        if (!(await adminOnly())) return true;
        const result = await call(user, (caller) => caller.billing.createRedemptionCodes({ type: "balance", amountCents: num(1), count: 1 }));
        await io.edit(codesText(`${yuan(num(1))} 余额兑换码`, result.codes), CODES_KEYBOARD);
        return true;
      }
      case "gcc": {
        if (!(await adminOnly())) return true;
        startPending(input.chatId, input.telegramId, { kind: "code_balance" });
        await io.edit("回复金额（元），要多个就在后面加个数：\n\n<code>50</code> → 1 个 50 元\n<code>50 10</code> → 10 个 50 元", {
          inline_keyboard: [[{ text: "❌ 取消", callback_data: "fx:x:cancel:gc" }]],
        });
        return true;
      }
      case "gcp": {
        if (!(await adminOnly())) return true;
        const days = REDEEM_DAYS.find((value) => value === num(2)) || 30;
        const result = await call(user, (caller) => caller.billing.createRedemptionCodes({ type: "plan", planId: num(1), durationDays: days, count: 1 }));
        const plans = (await call(user, (caller) => caller.plans.list()).catch(() => [])) as unknown as PlanRow[];
        const plan = plans.find((item) => Number(item.id) === num(1));
        await io.edit(codesText(`「${plan?.name || `套餐 #${num(1)}`}」${days} 天兑换码`, result.codes), CODES_KEYBOARD);
        return true;
      }
      case "dc": {
        if (!(await adminOnly())) return true;
        const view = discountMenuView();
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "dcy": {
        if (!(await adminOnly())) return true;
        const percent = parts[1] === "p";
        const value = num(2);
        const created = await call(user, (caller) => caller.billing.createDiscountCode({ discountType: percent ? "percent" : "amount", discountValue: value, maxUses: 1 }));
        const code = String((created as { code?: string } | undefined)?.code || "");
        const label = DISCOUNTS.find((item) => item.data === `${parts[1]}:${value}`)?.label || (percent ? `减 ${value}%` : `减 ${yuan(value)}`);
        await io.edit(`<b>✅ 生成了 1 个折扣码（${escapeHtml(label)}，用 1 次）</b>\n\n<code>${escapeHtml(code)}</code>\n\n点一下码就能复制。`, {
          inline_keyboard: [[{ text: "🏷 再生成", callback_data: "fx:x:dc" }, { text: "🛠 返回系统", callback_data: "fx:x:sys" }], MENU_ROW],
        });
        return true;
      }
      case "an": {
        if (!(await adminOnly())) return true;
        startPending(input.chatId, input.telegramId, { kind: "announce" });
        await io.edit("回复公告内容：第一行是标题，下面是正文（只发一行就标题正文都用它）。发之前会先给你看一遍。", {
          inline_keyboard: [[{ text: "❌ 取消", callback_data: "fx:x:cancel:sys" }]],
        });
        return true;
      }
      case "any": {
        if (!(await adminOnly())) return true;
        const key = pendingKey(input.chatId, input.telegramId);
        const draft = announceDrafts.get(key);
        announceDrafts.delete(key);
        if (!draft || draft.expiresAt < Date.now()) {
          await io.edit("这条公告草稿过期了，再点一次「发公告」。", SYSTEM_BACK_KEYBOARD);
          return true;
        }
        await call(user, (caller) => caller.announcements.create({ title: draft.title, content: draft.content, type: "normal", telegramPush: parts[1] === "1" }));
        await io.edit(`✅ 公告「${escapeHtml(draft.title)}」已发布${parts[1] === "1" ? "，并推送到了 Telegram" : ""}。`, SYSTEM_BACK_KEYBOARD);
        return true;
      }
      case "ra": {
        if (!(await adminOnly())) return true;
        const preview = await call(user, (caller) => caller.ops.hostOps.restartAllPreview());
        const skipped = Array.isArray(preview.skipped) ? preview.skipped.length : 0;
        if (preview.targets.length === 0) {
          await io.edit("没有在线的主机可以重启。", SYSTEM_BACK_KEYBOARD);
          return true;
        }
        const names = preview.targets.slice(0, 10).map((host) => escapeHtml(short(host.name, 20))).join("、");
        await io.edit(
          `<b>重启全部 Agent？</b>\n\n${preview.targets.length} 台：${names}${preview.targets.length > 10 ? " 等" : ""}${skipped ? `\n跳过 ${skipped} 台（不在线或版本太旧）` : ""}\n\n重启时这些机器上的转发会断几秒。`,
          { inline_keyboard: [[{ text: "🔄 确认重启", callback_data: "fx:x:ray" }, { text: "❌ 取消", callback_data: "fx:x:sys" }]] },
        );
        return true;
      }
      case "ray": {
        if (!(await adminOnly())) return true;
        const result = await call(user, (caller) => caller.ops.hostOps.restartAll());
        await io.edit(`✅ 已发起重启：${result.targetCount} 台主机，几分钟内陆续回来。面板「运维」里能看进度。`, SYSTEM_BACK_KEYBOARD);
        return true;
      }
      case "ah": {
        startPending(input.chatId, input.telegramId, { kind: "host_add" });
        await io.edit("回复 <code>名字 IP</code>，比如 <code>香港1 1.2.3.4</code>。加好后直接给你安装命令。", {
          inline_keyboard: [[{ text: "❌ 取消", callback_data: "fx:x:cancel:hosts" }]],
        });
        return true;
      }
      case "hi": {
        const view = await installCommandView(user, num(1), num(2));
        await io.edit(view.text, view.keyboard);
        return true;
      }

      // 续费 / 买套餐
      case "buy": {
        const view = await buyView(user);
        await io.edit(view.text, view.keyboard);
        return true;
      }
      case "bp": {
        const plans = (await call(user, (caller) => caller.plans.storeList()).catch(() => [])) as unknown as PlanRow[];
        const plan = plans.find((item) => Number(item.id) === num(1));
        if (!plan) {
          await io.edit("这个套餐现在不卖了。", MENU_KEYBOARD);
          return true;
        }
        const subId = num(2);
        await io.edit(`<b>${subId ? "续费" : "购买"} ${escapeHtml(plan.name)}？</b>\n\n从余额扣 <b>${yuan(plan.priceCents)}</b>${plan.durationDays ? `，${Number(plan.durationDays)} 天` : ""}。`, {
          inline_keyboard: [[{ text: "✅ 确认", callback_data: `fx:x:bpy:${num(1)}:${subId}` }, { text: "❌ 取消", callback_data: "fx:x:buy" }]],
        });
        return true;
      }
      case "bpy": {
        const subId = num(2);
        await call(user, (caller) => caller.billing.purchasePlanWithBalance({ planId: num(1), ...(subId ? { subscriptionId: subId } : {}) }));
        const view = await buyView(user, "✅ 已从余额扣款，套餐已生效。");
        await io.edit(view.text, view.keyboard);
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    await io.edit(errorText(error), MENU_KEYBOARD);
    return true;
  }
}

// ---------------------------------------------------------------- 文字

/**
 * 直接打字（不带 /）也能打开常用功能：截图里用户打「菜单」被当成搜规则，搜出「0 条」。
 * 只认整句就是这些词的，别的照旧交给智能查询。
 */
const KEYWORD_COMMANDS: Record<string, string> = {
  菜单: "/menu", 主菜单: "/menu", 开始: "/menu", menu: "/menu",
  帮助: "/help", help: "/help",
  流量: "/usage", 用量: "/usage",
  规则: "/rules", 转发规则: "/rules",
  主机: "/hosts", 机器: "/hosts",
  线路组: "/routes",
  通知: "/notify",
  简报: "/digest",
  面板: "/webapp",
  链路: "/links", 隧道: "/links",
  续费: "/buy", 买套餐: "/buy",
  系统: "/system",
};

export function telegramKeywordCommand(text: string): string | null {
  const key = text.trim().replace(/[。.!！?？\s]+$/g, "").toLowerCase();
  return KEYWORD_COMMANDS[key] || null;
}

/** /links /buy /system 三个新命令（发一条新消息，不是改旧消息）。 */
export async function handleTelegramMoreCommand(command: string, user: BotUser, io: TelegramMoreIO): Promise<boolean> {
  try {
    if (command === "/links") {
      const view = await linksView(user, 0);
      await io.send(view.text, view.keyboard);
      return true;
    }
    if (command === "/buy") {
      const view = await buyView(user);
      await io.send(view.text, view.keyboard);
      return true;
    }
    if (command === "/system") {
      if (!isAdmin(user)) return false;
      const view = await systemView(user);
      await io.send(view.text, view.keyboard);
      return true;
    }
  } catch (error) {
    await io.send(errorText(error), MENU_KEYBOARD);
    return true;
  }
  return false;
}
