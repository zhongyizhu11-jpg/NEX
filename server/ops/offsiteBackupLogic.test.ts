import assert from "node:assert/strict";
import test from "node:test";

import {
  isOffsiteBackupDue,
  nextBackupAt,
  offsiteBackupName,
  OFFSITE_BACKUP_RETRY_MS,
  parseOffsiteBackupName,
  selectBackupsToDelete,
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
});

test("每 N 小时：距上次成功满 N 小时才跑", () => {
  const schedule = { mode: "interval" as const, everyHours: 6 };
  const last = OCT4_0430 - 5 * HOUR;
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: last, lastAttemptAt: last }), false);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: last + 6 * HOUR, lastSuccessAt: last, lastAttemptAt: last }), true);
  assert.equal(isOffsiteBackupDue({ schedule, nowMs: OCT4_0430, lastSuccessAt: null, lastAttemptAt: null }), true);
  assert.equal(nextBackupAt(schedule, OCT4_0430, last), last + 6 * HOUR);
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
