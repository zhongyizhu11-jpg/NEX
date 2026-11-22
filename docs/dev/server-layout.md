# 服务端目录分域（进行中）

`server/` 以前是 1200 多个文件平铺在一个目录里。2026-11 起按领域分目录，第一批搬了四个边界清楚、别处依赖少的领域：

| 目录 | 内容 |
| --- | --- |
| `server/telegram/` | Telegram 机器人、通知偏好、手机端登录、小程序登录、Widget 安全校验 |
| `server/discord/` | Discord 机器人、通知、OAuth 登录、设置 |
| `server/oauth/` | Google / 通用 OIDC 登录、OAuth 原语与路由帮助 |
| `server/payment/` | 支付协议、签名、订单回调、GM Pay、支付地址 |

原有的 `routers/`、`repositories/`、`services/`、`ops/`、`_core/`、`forwardGroups/`、`hostReplace/`、`ipChange/`、`routeTargetHints/`、`shopSync/` 不变。

## 规矩

- 领域目录只放这个领域自己的实现和测试；跨领域共用的留在 `server/` 顶层或 `shared/`。
- 不为搬家改逻辑：一次提交只搬一个领域，`tsc`、`pnpm test:all`、`pnpm lint` 必须和搬之前一样绿。
- 测试里用字符串拼模块路径的（SQLite 真库测试的子进程脚本 `url("server/xxx.ts")`、`cwd: path.resolve(import.meta.dirname, "..")`）要一起改，`tsc` 看不到它们。

## 工具

`scripts/move-server-domain.mjs <领域> <文件名正则> [--apply]`：把 `server/` 顶层匹配的 `.ts` 文件搬进 `server/<领域>/`，用 TypeScript 编译器重写全仓库的相对导入（含 `import()`、`export ... from`、`import type`），并改 `package.json` 里 `test:server` 的显式路径。不带 `--apply` 只打印会搬哪些、改几处。搬完请：

1. `pnpm exec tsc --noEmit`
2. 全文搜 `"server/<旧文件名>.ts"` 这类字符串路径并改掉（脚本不改字符串）
3. 跑搬走的那些测试，再 `pnpm lint:update`（基线按文件记，搬家后要重新平衡，总数不能涨）

`scripts/extract-component.mjs <页面文件> <组件名> <目标文件> [--apply --pages-alias @/pages/Xxx]`：把页面里的顶层组件连同只有它用的帮助函数 / 类型抽成单独文件，页面改成 `lazy(() => import(...))`；别处也用的帮助函数留在页面并导出。抽完要手动给用点包 `<Suspense>`，并跑 `tsc`。`Rules.tsx` / `Tunnels.tsx` / `Settings.tsx` 的地球、自测弹窗和设置分区就是这么抽的。

## any 的清理

`pnpm lint` 的基线里 `@typescript-eslint/no-explicit-any` 有 7000 多条。第一刀去掉的是路由层里对数据库行的多余强转：`(rule as any).tunnelId` 这类字段本来就在 `ForwardRule` / `Tunnel` / `Host` 的推断类型上，直接 `rule.tunnelId` 即可，`tsc` 会把真正缺字段的留下。`rules.crud.ts` 348 → 244、`tunnels.ts` 253 → 235、`hosts.ts` 177 → 170。下一步建议同样按「先删 cast、让 tsc 说话」的办法推进仓储层的返回类型。

## 下一批候选

按依赖少到多：`mimic*`（12 个文件，脚本 dry-run 只改 17 处导入）、`ddns*` / `dnspod*`、`proxySub*`、`forwardGroup*`，然后是最大的 `agent*`（53 个文件）、`rule*`、`host*`、`tunnel*`。
