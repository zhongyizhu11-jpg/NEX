import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  在真的 SQLite 上走一遍主题包：从官方主题库安装、上传安装、同名替换、数量上限、卸载（站点默认回到经典）、
  导出再装回去、开机补装、从链接安装（下载用假的），以及 /api/ui-themes/<id>.css 这条公开路由的缓存头。
*/
test("主题包在 SQLite 上跑通：安装 / 替换 / 卸载 / 导出 / 开机补装 / 样式路由", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nex-ui-themes-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const themes = await import(url("server/uiThemes.ts"));
      const pkg = await import(url("server/uiThemePackage.ts"));
      const settings = await import(url("server/repositories/settingsRepository.ts"));
      const shared = await import(url("shared/uiThemePackage.ts"));
      const rejects = (work, pattern, code) => assert.rejects(work, (error) => {
        assert.ok(error instanceof themes.UiThemeError, String(error));
        assert.match(error.message, pattern);
        if (code) assert.equal(error.code, code);
        return true;
      });
      const archive = (id, css, version = "1.0.0") => pkg.writeZip({
        "theme.json": JSON.stringify({ apiVersion: 1, id, name: "主题 " + id, version, preview: { light: { page: "#fafafa", card: "#ffffff", accent: "#ff5500" } } }),
        "theme.css": css || 'html[data-ui-theme="' + id + '"] { --fx-l0-page: #fafafa; }',
      });

      // 新装的面板一套主题包都没有；官方主题库列得出五套，都没装
      assert.deepEqual(await themes.listInstalledUiThemes(), []);
      const official = await themes.listOfficialUiThemes();
      assert.deepEqual(official.map((theme) => theme.id), [...shared.OFFICIAL_UI_THEME_IDS]);
      assert.ok(official.every((theme) => theme.installedVersion === null && !theme.updateAvailable && theme.name && theme.description));

      // 从官方主题库装一套
      const gilt = await themes.installOfficialUiTheme("gilt");
      assert.equal(gilt.replaced, false);
      assert.equal(gilt.theme.id, "gilt");
      assert.equal(gilt.theme.name, "墨金");
      assert.equal(gilt.theme.source, "official");
      assert.match(gilt.theme.revision, /^[a-f0-9]{64}$/);
      assert.deepEqual(await themes.installedUiThemeIds(), ["gilt"]);
      const giltCss = await themes.getInstalledUiThemeCss("gilt");
      assert.equal(giltCss.revision, gilt.theme.revision);
      assert.ok(giltCss.css.includes('[data-ui-theme="gilt"]'));
      assert.equal((await themes.listOfficialUiThemes()).find((theme) => theme.id === "gilt").installedVersion, "1.0.0");
      // 再点一次是原地更新，不是报「已安装」
      assert.equal((await themes.installOfficialUiTheme("gilt")).replaced, true);
      await rejects(() => themes.installOfficialUiTheme("pearl"), /官方主题库里没有这套主题/, "NOT_FOUND");
      await rejects(() => themes.installOfficialUiTheme("../gilt"), /官方主题库里没有这套主题/, "NOT_FOUND");

      // 上传安装；同名的要勾「替换」
      const first = await themes.installUiThemeFromArchive(archive("my-theme"));
      assert.equal(first.theme.source, "upload");
      assert.deepEqual(first.theme.preview.light, { page: "#fafafa", card: "#ffffff", accent: "#ff5500" });
      await rejects(() => themes.installUiThemeFromArchive(archive("my-theme", null, "1.1.0")), /已经装着同名的主题/, "CONFLICT");
      const second = await themes.installUiThemeFromArchive(archive("my-theme", 'html[data-ui-theme="my-theme"] { color: red; }', "1.1.0"), { replace: true });
      assert.equal(second.replaced, true);
      assert.equal(second.previousVersion, "1.0.0");
      assert.equal(second.theme.version, "1.1.0");
      assert.notEqual(second.theme.revision, first.theme.revision);
      assert.equal((await themes.getInstalledUiThemeCss("my-theme")).css.trim(), 'html[data-ui-theme="my-theme"] { color: red; }');
      // 坏包：错误文字是给管理员看的那一句
      await rejects(() => themes.installUiThemeFromArchive(Buffer.from("nope")), /认不出这个文件/);
      await rejects(() => themes.installUiThemeFromArchive(archive("evil-theme", 'a { background: url(https://evil.example/x.png); }')), /不能引用外部地址/);
      assert.deepEqual(await themes.installedUiThemeIds(), ["gilt", "my-theme"], "装不上的不留痕迹");
      // 官方主题库里的 id 被上传的包盖掉以后：不再催「可更新」（那是管理员有意换的）
      await themes.installUiThemeFromArchive(archive("gilt", null, "9.0.0"), { replace: true });
      const overridden = (await themes.listOfficialUiThemes()).find((theme) => theme.id === "gilt");
      assert.equal(overridden.installedVersion, "9.0.0");
      assert.equal(overridden.updateAvailable, false);
      await themes.installOfficialUiTheme("gilt");

      // 导出再装回去：内容一样，revision 一样
      const exported = await themes.exportUiThemeArchive("my-theme");
      assert.equal(exported.filename, "nex-theme-my-theme-1.1.0.zip");
      assert.equal(pkg.parseUiThemeArchive(exported.archive).revision, second.theme.revision);
      assert.equal(await themes.exportUiThemeArchive("missing-theme"), null);
      const starter = themes.uiThemeStarterArchive();
      assert.equal(pkg.parseUiThemeArchive(starter.archive).manifest.id, "my-theme");

      // 从链接安装：跳转一跳一跳跟，每一跳都走检查过的下载；不是 2xx、跳太多次、太大都说得清楚
      const calls = [];
      const fakeFetch = (pages) => async (target, options) => {
        calls.push(target);
        assert.equal(options.maxBytes, shared.UI_THEME_LIMITS.archiveBytes);
        assert.equal(options.headers["Accept-Encoding"], "identity");
        const page = pages[target];
        if (!page) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        return page;
      };
      const downloaded = await themes.downloadUiThemeArchive("https://a.example/theme.zip", fakeFetch({
        "https://a.example/theme.zip": { status: 302, headers: { location: "/files/real.zip?token=1" }, body: Buffer.alloc(0) },
        "https://a.example/files/real.zip?token=1": { status: 200, headers: {}, body: archive("from-link") },
      }));
      assert.deepEqual(calls, ["https://a.example/theme.zip", "https://a.example/files/real.zip?token=1"]);
      const linked = await themes.installUiThemeFromArchive(downloaded, { source: "url", sourceUrl: "https://a.example/theme.zip" });
      assert.equal(linked.theme.source, "url");
      await rejects(() => themes.downloadUiThemeArchive("ftp://a.example/theme.zip"), /http:\/\/ 或 https:\/\//);
      await rejects(() => themes.downloadUiThemeArchive("https://a.example/missing.zip", fakeFetch({})), /HTTP 404/);
      await rejects(() => themes.downloadUiThemeArchive("https://a.example/loop", fakeFetch({ "https://a.example/loop": { status: 301, headers: { location: "https://a.example/loop" }, body: Buffer.alloc(0) } })), /跳转次数太多/);
      await rejects(() => themes.downloadUiThemeArchive("https://a.example/gz", fakeFetch({ "https://a.example/gz": { status: 200, headers: { "content-encoding": "gzip" }, body: Buffer.alloc(4) } })), /不肯给原始文件/);
      const ssrf = await import(url("server/ssrf.ts"));
      await rejects(() => themes.downloadUiThemeArchive("https://a.example/big", async () => { throw new ssrf.SafeOutboundError("正文超过上限", "too-large"); }), /不能超过 6MB/);
      await rejects(() => themes.downloadUiThemeArchive("https://a.example/blocked", async () => { throw new ssrf.SafeOutboundError("主题下载 不允许访问受限地址 127.0.0.1", "blocked"); }), /不允许访问受限地址/);
      // 真的下载器：内网和本机地址连都不连
      await rejects(() => themes.downloadUiThemeArchive("http://127.0.0.1:1/theme.zip"), /不允许访问受限地址/);
      await rejects(() => themes.downloadUiThemeArchive("http://169.254.169.254/latest/meta-data"), /不允许访问受限地址/);

      // 样式路由：公开、只认装着的 id、带对 revision 才长期缓存
      const { uiThemeRouter } = await import(url("server/uiThemeRoute.ts"));
      const express = (await import("express")).default;
      const app = express();
      app.use(uiThemeRouter);
      const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const base = "http://127.0.0.1:" + server.address().port;
      try {
        const pinned = await fetch(base + "/api/ui-themes/my-theme.css?v=" + second.theme.revision);
        assert.equal(pinned.status, 200);
        assert.equal(pinned.headers.get("content-type"), "text/css; charset=utf-8");
        assert.equal(pinned.headers.get("x-content-type-options"), "nosniff");
        assert.equal(pinned.headers.get("cache-control"), "public, max-age=31536000, immutable");
        assert.equal((await pinned.text()).trim(), 'html[data-ui-theme="my-theme"] { color: red; }');
        // 不带 revision、或带的是旧的：不长期缓存，靠 ETag
        const stale = await fetch(base + "/api/ui-themes/my-theme.css?v=" + first.theme.revision);
        assert.equal(stale.headers.get("cache-control"), "no-cache");
        const etag = stale.headers.get("etag");
        const notModified = await fetch(base + "/api/ui-themes/my-theme.css", { headers: { "If-None-Match": etag } });
        assert.equal(notModified.status, 304);
        for (const missing of ["/api/ui-themes/unknown-theme.css", "/api/ui-themes/classic.css", "/api/ui-themes/my-theme", "/api/ui-themes/..%2f..%2fpackage.css", "/api/ui-themes/my-theme.css.map"]) {
          assert.equal((await fetch(base + missing)).status, 404, missing);
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }

      // 卸载：不是站点默认的直接卸；是站点默认的，站点默认回到经典
      await settings.setSetting("personalizationUiTheme", "my-theme");
      assert.deepEqual(await themes.uninstallUiTheme("from-link"), { siteThemeReset: false });
      assert.equal(await settings.getSetting("personalizationUiTheme"), "my-theme");
      assert.deepEqual(await themes.uninstallUiTheme("my-theme"), { siteThemeReset: true });
      assert.equal(await settings.getSetting("personalizationUiTheme"), "classic");
      assert.equal(await themes.getInstalledUiThemeCss("my-theme"), null);
      await rejects(() => themes.uninstallUiTheme("my-theme"), /没有安装/, "NOT_FOUND");
      assert.deepEqual(await themes.installedUiThemeIds(), ["gilt"]);

      // 开机补装：站点默认是官方主题库里的一套、库里却没有（从主题还是内置的版本升上来）
      await themes.uninstallUiTheme("gilt");
      assert.equal(await themes.ensureSiteUiThemeInstalled(), null, "站点默认是经典：什么都不装");
      await settings.setSetting("personalizationUiTheme", "rose");
      assert.equal(await themes.ensureSiteUiThemeInstalled(), "rose");
      assert.deepEqual(await themes.installedUiThemeIds(), ["rose"], "只补站点默认这一套，别的还是按需安装");
      assert.equal(await themes.ensureSiteUiThemeInstalled(), null, "已经装着就不动");
      await settings.setSetting("personalizationUiTheme", "someone-elses-theme");
      assert.equal(await themes.ensureSiteUiThemeInstalled(), null, "不是官方主题库里的补不了，页面按经典画");

      // 数量上限
      for (let index = (await themes.installedUiThemeIds()).length; index < shared.UI_THEME_LIMITS.installed; index += 1) {
        await themes.installUiThemeFromArchive(archive("bulk-" + String(index).padStart(2, "0")));
      }
      await rejects(() => themes.installUiThemeFromArchive(archive("one-too-many")), /最多安装/);
      // 满了以后替换已有的还是可以
      assert.equal((await themes.installUiThemeFromArchive(archive("bulk-05", null, "2.0.0"), { replace: true })).replaced, true);

      // 库里混进一行坏清单：名单里没有它，别的照常
      await runtime.executeRaw('UPDATE "ui_theme_packages" SET "manifestJson" = ? WHERE "themeId" = ?', ["{ broken", "bulk-06"]);
      themes.invalidateUiThemeCache();
      const afterCorruption = await themes.installedUiThemeIds();
      assert.equal(afterCorruption.includes("bulk-06"), false);
      assert.equal(afterCorruption.includes("bulk-05"), true);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 120_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
