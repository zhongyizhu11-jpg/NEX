import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 订阅输出的金样。
 *
 * server/proxySubBench.fixture.ts 的小档账号（自建 / 粘来 / 落地池 / 分享来的节点，转发组、前置代理、
 * 停用 / 隐藏 / 只放 TCP 的转发，四条作用域和模板各不相同的令牌）按「8 种格式 × 典型客户端 ×
 * 节点订阅 / 规则订阅」和「只靠 UA 识别格式」各拉一遍。每一份的字节数、sha256、Content-Type、
 * ETag 都得和下面一样；带 gzip 再拉一次，解压后也必须一模一样。
 *
 * 这些值是在给订阅生成做性能优化**之前**记下的：优化只许让它更快，不许改输出的任何一个字节。
 * 真要改订阅内容（新功能、修渲染）时，跑
 *   FORWARDX_TEST_DB=/tmp/golden.db node --import tsx server/proxySubBench.fixture.ts golden
 * 把新值贴回来，并在提交说明里写清楚哪几份为什么变了。
 */
const GOLDEN: Record<string, string> = {
  "default/base64/nodes": "17232 fa33a2ebca5a00cb52cf907b text/plain 4350-Jwq6yn5I+Dmi3iQgNs+shRgw/sA",
  "default/base64/rules": "17232 fa33a2ebca5a00cb52cf907b text/plain 4350-Jwq6yn5I+Dmi3iQgNs+shRgw/sA",
  "default/clash/nodes": "21122 c84674a32c8d93e50b343ebe text/yaml 5282-pTy3dOUqWplIAE93flZqi6D3gz0",
  "default/clash/rules": "39629 775b31b4c592629a34d2a938 text/yaml 9acd-Q0WpdouPBnBZrQi5CtOhJlegoX0",
  "default/singbox/nodes": "28889 09f1fdb44d8c8f041b862f93 application/json 70d9-99IXzZKgXjIQZW6E2xBWQjlXT78",
  "default/singbox/rules": "52227 d63ee97b5646685d20978ad9 application/json cc03-KJIUkBMseshH+ow/JQtNsp8IjNc",
  "default/v2rayjson/nodes": "114129 2a4abe625f90d6ce5fd98bc3 application/json 1bdd1-TkIf284ehfm1sSDhYGo3SczAr2U",
  "default/v2rayjson/rules": "281766 326f0a4715ef8e10e1eb1343 application/json 44ca6-+yBaazW2aQUHT9958056BrFiVHg",
  "default/loon/nodes": "11323 dc3cb8ec38e09ab51f1253fe text/plain 2c3b-JxCpS/QKuVdb2JYvOCb+mQNe9wc",
  "default/loon/rules": "32578 6f221f95fac29661afc147e3 text/plain 7f42-d/pd75ozTwjfKNortuZ2tzAKBYg",
  "default/surge/nodes": "6395 db83007d971ca1a354415f0c text/plain 18fb-rdNktdO6hTyaxFnMs9owfDPWgBk",
  "default/surge/rules": "18161 bde1a713591ee02c13a788b5 text/plain 46f1-1mb9O31eenxx7DZpapyHpysAN5Q",
  "default/quantumultx/nodes": "8695 2c734c33696cf3f30161ea96 text/plain 21f7-Gnu9bcaaXbyyFK2zRvZIIo4Vrwk",
  "default/quantumultx/rules": "25777 ed7c1c984b373153d728ec65 text/plain 64b1-kMcIIq50+Mffy3dacRXnvxYpmbw",
  "default/shadowrocket/nodes": "17956 d1a3917acf5b173f489c9af0 text/plain 4624-Yl0gNV7ho56RaMXaasJkdWKvRfw",
  "default/shadowrocket/rules": "24179 1eb28d5556e28f25ab0f6894 text/plain 5e73-p8RmEj31Y9nYXNUHMbUC2Yc87Os",
  "scoped/base64/nodes": "8900 0ccae507ef9da056380c6886 text/plain 22c4-wA6Rf/iYSiW/iuUpUzy2imntkvA",
  "scoped/base64/rules": "8900 0ccae507ef9da056380c6886 text/plain 22c4-wA6Rf/iYSiW/iuUpUzy2imntkvA",
  "scoped/clash/nodes": "11328 ce0f7f9182da1eea684c5b01 text/yaml 2c40-+KVFJ8ZP/2TR3XD59ZuyzAPSu9A",
  "scoped/clash/rules": "37555 1566c60191e8b067ea77d753 text/yaml 92b3-mNIc3uvrfWV41caSi70fzKvyLt8",
  "scoped/singbox/nodes": "15032 047ba330af04f8bd89e331e0 application/json 3ab8-rDTfCdojljXGoz1qv49WaNdIorc",
  "scoped/singbox/rules": "47064 3763f557afb755b67ae9a48f application/json b7d8-VWqfU9w7H3qU8JTgV5cakpCYDRc",
  "scoped/v2rayjson/nodes": "48692 4e0d8467c7f4ee182d27ba38 application/json be34-Q06Ws/FGaqJQ4YBSBJRrrzHrilU",
  "scoped/v2rayjson/rules": "154244 a0d73e94ec9a83966239cce4 application/json 25a84-U4RCOJDnr5S0DDp37HNUfzrsN4E",
  "scoped/loon/nodes": "5393 95328f3d619d6ffd2f840dd2 text/plain 1511-dFVOJJ5rE/TKzpPo0aYEvfXM6JY",
  "scoped/loon/rules": "30436 011616cec06c9965535990c5 text/plain 76e4-Bsal7UXwJQaD3kFUB3pVjvY+wmw",
  "scoped/surge/nodes": "2637 e1521cdc8cde157ea7f815de text/plain a4d-psX71dTN4I+ex+oEXQ31xetmKFA",
  "scoped/surge/rules": "14699 b8bab59de5b3f3b2e3405cb1 text/plain 396b-WQV/baZAbWtFimqxmkKUkSDBK7I",
  "scoped/quantumultx/nodes": "3355 c21515ade74fb27fe9a452bd text/plain d1b-EK0boCgnk0kU9wGoTJskAhoCofY",
  "scoped/quantumultx/rules": "21759 cfaf50b9061e2228bf51aa7e text/plain 54ff-Xmw2TW+agFdkFDZvizRoc4Ljn4U",
  "scoped/shadowrocket/nodes": "8900 0ccae507ef9da056380c6886 text/plain 22c4-wA6Rf/iYSiW/iuUpUzy2imntkvA",
  "scoped/shadowrocket/rules": "27473 d23d0487298804adb613184b text/plain 6b51-MmYFC3khD1vO7/S0oAh77Pd+VNc",
  "templated/base64/nodes": "19264 c426bed0850aceb42d3ea862 text/plain 4b40-NFY0A5LfLE3GXFues1698dfTIls",
  "templated/base64/rules": "19264 c426bed0850aceb42d3ea862 text/plain 4b40-NFY0A5LfLE3GXFues1698dfTIls",
  "templated/clash/nodes": "24973 9abdaaf2b5f56d79276706c8 text/yaml 618d-PRYycjzHS4825rkTdt2yIRqNmvE",
  "templated/clash/rules": "46982 aaae9c8b2f6ce7486dd940a2 text/yaml b786-ou25Yl5MFV2v4w3egInDU46p1z0",
  "templated/singbox/nodes": "31233 4a400b62eeb922c83d9ce706 application/json 7a01-agbBnav0A1nXRVVNBcFL+vOSu+w",
  "templated/singbox/rules": "58457 aee9abcd26f00205b19aca76 application/json e459-F6iUahTMwtzVaAmq7ImzOeJ7xlE",
  "templated/v2rayjson/nodes": "114615 fb16bb920a5dd425ef1dc603 application/json 1bfb7-kVUziWiWsnoreWZzF4mXeep3Tqg",
  "templated/v2rayjson/rules": "299124 e9e9996a61b880384d1f946a application/json 49074-15g/v8x0ngLxxqGhxHXO8eM4TyQ",
  "templated/loon/nodes": "11830 ec8b07efaad8cdef9817f7fb text/plain 2e36-jWCGQxflhQTWYyWzqJxaZFvg7Cw",
  "templated/loon/rules": "38002 eef72d0570e941093c7a07e2 text/plain 9472-1tnbA4yq45GmsX9BCbPcJiPjXBg",
  "templated/surge/nodes": "6932 88a5272a3a28a71187b3129b text/plain 1b14-GuKMHF8IfWlkY/Qh0tORYmTHPaY",
  "templated/surge/rules": "21264 3e853e291b64c1d3a9b4b792 text/plain 5310-31HtY5aYkH27DhETFJaS0oq8JKA",
  "templated/quantumultx/nodes": "9271 d548a83759fc9e2de6732b57 text/plain 2437-smCpM1zU2Ljt09kcSV45Lrczc64",
  "templated/quantumultx/rules": "30054 cadd762008c5e1e00e2e8b44 text/plain 7566-ezKvRO1bxCTKLmJv8NfFNa/P2+E",
  "templated/shadowrocket/nodes": "20124 d9e785eafd98519a1c61fccb text/plain 4e9c-5I9kswNPOWcqLP2sJy1KVgTDc5Q",
  "templated/shadowrocket/rules": "29577 1c14596d64ebbb4388ddf0af text/plain 7389-4b0g/DK82LKDK/fvuLzRnJ2uayw",
  "info/base64/nodes": "14056 2fe0fdd2ba76b46ad0be6f64 text/plain 36e8-kUGXOIQkgaV1XiQg0Dsn+wzXQu8",
  "info/base64/rules": "14056 2fe0fdd2ba76b46ad0be6f64 text/plain 36e8-kUGXOIQkgaV1XiQg0Dsn+wzXQu8",
  "info/clash/nodes": "16806 e6a3cc7839f926a0e4a37655 text/yaml 41a6-tQbRJqAQMqZ12oLK49YInfnuDqE",
  "info/clash/rules": "21997 dc26e7c9d471da0783d077e7 text/yaml 55ed-kYiPg+nPT6REPn9R/qPx4ThvSvM",
  "info/singbox/nodes": "23007 943258a3e39ee697f85061b1 application/json 59df-KSfzPySonpmPv6DDVEilZYs1JDY",
  "info/singbox/rules": "29174 c01d640ac89325fa26079a5b application/json 71f6-3/M8b8lTTcgrJUrK8p920q5QD3A",
  "info/v2rayjson/nodes": "90595 a51548fd65c895004be3f33e application/json 161e3-9pN/S67kNcLqPFadWN6EEE/uV1o",
  "info/v2rayjson/rules": "164035 46015dabe8745123428446fc application/json 280c3-sfT6tl58esB/a6WHJ5BWQANkCIA",
  "info/loon/nodes": "8810 a608a03450b1cbb4ba992455 text/plain 226a-5Ma1TqzZpHcd7BsPdh2+3974ugg",
  "info/loon/rules": "15693 df17e9a5090a76351cbd52d9 text/plain 3d4d-jDdxKIBnPlgrPiI+V8ObIxsF288",
  "info/surge/nodes": "4580 0c51f754dd3220da383e7841 text/plain 11e4-0prEQYiBZbkak/lY4HqG/hBSWz8",
  "info/surge/rules": "7585 cffa3f2c826c985ca805a694 text/plain 1da1-2oXd/9ibUd/b1bVKT5TJ2v5dNCU",
  "info/quantumultx/nodes": "6840 cd4ae48e59478b3bf2c830ec text/plain 1ab8-cGyUMJu4quzAMcUdLnZNXlAFtG0",
  "info/quantumultx/rules": "12104 2286841df67a81e9c7b78935 text/plain 2f48-3+AeXDLSjZOSOFudaKReeQZJxNg",
  "info/shadowrocket/nodes": "14056 2fe0fdd2ba76b46ad0be6f64 text/plain 36e8-kUGXOIQkgaV1XiQg0Dsn+wzXQu8",
  "info/shadowrocket/rules": "7928 ad6d7b54f516f2c847547cc4 text/plain 1ef8-k1ruhEZoikXaMMwfnRL2vBAXTbs",
  "ua:mihomo": "39629 775b31b4c592629a34d2a938 text/yaml 9acd-Q0WpdouPBnBZrQi5CtOhJlegoX0",
  "ua:clash-verge": "45736 d2754117d0a9f953468b2494 text/yaml b2a8-OOCHBAxVS53BWHCrVXl7H1YzE3s",
  "ua:stash": "45441 14e2c6334d8e9ffb29ea72cf text/yaml b181-uggA4iXsVyVSEC88hBEMHKY2TUM",
  "ua:cmfa": "45736 d2754117d0a9f953468b2494 text/yaml b2a8-OOCHBAxVS53BWHCrVXl7H1YzE3s",
  "ua:sfa": "52227 d63ee97b5646685d20978ad9 application/json cc03-KJIUkBMseshH+ow/JQtNsp8IjNc",
  "ua:sing-box": "52227 d63ee97b5646685d20978ad9 application/json cc03-KJIUkBMseshH+ow/JQtNsp8IjNc",
  "ua:v2rayn": "281766 326f0a4715ef8e10e1eb1343 application/json 44ca6-+yBaazW2aQUHT9958056BrFiVHg",
  "ua:v2rayn-old": "17232 fa33a2ebca5a00cb52cf907b text/plain 4350-Jwq6yn5I+Dmi3iQgNs+shRgw/sA",
  "ua:v2rayng": "281766 326f0a4715ef8e10e1eb1343 application/json 44ca6-+yBaazW2aQUHT9958056BrFiVHg",
  "ua:shadowrocket": "24166 66ce3f4fbb67b1cd3cc65cd4 text/plain 5e66-qWCXVsNu9ZrB+Ff2+PbLZP7Mst0",
  "ua:surge": "18155 61c16d09a1fbe1d562a72925 text/plain 46eb-WShNGthXVukUWFzeUoECzfkDY+w",
  "ua:loon": "32578 6f221f95fac29661afc147e3 text/plain 7f42-d/pd75ozTwjfKNortuZ2tzAKBYg",
  "ua:qx": "25777 ed7c1c984b373153d728ec65 text/plain 64b1-kMcIIq50+Mffy3dacRXnvxYpmbw",
  "ua:hiddify": "17956 d1a3917acf5b173f489c9af0 text/plain 4624-Yl0gNV7ho56RaMXaasJkdWKvRfw",
  "ua:unknown": "45441 14e2c6334d8e9ffb29ea72cf text/yaml b181-uggA4iXsVyVSEC88hBEMHKY2TUM",
  "alias/mihomo": "39629 775b31b4c592629a34d2a938 text/yaml 9acd-Q0WpdouPBnBZrQi5CtOhJlegoX0",
  "query/emoji-region": "18519 a14a6e0976a137d5230129ba text/yaml 4857-BJ17vsxosOo8PaFhg9YhPaA3XKM",
};

test("订阅金样：每种格式 × 客户端 × 令牌的输出逐字节不变（gzip 解压后也一样）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sub-golden-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/proxySubBench.fixture.ts", "golden"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "golden.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rows = result.stdout.split("\n").filter((line) => line.startsWith("{\"label\"")).map((line) => JSON.parse(line));
    const counts = rows.find((row) => row.label === "counts");
    assert.deepEqual(counts, { label: "counts", rules: 56, nodes: 40, visibleTemplates: 37 }, "固定账号的规模变了：金样已经不是同一份数据");
    const seen = new Set<string>();
    const mismatches: string[] = [];
    for (const row of rows) {
      if (row.label === "counts") continue;
      seen.add(row.label);
      assert.equal(row.status, 200, `${row.label} 没拉到`);
      assert.equal(row.gzipSame, true, `${row.label}：gzip 解压后和不压的不一样`);
      assert.match(row.type, /; charset=utf-8$/, row.label);
      const actual = `${row.bytes} ${row.sha256.slice(0, 24)} ${row.type.split(";")[0]} ${row.etag.replace(/^W\/"/, "").replace(/"$/, "")}`;
      if (GOLDEN[row.label] !== actual) mismatches.push(`${row.label}\n  金样 ${GOLDEN[row.label]}\n  现在 ${actual}`);
    }
    assert.deepEqual(mismatches, [], `订阅输出变了：\n${mismatches.join("\n")}`);
    assert.deepEqual([...seen].sort(), Object.keys(GOLDEN).sort(), "拉取的矩阵和金样对不上");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
