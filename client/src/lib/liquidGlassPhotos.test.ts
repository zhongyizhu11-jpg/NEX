import assert from "node:assert/strict";
import test from "node:test";

import { liquidGlassBuiltinPair, liquidGlassPhotoSet, liquidGlassPhotoSourceHint } from "./liquidGlassPhotos";

/*
  用户面板 2026-11-23：照片来源「自定义背景」、背景选中项为空 → 照片格空着，玻璃卡压在平底色上
  （「玻璃主题怎么一点都不像玻璃了」）。没照片可放时要用内置壁纸顶着。
*/
test("自定义背景没选上：先用内置壁纸顶着，并标出是顶着的；选上了就用那张、拉不到退回内置", () => {
  const empty = liquidGlassPhotoSet({ photoSource: "wallpaper", wallpaper: null, seed: 7 });
  assert.deepEqual(empty.photos, liquidGlassBuiltinPair(7));
  assert.equal(empty.substituted, true);
  const own = liquidGlassPhotoSet({ photoSource: "wallpaper", wallpaper: "data:image/jpeg;base64,xxx", seed: 7 });
  assert.deepEqual(own.photos, ["data:image/jpeg;base64,xxx"]);
  assert.equal(own.fallbacks[0], liquidGlassBuiltinPair(7)[0]);
  assert.equal(own.substituted, false);
});

test("随机照片 / 自动：picsum 拉不到（断网、被墙）退回内置壁纸；不放照片就是空的", () => {
  const random = liquidGlassPhotoSet({ photoSource: "random", wallpaper: "x", seed: 3 });
  assert.equal(random.photos.length, 2);
  assert.ok(random.photos[0].startsWith("https://picsum.photos/"));
  assert.deepEqual(random.fallbacks, liquidGlassBuiltinPair(3));
  const auto = liquidGlassPhotoSet({ photoSource: "auto", wallpaper: null, seed: 3 });
  assert.deepEqual(auto.photos, random.photos);
  assert.deepEqual(liquidGlassPhotoSet({ photoSource: "auto", wallpaper: "x", seed: 3 }).photos, ["x"]);
  assert.deepEqual(liquidGlassPhotoSet({ photoSource: "none", wallpaper: "x", seed: 3 }), { photos: [], fallbacks: [], substituted: false });
});

test("内置壁纸按 seed 挑两张不同的", () => {
  for (let seed = 1; seed < 40; seed += 1) {
    const [a, b] = liquidGlassBuiltinPair(seed);
    assert.notEqual(a, b);
  }
  assert.equal(liquidGlassPhotoSourceHint("wallpaper", false).length > 0, true);
  assert.equal(liquidGlassPhotoSourceHint("wallpaper", true), "");
  assert.equal(liquidGlassPhotoSourceHint("random", false), "");
});
