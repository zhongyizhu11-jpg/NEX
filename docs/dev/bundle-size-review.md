# 体积与顺滑度专项（2026-11-23）

起因：发布包 forwardx-panel-v2.3.549.tar.gz 88 MB，「感觉臃肿」。先量再改，没量出收益的不改。

## 一、88 MB 是什么

发布包解压 239 MB：

| 内容 | 解压后 | 结论 |
|---|---|---|
| dist/agent 8 个 Go 二进制（gost 运行时 36+33、Agent 15+14、mita 12.5+11.7、FXP 9.6+7.9，amd64 / arm64 各一份） | 140 MB | 压缩后约占包的三分之二。gost 运行时和 mita 改按需下载能再砍一半，是产品决策，这一轮没动 |
| 服务端 source map 三份 | 49.5 MB | Node 不加 `--enable-source-maps` 根本不读。**已去掉** |
| migrate-forwardx.js、reset-admin-password.js 各自整包 | 13 MB | **已改成四个入口共享公共块** |
| 离线 IP 库 dist/geo | 12 MB | 要留 |
| 前端 client/dist | 17 MB | JS 9.4 MB（195 个按需块）、壁纸 JPG 5.5 MB、PNG 1.6 MB。**图片已转 WebP** |
| 服务端 index.js | 8.3 MB | 带着开发面板的演示数据种子。**已改动态导入** |

## 二、这一轮改了什么（都有前后数）

| 项 | 改前 | 改后 |
|---|---|---|
| dist/（服务端产物，含 12 MB IP 库） | 82 MB | 21 MB |
| 服务端 JS（含 .map） | 69.6 MB | 9 MB（163 个共享块 + 4 个入口，无 .map） |
| 面板冷启动到可服务（空库、本机） | 3.4 s（startupMs=1559） | 1.3 s（startupMs=158） |
| 壁纸 5 张 | JPG 5.30 MB（最宽 3840） | WebP 1.44 MB（最宽 2560、q80） |
| 星空 / 地形贴图 | PNG 0.88 + 0.37 MB | WebP 0.73 + 0.26 MB |
| client/dist | 17 MB | 14 MB |
| knip 无用导出 / 导出类型 / 死代码 | 860 / 251 | 0 / 0；tsc 顺带揪出 69 个再没人用的声明（多是 `*ForTests` 复位函数、没人用的 UI 原语、整个没人渲染的组件），已删 |
| lint 基线（no-explicit-any 等警告总数） | 7589 | 7460 |

发布包预计从 88 MB 降到约 75 MB（.map 压缩后约 10 MB、重复入口约 3 MB、图片 2.6 MB）；准确数字看下一次 Release。

兼容：
- `dist/` 里新增 `chunk-*.js`，入口文件名不变；安装脚本和 Dockerfile 都整目录拷，不用改。公共块和入口同目录，代码里 `__dirname` 找 `client/dist`、`dist/geo`、`dist/agent` 的路径不变。
- 要 source map 排错：`FORWARDX_SERVER_SOURCEMAP=1 pnpm build`。
- 本机反复 `pnpm build` 不再在 dist/ 里堆旧块：esbuild 配置先清掉上一次的入口和 chunk。
- 老 App / 旧缓存按旧文件名要壁纸 `.jpg`、贴图 `.png`：301 到同名 `.webp`（server/staticAssets.ts）。壁纸在设置里按 id 存，不受影响。
- knip 不再看 `shared/ssEgress.ts`、`gostRuntimeApi.ts`、`mitaAssets.ts`、`fxpRuntime.ts`：这几个文件的 `export const` 被 `scripts/check-versions.mjs`、`build-agent-release.sh` 用正则读，去掉 `export` 会把发布校验弄坏（第一遍自动修就撞上了）。

## 三、量过、没收益、没改的

**空闲预取改「只下载不执行」。** 原以为登录后预取 110 个块、4.5 MB 并全部执行是手机卡顿和内存的大头。实测（无头 Chromium，登录后 6 秒）：

| | 下载 JS | 执行（求值）JS | JS 堆 |
|---|---|---|---|
| 现状（标签栏 4 页 + 规则 / 主机 / 链路 全部 import） | 113 个 / 5538 KB | 111 个 / 4553 KB | 26～28 MB |
| 改成只执行前 3 页、其余 fetch 进缓存 | 114 个 / 5540 KB | 106 个 / 4550 KB | 28～30 MB |

执行量几乎没变：大头就是规则、主机、链路这三页本身（各 600～800 KB，连带 60 多个共享块），而这三页正是要「点下去就到」的；其余页加起来才几百 KB。省流量 / 慢网（`navigator.connection.saveData`、3G 及以下）本来就不预取。改动已回退，不值得多一份构建时清单。

**把外壳的 15 个慢变查询合成一个 bootstrap。** 实测登录到总览一共 12 个 tRPC HTTP 请求、27 个 procedure：其中 15 个外壳查询本来就在**同一个**批量请求里；总览的 4 张图表走 `criticalQueryPaths` 故意单发，不被别的拖慢；服务端处理整批只要 11～13 ms。合并省不出请求，也省不出时间，不做。

## 四、前端现状（基线，供以后对比）

无头 Chromium、本机、空库：登录页 3 个 JS 共 1562 KB 原始（入口 874 KB，brotli 后约 280 KB；英文界面多一个 651 KB 翻译包）；登录到总览 1.4～1.7 s；页内切换规则 125～239 ms、主机 70～165 ms、链路 57～110 ms；静置 10 秒只有 3 个轮询请求。静态资源 brotli + 一年 immutable，已经是对的。

入口包里：react-dom 177 KB、外壳组件 136 KB、query-core 44 KB、动画 42 KB、sonner 32 KB、lucide 25 KB。要再降首屏只能拆 DashboardLayout（2682 行）和换掉动画 / 提示库，收益几十 KB（gzip 后），这一轮没做。

## 五、还能做、要拍板的

1. gost 运行时（69 MB）和 mita（24 MB）不进面板包，首次需要时按钉死的 SHA-256 从 Release 下载并缓存：包约 75 MB → 35 MB；离线部署要另发完整包。
2. 继续拆大文件：telegramBot.ts 已按层拆成 7 个文件（见 `server-layout.md`）；Rules.tsx 10089 行（一个 8019 行的组件）和 agentHeartbeatRoute.ts 5791 行（一个 5458 行的函数）要按「每次抽一小块、带测试、单独提交」推进，另开一轮。
3. 多主机 / 多规则下的后端压测（心跳、列表），仓库里有 `scripts/bench/heartbeat-load.mjs`，这一轮没有带数据的环境。

量法都在本文件对应的脚本里：`scripts/bench/` 之外的临时脚本（Playwright 量首屏 / 预取 / 切页）没有入库，需要时按本文的指标重写即可。
