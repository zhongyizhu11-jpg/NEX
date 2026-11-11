import { billingCalendarParts } from "../shared/billingTime";
import { writeZipArchive } from "./zipArchive";

/*
  最小的 .xlsx 写入（账单 Excel 导出用，上游 2.3.286）。

  不为导出几张表引一个 Excel 库：xlsx 就是一个 ZIP，里面几份 XML。这里只写用得到的那几样 ——
  工作簿、每张表一份工作表、样式表、内容类型和关系文件 —— 字符串一律用内联字符串（inlineStr），
  不建共享字符串表，也从来不写公式（<f>）。

  安全上两件事：
    · XML 转义：& < > " ' 转成实体，XML 1.0 不允许的控制字符和落单的代理项直接去掉 ——
      留着的话 Excel 会报「文件已损坏」，用户名、订单标题都是用户自己能填的。
    · 公式注入：以 = + - @（以及制表符、回车）开头的文字，Excel 打开 CSV 时会当公式算。
      这里本来就只写内联字符串，不会被算；再给这些格子加上 quotePrefix（相当于手敲的前导单引号），
      用户把表另存成 CSV 再打开时也还是文字。
*/

export type XlsxCellValue = string | number | boolean | Date | null | undefined;
export type XlsxColumnType = "text" | "money" | "integer" | "datetime";
export type XlsxColumn = { header: string; width?: number; type?: XlsxColumnType };
export type XlsxSheet = { name: string; columns: XlsxColumn[]; rows: XlsxCellValue[][] };

/** Excel 单元格最多 32767 个字符，超了打开时报错。 */
const MAX_CELL_TEXT = 32_767;

const STYLE = {
  default: 0,
  header: 1,
  money: 2,
  integer: 3,
  textQuoted: 4,
  datetime: 5,
} as const;

const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(value: string) {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 会被表格软件当成公式开头的字符。 */
export function looksLikeFormula(text: string) {
  return /^[=+\-@\t\r]/.test(text);
}

export function columnLetter(index: number) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** 工作表名：最多 31 个字符，不能有 []:*?/\，不能重名（重名的后面加序号）。 */
function sheetNames(sheets: XlsxSheet[]) {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const base = (sheet.name.replace(/[[\]:*?/\\]/g, " ").replace(INVALID_XML_CHARS, "").trim() || `Sheet${index + 1}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)}_${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** 时间写成真的日期（北京时间），配上 yyyy-mm-dd hh:mm:ss 的格式：能排序、能筛选。 */
function excelSerial(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const p = billingCalendarParts(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 86_400_000 + 25_569;
}

function inlineString(ref: string, text: string, style: number) {
  const clipped = text.length > MAX_CELL_TEXT ? text.slice(0, MAX_CELL_TEXT) : text;
  const quoted = looksLikeFormula(clipped);
  const s = quoted ? STYLE.textQuoted : style;
  return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ""}><is><t xml:space="preserve">${escapeXml(clipped)}</t></is></c>`;
}

function cellXml(ref: string, value: XlsxCellValue, type: XlsxColumnType) {
  if (value === null || value === undefined || value === "") return "";
  if (type === "datetime" && (value instanceof Date || typeof value === "string" || typeof value === "number")) {
    const serial = excelSerial(value);
    if (serial !== null) return `<c r="${ref}" s="${STYLE.datetime}"><v>${serial}</v></c>`;
  }
  if ((type === "money" || type === "integer") && typeof value === "number" && Number.isFinite(value)) {
    const number = type === "money" ? Math.round(value * 100) / 100 : Math.round(value);
    return `<c r="${ref}" s="${type === "money" ? STYLE.money : STYLE.integer}"><v>${number}</v></c>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return inlineString(ref, value ? "是" : "否", STYLE.default);
  const text = value instanceof Date ? value.toISOString() : String(value);
  return inlineString(ref, text, STYLE.default);
}

function sheetXml(sheet: XlsxSheet) {
  const columnCount = Math.max(1, sheet.columns.length);
  const lastColumn = columnLetter(columnCount - 1);
  const lastRow = sheet.rows.length + 1;
  const cols = sheet.columns.map((column, index) => {
    const width = Math.max(4, Math.min(80, Number(column.width) || (column.type === "datetime" ? 20 : 14)));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const parts: string[] = [];
  parts.push(`<row r="1">${sheet.columns.map((column, index) => inlineString(`${columnLetter(index)}1`, column.header, STYLE.header)).join("")}</row>`);
  sheet.rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    let cells = "";
    for (let index = 0; index < sheet.columns.length; index += 1) {
      cells += cellXml(`${columnLetter(index)}${r}`, row[index], sheet.columns[index].type || "text");
    }
    parts.push(`<row r="${r}">${cells}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<dimension ref="A1:${lastColumn}${lastRow}"/>`
    // 冻结表头：往下翻几千行时还看得到每列是什么
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="16"/>`
    + (cols ? `<cols>${cols}</cols>` : "")
    + `<sheetData>${parts.join("")}</sheetData>`
    + `<autoFilter ref="A1:${lastColumn}${lastRow}"/>`
    + `</worksheet>`;
}

// 样式表的顺序就是 STYLE 里的下标：0 默认、1 表头（加粗 + 底色 + 下边框）、2 金额 #,##0.00、3 整数、
// 4 带前导单引号的文字、5 日期时间。
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font></fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="6">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
  + `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>`
  + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `</cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
  + `</styleSheet>`;

/** 生成 .xlsx 文件内容。至少要一张表。 */
export function buildXlsx(sheets: XlsxSheet[], options: { now?: Date } = {}): Buffer {
  if (sheets.length === 0) throw new Error("xlsx needs at least one sheet");
  const names = sheetNames(sheets);
  const created = (options.now || new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<bookViews><workbookView/></bookViews>`
    + `<sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>`
    // 筛选范围要配一个隐藏的 _FilterDatabase 名字，Excel 自己存的文件都带着
    + `<definedNames>${sheets.map((sheet, index) => {
      const lastColumn = columnLetter(Math.max(1, sheet.columns.length) - 1);
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">${escapeXml(`${quoteSheet(names[index])}!$A$1:$${lastColumn}$${sheet.rows.length + 1}`)}</definedName>`;
    }).join("")}</definedNames>`
    + `</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + names.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + names.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
    + `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`
    + `</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>`
    + `</Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:creator>NEX</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>`
    + `</cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>NEX</Application></Properties>`;
  const entries: Array<[string, string]> = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["docProps/core.xml", core],
    ["docProps/app.xml", app],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", workbookRels],
    ["xl/styles.xml", STYLES_XML],
    ...sheets.map((sheet, index): [string, string] => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)]),
  ];
  return writeZipArchive(entries, { deflate: true });
}
