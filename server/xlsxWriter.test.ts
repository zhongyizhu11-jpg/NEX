import assert from "node:assert/strict";
import test from "node:test";
import { buildXlsx, columnLetter, escapeXml, looksLikeFormula } from "./xlsxWriter";
import { assertWellFormedXml, readZipEntries } from "./testing/zipReader";
import { writeZipArchive } from "./zipArchive";

test("xlsx 包含必需的部件，每份 XML 都是良构的", () => {
  const file = buildXlsx([
    { name: "账单流水", columns: [{ header: "时间", type: "datetime" }, { header: "说明" }, { header: "金额", type: "money" }], rows: [[new Date("2026-01-01T00:00:00Z"), "<b>&\"'", 12.345]] },
    { name: "余额流水", columns: [{ header: "金额", type: "money" }], rows: [] },
  ], { now: new Date("2026-01-01T00:00:00Z") });
  const files = readZipEntries(file);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "docProps/core.xml", "docProps/app.xml"]) {
    assert.ok(files.has(name), `${name} missing`);
  }
  for (const [name, content] of files) assertWellFormedXml(content.toString("utf8"), name);
  const workbook = files.get("xl/workbook.xml")!.toString("utf8");
  assert.match(workbook, /<sheet name="账单流水" sheetId="1" r:id="rId1"\/>/);
  assert.match(workbook, /<sheet name="余额流水" sheetId="2" r:id="rId2"\/>/);
  const sheet = files.get("xl/worksheets/sheet1.xml")!.toString("utf8");
  // 冻结表头、列宽、筛选
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<cols><col min="1" max="1" width="20" customWidth="1"\/>/);
  assert.match(sheet, /<autoFilter ref="A1:C2"\/>/);
  // 表头用加粗 + 底色的样式 1
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">时间<\/t><\/is><\/c>/);
  // 金额是数字（两位小数的格式），不是文字
  assert.match(sheet, /<c r="C2" s="2"><v>12.35<\/v><\/c>/);
  // 日期是真日期：2026-01-01 08:00:00 北京时间
  const serial = Number(/<c r="A2" s="5"><v>([\d.]+)<\/v>/.exec(sheet)?.[1]);
  assert.ok(Math.abs(serial - (46023 + 8 / 24)) < 1e-6, String(serial));
  assert.match(sheet, /&lt;b&gt;&amp;&quot;&apos;/);
  const styles = files.get("xl/styles.xml")!.toString("utf8");
  assert.match(styles, /<font><b\/>/);
  assert.match(styles, /patternType="solid"/);
  assert.match(styles, /formatCode="yyyy-mm-dd hh:mm:ss"/);
  assert.match(styles, /numFmtId="4"/);
});

test("以 = + - @ 开头的文字写成带前导单引号样式的内联字符串，从不写公式", () => {
  const file = buildXlsx([{
    name: "t",
    columns: [{ header: "a" }, { header: "b" }, { header: "c" }, { header: "d" }, { header: "e" }],
    rows: [["=HYPERLINK(\"http://x\",\"y\")", "+1", "-2", "@SUM(A1)", "正常"]],
  }]);
  const sheet = readZipEntries(file).get("xl/worksheets/sheet1.xml")!.toString("utf8");
  assert.doesNotMatch(sheet, /<f>|<f /);
  assert.match(sheet, /<c r="A2" t="inlineStr" s="4"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/x&quot;,&quot;y&quot;\)<\/t><\/is><\/c>/);
  for (const ref of ["B2", "C2", "D2"]) assert.match(sheet, new RegExp(`<c r="${ref}" t="inlineStr" s="4">`));
  assert.match(sheet, /<c r="E2" t="inlineStr"><is>/);
  const styles = readZipEntries(file).get("xl/styles.xml")!.toString("utf8");
  assert.match(styles, /quotePrefix="1"/);
});

test("XML 转义去掉非法控制字符和落单的代理项", () => {
  assert.equal(escapeXml("a\u0001b\u0008c\uD800d"), "abcd");
  assert.equal(escapeXml("x\ty\nz"), "x\ty\nz");
  assert.equal(escapeXml("😀"), "😀");
  assert.ok(looksLikeFormula("=1"));
  assert.ok(looksLikeFormula("\t=1"));
  assert.ok(!looksLikeFormula("1=1"));
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(701), "ZZ");
  assert.equal(columnLetter(702), "AAA");
});

test("工作表名去掉非法字符、截到 31 个字符、不重名", () => {
  const file = buildXlsx([
    { name: "a/b:c*d?e[f]g\\h", columns: [{ header: "x" }], rows: [] },
    { name: "x".repeat(40), columns: [{ header: "x" }], rows: [] },
    { name: "x".repeat(40), columns: [{ header: "x" }], rows: [] },
  ]);
  const workbook = readZipEntries(file).get("xl/workbook.xml")!.toString("utf8");
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(names[0], "a b c d e f g h");
  assert.equal(names[1], "x".repeat(31));
  assert.notEqual(names[2], names[1]);
  assert.ok(names[2].length <= 31);
});

test("ZIP：deflate 压缩可被解开，只存模式和原来逐字节相同", () => {
  const big = "<row>".repeat(10_000);
  const compressed = writeZipArchive({ "a.xml": big }, { deflate: true });
  assert.ok(compressed.length < big.length / 10);
  assert.equal(readZipEntries(compressed).get("a.xml")!.toString("utf8"), big);
  assert.deepEqual(writeZipArchive({ "a.txt": "hi" }), writeZipArchive({ "a.txt": "hi" }));
  assert.throws(() => writeZipArchive({ "../x": "no" }), /invalid zip entry name/);
});
