import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_UI_THEME_IDS,
  DEFAULT_UI_THEME_PREVIEW,
  OFFICIAL_UI_THEME_IDS,
  UI_THEME_LIMITS,
  UiThemeManifestError,
  compareUiThemeVersions,
  isSafeUiThemePath,
  isValidUiThemePackageId,
  normalizeUiThemePreview,
  parseUiThemeManifest,
  resolveUiThemeId,
  uiThemeStarterFiles,
} from "./uiThemePackage";

const manifest = (patch: Record<string, unknown> = {}) => ({ apiVersion: 1, id: "my-theme", name: "我的主题", version: "1.2.3", ...patch });

test("主题包 id：小写字母开头，字母 / 数字 / 连字符，3～32 个字符，不和内置的重名", () => {
  for (const id of ["gilt", "deepspace", "my-theme", "abc", "t2-dark", `a${"b".repeat(31)}`]) assert.equal(isValidUiThemePackageId(id), true, id);
  for (const id of ["", "ab", "Gilt", "1theme", "my_theme", "my theme", "-theme", "theme-", "my--theme", `a${"b".repeat(32)}`, "classic", "pearl", "liquid-glass", "../x", "a.b"]) {
    assert.equal(isValidUiThemePackageId(id), false, id);
  }
  // 官方主题库里的 id 都得是合法的主题包 id，而且不和内置的撞
  for (const id of OFFICIAL_UI_THEME_IDS) assert.equal(isValidUiThemePackageId(id), true, id);
  assert.equal(OFFICIAL_UI_THEME_IDS.some((id) => (BUILTIN_UI_THEME_IDS as readonly string[]).includes(id)), false);
});

test("theme.json：缺的字段有默认值，不认识的字段忽略，文字去掉控制字符", () => {
  const parsed = parseUiThemeManifest(manifest({ description: "第一行\n第二行\u0007", author: "  me  ", homepage: "javascript:alert(1)", future: { anything: true } }));
  assert.deepEqual(parsed, {
    apiVersion: 1,
    id: "my-theme",
    name: "我的主题",
    version: "1.2.3",
    description: "第一行 第二行",
    author: "me",
    homepage: "",
    stylesheet: "theme.css",
    preview: { light: DEFAULT_UI_THEME_PREVIEW.light, dark: DEFAULT_UI_THEME_PREVIEW.dark },
  });
  assert.equal(parseUiThemeManifest(manifest({ homepage: "https://example.com/t" })).homepage, "https://example.com/t");
  assert.equal(parseUiThemeManifest(manifest({ stylesheet: "css/main.css" })).stylesheet, "css/main.css");
  assert.equal(parseUiThemeManifest(manifest({ version: "2.0.0-beta.1" })).version, "2.0.0-beta.1");
});

test("theme.json：写得不对的给出能照着改的提示", () => {
  const rejectsRaw = (raw: unknown, pattern: RegExp) => {
    assert.throws(() => parseUiThemeManifest(raw), (error: unknown) => {
      assert.ok(error instanceof UiThemeManifestError);
      assert.match((error as Error).message, pattern);
      return true;
    });
  };
  const rejects = (patch: Record<string, unknown>, pattern: RegExp) => rejectsRaw(manifest(patch), pattern);
  rejectsRaw(null, /必须是一个对象/);
  rejectsRaw([], /必须是一个对象/);
  rejects({ apiVersion: 2 }, /apiVersion 必须是 1/);
  rejects({ id: "pearl" }, /和内置主题重名/);
  rejects({ id: "My Theme" }, /小写字母、数字和连字符/);
  rejects({ name: "   " }, /缺少 name/);
  rejects({ version: "v1" }, /三段版本号/);
  rejects({ stylesheet: "../theme.css" }, /stylesheet/);
  rejects({ stylesheet: "/etc/passwd" }, /stylesheet/);
  rejects({ stylesheet: "theme.js" }, /stylesheet/);
});

test("预览色：只收十六进制色，别的回到默认；深色没给强调色时沿用浅色的", () => {
  assert.deepEqual(normalizeUiThemePreview(undefined), DEFAULT_UI_THEME_PREVIEW);
  const preview = normalizeUiThemePreview({
    light: { page: "#FAFAFA", card: "red", accent: "#123" },
    dark: { page: "url(https://evil.example/x)", card: "#11223344" },
  });
  assert.deepEqual(preview.light, { page: "#fafafa", card: "#ffffff", accent: "#123" });
  assert.deepEqual(preview.dark, { page: "#1e1e1e", card: "#11223344", accent: "#123" });
});

test("压缩包里的路径：只收相对路径，不许往外跳", () => {
  for (const name of ["theme.json", "assets/bg.webp", "a/b/c.css", "font_1.woff2"]) assert.equal(isSafeUiThemePath(name), true, name);
  for (const name of ["", "/theme.css", "../theme.css", "a/../b.css", "a//b.css", "./a.css", "a b.css", "a\\b.css", "C:/x.css", "a/", `${"a".repeat(201)}`]) {
    assert.equal(isSafeUiThemePath(name), false, name);
  }
});

test("存着的主题 id：内置的一直能用，主题包要装着，别的回到经典", () => {
  assert.equal(resolveUiThemeId("pearl"), "pearl");
  assert.equal(resolveUiThemeId("gilt"), "classic");
  assert.equal(resolveUiThemeId("gilt", ["rose", "gilt"]), "gilt");
  assert.equal(resolveUiThemeId(" gilt ", new Set(["gilt"])), "gilt");
  assert.equal(resolveUiThemeId(null, ["gilt"]), "classic");
});

test("版本号比较只看三段数字", () => {
  assert.ok(compareUiThemeVersions("1.2.0", "1.10.0") < 0);
  assert.ok(compareUiThemeVersions("2.0.0", "1.99.99") > 0);
  assert.equal(compareUiThemeVersions("1.0.0-beta", "1.0.0"), 0);
});

test("开发模板：清单自己过得了校验，样式都写在自己的 data-ui-theme 下面", () => {
  const files = uiThemeStarterFiles("starter-demo");
  assert.deepEqual(Object.keys(files).sort(), ["README.md", "theme.css", "theme.json"]);
  const parsed = parseUiThemeManifest(JSON.parse(files["theme.json"]));
  assert.equal(parsed.id, "starter-demo");
  assert.notDeepEqual(parsed.preview, DEFAULT_UI_THEME_PREVIEW, "模板带着自己的预览色");
  const rules = files["theme.css"].replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^\s@}][^{]*\{/gm) || [];
  assert.ok(rules.length >= 2);
  for (const rule of rules) assert.match(rule, /^html(\.dark)?\[data-ui-theme="starter-demo"\]/, rule);
});

test("上限：压缩包编码成 base64 后放得进 tRPC 的 10MB 请求体", () => {
  assert.ok(Math.ceil(UI_THEME_LIMITS.archiveBytes / 3) * 4 < 9.5 * 1024 * 1024);
  assert.ok(UI_THEME_LIMITS.fileBytes <= UI_THEME_LIMITS.expandedBytes);
});
