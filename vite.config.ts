import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const MIN_CHUNK = 20_000;

/*
  avataaars 只用得到 lodash.uniqueId，却 require 了整个 lodash。只把「从 avataaars
  里发出的」那一句换成 client/src/lib/avataaarsLodashShim.ts，别的依赖照常拿真 lodash。
  开发模式下依赖是 esbuild 预打包的、不走这里，用的仍是真 lodash —— 两边行为一致。
*/
function avataaarsLodashShim(): Plugin {
  const shim = path.resolve(__dirname, "./client/src/lib/avataaarsLodashShim.ts");
  return {
    name: "forwardx:avataaars-lodash-shim",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "lodash" && importer && /[\\/]avataaars[\\/]/.test(importer)) return shim;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [avataaarsLodashShim(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  publicDir: "client/public",
  build: {
    outDir: "client/dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /*
          小的共用块并进用到它的块里（2.3.559）。以前按页面拆包之后，页面之间共用的图标、小工具各成一个文件：
          第一次打开规则页要下 63 个文件、其中 41 个不到 4 KB。HTTP/1.1 下浏览器一个站点只开 6 条连接，海外线路上
          每个小文件都是一次往返，登录检查这种 2 KB 的接口排在它们后面要等两秒多。合并只在不改变模块执行顺序时才做。
        */
        experimentalMinChunkSize: MIN_CHUNK,
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
