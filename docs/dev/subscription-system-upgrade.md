# 客户端订阅系统升级方案（立项）

> 维护者内部文档，不进公开文档站（`docs/.vitepress/config.mts` 的 `srcExclude` 排除了 `dev/**`）。
> 立项日期 2026-10-22。来源：对现有订阅系统（`shared/proxySubscription*.ts`、`server/proxySubscriptionRoute.ts`、
> `server/routers/proxySubscriptions.ts`、`server/repositories/proxySubscriptionRepository.ts`、
> `client/src/pages/ClientSubscriptions.tsx`）的审计，加上对 GitHub 上主流订阅 / 面板项目的对比调研。

## 一、调研了哪些项目

| 项目 | Star | 和订阅相关的看点 |
| --- | --- | --- |
| [tindy2013/subconverter](https://github.com/tindy2013/subconverter) | 17k | 订阅转换的事实标准：`/sub` 参数体系（include / exclude / emoji / rename / sort / udp / scv / tfo / list / append_info / filename / interval）、外部配置（自定义策略组用正则挑节点、规则集 `Group,type:URL`）、模板引擎、`stream_rule` / `time_rule` 从节点名里抠流量和到期 |
| [Aethersailor/SubConverter-Extended](https://github.com/Aethersailor/SubConverter-Extended) | 1k | 在 subconverter 之上：远程订阅转成 mihomo `proxy-providers` 让客户端自己拉、按目标客户端做能力过滤、`&explain=true` 诊断、请求合并与微缓存、公网安全档位 |
| [sub-store-org/Sub-Store](https://github.com/sub-store-org/Sub-Store) | 10.7k | 节点「处理器」流水线：正则 / 地区 / 类型 / 脚本过滤，改名、加旗帜、排序、去重、设属性（udp / tfo / scv），多订阅组合成一个地址，定时缓存，推送通知 |
| [cedar2025/Xboard](https://github.com/cedar2025/Xboard) | 4.8k | 商业面板的订阅实现：按 UA 或 `flag` 参数分发到 11 个协议类（Clash / ClashMeta / SingBox / Surge / Surfboard / Loon / QX / Stash / Shadowrocket / Shadowsocks / General），`types` / `filter` 参数，`show_info_to_server_enable` 把剩余流量、重置日、到期日做成假节点插在最前，`show_protocol_to_server_enable` 节点名加协议前缀，模板文件 `resources/rules/*.yaml` 管理员可改，策略组成员写正则自动填充，按客户端版本门控协议（hysteria2 / ECH 最低版本表） |
| [Gozargah/Marzban](https://github.com/Gozargah/Marzban) | 7.5k | 路由设计：`/sub/{token}`（UA 协商）、`/sub/{token}/{client_type}`（显式格式）、`/sub/{token}/info`、`/sub/{token}/usage`；浏览器打开（`Accept: text/html`）给订阅落地页；头部 `profile-web-page-url`、`support-url`、`profile-title`；节点 remark 可用占位符 `{DATA_LEFT}` `{DAYS_LEFT}` `{STATUS_EMOJI}` 等；UA 识别表按客户端版本决定给 base64 还是 v2ray-json |
| [remnawave/panel](https://github.com/remnawave/panel) | 5.2k | 每个内核多套模板（mihomo / sing-box / xray-json / base64），按用户组或路由规则分配；**HWID 设备数限制**（`x-hwid` / `x-device-os` / `x-ver-os` / `x-device-model` 请求头，`x-hwid-*` 响应头告知客户端，用户卡片列设备、可删除）；独立订阅页项目 |
| [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui) | 48k | 订阅服务独立端口 / 域名、json 订阅、订阅里带流量和到期、客户端 IP 数限制 |
| [hiddify/Hiddify-Manager](https://github.com/hiddify/Hiddify-Manager) | 9.4k | 用户页一键跳客户端（`hiddify://import`）、自动 profile、剩余天数和流量展示 |

## 二、现状（审计结论摘要）

已经有的，而且做得不错：

- 7 种输出格式（base64 / clash / singbox / loon / surge / quantumultx / shadowrocket），按 UA 协商，`?format=` 可指定。
- 同一令牌靠 `rules` 参数区分节点订阅和规则订阅；4 档分流预设、18 个分类、规则集指向 MetaCubeX / SagerNet / blackmatrix7。
- 自动组（url-test / fallback / load-balance）、负载均衡按带宽加权、前置代理（dialer-proxy / detour / underlying-proxy）。
- 9 种协议 × 6 种传输，REALITY / XHTTP 等按格式能力过滤并在文件头注明跳过原因。
- `Subscription-Userinfo`、`Profile-Title`、`Content-Disposition`、Surge `MANAGED-CONFIG`、Shadowrocket `update-url`。
- 令牌启停、重置、拉取计数、最近失败原因；套餐授权、附带节点对账、自动开默认令牌、自动续费、错峰流量重置。
- 一键导入 9 家客户端、二维码、客户端图标可替换。
- 控制字符清洗（防配置注入），资格判定和落地机凭据用同一把尺子。

缺的（和上表项目对照）：

| # | 缺口 | 现状依据 |
| --- | --- | --- |
| 1 | **令牌没有自己的内容**：同一用户所有令牌拉到的节点完全一样，没有子集 / 正则过滤 | `getProxySubscriptionDocumentForUser` 只按 userId |
| 2 | 令牌 `expiresAt` 列存在但无处可设 | 全仓只有路由读它 |
| 3 | 没有设备数 / IP 数限制，`users.maxIPs` 只管转发 | 路由无相关判断 |
| 4 | 没有逐次访问日志，`lastAccessAt` / IP / UA 界面也不显示；管理员没有全站令牌视图 | `listTokens` 只回自己的 |
| 5 | 没有限流、没有缓存，每次请求完整组装 | 路由 :70-182 |
| 6 | 模板写死：Clash 没有 dns / tun / 端口段，sing-box 没有 dns / inbounds；管理员不能改模板、组名、测速地址、更新间隔、规则集地址 | `proxySubscription.ts:293-299` 常量 |
| 7 | 没有自定义规则（全局前置 / 后置、按用户） | `buildProxyRulePlan` 只认预设 |
| 8 | 节点名模板写死「入口主机名 → 模板名」；没有国旗 / 地区识别（`hosts.geoCountryCode` 有但没用）、没有地区分组、没有排序接口（`proxy_nodes.sortOrder` 无接口改） | `proxySubscriptionPlan.ts:264-273` |
| 9 | 没有「剩余流量 / 到期时间 / 公告」信息节点，只靠响应头（Shadowrocket 和 v2rayNG 旧版看不到） | — |
| 10 | 不能导入外部订阅地址并聚合；也不能把外部订阅作为 proxy-provider 透传 | 只能逐条粘贴 |
| 11 | 没有订阅落地页（浏览器打开 `/api/sub/<token>` 是一坨 base64），没有 `profile-web-page-url` / `support-url` / `announce` 头 | — |
| 12 | 没有短链 / 多域名备用地址 | 地址固定 `/api/sub/<40 位>` |
| 13 | UA 识别只认 10 来个子串，没有版本门控（v2rayN 新版吃 json、旧版吃 base64，Hy2 / ECH 的最低版本） | `formatFromUserAgent` |
| 14 | 没有 v2ray-json（xray 配置）、SIP008、Stash / Surfboard 独立目标 | `PROXY_SUBSCRIPTION_FORMATS` |
| 15 | 没有拉取事件通知（首次拉取、新设备、超设备数、被拒） | — |
| 16 | `docs/guide/` 没有订阅文档 | — |

## 三、目标与原则

**目标**：一份订阅地址，对任何主流客户端都「导入即用」；商家能按套餐 / 用户 / 令牌精细控制内容和外观；拉取过程可审计、可限制、可通知；外部节点能聚合进来；不牺牲现有的安全判定。

**原则**（沿用仓库现有做法）：

1. 纯逻辑放 `shared/`，前后端共用，预览所见即客户端所得。渲染拆成**流水线**：取节点 → 令牌过滤 → 处理器（改名 / 旗帜 / 排序 / 去重 / 信息节点） → 模板渲染 → 响应头。每一级可单测。
2. 新表、新列 **`drizzle/schema.ts` 和 `server/dbSchema.ts` 两处同改**，`ensureDatabaseSchema` 自动补列，三种数据库都要能跑。
3. 一律**向后兼容**：旧地址 `/api/sub/<token>?format=&rules=` 行为不变；所有新开关默认值等于现状。
4. 每个工作包独立成 PR，先补守源码的测试（`node:test`，加进 `package.json` 的 `test:server` 清单），改完跑 `pnpm test:all`。
5. 公网接口（`/api/sub/*`）的新能力先想「被滥用会怎样」：限流、SSRF、长度上限、404 不泄露存在性。

## 四、总体设计

### 4.1 公开接口

```
GET /api/sub/:token                       UA 协商；Accept: text/html → 订阅落地页（WP7）
GET /api/sub/:token/:format               显式格式：base64 | clash | mihomo | stash | singbox |
                                          v2ray-json | surge | surfboard | loon | quantumultx | shadowrocket
GET /api/sub/:token/info                  JSON：套餐、已用 / 总量、到期、重置日、节点数、设备数、公告
GET /s/:alias                             短链，内部等价于 /api/sub/<token>（WP1）
GET /api/sub/ruleset/:key.:ext            规则集镜像（可选，WP4）

查询参数（全部可选，沿用 subconverter 命名以便用户迁移）：
  format | target   格式；flag=<客户端名>（Xboard 风格，UA 识别不了时手动指定）
  rules             0 / 1 / <预设名>（现状不变）
  include / exclude 节点名正则（长度 ≤ 64，非法正则按字面量）
  types             协议白名单 vless,vmess,…
  emoji / info / prefix / sort / udp / scv   覆盖令牌上的开关（0 / 1）

请求头：User-Agent、x-hwid、x-device-os、x-ver-os、x-device-model（WP3）
响应头：Subscription-Userinfo、Profile-Update-Interval（可配）、Profile-Title、Content-Disposition、
        profile-web-page-url、support-url、announce（base64）、x-hwid-active / x-hwid-max-devices-reached /
        x-hwid-not-supported（WP3）、Cache-Control
```

### 4.2 渲染流水线（`shared/proxySubscriptionPipeline.ts`，新）

```
collect(userId)                    现有 getProxySubscriptionDocumentForUser（服务端）
  → applyTokenScope(token)         节点子集：ids 白名单 / 黑名单、include / exclude 正则、协议白名单
  → processors(token, settings)    依次：region(国家码→旗帜) → rename(模板) → prefix(协议前缀)
                                   → dedupe → sort → infoNodes(剩余流量/到期/公告)
  → capability(client)             现有 filterForFormat + 新的「客户端家族 + 版本」门控
  → template(target, templateId)   现有各 render* 改为「把 proxies / groups / rules 填进模板」
  → headers(token, owner, client)
```

现有的 `renderProxySubscription(document, format, options)` 保留签名作为薄封装，内部走流水线。

### 4.3 数据模型变更总表

| 表 | 变更 | 用在 |
| --- | --- | --- |
| `proxy_sub_tokens` | 新列 `alias`（短链，唯一，可空）、`scopeJson`（节点子集和过滤）、`nameTemplate`、`flagEmoji`、`protocolPrefix`、`infoNodes`、`sortMode`、`maxDevices`、`templateId`、`remark`、`lastClientFamily`、`lastClientVersion`；`expiresAt` 接上接口 | WP1 / WP3 / WP4 / WP5 |
| `proxy_sub_access_logs`（新） | `tokenId`、`userId`、`at`、`ip`、`userAgent`、`clientFamily`、`clientVersion`、`format`、`profile`、`result`、`hwid`、`bytes`；按天清理 | WP3 |
| `proxy_sub_devices`（新） | `tokenId`、`userId`、`hwid`、`deviceOs`、`osVersion`、`model`、`firstSeenAt`、`lastSeenAt`、`lastIp`、`userAgent`；唯一 `(tokenId, hwid)` | WP3 |
| `proxy_sub_templates`（新） | `name`、`target`、`content`、`isBuiltin`、`isDefault`、`updatedBy`、`updatedAt` | WP4 |
| `proxy_sub_rules`（新） | `scope`（global / user）、`userId`、`position`（prepend / append）、`rulesText`、`isEnabled` | WP4 |
| `proxy_sub_sources`（新） | `userId`、`name`、`url`、`userAgent`、`intervalSec`、`mode`（import / provider）、`lastFetchAt`、`lastStatus`、`lastError`、`upstreamUserinfo`、`nodeCount`、`isEnabled` | WP6 |
| `proxy_nodes` | 新列 `sourceId`（来自哪个外部订阅）、`countryCode`（手工覆盖）、`tags` | WP5 / WP6 |
| `users` / `subscription_plans` | `maxProxyDevices` 和 `manualMaxProxyDevices`（沿 `mergeManualAndPlanLimits` 合并）、`proxySubTemplateId`、`allowExternalSubSources`、`showSubInfoNodes` | WP3 / WP4 / WP6 / WP8 |
| `system_settings` 新键 | `proxySub.updateIntervalHours`、`proxySub.testUrl` / `testIntervalSec` / `toleranceMs`、`proxySub.rulesetMirror`、`proxySub.announce`、`proxySub.supportUrl`、`proxySub.domains`、`proxySub.rateLimitPerMin`、`proxySub.cacheTtlSec`、`proxySub.hwidEnabled` / `hwidFallbackLimit`、`proxySub.infoNodesDefault`、`proxySub.nameTemplateDefault` | 各包 |

## 五、工作包

每包给出：做什么、涉及文件、验收、规模（S ≤ 1 天，M 2–3 天，L 一周）。

### WP0 流水线底座 + 缓存 + 限流（M）

- 把 `renderProxySubscription` 内部拆成 4.2 的流水线，行为零变化（用现有 `shared/proxySubscription.test.ts` 快照守住）。
- 服务端响应缓存：键 `(userId, format, rulePreset, profile, tokenId, 处理器开关摘要)`，TTL 默认 60 秒，规则 / 节点 / 分享 / 套餐变更时按 userId 失效（`boundedCache` 已有）。缓存只缓渲染结果，资格判定和访问记录每次照做。
- 限流：每令牌每分钟 N 次（默认 30）、每 IP 每分钟 M 次（默认 120），超出返回 429 并记 `rate-limited`。复用 `authRateLimit` 的桶实现。
- `clientInfo` 升级为「客户端家族 + 版本」解析（见 WP2），写入 `lastClientFamily` / `lastClientVersion`。
- 验收：`proxySubscriptionQueryCost.test.ts` 保持通过；新增 `proxySubCache.test.ts`、`proxySubRateLimit.test.ts`。

### WP1 令牌升级：子集、过期、短链、备用域名（M）

- **令牌作用域**（`scopeJson`）：节点 id 白名单 / 黑名单、include / exclude 正则、协议白名单。管理员可给用户的令牌设作用域（给客户「只看香港」的订阅）。
- **令牌到期**：接上 `expiresAt`（建令牌 / 编辑时可设，可选「跟随套餐到期」）。
- **短链**：`alias` 唯一，`/s/<alias>`，默认不生成；用户改 alias 时校验 `[a-z0-9-]{4,32}` 且不与现有冲突。
- **备用域名**：`proxySub.domains` 配多个面板可达域名，一键导入面板每个客户端都列出全部地址；`profile-web-page-url` 用主域名。
- **UI**：令牌卡片显示最近拉取时间 / IP / 客户端（现有字段，补显示），编辑弹窗（名字、备注、格式、预设、作用域、到期、alias、处理器开关）。
- **管理员全站令牌页**：列所有用户的令牌，可搜索、停用、重置、看最近失败。
- 文件：`server/routers/proxySubscriptions.ts`、`proxySubscriptionRepository.ts`、`ClientSubscriptions.tsx`、`shared/proxyClientImport.ts`（多域名）、新 `client/src/pages/AdminSubscriptions.tsx`。
- 验收：`proxySubscriptionRoute.test.ts` 加「作用域只回子集」「alias 等价」「到期 404 且记 token-expired」。

### WP2 客户端识别与输出格式（M）

- **UA 识别表**数据化（`shared/proxyClientUserAgent.ts`）：每条 `{ family, pattern, versionRegex, target }`，覆盖 Clash Verge / FlClash / Mihomo Party / ClashMetaForAndroid / Stash / sing-box 系（SFA / SFI / SFM / SFT / Karing / Hiddify / NekoBox）/ v2rayN / v2rayNG / Happ / Streisand / v2RayTun / Shadowrocket / Surge / Surfboard / Loon / Quantumult X / Egern；支持 `flag=` 参数手动指定。
- **版本门控**：把 Xboard 的 `protocolRequirements` 思路并进现有 `shared/proxyClientCompatibility.ts`：家族 + 最低版本 → 是否给 hysteria2 / REALITY / XHTTP / AnyTLS / ECH；低版本客户端跳过并在文件头注明「客户端版本过低」。
- **新目标**：`v2ray-json`（xray 配置，v2rayN ≥ 6.40、v2rayNG ≥ 1.8.29、Happ 自动选它，老版本仍 base64）；`mihomo` 与 `clash` 分开（legacy clash 不给 hysteria2 / REALITY）；`stash` 和 `surfboard` 独立目标（现状归并到 clash / surge，但 Stash 对 `up-speed` 等字段的差异已在代码里零散处理，独立后更干净）；sing-box 补 `xhttp`（sing-box 1.11+ 的 `transport.type: "xhttp"` 按版本门控）。
- **显式路径** `/api/sub/:token/:format` 和 `/api/sub/:token/info`。
- 验收：`proxyClientUserAgent.test.ts` 覆盖每家一个真实 UA 样本；`proxySubscriptionRoute.test.ts` 加 v2rayN 新旧版本两条。

### WP3 访问审计、设备数限制、通知（L）

- **逐次访问日志** `proxy_sub_access_logs`：成功和失败都记（失败现状只记最后一次），保留天数可配（默认 30），按天清理（走 `server/repositories/historyRetention.ts` 的 `deleteExpiredHistoryRows`）。用户侧看自己令牌的最近 50 条；管理员侧按令牌 / 用户 / 客户端家族 / 结果统计。
- **设备数限制**（Remnawave 模式）：
  - 带 `x-hwid` 的客户端：按 `(tokenId, hwid)` 登记设备，超过 `maxDevices` 返回 404 + `x-hwid-max-devices-reached: true`；不带 HWID 的客户端在开启「严格」时拒绝，否则退化到按 IP 统计（24 小时窗口内去重 IP 数）。
  - 上限取 `min(令牌.maxDevices, 用户有效值)`，用户有效值由手动值和套餐值合并（沿 `mergeManualAndPlanLimits`）。
  - 用户和管理员都能看设备列表、删设备；令牌重置时清空设备。
- **通知**：接现有邮件 / Telegram 通知器，事件：令牌首次被拉取、新设备 / 新 IP、超设备数、连续失败（商家视角「客户导不进去」最有价值）。每令牌每事件每天去重。
- 验收：`proxySubAccessLog.test.ts`（并发写）、`proxySubDeviceLimit.test.ts`（HWID 超限、IP 退化、重置清空）。

### WP4 模板与自定义规则（L）

- **可编辑模板**：每个目标一份内置模板（放 `shared/proxySubscriptionTemplates/*.{yaml,json,conf}`），管理员在「系统设置 → 订阅」里复制一份改：
  - Clash / mihomo：补齐 `port` / `mixed-port` / `dns` / `tun` / `sniffer` 等段，`proxies` / `proxy-groups` / `rule-providers` / `rules` 由流水线填入；策略组成员支持写正则（Xboard 做法：`proxies: ["(?i)港|hk"]` 自动展开，空组删掉）。
  - sing-box：补 `dns` / `inbounds`（tun + mixed）/ `experimental.clash_api`；`outbounds` / `route` 填入。
  - Surge / Loon / QX / Shadowrocket：`[General]` 段可改，节点和规则段填入。
  - 占位符：`{{app_name}}` `{{panel_url}}` `{{sub_url}}` `{{username}}` `{{expire_date}}` `{{data_left}}`。
  - 模板分配优先级：令牌 → 用户 → 套餐 → 全局默认。
- **自定义规则** `proxy_sub_rules`：全局前置 / 后置，按用户前置 / 后置；只接受 DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / IP-CIDR6 / GEOIP / GEOSITE，去向限 DIRECT / REJECT / 主组 / 分类组，按目标格式转写；非法行报错不入库。令牌上可对 18 个分类逐个改去向（例如「哔哩哔哩走香港组」）。
- **可配参数**：测速地址 / 间隔 / 容差、规则集更新间隔、`Profile-Update-Interval`、规则集镜像前缀（`proxySub.rulesetMirror`，为空用 raw.githubusercontent.com）。
- **规则集镜像**（可选开关）：`/api/sub/ruleset/<key>.<mrs|srs|list>` 由面板拉取并缓存（24 小时），客户端从面板取，解决受限网络里规则集拉不下来的问题；带 ETag。
- 验收：模板渲染快照测试每目标一份；`proxySubCustomRules.test.ts`（非法规则拒绝、各格式转写）。

### WP5 节点处理器：命名、旗帜、地区组、排序、信息节点（M）

- **地区识别**：节点的国家码取 `hosts.geoCountryCode`（入口主机）→ `proxy_nodes.countryCode`（手工）→ 按名字关键词兜底；旗帜 emoji 由国家码生成；「地区组」按国家码自动生成 `🇭🇰 香港` 等 url-test 组（全局开关，和现有按模板的自动组并存）。
- **命名模板**：令牌 / 用户 / 全局三级，默认 `{host} → {node}`（等于现状）；变量 `{flag}` `{country}` `{host}` `{node}` `{protocol}` `{index}`；重名加 `#n` 沿现状。
- **正则改名**：Sub-Store 式 `原@新` 列表，令牌级。
- **协议前缀**：`[Hy2]` `[VLESS]` 等（Xboard `show_protocol_to_server_enable`）。
- **排序**：`sortMode` = 手动 / 名字 / 地区 / 延迟（延迟取现有 `resolveProxyNodeHealth` 的中转 tcping）；给 `proxy_nodes.sortOrder` 补拖拽排序接口（`reorderOwnership.test.ts` 的做法）。
- **去重**：同 `address:port:protocol:凭据` 只留一个。
- **信息节点**：开启后在最前插入不可用的占位节点「剩余 123.4 GB」「2026-11-20 到期」「公告：…」（Xboard `setSubscribeInfoToServers`），每种格式用各自最无害的协议表达（ss 指向 127.0.0.1）。
- **`udp` / `skip-cert-verify` / `tfo` 覆盖**：令牌级三态开关，对应 subconverter 的 `udp=` / `scv=` / `tfo=`。
- 验收：`proxySubProcessors.test.ts` 每个处理器独立用例 + 流水线顺序用例。

### WP6 外部订阅导入与聚合（L）

- **用户添加外部订阅**（管理员总开关 + 套餐开关 `allowExternalSubSources`）：填 URL、更新间隔、拉取 UA；面板按计划拉取（`scheduler.ts` 加一项，复用 `keyedTaskDispatcher`），解析 base64 / Clash YAML / sing-box JSON（`parseProxyNodeLink` 和 `proxyNodeJson.ts` 已覆盖大半，补 Clash YAML 的 `proxies:` 解析），写入 `proxy_nodes`（`sourceId` 标记），再次拉取时按 `address:port:协议` 对账：新增、更新、下线；上游的 `Subscription-Userinfo` 存下来在界面展示。
- 外部节点进订阅时 `includeDirect=true`、无前置代理，也可以作为节点模板绑到转发（走中转）。
- **provider 透传模式**（SubConverter-Extended 做法）：mihomo / Stash 目标把来源写成 `proxy-providers`（带 `interval` / `health-check`），面板不拉取、不存节点；其它目标退化为 import。
- **安全**：只允许 http(s)，解析后目标不得是私网 / 环回 / 链路本地（含 DNS 解析后再查一次）、不跟随跨主机重定向、响应 ≤ 2 MB、超时 15 秒、每用户来源数上限（默认 5）、拉取并发全局上限。
- 验收：`proxySubSource.test.ts`（解析三种格式、对账新增 / 下线、SSRF 拦截）。

### WP7 订阅落地页与公告（S–M）

- `/api/sub/:token` 带 `Accept: text/html` 时返回一张无需登录的落地页：套餐名、已用 / 总量进度条、到期日、重置日、设备数、公告、各客户端一键导入（复用 `shared/proxyClientImport.ts` 的目标表）、二维码、显式格式地址；不列节点明细（防泄露）。品牌用现有 `/api/client-logos` 与面板名称。
- 响应头补 `profile-web-page-url`（指向落地页）、`support-url`（`proxySub.supportUrl`）、`announce`（base64，`proxySub.announce`）。
- 落地页走同样的资格判定、限流与访问日志（`result=page`）。
- 验收：`proxySubPage.test.ts`（HTML 分支、不含节点明细、404 口径一致）。

### WP8 套餐与计费联动（S）

- 套餐新增 `maxProxyDevices`、`proxySubTemplateId`、`allowExternalSubSources`、`showSubInfoNodes`，并入 `planSnapshot`；用户有效值走 `mergeManualAndPlanLimits`，收回走 `syncUserSubscriptionEntitlementsUnlocked`。
- 令牌「跟随套餐到期」：`expiresAt` 为空且勾选时，路由用用户 `expiresAt`（现状已经间接实现，这里只是显式化）。
- `Subscription-Userinfo` 的 upload / download：Agent 的流量上报如果能分方向（`agentTrafficRoute` 看一下口径），就分开写；否则保持全计 download 并在文档里说明。
- 验收：`planProxyNodeGrant.test.ts` 补设备数和模板随套餐生效 / 到期回收的用例。

### WP9 文档（S）

- `docs/guide/subscriptions.md`：地址格式与参数、各客户端导入、令牌作用域、设备限制、模板与自定义规则、外部订阅、落地页、常见问题（「导进去没节点」对应跳过原因与版本门控）。
- 侧栏入口加进 `docs/.vitepress/config.mts`。

## 六、实施顺序

| 阶段 | 工作包 | 产出 |
| --- | --- | --- |
| 一（基础） | WP0 → WP2 → WP1 | 流水线 + 缓存限流；识别全部主流客户端、v2ray-json、显式格式路径和 `/info`；令牌子集 / 到期 / 短链 / 多域名；管理员全站令牌页 |
| 二（外观与可控） | WP5 → WP4 → WP8 | 旗帜、地区组、命名模板、信息节点、排序；可编辑模板、自定义规则、规则集镜像；套餐联动 |
| 三（审计与聚合） | WP3 → WP6 → WP7 → WP9 | 访问日志、设备限制、通知；外部订阅导入 / provider 透传；落地页与公告；文档 |

阶段一做完就已经覆盖 Xboard / Marzban 的核心订阅体验；阶段二追平 subconverter / Sub-Store 的节点处理能力；阶段三补上 Remnawave 的设备限制和 Sub-Store 的聚合。每个 PR 的版本号沿「发布 2.3.x」惯例递增。

## 七、兼容与风险

- **旧地址不变**：`/api/sub/<token>`、`?format=`、`?rules=` 行为一字不改；所有新开关默认等于现状（命名模板默认 `{host} → {node}`，信息节点默认关，设备限制默认关，缓存 TTL 可设 0）。
- **三种数据库**：新表都要在 `server/dbSchema.ts` 的 `MIGRATION_TABLES` 里声明唯一键和索引；MySQL 长文本列（模板内容、规则文本、scopeJson）用 `mysqlLongTextSchema.test.ts` 守住。
- **面板迁移**：新表加进 `server/migration.ts` 的表清单和按表重映射（`tokenId` / `userId` / `nodeId` / `templateId`）。
- **信息节点**是「假节点」，客户端测速会把它标红；默认关闭，文档里讲清楚。
- **外部订阅**是公网拉取，SSRF 和资源耗尽是主要风险，WP6 的安全项不做完不合并。
- **缓存与资格**：缓存只缓渲染结果，账号停用 / 到期 / 超流量的判定每次都做，不会出现「停用后 60 秒内还能拉」的问题；但节点增删在 TTL 内有延迟，界面「预览订阅」不走缓存，并在保存后主动失效。
- **HWID**：只有 Happ / v2RayTun 等少数客户端发 `x-hwid`，默认用 IP 退化模式，严格模式只给明确知道客户群的商家开。

## 八、工作量估计

| 工作包 | 规模 | 主要新增测试 |
| --- | --- | --- |
| WP0 | M | proxySubCache、proxySubRateLimit |
| WP1 | M | proxySubscriptionRoute 扩展、proxySubTokenScope |
| WP2 | M | proxyClientUserAgent、proxySubscriptionRoute 扩展 |
| WP3 | L | proxySubAccessLog、proxySubDeviceLimit、proxySubNotify |
| WP4 | L | 模板快照 × 目标、proxySubCustomRules、proxySubRulesetMirror |
| WP5 | M | proxySubProcessors |
| WP6 | L | proxySubSource |
| WP7 | S–M | proxySubPage |
| WP8 | S | planProxyNodeGrant 扩展 |
| WP9 | S | — |

合计约 6–8 周单人工作量；阶段一约 1.5–2 周。
