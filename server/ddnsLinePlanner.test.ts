import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultLineMembers,
  planDdnsLineRecordSets,
  sameDdnsValueSet,
  type LinePlanInput,
  type LinePlannerMember,
} from "./ddnsLinePlanner";

/*
  分线路解析规划（server/ddnsLinePlanner.ts）：电信 → A、联通 → B、默认 → C 这类配置下，
  每条线路该发布什么、全挂了怎么回落、什么时候删。
*/

const DEFAULT = { id: "0", name: "默认" };
const TELECOM = { id: "10=0", name: "电信" };
const UNICOM = { id: "10=1", name: "联通" };
const MOBILE = { id: "10=3", name: "移动" };

function member(id: number, value: string, lines: typeof DEFAULT[] = [], patch: Partial<LinePlannerMember> = {}): LinePlannerMember {
  return { memberId: id, hostId: id, priority: id, value, lines, status: "up", ...patch };
}

function plan(patch: Partial<LinePlanInput> & Pick<LinePlanInput, "members">) {
  return planDdnsLineRecordSets({
    recordType: "A",
    mode: "multi",
    defaultLine: DEFAULT,
    defaultPreviousValues: [],
    previous: {},
    fallback: "default",
    ...patch,
  });
}

function line(result: ReturnType<typeof plan>, id: string) {
  return result.lines.find((entry) => entry.line.id === id);
}

test("全部健康：每条线路发布自己的成员，默认线路只剩没分线路的", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM]),
      member(2, "198.51.100.2", [UNICOM]),
      member(3, "198.51.100.3"),
    ],
  });
  assert.deepEqual(result.defaultMemberIds, [3]);
  assert.deepEqual(result.defaultValues, ["198.51.100.3"]);
  assert.deepEqual(result.lines.map((entry) => [entry.line.name, entry.action, entry.values, entry.source]), [
    ["电信", "publish", ["198.51.100.1"], "members"],
    ["联通", "publish", ["198.51.100.2"], "members"],
  ]);
});

test("一个成员可以分到多条线路，勾了「默认」的同时留在默认线路", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM, UNICOM]),
      member(2, "198.51.100.2", [UNICOM, DEFAULT]),
      member(3, "198.51.100.3"),
    ],
  });
  assert.deepEqual(result.defaultMemberIds, [2, 3]);
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.1"]);
  assert.deepEqual(line(result, UNICOM.id)?.values, ["198.51.100.1", "198.51.100.2"]);
  // 默认线路本身不出现在线路列表里：它由原来那套逻辑发布。
  assert.equal(line(result, DEFAULT.id), undefined);
});

test("所有成员都分了非默认线路时，默认线路用全部成员兜底", () => {
  const members = [member(1, "198.51.100.1", [TELECOM]), member(2, "198.51.100.2", [UNICOM])];
  assert.deepEqual(defaultLineMembers(members, DEFAULT).map((entry) => entry.memberId), [1, 2]);
  const result = plan({ members });
  assert.deepEqual(result.defaultValues, ["198.51.100.1", "198.51.100.2"]);
});

test("没分线路的组：没有任何线路条目，默认线路就是全部成员（和以前一样）", () => {
  const result = plan({ members: [member(1, "198.51.100.1"), member(2, "198.51.100.2")] });
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.defaultMemberIds, [1, 2]);
  assert.deepEqual(result.defaultValues, ["198.51.100.1", "198.51.100.2"]);
});

test("一条线路全挂：默认回落到默认线路的健康成员，绝不发布空集", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM], { status: "down" }),
      member(2, "198.51.100.2", [UNICOM]),
      member(3, "198.51.100.3"),
    ],
    previous: { [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1"] } },
  });
  const telecom = line(result, TELECOM.id)!;
  assert.equal(telecom.action, "publish");
  assert.equal(telecom.source, "fallback");
  assert.deepEqual(telecom.values, ["198.51.100.3"]);
  assert.deepEqual(telecom.memberIds, [3]);
  assert.deepEqual(line(result, UNICOM.id)?.values, ["198.51.100.2"]);
});

test("一条线路全挂且设成「删掉」：删这条线路的记录，交给服务商回落到默认线路", () => {
  const result = plan({
    fallback: "remove",
    members: [member(1, "198.51.100.1", [TELECOM], { status: "down" }), member(3, "198.51.100.3")],
    previous: { [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1"] } },
  });
  assert.deepEqual(line(result, TELECOM.id), {
    line: TELECOM, action: "delete", values: [], memberIds: [], source: null, reason: "fallback-remove",
  });
});

test("线路和默认线路都没有健康成员：这条线路保留上一次的记录（每条线路各自保留）", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM], { status: "down" }),
      member(2, "198.51.100.2", [UNICOM], { status: "down" }),
      member(3, "198.51.100.3", [], { status: "down" }),
    ],
    previous: {
      [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1"] },
      [UNICOM.id]: { ...UNICOM, values: ["198.51.100.2"] },
    },
  });
  assert.deepEqual(result.defaultValues, []);
  assert.deepEqual(result.lines.map((entry) => [entry.line.id, entry.action, entry.source, entry.values]), [
    [TELECOM.id, "publish", "hold", ["198.51.100.1"]],
    [UNICOM.id, "publish", "hold", ["198.51.100.2"]],
  ]);
});

test("保留上一次记录时，流量到阈值的地址照样剔掉；剩不下就删掉这条线路", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM], { status: "quota" }),
      member(2, "198.51.100.2", [TELECOM], { status: "down" }),
      member(4, "198.51.100.4", [UNICOM], { status: "quota" }),
      member(3, "198.51.100.3", [], { status: "down" }),
    ],
    previous: {
      [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1", "198.51.100.2"] },
      [UNICOM.id]: { ...UNICOM, values: ["198.51.100.4"] },
    },
  });
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.2"]);
  assert.equal(line(result, TELECOM.id)?.source, "hold");
  assert.equal(line(result, UNICOM.id)?.action, "delete");
  assert.equal(line(result, UNICOM.id)?.reason, "nothing-to-hold");
});

test("流量到阈值（剔除）只影响它所在的线路，同一线路的其他成员照常发布", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM], { status: "quota" }),
      member(2, "198.51.100.2", [TELECOM]),
      member(3, "198.51.100.3"),
    ],
    previous: { [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1", "198.51.100.2"] } },
  });
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.2"]);
  assert.equal(line(result, TELECOM.id)?.source, "members");
});

test("等健康结果 / 观察期内的成员：已经在这条线路里的留着，不会新加进别的线路", () => {
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM, UNICOM], { status: "pending" }),
      member(2, "198.51.100.2", [UNICOM]),
      member(3, "198.51.100.3"),
    ],
    previous: {
      [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1"] },
      [UNICOM.id]: { ...UNICOM, values: ["198.51.100.2"] },
    },
  });
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.1"]);
  assert.deepEqual(line(result, UNICOM.id)?.values, ["198.51.100.2"]);
});

test("带宽排序只在每条线路自己的成员里排", () => {
  const seen: number[][] = [];
  const result = plan({
    members: [
      member(1, "198.51.100.1", [TELECOM], { bandwidthMbps: 100 }),
      member(2, "198.51.100.2", [TELECOM], { bandwidthMbps: 1000 }),
      member(3, "198.51.100.3", [UNICOM], { bandwidthMbps: 500 }),
      member(4, "198.51.100.4", [], { bandwidthMbps: 10 }),
    ],
    rank: (members, values) => {
      seen.push(members.map((entry) => entry.memberId));
      const bandwidth = new Map(members.map((entry) => [entry.value, Number(entry.bandwidthMbps || 0)]));
      return [...values].sort((a, b) => (bandwidth.get(b) || 0) - (bandwidth.get(a) || 0));
    },
  });
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.2", "198.51.100.1"]);
  // 只有一个值的线路不用排；每次排序拿到的都只是这一条线路的成员。
  assert.deepEqual(seen, [[1, 2]]);
});

test("排序函数要是加了或弄丢了值，就不用它的结果", () => {
  const result = plan({
    members: [member(1, "198.51.100.1", [TELECOM]), member(2, "198.51.100.2", [TELECOM])],
    rank: () => ["198.51.100.9"],
  });
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.1", "198.51.100.2"]);
});

test("IPv6（AAAA）和 IPv4 一样按线路发布；CNAME 每条线路只取一个", () => {
  const v6 = plan({
    recordType: "AAAA",
    members: [member(1, "2001:db8::1", [TELECOM]), member(2, "2001:db8::2", [TELECOM]), member(3, "2001:db8::3")],
  });
  assert.deepEqual(line(v6, TELECOM.id)?.values, ["2001:db8::1", "2001:db8::2"]);
  assert.deepEqual(v6.defaultValues, ["2001:db8::3"]);

  const cname = plan({
    recordType: "CNAME",
    members: [member(1, "A.Example.com.", [TELECOM]), member(2, "b.example.com", [TELECOM]), member(3, "c.example.com")],
  });
  assert.deepEqual(line(cname, TELECOM.id)?.values, ["a.example.com"]);
});

test("线路不再有成员（改了配置）：删掉；上一轮的值不影响这个判断", () => {
  const result = plan({
    members: [member(1, "198.51.100.1", [TELECOM]), member(3, "198.51.100.3")],
    previous: {
      [TELECOM.id]: { ...TELECOM, values: ["198.51.100.1"] },
      [MOBILE.id]: { ...MOBILE, values: ["198.51.100.9"] },
    },
  });
  assert.deepEqual(result.lines.map((entry) => [entry.line.id, entry.action, entry.reason]), [
    [TELECOM.id, "publish", "members"],
    [MOBILE.id, "delete", "unassigned"],
  ]);
});

test("没有可用地址的成员（没配 IPv6 之类）算这条线路的成员，但不会被发布", () => {
  const result = plan({
    members: [member(1, "", [TELECOM], { status: "down" }), member(3, "198.51.100.3")],
  });
  assert.equal(line(result, TELECOM.id)?.source, "fallback");
  assert.deepEqual(line(result, TELECOM.id)?.values, ["198.51.100.3"]);
});

test("主备组每条线路一个成员：当前成员观察期内不换，不可用了换下一个，恢复够久了回切", () => {
  const base = {
    mode: "single" as const,
    autoFailback: true,
    previous: { [TELECOM.id]: { ...TELECOM, values: ["198.51.100.2"] } },
  };
  const graceKeeps = plan({
    ...base,
    members: [member(1, "198.51.100.1", [TELECOM]), member(2, "198.51.100.2", [TELECOM], { status: "grace" }), member(3, "198.51.100.3")],
  });
  assert.deepEqual(line(graceKeeps, TELECOM.id)?.values, ["198.51.100.2"]);

  const failover = plan({
    ...base,
    members: [member(1, "198.51.100.1", [TELECOM], { status: "down" }), member(2, "198.51.100.2", [TELECOM], { status: "down" }), member(4, "198.51.100.4", [TELECOM]), member(3, "198.51.100.3")],
  });
  assert.deepEqual(line(failover, TELECOM.id)?.values, ["198.51.100.4"]);

  const failback = plan({
    ...base,
    members: [member(1, "198.51.100.1", [TELECOM], { recovered: true }), member(2, "198.51.100.2", [TELECOM]), member(3, "198.51.100.3")],
  });
  assert.deepEqual(line(failback, TELECOM.id)?.values, ["198.51.100.1"]);

  const noFailback = plan({
    ...base,
    autoFailback: false,
    members: [member(1, "198.51.100.1", [TELECOM], { recovered: true }), member(2, "198.51.100.2", [TELECOM]), member(3, "198.51.100.3")],
  });
  assert.deepEqual(line(noFailback, TELECOM.id)?.values, ["198.51.100.2"]);

  // 默认线路（主备）也只给一个值，线路全挂时回落的就是它。
  const fallback = plan({
    ...base,
    members: [member(2, "198.51.100.2", [TELECOM], { status: "down" }), member(3, "198.51.100.3"), member(5, "198.51.100.5")],
  });
  assert.deepEqual(fallback.defaultValues, ["198.51.100.3"]);
  assert.deepEqual(line(fallback, TELECOM.id)?.values, ["198.51.100.3"]);
});

test("记录集比较与顺序、大小写（CNAME）无关", () => {
  assert.equal(sameDdnsValueSet("A", ["198.51.100.1", "198.51.100.2"], ["198.51.100.2", "198.51.100.1"]), true);
  assert.equal(sameDdnsValueSet("A", ["198.51.100.1"], ["198.51.100.1", "198.51.100.2"]), false);
  assert.equal(sameDdnsValueSet("CNAME", ["A.example.com."], ["a.example.com"]), true);
});
