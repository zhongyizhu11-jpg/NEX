import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { OFFICIAL_UI_THEME_IDS, UI_THEME_LIMITS, uiThemeStarterFiles } from "../shared/uiThemePackage";
import {
  UiThemePackageError,
  buildUiThemePackage,
  compileUiThemeCss,
  crc32,
  parseUiThemeArchive,
  readUiThemeArchive,
  writeZip,
} from "./uiThemePackage";

/*
  主题包的读包和样式检查。主题是管理员装的，样式却进每个访客的浏览器，包又经常来自网上：
  这里守的是「坏包装不上」和「装上的样式发不出外网请求」。
*/

const MANIFEST = JSON.stringify({ apiVersion: 1, id: "my-theme", name: "我的主题", version: "1.0.0" });
const CSS = 'html[data-ui-theme="my-theme"] { --fx-l0-page: #fff; }';

/** 手工拼一个 ZIP，能指定每个条目的压缩方式、标志位、权限位和声明的大小 —— writeZip 只会写规矩的包。 */
function craftZip(entries: Array<{ name: string; content: Buffer | string; deflate?: boolean; flags?: number; mode?: number; declaredSize?: number }>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const data = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((entry.mode ?? 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function craftTar(entries: Array<{ name: string; content?: string; type?: string }>) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "latin1");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "latin1");
    header.write(entry.type ?? "0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function rejects(work: () => unknown, pattern: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof UiThemePackageError, `要抛 UiThemePackageError，实际是 ${String(error)}`);
    assert.match((error as Error).message, pattern);
    return true;
  });
}

test("ZIP：只存的、Deflate 压缩的都读得出来；写出来的包自己读得回去", () => {
  const stored = writeZip({ "theme.json": MANIFEST, "theme.css": CSS, "assets/readme.txt": "hi" });
  assert.deepEqual([...readUiThemeArchive(stored).keys()], ["theme.json", "theme.css", "assets/readme.txt"]);
  assert.equal(readUiThemeArchive(stored).get("theme.css")?.toString(), CSS);
  // 同样的内容打出来逐字节相同（时间戳是固定的）
  assert.deepEqual(writeZip({ "theme.json": MANIFEST, "theme.css": CSS, "assets/readme.txt": "hi" }), stored);

  const deflated = craftZip([
    { name: "theme.json", content: MANIFEST, deflate: true },
    { name: "theme.css", content: CSS.repeat(200), deflate: true },
    { name: "assets/", content: "", mode: 0o040755 },
  ]);
  const files = readUiThemeArchive(deflated);
  assert.deepEqual([...files.keys()], ["theme.json", "theme.css"]);
  assert.equal(files.get("theme.css")?.toString(), CSS.repeat(200));
  assert.equal(parseUiThemeArchive(deflated).manifest.id, "my-theme");
});

test("TAR / TAR.GZ 读得出来；外面套了一层目录的包自动去掉那一层", () => {
  const tar = craftTar([
    { name: "PaxHeader", content: "13 path=x\n", type: "x" },
    { name: "my-theme/", type: "5" },
    { name: "my-theme/theme.json", content: MANIFEST },
    { name: "my-theme/theme.css", content: CSS },
  ]);
  assert.deepEqual([...readUiThemeArchive(tar).keys()], ["theme.json", "theme.css"]);
  assert.deepEqual([...readUiThemeArchive(zlib.gzipSync(tar)).keys()], ["theme.json", "theme.css"]);
  // 根目录就有 theme.json 的不动；两个顶层目录的也不动（那就是放错了，让它报「没有 theme.json」）
  assert.deepEqual([...readUiThemeArchive(writeZip({ "theme.json": MANIFEST, "sub/theme.css": CSS })).keys()], ["theme.json", "sub/theme.css"]);
  rejects(() => parseUiThemeArchive(writeZip({ "a/theme.json": MANIFEST, "b/theme.css": CSS })), /根目录里没有 theme\.json/);
});

test("坏包装不上：认不出的格式、加密、链接、往外跳的路径、重名、不支持的文件、ZIP64", () => {
  rejects(() => readUiThemeArchive(Buffer.alloc(0)), /空的/);
  rejects(() => readUiThemeArchive(Buffer.from("not an archive at all")), /认不出这个文件/);
  rejects(() => readUiThemeArchive(Buffer.from("PK\u0003\u0004 truncated")), /读不了这个 ZIP/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "theme.json", content: MANIFEST, flags: 0x1 }])), /不能加密/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "link.css", content: "theme.css", mode: 0o120777 }])), /链接或特殊文件/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "../evil.css", content: CSS }])), /不安全的路径/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "/etc/theme.css", content: CSS }])), /不安全的路径/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "a.css", content: CSS }, { name: "A.CSS", content: CSS }])), /重名/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "evil.js", content: "alert(1)" }])), /不支持的文件/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "page.html", content: "<script>" }])), /不支持的文件/);
  rejects(() => readUiThemeArchive(craftTar([{ name: "theme.css", type: "2", content: "" }])), /链接或特殊文件/);
  rejects(() => readUiThemeArchive(craftTar([{ name: "../theme.css", content: CSS }])), /不安全的路径/);
  rejects(() => readUiThemeArchive(craftZip([{ name: "theme.css", content: CSS, declaredSize: 0xffffffff }])), /ZIP64/);
});

test("压缩炸弹：声明的大小不信，真解出来超过上限就停；校验和对不上的不要", () => {
  // 声明只有 10 字节，实际解出来 5MB（超过单文件 4MB 的上限）
  const bomb = craftZip([{ name: "theme.css", content: Buffer.alloc(5 * 1024 * 1024, 0x20), deflate: true, declaredSize: 10 }]);
  assert.ok(bomb.length < 64 * 1024, "压缩后很小");
  rejects(() => readUiThemeArchive(bomb), /解不开|校验不通过/);
  // 声明的大小超过上限：不解压直接拒绝
  rejects(() => readUiThemeArchive(craftZip([{ name: "theme.css", content: "x", declaredSize: UI_THEME_LIMITS.fileBytes + 1 }])), /太大/);
  // 内容被改过（声明大小和实际不符）
  rejects(() => readUiThemeArchive(craftZip([{ name: "theme.css", content: CSS, declaredSize: CSS.length - 1 }])), /校验不通过/);
  // 文件太多
  const many = Object.fromEntries(Array.from({ length: UI_THEME_LIMITS.files + 1 }, (_, index) => [`f${index}.txt`, "x"]));
  rejects(() => readUiThemeArchive(writeZip(many)), /文件太多/);
  // gzip 炸弹
  rejects(() => readUiThemeArchive(zlib.gzipSync(Buffer.alloc(UI_THEME_LIMITS.expandedBytes + 4 * 1024 * 1024))), /解不开/);
  rejects(() => readUiThemeArchive(Buffer.alloc(UI_THEME_LIMITS.archiveBytes + 1, 0x50)), /不能超过/);
});

test("样式：去掉注释，普通写法原样保留", () => {
  const css = compileUiThemeCss(`
    /* 说明 */
    @media (min-width: 640px) {
      html[data-ui-theme="my-theme"] .md\\:grid > .w-1\\/2 { content: "a \\201C b } /* 不是注释 */"; margin: -1px; color: #fff; }
    }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    html.dark[data-ui-theme="my-theme"] { --fx-page: rgb(0 0 0 / 50%); background: linear-gradient(135deg, #111, #222); }
  `);
  assert.doesNotMatch(css, /说明/);
  assert.match(css, /\.md\\:grid > \.w-1\\\/2/);
  assert.match(css, /content: "a \\201C b \} \/\* 不是注释 \*\/"/, "字符串里的东西一个字都不动");
  assert.match(css, /@keyframes spin/);
  assert.match(css, /linear-gradient\(135deg, #111, #222\)/);
});

test("样式里的 url()：包里的文件内联成 data:，面板自己的字体、data: 图片、#片段放行", () => {
  const files = new Map<string, Buffer>([
    ["css/img/bg.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["fonts/a.woff2", Buffer.from("font")],
  ]);
  const css = compileUiThemeCss(`
    html[data-ui-theme="my-theme"] { background: url(img/bg.png); mask: url( "#mask-1" ); }
    @font-face { font-family: A; src: url('../fonts/a.woff2') format("woff2"), url("/fonts/inter-latin-variable.woff2"); }
    html[data-ui-theme="my-theme"] i { background: URL("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>"); }
  `, { stylesheet: "css/theme.css", files });
  assert.match(css, /background: url\("data:image\/png;base64,iVBORw=="\)/);
  assert.match(css, /url\("data:font\/woff2;base64,Zm9udA=="\) format\("woff2"\)/);
  assert.match(css, /url\("\/fonts\/inter-latin-variable\.woff2"\)/);
  assert.match(css, /mask: url\("#mask-1"\)/);
  assert.match(css, /url\("data:image\/svg\+xml;utf8,<svg/);
});

test("样式里发不出外网请求：外链、@import、能带地址的函数、转义绕过，一律拒绝", () => {
  const bad: Array<[string, RegExp]> = [
    ['a { background: url(https://evil.example/x.png); }', /不能引用外部地址/],
    ['a { background: url("//evil.example/x.png"); }', /不能引用外部地址/],
    ['a { background: url(/api/trpc/auth.logout); }', /不能引用外部地址/],
    ['a { background: url(img.png?x=1); }', /不能引用外部地址/],
    ['a { background: url(missing.png); }', /不在包里/],
    ['a { background: url(../../etc/passwd.png); }', /不在包里/],
    ['a { background: url(data:text/html;base64,PHNjcmlwdD4=); }', /只能是图片或字体/],
    ['a { background: url("a\\62.png"); }', /不能有转义/],
    ['@import "https://evil.example/x.css";', /不支持 @import/],
    ['@IMPORT url(x.css);', /不支持 @import/],
    ['@namespace svg url(http://www.w3.org/2000/svg);', /不支持 @namespace/],
    ['a { background: image-set("https://evil.example/x.png" 1x); }', /不支持 image-set\(\)/],
    ['a { background: -webkit-image-set(url(x.png) 1x); }', /不支持 -webkit-image-set\(\)/],
    ['a { width: expression(alert(1)); }', /不支持 expression\(\)/],
    ['@font-face { font-family: A; src: src("https://evil.example/a.woff2"); }', /不支持 src\(\)/],
    // \75 是 u：不拦转义的话，下面这条就是一个漏网的 url()
    ['a { background: \\75rl(https://evil.example/x.png); }', /反斜杠只能用来转义/],
    ['a { background: u\\rl(https://evil.example/x.png); }', /反斜杠只能用来转义/],
    ['@\\69mport "x.css";', /反斜杠只能用来转义|不支持 @/],
    ['a { behavior: url(x.htc); }', /不在包里|不支持的属性/],
    ['a { -moz-binding: none; }', /不支持的属性/],
    ['a { color: red; } </style><script>alert(1)</script>', /不能有 HTML 标签/],
    ['a { color: red; ', /花括号不配对/],
    ['a { color: red; } }', /花括号不配对/],
    ['a { color: red; } /* 没收尾', /没收尾的注释/],
    ['a { content: "没收尾; }', /没收尾的字符串/],
    ['a { background: url(x.png', /没有收尾|不在包里/],
    ['/* 只有注释 */', /是空的/],
    [`a { color: red; }${" ".repeat(UI_THEME_LIMITS.cssBytes)}`, /太大/],
  ];
  for (const [source, pattern] of bad) rejects(() => compileUiThemeCss(source), pattern);
});

test("引用的图片和字体加起来有上限", () => {
  const big = Buffer.alloc(UI_THEME_LIMITS.fileBytes, 1);
  const files = new Map<string, Buffer>([["a.png", big], ["b.png", big]]);
  rejects(() => compileUiThemeCss("a { background: url(a.png), url(b.png); }", { files }), /加起来太大/);
});

test("一个完整的包：清单 + 样式 → 主题；revision 跟着内容变", () => {
  const first = buildUiThemePackage(new Map([["theme.json", Buffer.from(MANIFEST)], ["theme.css", Buffer.from(CSS)]]));
  assert.equal(first.manifest.id, "my-theme");
  assert.equal(first.css.trim(), CSS);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  const again = parseUiThemeArchive(writeZip({ "theme.json": MANIFEST, "theme.css": CSS }));
  assert.equal(again.revision, first.revision, "同样的内容 revision 相同");
  const changed = parseUiThemeArchive(writeZip({ "theme.json": MANIFEST, "theme.css": `${CSS} html[data-ui-theme="my-theme"] b { color: red; }` }));
  assert.notEqual(changed.revision, first.revision);

  rejects(() => parseUiThemeArchive(writeZip({ "theme.css": CSS })), /没有 theme\.json/);
  rejects(() => parseUiThemeArchive(writeZip({ "theme.json": "{ not json", "theme.css": CSS })), /不是合法的 JSON/);
  rejects(() => parseUiThemeArchive(writeZip({ "theme.json": JSON.stringify({ apiVersion: 1, id: "classic", name: "x", version: "1.0.0" }), "theme.css": CSS })), /和内置主题重名/);
  rejects(() => parseUiThemeArchive(writeZip({ "theme.json": MANIFEST })), /找不到 theme\.json 指定的样式文件/);
  rejects(() => parseUiThemeArchive(writeZip({ "theme.json": MANIFEST, "theme.css": Buffer.from([0xff, 0xfe, 0xfd]) })), /不是 UTF-8/);
});

test("开发模板和官方主题库里的每一套都装得上", () => {
  const starter = buildUiThemePackage(new Map(Object.entries(uiThemeStarterFiles()).map(([name, content]) => [name, Buffer.from(content)])));
  assert.equal(starter.manifest.id, "my-theme");
  const root = path.resolve(import.meta.dirname, "../themes/official");
  for (const id of OFFICIAL_UI_THEME_IDS) {
    const files = new Map<string, Buffer>();
    for (const name of fs.readdirSync(path.join(root, id))) files.set(name, fs.readFileSync(path.join(root, id, name)));
    const built = buildUiThemePackage(files);
    assert.equal(built.manifest.id, id, `themes/official/${id}/theme.json 的 id 要和目录名一致`);
    assert.equal(built.manifest.author, "NEX");
    assert.ok(built.manifest.description.length > 10, `${id} 要有说明`);
    assert.doesNotMatch(built.css, /\/\*/, "下发的样式不带注释");
    assert.ok(built.css.includes(`[data-ui-theme="${id}"]`));
  }
});
