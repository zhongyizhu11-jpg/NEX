/*
  按账号保存的界面偏好（users.uiPreferences，一段 JSON 文本），跟着账号走、换设备也一样：

  · motion：界面动画（个人资料 › 界面，上游 2.3.287），默认开；关了整站不做过渡和动画
    （<html data-motion="off">，见 client/src/lib/uiMotion.ts）。
  · tables：列表显示列、顺序、列宽（主机列表、转发规则的列表视图，上游 2.3.287）。

  布局密度（标准 / 精简）早就单独存在 users.uiLayout，这里不重复。

  存的时候只做「结构上」的清洗（类型、长度、个数、宽度范围）：服务端不知道每张表现在有哪些列，
  列被删了、改名了，旧的偏好里照样留着它；画表的时候 resolveTableColumns 只认现在有的列，
  不认识的丢掉，必须显示的列（名称、操作）藏不掉，新加的列按默认位置补进来。
*/

export const UI_PREFERENCE_TABLES = ["hosts", "rules"] as const;
export type UiPreferenceTable = (typeof UI_PREFERENCE_TABLES)[number];

/** 一张表最多记多少列、列 key 多长：防止一份偏好被塞得很大。 */
const MAX_TABLE_COLUMNS = 48;
const COLUMN_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;
export const TABLE_COLUMN_WIDTH_MIN = 48;
export const TABLE_COLUMN_WIDTH_MAX = 1200;
/** 整段 JSON 的上限：上面的限制下正常用远远到不了。 */
export const UI_PREFERENCES_MAX_LENGTH = 16_000;

export type TableColumnPreference = {
  /** 用户排过的顺序（只记可以挪的列）。 */
  order: string[];
  /** 用户藏起来的列。 */
  hidden: string[];
  /** 用户拖过的列宽（px）；没拖过的列按默认。 */
  widths: Record<string, number>;
};

export type UiPreferences = {
  motion?: boolean;
  tables?: Partial<Record<UiPreferenceTable, TableColumnPreference>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanColumnKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !COLUMN_KEY_PATTERN.test(item) || seen.has(item)) continue;
    seen.add(item);
    if (seen.size >= MAX_TABLE_COLUMNS) break;
  }
  return Array.from(seen);
}

export function clampTableColumnWidth(width: number, min = TABLE_COLUMN_WIDTH_MIN, max = TABLE_COLUMN_WIDTH_MAX) {
  const low = Math.max(TABLE_COLUMN_WIDTH_MIN, min);
  const high = Math.max(low, Math.min(TABLE_COLUMN_WIDTH_MAX, max));
  return Math.min(high, Math.max(low, Math.round(width)));
}

/** 一张表的偏好：认不出来的字段丢掉；什么都没剩就是 null（= 默认）。 */
export function sanitizeTableColumnPreference(value: unknown): TableColumnPreference | null {
  if (!isRecord(value)) return null;
  const order = cleanColumnKeys(value.order);
  const hidden = cleanColumnKeys(value.hidden);
  const widths: Record<string, number> = {};
  if (isRecord(value.widths)) {
    let count = 0;
    for (const [key, width] of Object.entries(value.widths)) {
      if (count >= MAX_TABLE_COLUMNS) break;
      if (!COLUMN_KEY_PATTERN.test(key) || typeof width !== "number" || !Number.isFinite(width)) continue;
      widths[key] = clampTableColumnWidth(width);
      count += 1;
    }
  }
  if (order.length === 0 && hidden.length === 0 && Object.keys(widths).length === 0) return null;
  return { order, hidden, widths };
}

/** 库里那段文本（或已经解析好的对象）→ 偏好。坏 JSON、不认识的字段都当没有。 */
export function parseUiPreferences(raw: unknown): UiPreferences {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim() || raw.length > UI_PREFERENCES_MAX_LENGTH) return {};
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!isRecord(value)) return {};
  const result: UiPreferences = {};
  if (typeof value.motion === "boolean") result.motion = value.motion;
  if (isRecord(value.tables)) {
    const tables: UiPreferences["tables"] = {};
    for (const table of UI_PREFERENCE_TABLES) {
      const pref = sanitizeTableColumnPreference(value.tables[table]);
      if (pref) tables[table] = pref;
    }
    if (Object.keys(tables).length) result.tables = tables;
  }
  return result;
}

/** 存回库里的文本；全是默认就存 null。 */
export function serializeUiPreferences(preferences: UiPreferences): string | null {
  const clean = parseUiPreferences(preferences);
  if (clean.motion === undefined && !clean.tables) return null;
  return JSON.stringify(clean);
}

export type UiPreferencesPatch = {
  motion?: boolean | null;
  table?: { id: UiPreferenceTable; columns: Partial<TableColumnPreference> | null };
};

/** 只改这次提交的那一项，别的照旧（两个标签页一个改列、一个关动画，谁也不覆盖谁）。null = 恢复默认。 */
export function mergeUiPreferences(current: UiPreferences, patch: UiPreferencesPatch): UiPreferences {
  const next: UiPreferences = { ...current, tables: { ...(current.tables || {}) } };
  if (patch.motion === null) delete next.motion;
  else if (patch.motion !== undefined) next.motion = patch.motion;
  if (patch.table) {
    const pref = patch.table.columns === null ? null : sanitizeTableColumnPreference(patch.table.columns);
    if (pref) next.tables![patch.table.id] = pref;
    else delete next.tables![patch.table.id];
  }
  if (!Object.keys(next.tables!).length) delete next.tables;
  return next;
}

/** 这个账号开没开界面动画：没设过 = 开。 */
export function isUiMotionEnabled(user: { uiPreferences?: unknown } | null | undefined) {
  return parseUiPreferences(user?.uiPreferences).motion !== false;
}

export function readTableColumnPreference(user: { uiPreferences?: unknown } | null | undefined, table: UiPreferenceTable) {
  return parseUiPreferences(user?.uiPreferences).tables?.[table] ?? null;
}

// ==================== 按现在的列定义把偏好落成实际的列 ====================

export type TableColumnDefinition = {
  key: string;
  /** 必须显示（名称、操作）：列设置里不能取消勾选。 */
  required?: boolean;
  /** 钉在头 / 尾，不参与排序（冻结列、操作列）。 */
  pin?: "start" | "end";
  minWidth?: number;
  maxWidth?: number;
};

export type ResolvedTableColumn = {
  key: string;
  visible: boolean;
  required: boolean;
  pin: "start" | "end" | null;
  /** 用户拖过的宽度；null 用这张表自己的默认宽度。 */
  width: number | null;
};

/**
 * 列定义 + 偏好 → 实际的列（全部列，按显示顺序，带 visible）。
 *
 * 顺序：钉在头的 → 可挪的（先按偏好里的顺序，偏好里没有的新列插到它默认位置的前一列后面）→ 钉在尾的。
 * 偏好里认不出来的列直接忽略；必须显示的列就算偏好里写着藏也照样显示。
 */
export function resolveTableColumns(definitions: readonly TableColumnDefinition[], preference: TableColumnPreference | null | undefined): ResolvedTableColumn[] {
  const known = new Map(definitions.map((definition) => [definition.key, definition]));
  const movable = definitions.filter((definition) => !definition.pin).map((definition) => definition.key);
  const movableSet = new Set(movable);
  const order = (preference?.order || []).filter((key) => movableSet.has(key));
  const placed = new Set(order);
  movable.forEach((key, index) => {
    if (placed.has(key)) return;
    // 默认顺序里它前面最近的、已经排进去的那一列；一列都没有就放最前
    let insertAt = 0;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const position = order.indexOf(movable[previous]);
      if (position >= 0) {
        insertAt = position + 1;
        break;
      }
    }
    order.splice(insertAt, 0, key);
    placed.add(key);
  });
  const keys = [
    ...definitions.filter((definition) => definition.pin === "start").map((definition) => definition.key),
    ...order,
    ...definitions.filter((definition) => definition.pin === "end").map((definition) => definition.key),
  ];
  const hidden = new Set(preference?.hidden || []);
  return keys.map((key) => {
    const definition = known.get(key)!;
    const saved = preference?.widths?.[key];
    return {
      key,
      required: !!definition.required,
      pin: definition.pin ?? null,
      visible: !!definition.required || !hidden.has(key),
      width: typeof saved === "number" && Number.isFinite(saved)
        ? clampTableColumnWidth(saved, definition.minWidth, definition.maxWidth)
        : null,
    };
  });
}

function basePreference(preference: TableColumnPreference | null | undefined): TableColumnPreference {
  return {
    order: [...(preference?.order || [])],
    hidden: [...(preference?.hidden || [])],
    widths: { ...(preference?.widths || {}) },
  };
}

/** 勾选 / 取消一列。必须显示的列不让藏。 */
export function setTableColumnVisible(
  definitions: readonly TableColumnDefinition[],
  preference: TableColumnPreference | null | undefined,
  key: string,
  visible: boolean,
): TableColumnPreference {
  const next = basePreference(preference);
  const definition = definitions.find((item) => item.key === key);
  if (!definition || definition.required) return next;
  next.hidden = next.hidden.filter((item) => item !== key);
  if (!visible) next.hidden.push(key);
  return next;
}

/** 把一列往前（-1）/ 往后（+1）挪一格；钉住的列不动。顺序会整份写下来，以后加的新列照默认位置补。 */
export function moveTableColumn(
  definitions: readonly TableColumnDefinition[],
  preference: TableColumnPreference | null | undefined,
  key: string,
  delta: -1 | 1,
): TableColumnPreference {
  const next = basePreference(preference);
  const order = resolveTableColumns(definitions, preference).filter((column) => !column.pin).map((column) => column.key);
  const index = order.indexOf(key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return next;
  [order[index], order[target]] = [order[target], order[index]];
  next.order = order;
  return next;
}

export function setTableColumnWidth(
  definitions: readonly TableColumnDefinition[],
  preference: TableColumnPreference | null | undefined,
  key: string,
  width: number | null,
): TableColumnPreference {
  const next = basePreference(preference);
  const definition = definitions.find((item) => item.key === key);
  if (!definition) return next;
  if (width === null) delete next.widths[key];
  else next.widths[key] = clampTableColumnWidth(width, definition.minWidth, definition.maxWidth);
  return next;
}

/** 偏好和默认一模一样（没藏、没排、没拖）时，「恢复默认」按钮没必要亮。 */
export function isDefaultTableColumnPreference(definitions: readonly TableColumnDefinition[], preference: TableColumnPreference | null | undefined) {
  if (!preference) return true;
  const resolved = resolveTableColumns(definitions, preference);
  const defaultOrder = resolveTableColumns(definitions, null).map((column) => column.key);
  return resolved.every((column, index) => column.visible && column.width === null && column.key === defaultOrder[index]);
}
