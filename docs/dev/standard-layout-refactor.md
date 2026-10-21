# 标准布局重构（立项）

> 维护者内部文档，不进公开文档站（`docs/.vitepress/config.mts` 的 `srcExclude` 排除了 `dev/**`）。
> 立项日期 2026-10-20。来源：做精简布局（`feat/compact-layout-v2`，2.3.468）时对首页 / 外壳 / 设置、规则 / 链路、主机 / 用户 / 套餐 / 订阅三组页面的审计。

> **2026-10-21 调整**：五个工作包里用户看得见的摆法改动（规则表格并列、用户授权按类型切换、用户表一行一人、
> 订阅卡按钮进菜单、套餐页头 ··· 和按量计费入统计条、设置页两张卡合并、开源与联系并进版本升级、Google / Discord 并排、
> 主机详情分页）全部挂到**精简布局开关**下，标准布局回到原样。留在两种布局里共用的只有纯代码层面的：死代码清理、
> ViewModeToggle / viewModeStorage、规则表格「列定义一个数组出」（数组里两支，按开关选）。

## 背景

精简布局的原则是**只在 `<html data-layout="compact">` 下生效，关掉精简就是原样**。审计里下面这些发现不属于「摆法」，改了就是标准布局也跟着改，所以不放进精简开关，单独立项，逐个评审。

每一项独立成 PR，带截图对比；改之前先补一条守源码的测试（照 `client/src/components/mobileDensity.test.ts` 的做法），改完跑 `pnpm test:all`。

## 进度

| # | 工作包 | 状态 | PR |
| --- | --- | --- | --- |
| 四 | 死代码和不可达分支清理 | 已完成 | `refactor/standard-layout` |
| 三 | 视图切换控件统一 | 已完成 | `refactor/standard-layout` |
| 五 | 页面级的小合并 | 已完成（两项缩减，见下） | `refactor/standard-layout` |
| 一 | 规则表格重排 | 已完成 | `refactor/standard-layout` |
| 二 | 用户管理「流量与权限」对话框重排 | 已完成 | `refactor/standard-layout` |

建议顺序：四 → 三 → 五 → 一 → 二。四是零风险的地基清理；三是机械替换；一和二要先出一版截图给维护者看过再动手。

---

## 一、规则表格重排

**现状**：`client/src/pages/Rules.tsx` 约 7940 行起，`table-fixed` + `<colgroup>` 固定 13～14 列，最小宽度 1610～1764px，1366 宽的屏幕必定横向滚动。

- 「状态」点列和「开关」列两列说同一件事
- 「所属资源」列和「链路」徽章列都在说这条规则挂在哪个隧道 / 组上
- 累计 / 24H / 延迟三个指标各占一列

**目标**：桌面 1366 宽不横滚；列定义集中在一处（一个列数组驱动 `<col>`、`<TableHead>`、`<TableCell>` 三处，别再手写三遍）。

- 状态点并进「规则」列名字前面（卡片视图就是这么画的），去掉「状态」列
- 「链路」并进「所属资源」列（一个徽章 + 名字）
- 累计 / 24H 合成一列「流量」（上下两行），延迟单独留
- 精简布局下可以再少一列「协议」（`data-fx-compact-hide`）

**风险**：固定列宽下隐藏某一列会错位 —— 这正是精简布局没敢动它的原因；重排必须把 `<colgroup>` 一起改。排序模式（`ruleSortingEnabled`）多一列拖拽手柄，两种宽度都要验。

## 二、用户管理「流量与权限」对话框重排

**现状**：`client/src/pages/Users.tsx` 约 2247 行起，三个页签；「资源授权」页按资源类型（端口转发、转发链、转发组、隧道、网络测试主机、计费资源……）各一段，每段一个表头 + 列表 + 空提示，八个空提示框（精简下已只留一句话）。列表页的表格行约 70px 高（头像、名字、标签行、备注、两层流量块），`min-w` 最大 1520px。

**目标**：

- 「资源授权」改成一张列表：左侧资源类型做分段 / 筛选，右侧只列选中那一类，空提示只出现一次
- 用户表每行一到两行高：标签行并进名字右边，流量块只留一行进度 + 数字，备注做悬停
- 「加赠流量 / 更改到期 / 取消」三个按钮（约 1770～1800 行）收成「编辑 + ···」，和列表页 1665～1675 行的做法一致

## 三、视图切换控件统一

**现状**：同一个「卡片 / 列表」分段按钮组复制粘贴了六份：

- `client/src/pages/Hosts.tsx` 2675～2811（主机 5 档、Token、分组、服务各 2 档，四组各自实现）
- `client/src/components/hosts/HostProbeServiceManager.tsx` 445～467
- `client/src/components/AgentTokenManager.tsx` 653～672
- `client/src/pages/Plans.tsx` 1233～1252
- `client/src/pages/ForwardGroups.tsx` 2246～2267
- `client/src/components/hosts/HostGroupManager.tsx`

**目标**：一个 `ViewModeToggle` 组件（`client/src/components/ui/`），`items: { value, label, icon }[]`、`value`、`onChange`，带 `aria-pressed` 和 title；本地存储的读写（`getStored*ViewMode` 那几对）也收进一个 hook。六处换成同一个。主机页五档（卡片 / 精简卡片 / 列表 / 地图 / 平面地图）可以改成 3 档 + 地图子菜单。

**验收**：六处行为不变；`client/src` 里不再出现第二份 `title="卡片视图"` 的实现（守一条源码测试）。

## 四、死代码和不可达分支清理

审计里确认的，都在标准布局下就是死的：

- `client/src/pages/Hosts.tsx:973` `HostSummaryCard`：页面用的是 `HostEntitySummaryCard`，这个没有引用
- `client/src/pages/ForwardGroups.tsx:1765` `groupKindBadge` 永远返回 null，2010 行还在调
- `client/src/pages/Rules.tsx:5781 / 5787` `openExportDialog` / `openImportDialog` 没有调用方，独立的导出 / 导入对话框（约 8703、8765 行）到不了；「批量管理」已经覆盖这两件事
- `client/src/pages/Tunnels.tsx:4933` 新增链路对话框里 `selectedCreateType === "tunnel"` 的整个分支：类型只会被设成 `"chain"`（4151 行），这一支是编辑对话框正文的一份完整拷贝（约 5233 行起）
- `client/src/pages/ForwardGroups.tsx` 2347 行「用途」列打印的是静态的「固定入口 / 固定出口」，`renderGroupFacts`（1848～1852）自己的注释都说它和分类条重复

每删一处跑一遍相关测试；Tunnels 那一支删掉后编辑对话框是唯一一份，顺手把它抽成组件。

## 五、页面级的小合并（标准布局）

单个都不大，攒成一个 PR：

- 套餐管理页头「手动分配」「新增套餐」两个按钮（`Plans.tsx` 1143～1150）→ 新增为主，手动分配进 ···
- 套餐页「对用户开放」两行 + 统计条（1167～1203）→ 一条带开关的统计条；「按量计费」那一行只是跳到计费页签，分类条已经有
- 订阅管理页两张叠放的卡（`ClientSubscriptions.tsx` 1033～1065、`ProxyInboundsSection.tsx` 711～808）各自一套头部和动作 → 共用一条页面工具栏
- 系统设置里的单行卡（登录会话 6595、左侧导航栏菜单 6624）→ 一行 SettingRow；「开源与联系」并进「版本升级」
- 个人资料 Telegram / 2FA / Google / Discord 四张卡 → 一张「安全与绑定」分组列表
- 主机详情框（`HostDetailDialog.tsx`）标准布局也改成页签（精简下已经是）

**做完后的说明（2026-10-20）**：
- 订阅管理页两张卡共用一条工具栏 —— 评审后不做。两张卡各自的动作集不同（分组下拉、我的机器、预览订阅、新建菜单 vs 新建链接），
  合并要加一层「现在在操作哪一张」的状态，比两张卡各自带动作更绕；精简布局下已经把每条链接的操作收进菜单。
- 个人资料四张绑定卡合成一张列表 —— 只做了 Google / Discord 并排（和 Telegram / 2FA 一样）。Telegram 和 2FA 各有自己的
  绑定流程（绑定码、二维码、备用码），塞进一张列表会把流程切碎。
- 其余四项照做：套餐页头 ···、按量计费进统计条并去掉重复横幅、会话与导航并成一张卡、开源与联系并进版本升级、主机详情两种布局都分页。

## 六、不在这个立项里的

- 精简布局本身的任何改动 → 继续在 `feat/compact-layout-v2` 或它合并后的后续 PR 里做
- 手机端密度（`workspace.css` 767px 以下那一段）→ 另算
- 任何配色 / 主题 / 卡片风格的改动

## 行号说明

以上行号按 2026-10-20 的 `main`（2.3.467）和 `feat/compact-layout-v2` 记，动手时以 grep 关键字为准。
