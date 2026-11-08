// 比两份心跳对照 JSON（capture.mjs 录的）：列出不一样的路径（数组下标换成 [i] 归类，后面跟几个样例）。
// 用法：node scripts/bench/heartbeat-golden/diff.mjs a.json b.json [mask.json]
// mask.json 是要屏蔽的「键名」或「路径模式」清单：{ "keys": ["issuedAt"], "paths": ["round1.*.body.desiredState.issuedAt"] }
import fs from "node:fs";

const [aFile, bFile, maskFile] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(aFile, "utf8"));
const b = JSON.parse(fs.readFileSync(bFile, "utf8"));
const mask = maskFile ? JSON.parse(fs.readFileSync(maskFile, "utf8")) : { keys: [], paths: [] };
const maskKeys = new Set(mask.keys || []);
const maskPaths = (mask.paths || []).map((pattern) => new RegExp("^" + pattern.split(".").map((part) => (part === "*" ? "[^.]+" : part.replace(/[[\]]/g, "\\$&"))).join("\\.") + "$"));

const diffs = new Map();
function note(pathText, left, right) {
  const group = pathText.replace(/\.\d+(?=\.|$)/g, ".[i]");
  if (!diffs.has(group)) diffs.set(group, []);
  const list = diffs.get(group);
  if (list.length < 3) list.push([pathText, JSON.stringify(left)?.slice(0, 120), JSON.stringify(right)?.slice(0, 120)]);
  else list.count = (list.count || 3) + 1;
}
function masked(pathText, key) {
  if (maskKeys.has(key)) return true;
  return maskPaths.some((pattern) => pattern.test(pathText));
}
function walk(left, right, pathText, key) {
  if (masked(pathText, key)) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) note(pathText + ".length", left.length, right.length);
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i += 1) walk(left[i], right[i], `${pathText}.${i}`, String(i));
    return;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const k of keys) {
      if (!(k in left) || !(k in right)) {
        if (!masked(`${pathText}.${k}`, k)) note(`${pathText}.${k}`, left[k], right[k]);
        continue;
      }
      walk(left[k], right[k], `${pathText}.${k}`, k);
    }
    return;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) note(pathText, left, right);
}
walk(a, b, "$", "$");
if (diffs.size === 0) {
  console.log("IDENTICAL");
} else {
  for (const [group, list] of diffs) {
    console.log(`${group}  (${list.count || list.length})`);
    for (const [p, l, r] of list) console.log(`    ${p}: ${l} -> ${r}`);
  }
  console.log(`DIFF groups=${diffs.size}`);
}
