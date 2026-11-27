// Deterministic sizing of the supplied artwork. Requires ImageMagick (convert).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "assets/brand/nex-logo-source.png");
const icon = path.join(root, "assets/brand/nex-icon.png");
function render(input, args, output) {
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync("convert", [input, ...args, "-strip", output]);
}
// Crop only the empty sides of the original 2:1 canvas; never stretch the letters.
render(source, ["-gravity", "center", "-crop", "887x887+0+0", "+repage", "-resize", "1024x1024", "-alpha", "off"], icon);
// 页面上的 logo 最大画 56 px（3 倍屏 168 px），192 px 够了：512 px 的 166 KB，192 px 的 24 KB，第一次打开少下 140 多 KB
for (const [file, size] of [["favicon.png", 192], ["logo-light.png", 192], ["logo-dark.png", 192]]) {
  render(icon, ["-resize", `${size}x${size}`], path.join(root, "client/public", file));
}
mkdirSync(path.join(root, "docs/public"), { recursive: true });
copyFileSync(path.join(root, "client/public/logo-light.png"), path.join(root, "docs/public/nex-logo.png"));
copyFileSync(icon, path.join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"));
const res = path.join(root, "android/app/src/main/res");
for (const [density, size, foreground] of [["mdpi",48,108],["hdpi",72,162],["xhdpi",96,216],["xxhdpi",144,324],["xxxhdpi",192,432]]) {
  for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) {
    render(icon, ["-resize", `${size}x${size}`], path.join(res, `mipmap-${density}`, name));
  }
  // Lettering fits inside Android's adaptive-icon safe zone under all masks.
  const inset = Math.round(foreground * 0.9);
  render(icon, ["-resize", `${inset}x${inset}`, "-background", "#020408", "-gravity", "center", "-extent", `${foreground}x${foreground}`], path.join(res, `mipmap-${density}/ic_launcher_foreground.png`));
}
for (const dir of readdirSync(res).filter(name => name.startsWith("drawable"))) {
  const files = readdirSync(path.join(res, dir));
  if (files.includes("splash.png")) render(icon, ["-resize", "512x512"], path.join(res, dir, "splash.png"));
}
console.log("NEX web, docs, iOS and Android assets prepared.");
