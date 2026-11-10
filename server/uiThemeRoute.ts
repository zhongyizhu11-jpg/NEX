import express, { type Request, type Response } from "express";
import { isValidUiThemePackageId } from "../shared/uiThemePackage";
import { getInstalledUiThemeCss } from "./uiThemes";

/*
  GET /api/ui-themes/<id>.css —— 已安装主题包的样式（见 shared/uiThemePackage.ts）。

  不要登录：登录页也要按站点主题画，和主样式表一样是公开的静态资源；里面只有样式（装的时候检查过，
  不含外链，见 server/uiThemePackage.ts）。只认装着的主题 id，别的一律 404，不能拿它读别的东西。

  缓存：浏览器带着 ?v=<revision>（revision 是内容的 sha256，名单从 publicInfo 来）请求时，内容永远
  不会变，按一年缓存；不带、或带的是旧 revision（主题刚更新，这台设备记的还是上一版）时不缓存，
  靠 ETag 省流量 —— 这样更新主题不用等缓存过期。
*/
export const uiThemeRouter = express.Router();

uiThemeRouter.get("/api/ui-themes/:file", async (req: Request, res: Response) => {
  const file = String(req.params.file || "");
  const themeId = file.endsWith(".css") ? file.slice(0, -4) : "";
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!isValidUiThemePackageId(themeId)) {
    res.status(404).type("text/plain").send("theme not found");
    return;
  }
  let theme: Awaited<ReturnType<typeof getInstalledUiThemeCss>> = null;
  try {
    theme = await getInstalledUiThemeCss(themeId);
  } catch {
    // 库读不了：按没有这套主题回，页面退回经典，别让一张样式表的请求变成 500
  }
  if (!theme) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).type("text/plain").send("theme not found");
    return;
  }
  const etag = `"${theme.revision}"`;
  const pinned = typeof req.query.v === "string" && req.query.v === theme.revision;
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", pinned ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).send(theme.css);
});
