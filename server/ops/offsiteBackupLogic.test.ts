import assert from "node:assert/strict";
import test from "node:test";

import {
  isOffsiteBackupDue,
  latestBackupSlot,
  nextBackupAt,
  offsiteBackupClaimKey,
  offsiteBackupName,
  OFFSITE_BACKUP_FAILURE_REPORT_MS,
  OFFSITE_BACKUP_RETRY_MS,
  parseOffsiteBackupName,
  selectBackupsToDelete,
  shouldReportBackupFailure,
  type OffsiteBackupSchedule,
} from "./offsiteBackupLogic";
import { parseWebdavPropfind, webdavFileUrl, webdavFolderUrl } from "./offsiteBackupWebdav";

const HOUR = 3600 * 1000;
// 2026-10-04 04:30 北京时间
const OCT4_0430 = Date.UTC(2026, 9, 3, 20, 30);

test("文件名按北京时间，能还原回来", () => {
  assert.equal(offsiteBackupName(OCT4_0430), "nex-backup-20261004-0430.fwxbak");
  assert.equal(parseOffsiteBackupName("nex-backup-20261004-0430.fwxbak"), OCT4_0430);
  assert.equal(parseOffsiteBackupName("other.fwxbak"), null);
  assert.equal(parseOffsiteBackupName("nex-backup-20261004-0430.fwxbak.bak"), null);
});

test("保留最新 N 份，只动自己起名的文件", () => {
  const files = [
    { name: "nex-backup-20261001-0400.fwxbak", size: 1, modifiedAt: null },
    { name: "nex-backup-20261003-0400.fwxbak", size: 1, modifiedAt: null },
    { name: "my-notes.txt", size: 1, modifiedAt: null },
    { name: "nex-backup-20261002-0400.fwxbak", size: 1, modifiedAt: null },
    { name: "nex-backup-20261004-0400.fwxbak", size: 1, modifiedAt: 0 },
  ];
  assert.deepEqual(selectBackupsToDelete(files, 2).map((file) => file.name), [
    "nex-backup-20261002-0400.fwxbak",
    "nex-backup-20261001-0400.fwxbak",
  ]);
  assert.deepEqual(selectBackupsToDelete(files, 10), []);
  // 至少留一份
  assert.equal(selectBackupsToDelete(files, 0).length, 3);
});

test("每天固定时间：到点且今天还没成功才跑", () => {
  const schedule = { mode: "daily" as const, hour: 4 };
  const today4 = Date.UTC(2026, 9, 3, 20, 0);
  // 4:30，今天还没跑过
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: today4 - 24 * HOUR, lastAttemptAt: today4 - 24 * HOUR }), true);
  // 今天 4:01 已经成功
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: today4 + 60_000, lastAttemptAt: today4 + 60_000 }), false);
  // 3:30 还没到点：昨天 4 点之后成功过就不跑
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: today4 - 30 * 60_000, lastSuccessAt: today4 - 23 * HOUR, lastAttemptAt: today4 - 23 * HOUR }), false);
  // 今天 4:01 失败了：4:30 不重试，5:02 重试
  const failedAt = today4 + 60_000;
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: null, lastAttemptAt: failedAt }), false);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: failedAt + OFFSITE_BACKUP_RETRY_MS, lastSuccessAt: null, lastAttemptAt: failedAt }), true);
  // 从没跑过：立刻跑
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: null, lastAttemptAt: null }), true);
  // 下次：明天 4 点
  assert.equal(nextBackupAt(schedule, OCT4_0430, today4 + 60_000), today4 + 24 * HOUR);
  // 欠着没跑：下次就是现在；刚失败过：下次是失败后一小时的那次重试
  assert.equal(nextBackupAt(schedule, OCT4_0430, today4 - 24 * HOUR), OCT4_0430);
  assert.equal(nextBackupAt(schedule, OCT4_0430, today4 - 24 * HOUR, failedAt), failedAt + OFFSITE_BACKUP_RETRY_MS);
});

test("每 N 小时：距上次成功满 N 小时才跑", () => {
  const schedule = { mode: "interval" as const, everyHours: 6 };
  const last = OCT4_0430 - 5 * HOUR;
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: last, lastAttemptAt: last }), false);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: last + 6 * HOUR, lastSuccessAt: last, lastAttemptAt: last }), true);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: null, lastAttemptAt: null }), true);
  assert.equal(nextBackupAt(schedule, OCT4_0430, last), last + 6 * HOUR);
});

test("每天固定时间按面板时区算：北京时间 0 点到 8 点之间，UTC 还停在前一天", () => {
  const schedule = { mode: "daily" as const, hour: 2 };
  // 北京时间 10 月 5 日 02:10 = UTC 10 月 4 日 18:10
  const now = Date.UTC(2026, 9, 4, 18, 10);
  const slot = Date.UTC(2026, 9, 4, 18, 0);
  assert.equal(latestBackupSlot(schedule, now, null), slot);
  // 北京时间 10 月 5 日 01:50（UTC 10 月 4 日 17:50）还没到点：算 10 月 4 日 02:00 那一个
  assert.equal(latestBackupSlot(schedule, slot - 10 * 60_000, null), slot - 24 * HOUR);
  // 23 点的备份跨过北京时间的午夜也不会多跑：23:05 成功后，00:30 不到期，下一次是当天 23:00
  const late = { mode: "daily" as const, hour: 23 };
  const slot23 = Date.UTC(2026, 9, 4, 15, 0);
  const done = slot23 + 5 * 60_000;
  assert.equal(isOffsiteBackupDue({ schedule: late, nowMs: slot23 + 90 * 60_000, lastSuccessAt: done, lastAttemptAt: done }), false);
  assert.equal(nextBackupAt(late, slot23 + 90 * 60_000, done), slot23 + 24 * HOUR);
});

test("每周固定时间：只在那一天到点之后跑，一周一次", () => {
  // 2026-10-04 是周日。每周一 03:00（北京时间）
  const schedule = { mode: "weekly" as const, weekday: 1, hour: 3 };
  const monday3 = Date.UTC(2026, 9, 4, 19, 0); // 北京时间 10 月 5 日（周一）03:00
  // 周日 04:30：上一个时间点是上周一
  assert.equal(latestBackupSlot(schedule, OCT4_0430, null), monday3 - 7 * 24 * HOUR);
  // 周一 02:59 还没到点，03:00 到点
  assert.equal(latestBackupSlot(schedule, monday3 - 60_000, null), monday3 - 7 * 24 * HOUR);
  assert.equal(latestBackupSlot(schedule, monday3, null), monday3);
  // 上周一成功过：周日不跑，周一 03:10 跑
  const lastWeek = monday3 - 7 * 24 * HOUR + 5 * 60_000;
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: lastWeek, lastAttemptAt: lastWeek }), false);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: monday3 + 10 * 60_000, lastSuccessAt: lastWeek, lastAttemptAt: lastWeek }), true);
  // 这周一成功了：周三、周日都不再跑，下一次是下周一
  const done = monday3 + 12 * 60_000;
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: monday3 + 2 * 24 * HOUR, lastSuccessAt: done, lastAttemptAt: done }), false);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: monday3 + 6 * 24 * HOUR + 20 * HOUR, lastSuccessAt: done, lastAttemptAt: done }), false);
  assert.equal(nextBackupAt(schedule, monday3 + 2 * 24 * HOUR, done), monday3 + 7 * 24 * HOUR);
  // 周日（weekday 0）23 点：周日当天 22:00 算上周的，23:00 算今天的
  const sunday = { mode: "weekly" as const, weekday: 0, hour: 23 };
  const sunday23 = Date.UTC(2026, 9, 4, 15, 0);
  assert.equal(latestBackupSlot(sunday, sunday23 - HOUR, null), sunday23 - 7 * 24 * HOUR);
  assert.equal(latestBackupSlot(sunday, sunday23 + HOUR, null), sunday23);
});

test("面板停了好几天再起来：欠下的只补跑一次，不是一天补一份", () => {
  const today4 = Date.UTC(2026, 9, 3, 20, 0);
  const cases: OffsiteBackupSchedule[] = [
    { mode: "daily", hour: 4 },
    { mode: "weekly", weekday: 0, hour: 4 },
    { mode: "interval", everyHours: 6 },
  ];
  for (const schedule of cases) {
    // 上次成功是 20 天前，现在重启回来
    const stale = today4 - 20 * 24 * HOUR;
    assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: stale, lastAttemptAt: stale }), true, schedule.mode);
    // 补跑成功之后，接下来十分钟一次的检查都不再到期
    const done = OCT4_0430 + 60_000;
    for (const later of [10, 20, 60, 180]) {
      assert.equal(isOffsiteBackupDue({ schedule, nowMs: done + later * 60_000, lastSuccessAt: done, lastAttemptAt: done }), false, `${schedule.mode} +${later}min`);
    }
  }
});

test("开跑时就记了「试过」：中途被杀或另一个进程来看，一小时内不重来", () => {
  const schedule = { mode: "daily" as const, hour: 4 };
  const today4 = Date.UTC(2026, 9, 3, 20, 0);
  const startedAt = today4 + 5 * 60_000;
  const yesterday = today4 - 24 * HOUR + 60_000;
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: startedAt + 10 * 60_000, lastSuccessAt: yesterday, lastAttemptAt: startedAt }), false);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: startedAt + OFFSITE_BACKUP_RETRY_MS, lastSuccessAt: yesterday, lastAttemptAt: startedAt }), true);
  // 同一个小时里抢的是同一个标记，下一个小时换一个；结尾带日期，方便一周后清掉
  assert.equal(offsiteBackupClaimKey(today4 + 1), offsiteBackupClaimKey(today4 + 59 * 60_000));
  assert.notEqual(offsiteBackupClaimKey(today4), offsiteBackupClaimKey(today4 + HOUR));
  assert.match(offsiteBackupClaimKey(today4), /^opsBackupRun:\d+:2026-10-03$/);
});

test("连续失败只在第一次和之后每满一天各记一条事件", () => {
  const first = Date.UTC(2026, 9, 3, 20, 5);
  assert.equal(shouldReportBackupFailure({ streak: 1, lastReportedAt: null, nowMs: first }), true);
  // 上一轮失败留下的「记过」时间不算数：新一轮的第一次照样要记
  assert.equal(shouldReportBackupFailure({ streak: 1, lastReportedAt: first - HOUR, nowMs: first }), true);
  for (let n = 2; n <= 24; n += 1) {
    assert.equal(shouldReportBackupFailure({ streak: n, lastReportedAt: first, nowMs: first + (n - 1) * HOUR }), false, `第 ${n} 次`);
  }
  assert.equal(shouldReportBackupFailure({ streak: 25, lastReportedAt: first, nowMs: first + OFFSITE_BACKUP_FAILURE_REPORT_MS }), true);
});

test("WebDAV PROPFIND：不同前缀、自闭合标签、目录自身", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">
  <D:response>
    <D:href>/dav/nex/</D:href>
    <D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype><lp1:getlastmodified>Sat, 03 Oct 2026 20:00:00 GMT</lp1:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>https://dav.example.com/dav/nex/nex-backup-20261004-0400.fwxbak</D:href>
    <D:propstat><D:prop><lp1:resourcetype/><lp1:getcontentlength>2048</lp1:getcontentlength><lp1:getlastmodified>Sat, 03 Oct 2026 20:00:05 GMT</lp1:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    <D:propstat><D:prop><D:quota-used-bytes/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
  <d:response xmlns:d="DAV:">
    <d:href>/dav/nex/%E5%A4%87%E4%BB%BD%20a.txt</d:href>
    <d:propstat><d:prop><d:resourcetype></d:resourcetype><d:getcontentlength>3</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</D:multistatus>`;
  const entries = parseWebdavPropfind(xml);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].isCollection, true);
  assert.equal(entries[0].name, "nex");
  assert.equal(entries[1].name, "nex-backup-20261004-0400.fwxbak");
  assert.equal(entries[1].size, 2048);
  assert.equal(entries[1].isCollection, false);
  assert.equal(entries[1].modifiedAt, Date.UTC(2026, 9, 3, 20, 0, 5));
  assert.equal(entries[2].name, "备份 a.txt");
  assert.equal(entries[2].modifiedAt, null);
});

test("WebDAV 地址拼接", () => {
  assert.equal(webdavFolderUrl("https://dav.example.com/dav/nex"), "https://dav.example.com/dav/nex/");
  assert.equal(webdavFileUrl("https://dav.example.com/dav/nex/", "a b.fwxbak"), "https://dav.example.com/dav/nex/a%20b.fwxbak");
});
