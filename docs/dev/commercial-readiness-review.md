# NEX 商用上线前整改方向（2026-11-22 审计）

> 整改进度见文末「已落地的整改」。
> 审计对象：`main` 分支 ddd7380（面板 2.3.547 / Agent 2.2.267 / FXP 2.2.149）。
> 方法：实际跑了类型检查、全量测试、依赖漏洞审计、Go 漏洞扫描、staticcheck、前端构建，并按安全 / 主机安全 / 数据与运维 / 计费 / 法务合规 / 工程质量 / 前端移动端七个维度读代码取证。文中标注「需核实」的是没能在仓库内确认、要你们去查的事项。

---

## 0. 总体判断

这是一个**工程基础扎实、但以「单人维护的开源自部署面板」形态长成的系统**。要变成对外收费的商用产品，差的不是功能，而是下面四类东西：

1. **信任边界要收紧**：Agent 以 root 跑在客户机器上、面板默认明文 HTTP、CSP 放开了内联脚本和外部 CDN。
2. **运行形态要从「一台机器一个 SQLite」升级到「可横向扩、可回滚、可恢复」**：没有版本化迁移、多实例只在 MySQL/PG 下部分支持、容器以 root 运行、没有 HEALTHCHECK。
3. **法务与合规是空白**：AGPL 义务没在 UI 里履行、第三方组件声明不全、品牌仍叫 ForwardX、没有隐私政策/服务条款/账号注销、Android 签名密钥在仓库里。
4. **工程可持续性**：52 次提交 50 次来自一个人；`server/` 1250 个文件平铺；单个前端页面 1.1 万行；7589 条 lint 基线债务；每个 PR 一个 patch 版本号、没有稳定通道。

### 实测基线（这些是好消息）

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过（1 分 26 秒） |
| `pnpm test:all` | 4797 个用例，4790 通过，0 失败，7 跳过（需外部 MySQL/PG/netns），12 分钟 |
| `pnpm audit --prod` | 运行时依赖 0 个已知漏洞 |
| `pnpm audit`（含 dev） | 16 个（vite via vitepress、esbuild、glob），均不进运行时镜像 |
| `go vet` / `go test` lbcore | 通过 |
| `govulncheck` agent / fxp | 仅标准库条目，均在 Go 1.24.8+ 修复；CI 与 Dockerfile 用 1.26，但 `go.mod` 仍写 1.24.0 |
| `staticcheck -checks SA*` agent | 10 条，其中 `actions.go:1773`（循环首轮即 return）和 `protocol_guard_rate.go:221` 值得人工看；CI 里该步骤是 `continue-on-error` |
| 前端构建 | 通过，JS 共 9.6 MB（未压缩），最大块 react-globe 1.7 MB、maplibre 1.0 MB、主包 873 KB、英文词典 651 KB |
| E2E | 真 Agent + 真流量 17 步场景（`e2e/scenario.ts`），覆盖主备切换、人工指定、交回 |

已经做对的安全控制（不用重做）：scrypt 异步哈希且对未知账号等时（`server/password.ts`）；JWT 占位密钥一律拒绝并自动持久化随机密钥（`server/env.ts:9-57`）；`trust proxy` 默认只信回环；支付回调签名用 `timingSafeEqual`、校验商户号、处理迟到回调与已删订单墓碑（`server/payment.ts:1808-1879`、`gmPay.ts:90`）；金额全部整数分 `bigint`（`drizzle/schema.ts:198,1779,1994`）；安装向导在有管理员后对所有人锁死写接口，连管理员令牌也不例外（`server/routers/setup.ts:196-226`）；富文本统一过 `sanitizeHtml`（`client/src/lib/htmlContent.ts:146`）；有 SSRF 模块；Agent 二进制下载校验 SHA256SUMS（`server/agentInstallScripts.ts:40-74`）；Agent 请求体加密 + HMAC 证明（`agentCrypto.ts`、`agentAuthChallenge.ts`）；原生 SQL 124 处插值全部是 `quoteIdentifier` 包过的表/列名，数据走参数。

---

## 1. 应用安全（面板）

### P0 上线前必须

| # | 问题 | 证据 | 整改 |
| --- | --- | --- | --- |
| S1 | **CSP 允许 `'unsafe-inline'` 脚本并信任 jsdelivr / live2d CDN**，一处 XSS 即可执行任意脚本；`connect-src https: http:` 等于不限 | `server/index.ts:158-161` | 改为 nonce 或 hash 方式；把 live2d / jsdelivr 的脚本改成面板自托管（规则集镜像 `proxySubRulesetMirror.ts` 已有同类做法）；`connect-src` 只留 `'self'` 与明确的第三方域 |
| S2 | **CSRF 只依赖 `SameSite=Lax`**，没有显式 Origin / `Sec-Fetch-Site` 校验；移动端 CORS 又带 `Allow-Credentials` | `server/_core/cookies.ts:9-12`；`server/index.ts:125-140`；全仓无 csrf 相关逻辑 | 在 tRPC 中间件对所有 mutation 校验 `Origin` 必须等于面板自身或白名单 App 源；给状态变更的 express POST 路由（主题上传、Logo、插件包）同样加 |
| S3 | ~~操作审计只有 3 处落点~~ **更正：审计已是 tRPC 中间件级全覆盖**（`server/_core/trpc.ts:120` 的 `auditMutationCall` 对所有登录用户的 mutation 记一行，另有 `config_audit_events` 记前后值）。首稿按函数名 grep 误判，此条撤销 | `server/operationAudit.ts` | 无需整改；建议补：审计表的导出 / 只读归档与保留期在商用 SLA 里写明 |
| S4 | **面板默认明文 HTTP，Agent 安装命令把 Token 放在 `http://IP:9810/...` 里** | README 快速部署、`shared/agentInstallCommand.ts:85` | 默认开启面板 TLS（已有 `panelSsl.ts` 和自动热加载），安装脚本默认走 HTTPS 并校验证书；明文 HTTP 只允许回环 / 内网并在 UI 持续警告 |
| S5 | 登录会话 10 天、无绝对过期与并发会话上限的产品化策略 | `server/_core/cookies.ts:12` | 商用默认：管理员 2FA 强制、会话 24h 滑动 + 7 天绝对、可配置；敏感操作（改密、改支付配置、导出备份）二次验证 |

### P1 上线后 30 天

- API 令牌（`shared/apiTokenModules.ts`）按模块授权，但 `auth.` 前缀对所有令牌放行，确认其中没有改密 / 改邮箱类接口。
- `publicProcedure` 11 处逐一复核返回字段（`redactSetupStatusForPublic` 是好例子，照此检查公告、套餐、落地页）。
- 用户态 `protectedProcedure` 只有 10 处，大部分面板能力是管理员态；若商用是「多租户用户自助」，要专门做一轮用户态 IDOR 测试：`requireHostAccess / requireRuleAccess`（`server/routers/helpers.ts:33-115`）是否覆盖了每条带 id 的用户态接口。
- 速率限制、验证码、登录失败锁定全部在进程内存（`apiRateLimit.ts`、`authRateLimit.ts`），多实例下失效，见第 3 节。
- 引入自动化安全测试：依赖审计进 CI（`pnpm audit --prod` 失败即红）、Semgrep / CodeQL、每季度一次外部渗透测试并保留报告。

---

## 2. Agent 与客户主机安全

Agent 是装在**客户**机器上以 root 运行、能改防火墙和路由的组件，它的事故会直接变成客户事故。

### P0

| # | 问题 | 证据 | 整改 |
| --- | --- | --- | --- |
| A1 | systemd 单元只有 `Restart=always` 和 `LimitNOFILE`，无任何沙箱 | `server/agentInstallScripts.ts:735-743` | 加 `NoNewPrivileges=yes`、`ProtectSystem=strict` + 明确 `ReadWritePaths`、`ProtectHome=yes`、`CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE ...`、`AmbientCapabilities`、`SystemCallFilter=@system-service`；目标是去掉 root 跑 |
| A2 | Agent 与面板的信任是**单向 Token**，面板证书不校验绑定；面板被接管即可向所有客户机下发任意配置 | `agent/main.go:1795` 接受 `http://`；`InsecureSkipVerify` 虽只在探测代码（`ext_realitycheck.go:360`）属合理 | 面板侧证书指纹或公钥在安装时固定进 Agent 配置（TOFU + 可轮换）；下发的「期望状态」加面板签名（Ed25519），Agent 验签再执行；二进制升级的 SHA256SUMS 改为签名文件 |
| A3 | 卸载 / 崩溃后 iptables / nft 规则残留与误删客户已有规则的风险未见专项测试（netns 测试默认 SKIP） | 测试 887/888/3003 需 `FORWARDX_NETNS_E2E=1` | 把 netns 真机测试放进 CI 的独立 job（GitHub runner 支持 unshare）；增加「卸载后链为空」「不碰非 NEX 链」「SSH 端口永不被规则覆盖」三条硬断言 |
| A4 | `go.mod` 声明 1.24.0，本地 1.24.7 扫出标准库漏洞；发布虽用 1.26，但没有「标准库出 CVE 就重建发版」的机制 | govulncheck 输出 | `go.mod` 升到与发布一致并写 `toolchain`；Dependabot/Renovate 盯 Go 版本；每月一次无代码变更的安全重建 |

### P1

- staticcheck 从 `continue-on-error` 改为拦截，先清掉现有 10 条（`actions.go:1773` 的循环逻辑看起来就是 bug）。
- 为 Agent 写一页「威胁模型」：它能做什么、不能做什么、面板失陷时的爆炸半径、客户如何审计它执行过的命令（本地只追加日志 + 面板侧审计）。
- 资源上限：Agent 对规则数、连接数、日志体积的上限与降级行为需要有文档与测试（长时间运行内存曲线做一次 72 小时压测）。
- FXP 加密协议目前没有对外的设计文档；商用前请一位外部密码学审阅者看一次 V1/V2/V3 的密钥派生、nonce、重放与降级路径。

---

## 3. 数据层、可靠性与运维

### P0

| # | 问题 | 证据 | 整改 |
| --- | --- | --- | --- |
| D1 | **没有版本化迁移**：启动时 `ensureDatabaseSchema` 做幂等 `CREATE/ALTER`，无迁移编号、无回滚、无「升级前快照」 | `server/dbSchema.ts:1291`；`drizzle/` 只有 `schema.ts`，无 migrations | 引入编号迁移（drizzle-kit generate 或自写 `migrations/0001_*.sql`）+ `schema_version` 表；升级前自动做一次本地备份；写明「哪些版本可以直接回退」 |
| D2 | **多实例不可用**：限流、验证码、缓存、任务锁都在内存；SQLite 明确单实例 | `panelLease.ts:22-23`；`apiRateLimit.ts`、`queryCache.ts`、`keyedTaskLock.ts` 均为 `new Map` | 商用部署基线定为 PostgreSQL；把限流/锁迁到 DB 行锁或 Redis；文档明确「SQLite 仅用于评估」 |
| D3 | 容器以 root 运行、无 `HEALTHCHECK`、无资源限制；镜像内带 docker-cli 用于自升级（需要挂 docker.sock = 容器逃逸等价物） | `Dockerfile` 无 `USER`；`docker-compose.yml` 无 healthcheck；`install-panel-docker.sh:941` | 以非 root 用户运行；加 `HEALTHCHECK`（已有 `/api/database-health`）；自升级改为宿主机 systemd timer / 外部编排触发，不再挂 socket；compose 加 `mem_limit`/`pids_limit` |
| D4 | 备份有定时异地（S3/WebDAV/Telegram）但**没有恢复演练与校验** | `server/ops/offsiteBackupLogic.ts`，`scripts/decrypt-backup.mjs` | 加「备份后自动恢复到临时库并比对行数」的自检；文档化 RTO/RPO；SQLite 用 `VACUUM INTO` 或 backup API 而非拷文件 |

### P1

- 优雅退出只覆盖写缓冲（`dbWriteBatcher.ts:347`），应补：停止接收新请求 → 等待在途心跳 → 释放 `panel_leases` → 刷缓冲 → 退出，并给 compose `stop_grace_period`。
- 后台任务统一到 `scheduler.ts` 的注册表，输出 Prometheus 指标（已有 `metricsExport.ts`）：每个任务的最近成功时间、耗时、失败次数，并加告警规则进 `deploy/grafana`。
- 日志：结构化 JSON、请求 ID 贯穿 tRPC → 仓储 → Agent 事件；对 IP / 邮箱做可配置脱敏；明确保留期。
- 发布镜像只有 `latest` 和 `vX.Y.Z` 两个标签，没有 SBOM、签名、Provenance；加 `syft` 生成 SBOM、`cosign` 签名、GitHub attestations。
- 容量基线：用 `scripts/bench` 做 200 主机 / 2000 规则 / 50 并发用户的压测，记录 p95，作为后续回归门槛（已有多处 `*QueryCost.test.ts` 是好基础）。

---

## 4. 计费与商业能力

正确性基础不错：整数分、支付签名与商户校验、迟到回调、订单墓碑、兑换码限频（`billingRepository.ts:171-258`）、折扣预览限流、库存与配额预留均有测试。缺的是**商业闭环**。

### P0

- **退款 / 撤销 / 争议流程**：未见退款接口与账本冲正语义（需核实 `billingRepository.ts` 是否有 refund 类型）。商用必须有：管理员发起退款 → 账本冲正 → 套餐/配额回收 → 通知用户，并可对接支付通道原路退回。
- **发票 / 收据**：全仓没有 发票 / invoice 相关实现。至少做到：订单可导出 PDF 收据（含经营主体信息、税号字段）；对接电子发票留接口。
- **支付通道合规**：现有易支付（EasyPay）、GM Pay 属于聚合/第四方类通道，支付宝、微信为官方；上线前确认每个通道的商户资质与「代理/VPN 类商户」禁限类目（见第 5 节）。
- **账本不可绕过**：确认所有改 `balanceCents` 的路径（含 Telegram 机器人的「续费 / 加余额」、商城对接 `shopSync`、Xboard 兼容）都经同一个记账函数，并由数据库约束（触发器或唯一账本序号）保证；加一条每日对账任务：Σ账本 == 余额。

### P1

- 定价、折扣、推荐佣金的边界测试：自荐、佣金环路、折扣叠加、负数、极大值。
- 时区：计费周期以 `billingTime.ts` + `panelClock.ts` 为准，确认 UI 显示与账单一致，并在设置里显式声明结算时区。
- 用量计量的信任模型：流量由 Agent 上报，被攻破的 Agent 可少报。商用需在面板侧做跨源校验（入口 vs 出口、规则 vs 主机网卡总量）并对异常给告警（已有「流量异常检测」，把它接到计费侧）。
- Telegram 机器人承载了续费、兑换、加主机等资金 / 资源操作（`telegramBotMore.ts`），需确认：Telegram 身份与面板账号的绑定是一次性密码或 Web App 签名验证，且管理员命令对非管理员 chat 严格拒绝。

---

## 5. 法务、许可证与合规

这一节决定「能不能卖」，优先级与安全同级。

### 许可证义务

- **AGPL-3.0**：作为 SaaS 或售卖自部署版，必须向每个网络用户提供对应源码（含你们的修改），UI 中要有可达的源码 / 许可证入口。目前 `client/src` 没有任何 AGPL / 源码链接（仅 `clientLogos/README.md` 提到 license）。→ 在「关于 / 页脚」加版本号 + 源码仓库链接 + 许可证文本，且发布的镜像与源码 tag 一一对应。
- **上游 poouo/Forwardx**：NEX 是其衍生品（README、`migrate-from-forwardx.md`）。上游许可证**需核实**。若上游是 AGPL/GPL，NEX 无法闭源或改成商业许可，只能卖服务 / 托管 / 支持；若上游是宽松许可，也要保留其版权声明。`LICENSE` 与 `package.json` 目前都没有上游版权行。
- **第三方组件声明缺口**（`THIRD_PARTY_NOTICES.md` 现有：wireguard-go、reedsolomon、kcp、地球贴图、Inter、Pearl Glass、ip2region、mita）：

| 组件 | 使用方式 | 许可证 | 商用注意 | 已在 NOTICES |
| --- | --- | --- | --- | --- |
| go-gost/gost | 下载官方二进制随 Agent 分发（`build-agent-release.sh:106`）+ `gost-runtime/` 补丁 | MIT（需核实版本） | 保留声明；补丁需公开 | 否 |
| realm | 下载分发 | MIT/Apache（需核实） | 保留声明 | 否 |
| sing-box | 运行时计划（`singboxRuntimePlan.ts`） | GPL-3.0 带附加条款（需核实） | 若随产品分发二进制，附加条款限制品牌与分发方式 | 否 |
| nginx（forwardx-nginx 运行时）、socat | 分发 / 调用 | BSD-2 / GPL-2 | 保留声明 | 否 |
| mimic / wg-mimic-fabric | 安装脚本拉取 | 需核实 | 内核模块，GPL 传染性需评估 | 否 |
| live2d-widget + Cubism Core | 插件按需加载 | GPL-3 + Live2D 专有许可 | Live2D 对商用有年营收门槛与出版许可要求 | 是（插件内） |
| ipapi.co / ipwho.is | 面板把**客户主机 IP** 发往第三方查归属地（`server/hostGeo.ts:80,105`） | 服务条款 | 免费层通常禁止商用 / 有配额；且是客户数据出境 | 否 |
| flagcdn.com | 前端直连取国旗 | 服务条款 | 可自托管 | 否 |
| ipverse/country-ip-blocks | 防火墙国家段数据 | 需核实 | — | 否 |

→ 做一次 SBOM 驱动的许可证盘点（`syft` + `go-licenses` + `license-checker`），把结果写回 NOTICES，并在 UI「关于」页可查看。

### 品牌

- 包名 `forwardx`、镜像 `ghcr.io/.../forwardx`、服务名 `forwardx-panel`、Android `com.forwardx.app`、安装目录 `/opt/forwardx-panel`，而产品叫 NEX。对外商用前统一品牌，否则与上游 ForwardX 构成混淆，也影响商标注册。Android 包名一旦上架不可改，**必须在首次商用发布前定稿**。

### 隐私与数据保护

- 存储的个人数据：邮箱、密码哈希、登录设备与 IP、Telegram / Discord / Google / OIDC 身份、订阅访客地理位置（`proxySubVisitorGeo.ts`）、工单内容。
- 对外传输：主机 IP → ipapi.co / ipwho.is；版本检查 → GitHub API；时钟校准 → cloudflare / github / baidu；AI 功能 → 管理员配置的 LLM 提供商（`server/ai/client.ts:242`，发送系统提示与对话，需确认是否含主机 / 用户数据）。
- 缺失：隐私政策、服务条款、Cookie 说明、数据保留期配置、**账号注销与数据导出接口**（全仓未找到）、处理者清单。中国大陆用户适用《个人信息保护法》，境外用户适用 GDPR 等；至少补齐：注册勾选协议、注销流程、导出接口、第三方清单可关闭（地理归属地改走离线 ip2region 已有能力）。

### 产品类别的监管风险（请法务逐项评估，这里只列检查点）

- 产品包含代理订阅生成（VLESS / Reality / sing-box / Xboard 兼容）、UDP 流量混淆、国家区域白名单插件。按运营所在地与用户所在地分别评估：增值电信业务许可（IDC / ISP / CDN）、跨境数据与加密出口管制、支付机构对「VPN / 代理」类目的禁限、应用商店（Google Play、App Store）对该类功能的政策。
- 建议：把「纯端口转发 / 隧道运维」与「代理订阅」在产品与定价上拆成可独立关闭的模块，让不同市场可以只发合规子集。

### App 分发

- **社区签名密钥和口令都在仓库里**（`android/app/keystore/community-release.p12`，口令 `forwardx-community-release` 写在 `.github/workflows/android-apk.yml:150,182,184`），发布流程在没配 secrets 时会回落到它。任何人都能签出可**原地覆盖升级**用户已装 App 的 APK。商用前：生成私有密钥、改包名（等于新 App）、从仓库与历史中移除旧密钥、发布说明里告知社区版用户需卸载重装。
- iOS 目前是未签名 IPA 自签流程，无法商用分发；需要 Apple 开发者账号、隐私清单、App Review 评估（见上一条监管风险）。

---

## 6. 工程质量与可持续性

| 指标 | 数值 | 影响 |
| --- | --- | --- |
| `server/` 顶层文件数 | ~1250（平铺） | 新人找不到边界；`routers/ repositories/ services/ ops/ _core/` 与平铺文件混用 |
| 最大文件 | `Rules.tsx` 10988 行、`Settings.tsx` 7480、`telegramBot.ts` 6483、`agentHeartbeatRoute.ts` 5791、`billingRepository.ts` 4660 | 任何改动都在同一文件冲突；无法做局部测试 |
| lint 基线债务 | 7589 条（`any` 7175 条 / 446 文件；未 await Promise 307；hooks 依赖 107） | 类型安全名存实亡的区域集中在服务端 |
| TODO/FIXME | 149 | 可接受，但要进 issue 跟踪 |
| 提交作者 | 50/52 来自一人 | **单点风险**：没有人能在作者缺席时发版 |
| 版本号 | 2.3.547，每个 PR +1 patch | 用户无法区分「安全修复」与「功能变更」；`latest` 镜像每次都动 |

### P0

- **发布通道**：建立 `stable`（每月，仅修复）与 `edge`（现状）两条线；`latest` 指向 stable；语义化版本：破坏性改动升 minor，安全修复单独发并写 CVE 风格公告；保留 N-1 版本的回退路径与数据库兼容说明。
- **知识转移**：写 `ARCHITECTURE.md`（请求如何从 tRPC 到仓储到 Agent 心跳、关键后台任务、关键不变量）与 `RUNBOOK.md`（告警 → 处置）；把散落在注释里的事故经验（如 `index.ts` 内「用户 2026-11-03」）收口到 docs/dev。
- **CI 收紧**：staticcheck 拦截；`pnpm audit --prod` 进 CI；netns 测试进 CI；`go test -race` 从每夜改为 PR 必跑（lbcore / fxp 关键包）。

### P1

- 把 `server/` 按领域分目录（auth、agent、forwarding、tunnels、billing、notifications、ops），先移动不改逻辑；`db.ts` 作为「上帝模块」逐步拆成仓储。
- 拆页面：`Rules.tsx` / `Settings.tsx` / `Tunnels.tsx` 按 Tab 拆成独立懒加载模块，顺带把主包 873 KB 压下来。
- `any` 债务按模块设清零目标，先从 `routers/` 与 `repositories/` 的对外签名开始；`lint:update` 只允许下降。
- 覆盖率：接入 `c8` 输出覆盖率并设最低线；现有 4797 个用例以纯逻辑为主，路由层集成测试偏少。
- 依赖：Express 4（5 已 GA）、`avataaars` + lodash shim、`svg-captcha`（已有 Cap 验证码可替代）列入淘汰清单；`patches/` 目录逐个记录为什么打补丁、上游 issue 链接。

---

## 7. 前端、移动端与国际化

### 性能

- 首屏主包 873 KB + 英文词典 651 KB（切英文时）+ 5.4 MB 壁纸目录；地图相关 react-globe 1.7 MB、maplibre 1.0 MB、HostFlatMap 733 KB。已有 6 处路由级懒加载和 immutable 缓存策略（`server/index.ts:70-95`），但：
  - 地球 / 地图应在进入对应页面时才加载，并提供「轻量列表模式」给低端设备。
  - 壁纸、地球贴图走对象存储或 CDN，不随镜像分发。
  - 轮询以 30s 为主（7 处）、最密 2s（1 处），规模化后改为 SSE 推送（Agent 事件已是 SSE）。

### 国际化

- 英文是**运行时 DOM 文本替换**（`client/src/i18n/domTranslator.ts`），词典 700 KB。作者注释已说明这是为了避免重写 13 万行。商用面向海外时它的问题是：拼接句、动态数字、第三方组件文案无法稳定覆盖，且每次 UI 改动都可能静默回退成中文。建议：新代码一律 `t()`，旧页面按 Tab 拆分时顺带迁移；日期 / 货币 / 字节格式化集中到 `shared/format*.ts` 并随语言切换。

### 移动端

- 包名 `com.forwardx.app` 需定稿（见第 5 节）；App 如何发现面板地址（一个 App 服务多个客户面板）需要明确商用形态：单租户白标 App 还是通用 App + 输入面板地址。
- iOS：隐私清单、ATT、后台刷新与通知权限说明；Android：targetSdk 跟进当年 Play 要求、64 位、数据安全表单。

### 体验

- 缺少面向付费用户的法律入口（协议、隐私、退款政策）、状态页链接、支持渠道（工单已有）。
- 建议建立「设计走查清单」：破坏性操作二次确认、空态、错误态、键盘可达（已有 `accessibleNames.test.ts` 等结构性测试，是很好的起点）。

---

## 8. 分阶段路线

### 阶段 0：上线前（阻塞项，建议 4–6 周）

1. 法务：核实上游许可证 → 决定商业模式（托管 / 服务 / 双许可）；SBOM 许可证盘点并补 NOTICES；隐私政策、服务条款、退款政策；支付通道类目确认；品牌与包名定稿。（第 5 节）
2. 安全：CSP 去 `unsafe-inline`、CSRF Origin 校验、统一审计中间件、面板默认 TLS、Agent systemd 沙箱、Agent 期望状态签名、换掉仓库内 Android 密钥。（S1–S5、A1–A2、App 分发）
3. 运维：版本化迁移 + 升级前备份 + 回退说明、非 root 容器 + HEALTHCHECK、PostgreSQL 作为商用基线、备份恢复演练。（D1–D4）
4. 计费：退款与冲正、收据、每日账本对账。（第 4 节 P0）
5. 工程：stable/edge 通道、ARCHITECTURE/RUNBOOK、CI 收紧。（第 6 节 P0）

### 阶段 1：上线后 30–60 天

- 限流 / 锁迁出内存，支持多实例；结构化日志与请求 ID；任务指标与告警；SBOM 与镜像签名；netns 测试进 CI；FXP 外部密码学审阅；用户态 IDOR 专项测试；账号注销与数据导出；地理归属地默认离线。

### 阶段 2：持续

- `server/` 分域重构与大页面拆分；`any` 清零计划；i18n 迁移到 `t()`；地图资源按需加载与 CDN；Express 5 与依赖淘汰；覆盖率门槛；每季度渗透测试与依赖复审；第二位发布负责人与密钥托管。

---

## 9. 排查方法建议（怎么自己持续发现这类问题）

- **每次发版前的固定清单**：`tsc` → `pnpm test:all` → `pnpm audit --prod` → `govulncheck`（用发布工具链）→ `staticcheck` → 构建产物大小对比 → 迁移脚本在上一版数据库快照上演练 → 备份恢复自检。
- **威胁建模会**：每新增一类「面板替客户执行」的能力（换主机、自升级、远程诊断、插件任务），先写一页：谁能触发、Agent 如何验证、失败如何回滚、留什么痕。
- **许可证与隐私门禁**：新增依赖或新外呼域名的 PR 必须更新 NOTICES / 第三方清单，CI 用 SBOM diff 拦截。
- **指标驱动的质量债**：每月输出 lint 基线、`any` 数、最大文件行数、覆盖率四个数字的趋势图，只许降不许升。

---

## 10. 已落地的整改（2026-11-22，分支 claude/nice-goldberg-inty9l）

| 条目 | 改动 | 验证 |
| --- | --- | --- |
| S2 CSRF | 新增 `server/_core/csrf.ts`：对所有用 Cookie（或未登录）发来的 tRPC mutation 校验 `Origin` 必须是面板主机 / 手机 App 源 / `FORWARDX_TRUSTED_ORIGINS`；无 Origin 时拒绝 `Sec-Fetch-Site: cross-site`。Bearer 令牌请求不受影响。中间件挂在操作审计之后，被拒的请求也留痕 | `server/_core/csrf.test.ts` 7 个用例；全量测试 |
| S3 | 撤销（见上表更正） | — |
| A1 Agent 沙箱 | systemd 单元新增 `NoNewPrivileges / RestrictSUIDSGID / RestrictRealtime / LockPersonality / ProtectHostname / ProtectClock / ProtectKernelLogs`；刻意不加 `ProtectSystem / ProtectKernelTunables / ProtectKernelModules`（会挡 sysctl、mimic、运行时目录） | `server/agentInstallScripts.test.ts` 断言正反两组指令 |
| D3 健康检查 | `Dockerfile` 加 `HEALTHCHECK`，`docker-compose.yml` 加 `healthcheck` 与 `stop_grace_period: 30s`（给写缓冲刷库留时间）。探测 `/api/database-health`，库故障时仍 200，不会误触发重启 | 构建通过 |
| A-P1 staticcheck | 清掉 agent 10 条、fxp 5 条 SA 级问题：其中 `agent/actions.go` 的 `activeSharedRuntimeForwardType` 循环首轮即 return 是真 bug（只看第一条路径），已修；无法改的写法用 `//lint:ignore` 注明原因。CI 去掉 `continue-on-error`，开始拦截 | `go vet` / `staticcheck` 三模块 0 条 |
| CI 依赖审计 | typecheck 任务新增 `pnpm audit --prod --audit-level=moderate` | 当前 0 漏洞 |
| AGPL 入口 | 登录页底部加「基于 NEX（AGPL-3.0 开源）」源码链接（未登录用户可见，满足 §13）；系统设置「版本升级」卡加「开源许可」行 | `tsc` |

| 转发专项 | 另见 `docs/dev/forwarding-performance-review.md`：客户端 / 目标复位后会话再挂 30 秒导致连接风暴耗尽句柄（已修，建连速率 180 → 5216 conns/s）、TCP 隧道每块明文一次逃逸分配（allocs/GB −87%）、转发组保护期每次读分配 32 KiB（吞吐 +63% ~ +141%）、UDP 多会话热路径每包加锁（单核 256 会话 pps +23%、丢包 −36%）等 | 新增 9 个测试、3 个基准，全量 Go 测试通过 |

**未动、需要你们决策或密钥的项**：上游许可证核实与品牌统一（含 Android 包名）、Android 私有签名密钥（生成后从仓库移除社区密钥与口令）、CSP 去 `unsafe-inline`（需先把 live2d / jsdelivr 自托管并给 `index.html` 内联脚本加 nonce，且浏览器端探测依赖 `connect-src http:`）、版本化迁移体系、非 root 容器（涉及已有数据卷属主迁移）、PostgreSQL 作为商用基线与限流 / 锁迁出内存、退款与发票、隐私政策 / 服务条款 / 账号注销、stable 发布通道。
