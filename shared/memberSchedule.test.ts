import assert from "node:assert/strict";
import test from "node:test";
import {
  describeMemberSchedule,
  groupModeSupportsMemberSchedule,
  memberEnabledIntent,
  memberScheduleActiveAt,
  parseMemberSchedule,
  resolveMemberScheduleState,
  serializeMemberSchedule,
} from "./memberSchedule";

const at = (iso: string) => new Date(iso);
// 晚高峰：每天 20:00 到次日 02:00（北京时间）
const peak = { timezone: "Asia/Shanghai", windows: [{ days: [], from: "20:00", to: "02:00" }] };

test("没设时段永远可用；跨午夜的时段到次日凌晨", () => {
  assert.equal(memberScheduleActiveAt(null, at("2026-10-18T05:00:00Z")), true);
  assert.equal(memberScheduleActiveAt(peak, at("2026-10-18T12:30:00Z")), true, "北京 20:30");
  assert.equal(memberScheduleActiveAt(peak, at("2026-10-18T17:59:00Z")), true, "北京次日 01:59");
  assert.equal(memberScheduleActiveAt(peak, at("2026-10-18T18:00:00Z")), false, "北京 02:00 结束");
  assert.equal(memberScheduleActiveAt(peak, at("2026-10-18T04:00:00Z")), false, "北京中午");
});

test("按星期：跨午夜的时段属于开始那天", () => {
  // 只有周五 20:00-02:00
  const friday = { timezone: "Asia/Shanghai", windows: [{ days: [5], from: "20:00", to: "02:00" }] };
  assert.equal(memberScheduleActiveAt(friday, at("2026-10-16T17:00:00Z")), true, "周六凌晨 1 点属于周五的时段");
  assert.equal(memberScheduleActiveAt(friday, at("2026-10-17T17:00:00Z")), false, "周日凌晨 1 点不算");
});

test("实际启用 = 想开 且 在时段里；只有时段停用的才标 scheduleSuspended", () => {
  const inside = at("2026-10-18T12:30:00Z");
  const outside = at("2026-10-18T04:00:00Z");
  assert.deepEqual(resolveMemberScheduleState(true, peak, inside), { isEnabled: true, scheduleSuspended: false });
  assert.deepEqual(resolveMemberScheduleState(true, peak, outside), { isEnabled: false, scheduleSuspended: true });
  assert.deepEqual(resolveMemberScheduleState(false, peak, inside), { isEnabled: false, scheduleSuspended: false }, "手动停的不被时段恢复");
  assert.deepEqual(resolveMemberScheduleState(true, null, outside), { isEnabled: true, scheduleSuspended: false });
  assert.equal(memberEnabledIntent({ isEnabled: false, scheduleSuspended: true }), true);
  assert.equal(memberEnabledIntent({ isEnabled: 0, scheduleSuspended: 0 }), false);
});

test("不合法的设置当作不限时段；不认识的时区也一样", () => {
  assert.equal(parseMemberSchedule("not json"), null);
  assert.equal(parseMemberSchedule({ windows: [{ from: "25:00", to: "02:00" }] }), null);
  assert.equal(parseMemberSchedule({ windows: [{ from: "10:00", to: "10:00" }] }), null, "起止相同没有长度");
  assert.equal(memberScheduleActiveAt({ timezone: "Mars/Olympus", windows: [{ days: [], from: "20:00", to: "02:00" }] }, at("2026-10-18T04:00:00Z")), true);
  assert.equal(serializeMemberSchedule({ windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "08:00", to: "09:00" }] }), '{"timezone":"Asia/Shanghai","windows":[{"days":[],"from":"08:00","to":"09:00"}]}');
});

test("文案和适用范围", () => {
  assert.equal(describeMemberSchedule(peak), "每天 20:00-02:00");
  assert.equal(describeMemberSchedule(null), "不限时段");
  assert.equal(groupModeSupportsMemberSchedule("failover"), true);
  assert.equal(groupModeSupportsMemberSchedule("entry"), true);
  assert.equal(groupModeSupportsMemberSchedule("chain"), false);
  assert.equal(groupModeSupportsMemberSchedule("port"), false);
});
