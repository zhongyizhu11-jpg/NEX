import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

// 终端用户 IP 的离线归属地库（server/ipRegionOffline.ts 运行时读 dist/geo，带 sha256 校验）。
// 发布包（release-panel.yml 打包整个 dist）和 Docker 镜像（COPY dist）都靠这一步带上它。
mkdirSync("dist/geo", { recursive: true });
for (const name of ["ip2region_v4.xdb.gz", "ip2region_v6.xdb.gz", "LICENSE.txt", "NOTICE.txt"]) {
  copyFileSync(`server/assets/ip2region/${name}`, `dist/geo/${name}`);
}

// 入口和公共块都带哈希名（chunk-XXXX.js），改一行代码就换一个名字：不先清掉上一次的产物，
// 本机反复构建会在 dist/ 里越积越多（发布流程和镜像是干净 checkout，不受影响）。
for (const name of readdirSync("dist")) {
  if (/^(index|migrate-legacy|migrate-forwardx|reset-admin-password)\.js(\.map)?$/.test(name) || /^chunk-[A-Z0-9]+\.js(\.map)?$/.test(name)) {
    rmSync(`dist/${name}`, { force: true });
  }
}

// 官方主题库（themes/official：墨金、玫瑰、朱砂、液态玻璃、靛蓝）。这几套不打进页面，管理员在
// 「主题管理」里点安装时面板从 dist/themes/official 读（server/uiThemes.ts），所以安装不用外网。
rmSync("dist/themes", { recursive: true, force: true });
cpSync("themes/official", "dist/themes/official", { recursive: true });

await build({
  entryPoints: {
    index: "server/index.ts",
    "migrate-legacy": "server/legacyMigrationCli.ts",
    // 从原版 ForwardX 迁到 NEX：安装脚本的 migrate-forwardx 动作调它（server/forwardxMigrationCli.ts）
    "migrate-forwardx": "server/forwardxMigrationCli.ts",
    "reset-admin-password": "server/resetAdminPasswordCli.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  // Mark all node_modules as external so they're resolved at runtime
  packages: "external",
  // Also mark node built-in modules as external
  external: [],
  // 四个入口共用的代码（数据库、仓储、迁移……）只打一份：以前 migrate-forwardx.js 和
  // reset-admin-password.js 各自把整个服务端带了一遍（各 6.5 MB）。公共块就放在 dist/ 根目录，
  // 和入口同一层，代码里的 __dirname（找 client/dist、dist/geo、dist/agent）才和以前一样。
  splitting: true,
  chunkNames: "chunk-[hash]",
  // source map 默认不出：Node 不加 --enable-source-maps 根本不读它们，但三份 .map 有 49 MB，
  // 以前一直被打进发布包和镜像。要本地排错就 FORWARDX_SERVER_SOURCEMAP=1 pnpm build。
  sourcemap: process.env.FORWARDX_SERVER_SOURCEMAP === "1",
  // Resolve path aliases
  alias: {
    "@shared": "./shared",
  },
  banner: {
    // Required for ESM compatibility with __dirname and require
    js: `
import { createRequire } from 'module';
import { fileURLToPath as __forwardxFileURLToPath } from 'url';
import { dirname as __forwardxDirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = __forwardxFileURLToPath(import.meta.url);
const __dirname = __forwardxDirname(__filename);
`,
  },
});

console.log("Server build complete: dist/index.js, dist/migrate-legacy.js, dist/migrate-forwardx.js, dist/reset-admin-password.js");
