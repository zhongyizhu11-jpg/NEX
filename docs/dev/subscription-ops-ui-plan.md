# 订阅 / 运营 / 弹窗与编辑页：审计结论与分批计划（2026-11-24）

三路只读审计（订阅后端、订阅与运营页面、全部 72 个带弹窗的文件）得到的结论，按影响排序；做法是三条互不碰文件的并行线，每条做完跑各自的测试。性能、效率、稳定优先；合规类放后面。

## 一、订阅后端（server/proxySub*、routers/proxySubscriptions.ts、routers/plans.ts）

高影响：
1. 限流排在重活之后，被限的请求照样写库：`proxySubscriptionRoute.ts` 里 gate / resolvePanelUrl（4～5 次读）跑在 `checkProxySubRateLimit` 之前；被限或被 gate 拒的命中仍 UPDATE 令牌行 + INSERT 访问日志。→ IP 限流提到 findToken 之前、令牌限流紧跟其后；被限的命中不写日志；失败写入按（令牌, 原因）每分钟去重。
2. 落地页与 /info 不限流且每次全量构建（只为数节点个数，还渲染二维码）。→ 同样过限流；节点数走便宜查询或缓存上下文；二维码按令牌+来源记忆。
3. 缓存只存整份渲染结果，键里带 originalUrl / 客户端版本 / 完整设置对象（JSON.stringify + sha1 每次算，设置里有两段最多 20 KB 的自定义规则），命中率低。→ 设置指纹在 loadProxySubSettings 算一次；再加一层按用户缓存 `{plan, templates, providers, unlockStatuses}`（大项）。
4. 缓存命中仍 8～12 次往返、3～5 次写：用户与套餐串行读、panelPublicUrl 不缓存、模板每次查、设备 SELECT+UPDATE、同一令牌行两次 UPDATE、访问日志单条 INSERT。→ 两次 UPDATE 合一；用户/套餐并行读；panelPublicUrl 与 hideUnreachable 走设置缓存；设备 5 分钟内不更新、改 ON CONFLICT；访问日志走已有的批量写。
5. 入站 / 主机地址变化不让订阅缓存失效（`proxyInboundRepository.ts` 直接写 proxy_nodes 绕过了 updateProxyNode），凭据轮换、端口、IP 变了最多陈旧 cacheTtlSec（可到 3600）。→ syncProxyNodeFromInbound 末尾让所有者和每个分享对象失效。
6. 版本表 clear 后老键又能命中；失效不删条目；缓存按条数（2000）而不是字节上限，Clash 配置 500 KB 时最坏 1～1.5 GB。→ clear 时 globalVersion++；按字节上限淘汰。
7. 缓存未命中时强制 flush tcping 批量写并扫 15 分钟探测数据，只用最新 N 条。→ 不在订阅路径 flush；按规则缓存 30 秒或只取最新 N 条。
8. `routers/plans.ts` 的 mySubscriptions 和管理员列表每次读都跑全体用户的到期处理（无索引扫表、逐用户事务）；调度器已经在跑。→ 读路径去掉；补 (status, expiresAt) 索引。

中影响：源同步无串行化可重复导入（proxy_nodes 没有 (sourceId, sourceKey) 唯一索引、不在事务里）；源同步每节点 3+ 条查询、删除 8 条；到期源选取在 JS 里过滤会饿死（PostgreSQL 上 NULL 排最后）；手动同步在请求里同步跑最多 4 跳 × 15 秒、dns.lookup 无超时；套餐更新对每个订户串行刷新；listTokens / landingPoolNodeInfo / setNodeShares / proxyInbounds.list 的 N+1；setSettings 每键一次往返；自定义规则每次渲染解析 5 次；用户给的正则直接 new RegExp；限流器每次命中 O(limit) 拷贝；访问统计三次扫描；管理员令牌列表无索引排序；countProxySubTokensByUser 在 JS 里数；重排 1000 条逐条 UPDATE 不在事务里；updateSource 让错了用户的缓存失效；删除模板 4 条语句无事务；pruneStaleIpDevices 在 PostgreSQL / MySQL 下读不到受影响行数。

方言复查干净：count 都 Number() 过，epoch 都是整秒。

验证：server/proxySubscriptionRoute*.test.ts、proxySubCache.test.ts、proxySubRateLimit.test.ts、proxySubscriptionQueryCost.test.ts（语句计数，改完要更新基线）、proxySubGolden.test.ts（输出逐字节一致）、proxySubSourceSync.test.ts、proxyInboundSubscription.test.ts、proxyNodeShare.test.ts、planProxyNodeGrant 等套餐测试；压测 scripts/bench-proxy-sub.mjs。

## 二、订阅与运营页面（client/src/pages/ClientSubscriptions.tsx、AdminSubscriptions.tsx、Payments.tsx、Users.tsx、components/proxy/*）

1. Payments：100 条订单画两遍（手机卡片 + 表格，约 200 行 DOM），和配置表单同在一个组件，每敲一个键全部重画；30 秒轮询无分页。→ 订单卡独立 memo 组件 + 服务端分页。
2. ClientSubscriptions（2690 行）：节点 / 令牌 / 改名弹窗的表单状态放在页面组件里，每个键击重画整页；ProxyInboundsSection、ProxyNodeRow 不 memo，回调内联。→ 弹窗抽成带本地状态的组件，section 与行 memo，回调 useCallback。
3. ProxyInboundsSection：非管理员下 `usersQuery.data || []` 每次新数组，inboundRowSpecs 的 useMemo 每次重算。→ 模块级 EMPTY 常量。
4. validateCustomRules 每键一次请求（键是整段文本）。→ useDebouncedValue 400 ms + placeholderData。
5. AdminSubscriptions 搜索不防抖、无 placeholderData，表格闪「加载中…」。
6. ClientSubscriptions 的行开关不乐观、成功后把 listNodes / listTokens / preview 全失效，还弹「客户端节点已更新」并关掉节点弹窗。→ OptimisticSwitch + 各自定向失效。
7. ProxyInboundsSection 只为取名字调重的 hosts.list（服务端会顺带排清理任务、算整形状态）。→ hosts.options + Map。
8. 入站订阅开关 `void Promise.all(mutateAsync…)` 失败成未处理拒绝、无 pending。
9. AdminSubscriptions 对 React Query 缓存数组原地 sort。
10. Users 流量权限弹窗打开即发约 10 个查询，只显示一种资源；无 staleTime。
11. 同一查询各处 staleTime 不一（trafficBilling.configs 30 s / 5 s；users.options 60 s / 默认）。→ lib/queryPresets。
12. 裸轮询数字（Payments 30_000、MyHostsSection、ExitQualityView 60_000、TrafficAnomalySettings、Tickets），Payments 的二维码检查是手写 setInterval 不看可见性。→ pollingInterval()。
13. qrcode 静态引入（ClientSubscriptions、Payments）；ProxySubTokenDialogs（878 行）、ProxySubTemplateVisualEditor 急加载。→ 动态 import / lazy。
14. 手机 / 桌面两套列表都渲染且断点不一（sm 与 md 混用）。
15～19. 空状态、加载 / 错误状态、破坏性确认的 tone、AdminSubscriptions 手写分页与「大白卡」、日期金额格式各自为政。
20～22. 入站弹窗 Label 没绑控件（靠 placeholder 过测试）、弹窗缺 DialogDescription、图标按钮只有 title、日志弹窗表格手机不堆叠。

验证：accessibleNames.test、mobileDensity.test、stateBlocks.test、destructiveConfirm.test（要把新加的确认补进去）、usersDialog.test、routeChunks.test；这些页面没有渲染测试。

## 三、弹窗与编辑表单（72 个文件）

事实：没有 Sheet（RouteGroupSheet / RoutePolicySheet 是普通 Dialog）；没有 window.confirm；54 个文件用 useConfirmDialog。

高影响：
1. **Users「流量与权限设置」会把权限存成空**：打开时把 ID 列表清成 []，只靠 query data 引用变化的 effect 回填；再次打开同一用户时引用没变、effect 不跑，isLoading 为 false，保存按钮可点，写进去的是 []。sharedProxyNodeIds 也不重置。→ 打开时从 utils.getData 种子，或 effect 以 [open, userId, data] 为键。
2. 所有弹窗表单都没有「未保存就关」的保护（全仓库没有 onInteractOutside / onEscapeKeyDown），点一下遮罩表单就没了：Rules、ForwardGroups、Hosts、Plans、ProxySubTokenDialogs、Users。
3. 只显示一次的密钥（ApiTokensSection、ShopSyncSection）能被 ESC / 点遮罩关掉。

中影响：缺 DialogDescription（Tunnels ×2、ForwardGroups、ProxyInboundsSection ×2、ProxyNodeShareDialog；Rules / Plugins 有时缺）且没有 ratchet 测试；手写确认弹窗代替 useConfirmDialog（Rules ×2、Users ×4、AgentTokenManager、TelegramBot、DeepSeek、Hosts）——原因是 hook 没有 pending 状态和细节槽；确认后何时关闭不一致；几乎没有 <form>，回车不提交；校验一半 toast 一半 inline；Label 未绑控件（ProxyInbounds 21、Hosts 18、Users 12、Rules 11）；ProxyNodeReorderDialog 以 [open, nodes] 重置，轮询回来就把用户排好的顺序冲掉；Plans 两个只在弹窗里用的查询页面加载就发；Rules 打开时 enabled + refetch 双重请求；八个 500～800 行的内联弹窗可以懒加载（Users 权限、ForwardGroups 编辑、Rules 批量 / 编辑、Hosts 编辑、Plans 编辑、入站编辑、订阅内容）。

低影响：高度上限单位混用（vh / dvh / svh）、Users 弹窗双滚动区、不折行的两列网格、手机侧边距各异、信息类弹窗页脚各异、Topology 删连线无确认。

重复：Tunnels / ForwardGroups 的「删除影响」弹窗几乎逐字相同；密钥 / 命令展示弹窗 6 处、复制+toast 助手 3 份、http 剪贴板提示 2 份；单字段 prompt 弹窗 8 处；确认弹窗里的键值表 7 处；Users 用 12 组 show*/UserId/UserName 三元组管弹窗。

建议的共享件：扩展 useConfirmDialog（onConfirm 返回 Promise 时保持打开显示 pending、禁 ESC、成功关闭；details 槽放键值表）；<FormDialog>（header + 滚动 body + 固定 footer + 真 <form onSubmit> + inline blocker + dirty 时关前确认 + pending 时禁关）；<SecretRevealDialog> + useCopyWithToast；<DeleteWithImpactDialog>；useDialogTarget<T>()（关闭动画期间保留 target）。

## 四、分批

第一批（并行三线，互不碰文件；已做完，见 2026-11-24 的提交「订阅后端第一批」「订阅与运营页面第一批」「弹窗与编辑表单第一批」）：
- A 订阅后端快赢：一 1、2、4、5、6、7、8 及 N+1 / count / 失效目标 / rowsAffected 这些小项。
- B 订阅与运营页面快赢：二 3～9、12、13、15～17、20～22，以及三里落在这些文件上的项（重排弹窗重置键、DialogDescription、tone）。
- C 其他弹窗与表单快赢：三 1、3、Plans 查询门控、Rules 双重请求、确认后在 onSuccess 关闭、AuditDetailDialog 单位、Topology 删连线确认、Tunnels / Hosts / ForwardGroups 的弹窗懒加载、缺 DialogDescription 的站点 + ratchet 测试、SecretRevealDialog + useCopyWithToast 收掉 6 处。

第二批：一 3 的按用户缓存、字节上限缓存、源同步串行化与事务与 diff 写、批量访问日志、后台任务（套餐更新扇出、到期处理）、正则安全；二 1、2、6、10、11、14、18；三 2 的 FormDialog + 未保存保护、扩展 useConfirmDialog 替掉手写确认、DeleteWithImpactDialog、useDialogTarget、八个大弹窗懒加载。

## 五、第一批结果

- 订阅后端：一次订阅构建 6 → 5 条语句；被限流的命中从「5 次读 + 2～3 次写」变成 0 次写、1 次读（设置缓存）；入站 / 地址变化即时让缓存失效；读路径不再跑全体用户到期处理。订阅相关 125 项测试通过、golden 输出逐字节一致。
- 页面：ClientSubscriptions 块 155.8 kB、Payments 块 32.0 kB，qrcode 独立成 25.8 kB 共享块；入站列表不再每个键击重算；搜索与规则校验防抖；7 处破坏性确认补上红色 tone 并进测试。
- 弹窗：Users 权限弹窗存空 bug 修掉并钉住测试；5 处一次性密钥弹窗收成 SecretRevealDialog（不可误关）；DialogDescription 守门测试上线（零例外）；4 个弹窗模块懒加载。
- 顺带发现并修掉：PostgreSQL 的 epoch 默认值四舍五入（见 docs/dev/postgres-baseline.md）。

## 六、第二批结果（2026-11-25）

- 订阅后端：同一用户换格式 / 换令牌的订阅构建从 6 条语句降到 0 条（按用户的上下文缓存）；源同步按源串行、整体在事务里、只写变了的节点，老竞态留下的重复行会在下次同步时清掉；手动同步最多 2 个并发、正在同步的直接返回 `status: "running"`；访问日志批量写；用户给的正则先过 shared/safeRegex；设置批量写一条 upsert；模板列表进内存。
- 页面：ClientSubscriptions 2702 → 1452 行，三个弹窗各自持有状态、预览弹窗懒加载（页面块 155.8 → 134.8 kB，预览 25.2 kB 按需），在弹窗里打字不再重画节点列表；行开关全部乐观化并定向失效；Payments 订单服务端分页、只渲染一种列表；AdminSubscriptions 统一分页去掉大白卡；lib/queryPresets 共享查询预设。
- 弹窗：确认框支持异步 onConfirm（pending、禁关、就地报错）与 details 槽，11 处手写确认收掉；FormDialog（回车提交、未保存保护）用在三个表单，Rules / ForwardGroups / Hosts 长编辑器有了未保存保护；DeleteWithImpactDialog、useDialogTarget；Users 3100 → 1726 行，权限弹窗懒加载并按资源类型门控查询。

剩下没做的（第三批候选）：
1. proxy_nodes (sourceId, sourceKey) 唯一索引 + 去重回填（SQLite 建索引不容错，要一起做）。
2. Rules 批量管理弹窗（约 770 行）先抽 hook 再懒加载；ForwardGroups / Hosts 编辑弹窗单独懒加载；Hosts 批量升级确认改走确认框。
3. 客户端按 `result.status`（running / queued）给手动同步不同的提示。
4. 字节上限的渲染结果缓存；套餐更新对订户的扇出改后台任务；到期处理补 (status, expiresAt) 索引已加，扫表语句本身可再看。
5. 一处要手动看一眼：Rules 编辑器打开后若有查询驱动的回填晚于 1.2 秒，关闭时可能多问一次「放弃修改？」。
