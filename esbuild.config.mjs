import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

// 终端用户 IP 的离线归属地库（server/ipRegionOffline.ts 运行时读 dist/geo，带 sha256 校验）。
// 发布包（release-panel.yml 打包整个 dist）和 Docker 镜像（COPY dist）都靠这一步带上它。
mkdirSync("dist/geo", { recursive: true });
for (const name of ["ip2region_v4.xdb.gz", "ip2region_v6.xdb.gz", "LICENSE.txt", "NOTICE.txt"]) {
  copyFileSync(`server/assets/ip2region/${name}`, `dist/geo/${name}`);
}

await build({
  entryPoints: {
    index: "server/index.ts",
    "migrate-legacy": "server/legacyMigrationCli.ts",
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
  sourcemap: true,
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

console.log("Server build complete: dist/index.js, dist/migrate-legacy.js, dist/reset-admin-password.js");
