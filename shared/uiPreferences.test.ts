import assert from "node:assert/strict";
import test from "node:test";
import {
  isDefaultTableColumnPreference,
  isUiMotionEnabled,
  mergeUiPreferences,
  moveTableColumn,
  parseUiPreferences,
  resolveTableColumns,
  sanitizeTableColumnPreference,
  serializeUiPreferences,
  setTableColumnVisible,
  setTableColumnWidth,
  type TableColumnDefinition,
} from "./uiPreferences";

const COLUMNS: TableColumnDefinition[] = [
  { key: "name", required: true, pin: "start", minWidth: 120 },
  { key: "runtime" },
  { key: "resources", minWidth: 100, maxWidth: 400 },
  { key: "traffic" },
  { key: "actions", required: true, pin: "end" },
];
const keys = (columns: { key: string }[]) => columns.map((column) => column.key);

test("没有偏好：默认顺序、全部显示、默认宽度", () => {
  const resolved = resolveTableColumns(COLUMNS, null);
  assert.deepEqual(keys(resolved), ["name", "runtime", "resources", "traffic", "actions"]);
  assert.ok(resolved.every((column) => column.visible && column.width === null));
  assert.equal(isDefaultTableColumnPreference(COLUMNS, null), true);
});

test("认不出来的列忽略；必须显示的列藏不掉；钉住的列不随排序动", () => {
  const resolved = resolveTableColumns(COLUMNS, {
    order: ["removedColumn", "traffic", "name", "runtime", "actions"],
    hidden: ["name", "actions", "resources", "ghost"],
    widths: { ghost: 300, traffic: 180 },
  });
  assert.deepEqual(keys(resolved), ["name", "traffic", "runtime", "resources", "actions"]);
  assert.deepEqual(resolved.filter((column) => !column.visible).map((column) => column.key), ["resources"]);
  assert.equal(resolved.find((column) => column.key === "traffic")!.width, 180);
  assert.ok(!resolved.some((column) => column.key === "ghost" || column.key === "removedColumn"));
});

test("偏好里没有的新列，插在默认顺序里它前一列的后面", () => {
  // 存偏好的时候还没有 resources 这一列
  const resolved = resolveTableColumns(COLUMNS, { order: ["traffic", "runtime"], hidden: [], widths: {} });
  assert.deepEqual(keys(resolved), ["name", "traffic", "runtime", "resources", "actions"]);
  // 默认第一列可挪的列没排过：放最前
  const first = resolveTableColumns(COLUMNS, { order: ["traffic", "resources"], hidden: [], widths: {} });
  assert.deepEqual(keys(first), ["name", "runtime", "traffic", "resources", "actions"]);
});

test("列宽按每列的上下限夹住", () => {
  const resolved = resolveTableColumns(COLUMNS, { order: [], hidden: [], widths: { resources: 900, name: 10 } });
  assert.equal(resolved.find((column) => column.key === "resources")!.width, 400);
  assert.equal(resolved.find((column) => column.key === "name")!.width, 120);
});

test("勾选、挪动、拖宽、恢复", () => {
  let pref = setTableColumnVisible(COLUMNS, null, "runtime", false);
  assert.deepEqual(pref.hidden, ["runtime"]);
  assert.deepEqual(setTableColumnVisible(COLUMNS, pref, "name", false).hidden, ["runtime"], "必须显示的列点了也不藏");
  pref = setTableColumnVisible(COLUMNS, pref, "runtime", true);
  assert.deepEqual(pref.hidden, []);
  pref = moveTableColumn(COLUMNS, pref, "traffic", -1);
  assert.deepEqual(keys(resolveTableColumns(COLUMNS, pref)), ["name", "runtime", "traffic", "resources", "actions"]);
  assert.deepEqual(moveTableColumn(COLUMNS, pref, "runtime", -1).order, pref.order, "已经在最前就不动");
  assert.deepEqual(moveTableColumn(COLUMNS, pref, "name", 1).order, pref.order, "钉住的列不动");
  pref = setTableColumnWidth(COLUMNS, pref, "resources", 250.6);
  assert.equal(pref.widths.resources, 251);
  assert.equal(isDefaultTableColumnPreference(COLUMNS, pref), false);
  pref = setTableColumnWidth(COLUMNS, pref, "resources", null);
  pref = moveTableColumn(COLUMNS, pref, "traffic", 1);
  assert.equal(isDefaultTableColumnPreference(COLUMNS, pref), true, "挪回去、宽度清掉就等于默认");
});

test("存库前的结构清洗：非法 key、重复、非数字宽度丢掉，宽度夹在 48～1200", () => {
  assert.equal(sanitizeTableColumnPreference(null), null);
  assert.equal(sanitizeTableColumnPreference({ order: [], hidden: [], widths: {} }), null);
  assert.deepEqual(sanitizeTableColumnPreference({
    order: ["a", "a", "<script>", 5, "b"],
    hidden: "a",
    widths: { a: 2000, b: 1, c: "300", "bad key": 100, d: Number.NaN },
  }), { order: ["a", "b"], hidden: [], widths: { a: 1200, b: 48 } });
  const many = Array.from({ length: 100 }, (_, index) => `c${index}`);
  assert.equal(sanitizeTableColumnPreference({ order: many })!.order.length, 48);
});

test("整份偏好：坏 JSON 当没有；合并只改提交的那一项；全是默认存 null", () => {
  assert.deepEqual(parseUiPreferences("{bad"), {});
  assert.deepEqual(parseUiPreferences(JSON.stringify({ motion: "no", tables: { hosts: { order: ["x"] }, unknown: { order: ["y"] } } })), {
    tables: { hosts: { order: ["x"], hidden: [], widths: {} } },
  });
  let prefs = mergeUiPreferences({}, { motion: false });
  prefs = mergeUiPreferences(prefs, { table: { id: "rules", columns: { hidden: ["personalGroups"] } } });
  assert.deepEqual(prefs, { motion: false, tables: { rules: { order: [], hidden: ["personalGroups"], widths: {} } } });
  prefs = mergeUiPreferences(prefs, { table: { id: "hosts", columns: { widths: { name: 300 } } } });
  assert.deepEqual(Object.keys(prefs.tables!).sort(), ["hosts", "rules"]);
  prefs = mergeUiPreferences(prefs, { table: { id: "rules", columns: null } });
  prefs = mergeUiPreferences(prefs, { table: { id: "hosts", columns: null } });
  assert.deepEqual(prefs, { motion: false });
  assert.equal(serializeUiPreferences(mergeUiPreferences(prefs, { motion: null })), null);
});

test("界面动画默认开，只有明确存成 false 才关", () => {
  assert.equal(isUiMotionEnabled(null), true);
  assert.equal(isUiMotionEnabled({ uiPreferences: null }), true);
  assert.equal(isUiMotionEnabled({ uiPreferences: "{}" }), true);
  assert.equal(isUiMotionEnabled({ uiPreferences: JSON.stringify({ motion: true }) }), true);
  assert.equal(isUiMotionEnabled({ uiPreferences: JSON.stringify({ motion: false }) }), false);
  assert.equal(isUiMotionEnabled({ uiPreferences: "not json" }), true);
});
