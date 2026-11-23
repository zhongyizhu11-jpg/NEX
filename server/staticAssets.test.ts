import assert from "node:assert/strict";
import test from "node:test";
import { legacyImageRedirectTarget } from "./staticAssets";

test("改成 WebP 的壁纸和贴图：旧文件名 301 到同名 .webp", () => {
  assert.equal(legacyImageRedirectTarget("/wallpapers/anime-3.jpg"), "/wallpapers/anime-3.webp");
  assert.equal(legacyImageRedirectTarget("/wallpapers/illustration-1.jpg"), "/wallpapers/illustration-1.webp");
  assert.equal(legacyImageRedirectTarget("/globe/night-sky.png"), "/globe/night-sky.webp");
  assert.equal(legacyImageRedirectTarget("/globe/earth-topology.png"), "/globe/earth-topology.webp");
});

test("还是原格式的、不认识的、别的目录的都不跳", () => {
  assert.equal(legacyImageRedirectTarget("/globe/earth-dark.jpg"), null);
  assert.equal(legacyImageRedirectTarget("/globe/earth-night.jpg"), null);
  assert.equal(legacyImageRedirectTarget("/wallpapers/unknown.jpg"), null);
  assert.equal(legacyImageRedirectTarget("/wallpapers/anime-1.webp"), null);
  assert.equal(legacyImageRedirectTarget("/assets/anime-1.jpg"), null);
  assert.equal(legacyImageRedirectTarget("/wallpapers/../anime-1.jpg"), null);
});
