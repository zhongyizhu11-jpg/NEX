# DDNS 与故障转移

DDNS 用来把域名自动解析到可用入口。NEX 可以在主机 IP 变化、入口组成员变化或转发组故障切换时，自动更新 DNS 记录。

## 工作原理 {#how-it-works}

NEX 的 DDNS 功能分两层：

**自动更新层**：NEX 监听主机 Agent 上报的公网 IP 和入口组成员状态。当检测到变化时，调用你配置的 DNS 服务商 API，将指定域名的记录值改写为当前可用地址。

**故障转移层**：转发组持续对成员入口执行健康检查。当主入口不可用时，NEX 将域名切换到备用入口；主入口恢复后，可根据配置决定是否切回。

### 故障转移触发条件

以下情况会触发 DDNS 更新或故障切换：

| 触发场景 | 动作 |
| --- | --- |
| Agent 上报的主机公网 IP 发生变化 | 更新主机 DDNS 域名记录 |
| 入口组成员新增或移除 | 将域名记录同步到当前全部成员 IP |
| 转发组健康检查判定入口不可用 | 将域名切换到健康备用入口 |
| 转发组主入口恢复（视配置） | 将域名切回主入口 |

::: tip
故障切换依赖健康检查的判定周期，建议不要将检查间隔或切换阈值设置过短，避免网络抖动引发频繁切换。
:::

## 支持的 DNS 服务商

| 服务商 | 官方教程和入口 |
| --- | --- |
| Cloudflare | [创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) / [DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/) / [API Token 控制台](https://dash.cloudflare.com/profile/api-tokens) |
| 华为云 DNS | [云解析 DNS 文档](https://support.huaweicloud.com/dns/index.html) / [访问密钥 AK/SK](https://support.huaweicloud.com/usermanual-ca/ca_01_0003.html) / [DNS 控制台](https://console.huaweicloud.com/dns/) |
| 阿里云 DNS | [创建 AccessKey](https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair) / [云解析 OpenAPI](https://api.aliyun.com/product/Alidns) / [云解析控制台](https://dns.console.aliyun.com/) |
| 腾讯云 DNSPod | [DNSPod API 简介](https://cloud.tencent.com/document/product/1427/56193) / [API 密钥管理](https://cloud.tencent.com/document/product/598/40488) / [DNSPod 控制台](https://console.cloud.tencent.com/dnspod) |
| 自定义 Webhook | 适用于自有接口或暂未内置的服务商 |

## 配置步骤 {#quick-setup}

### 第一步：配置 DDNS 服务商

配置路径：

```text
系统设置 -> 系统配置 -> DDNS 服务商
```

基本流程：

1. 在 DNS 服务商处准备好域名和 API 密钥。
2. 在 NEX 的 DDNS 服务商中选择对应服务商。
3. 填写服务商要求的密钥、主域名、Zone ID 或线路等信息。
4. 设置 TTL，默认 `60` 秒（入口组故障切换最迟一个 TTL 后被客户端看到）。阿里云、腾讯云 DNSPod 免费版最低只允许 `600` 秒，TTL 设得更低时会被自动抬到 `600` 秒提交。
5. 保存 DDNS 配置。

::: warning 权限建议
DDNS 密钥只建议授予目标域名所需权限，不要使用拥有账号全部权限的长期密钥。
:::

### 第二步：在功能模块中填写域名

根据你的使用场景，到对应模块填写要自动维护的域名：

- **主机 DDNS**：主机管理 -> 新增/编辑主机 -> DDNS 服务
- **入口组**：链路管理 -> 更多 -> 入口组 -> 编辑入口组
- **转发组**：链路管理 -> 更多 -> 转发组 -> 编辑转发组

## Cloudflare {#cloudflare}

适合域名托管在 Cloudflare 的用户。

官方入口：

- [Cloudflare 创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
- [Cloudflare API Token 控制台](https://dash.cloudflare.com/profile/api-tokens)

需要准备：

- Cloudflare API Token。
- 可选：Zone ID。

Token 权限建议：

| 权限 | 用途 |
| --- | --- |
| Zone:Read | 未填写 Zone ID 时，用于自动查找域名所在 Zone |
| DNS:Edit | 创建或更新 DNS 记录 |

面板填写：

| 字段 | 说明 |
| --- | --- |
| Zone ID | 可留空，留空时系统会按域名自动识别 |
| API Token | 填写 Cloudflare API Token |

如果你手动填写了 Zone ID，Token 仍然需要能编辑该 Zone 的 DNS 记录。

## 华为云 DNS {#huaweicloud}

适合域名解析托管在华为云云解析 DNS 的用户。

官方入口：

- [华为云云解析 DNS 文档](https://support.huaweicloud.com/dns/index.html)
- [华为云访问密钥 AK/SK 文档](https://support.huaweicloud.com/usermanual-ca/ca_01_0003.html)
- [华为云 DNS 控制台](https://console.huaweicloud.com/dns/)

需要准备：

- Access Key ID。
- Secret Access Key。
- 公网域名 Zone ID。
- 区域，例如 `cn-north-4`。

面板填写：

| 字段 | 说明 |
| --- | --- |
| Access Key ID | 华为云 AK |
| Secret Access Key | 华为云 SK，留空保存时会保留旧密钥 |
| 公网 Zone ID | 云解析 DNS 中对应公网域名的 Zone ID |
| 区域 | 默认可使用 `cn-north-4` |
| 默认线路 | 默认 `default_view` |
| Endpoint | 一般留空即可，特殊环境再填写完整 URL |

如果更新失败，优先确认 AK/SK 是否有云解析 DNS 的记录查询和编辑权限。

## 阿里云 DNS {#aliyun}

适合域名解析托管在阿里云云解析 DNS 的用户。

官方入口：

- [阿里云创建 AccessKey](https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair)
- [阿里云云解析 OpenAPI](https://api.aliyun.com/product/Alidns)
- [阿里云云解析控制台](https://dns.console.aliyun.com/)

需要准备：

- AccessKey ID。
- AccessKey Secret。
- 主域名，例如 `example.com`。

面板填写：

| 字段 | 说明 |
| --- | --- |
| AccessKey ID | 阿里云 AccessKey ID |
| AccessKey Secret | 阿里云 AccessKey Secret，留空保存时会保留旧密钥 |
| 主域名 | 根域名，例如 `example.com` |
| Endpoint | 默认 `https://alidns.aliyuncs.com` |
| 默认线路 | 默认 `default` |

例如你要维护 `a.example.com`，主域名填 `example.com`，NEX 会自动拆分主机记录 `a`。

## 腾讯云 DNSPod {#tencentcloud}

适合域名解析托管在腾讯云 DNSPod 的用户。

官方入口：

- [腾讯云 DNSPod API 简介](https://cloud.tencent.com/document/product/1427/56193)
- [腾讯云 API 密钥管理](https://cloud.tencent.com/document/product/598/40488)
- [腾讯云 DNSPod 控制台](https://console.cloud.tencent.com/dnspod)

需要准备：

- SecretId。
- SecretKey。
- 主域名，例如 `example.com`。

面板填写：

| 字段 | 说明 |
| --- | --- |
| SecretId | 腾讯云 SecretId |
| SecretKey | 腾讯云 SecretKey，留空保存时会保留旧密钥 |
| 主域名 | 根域名，例如 `example.com` |
| 默认线路名称 | 通常填 `默认` |
| 默认线路 ID | 可留空，特殊线路才需要填写 |

如果记录无法更新，检查域名是否在 DNSPod 下，并确认密钥有 DNSPod 记录管理权限。

## DNSPod 解析记录管理 {#dnspod-records}

服务商选的是腾讯云 DNSPod 并保存后，DDNS 服务商下面会多出一张「DNSPod 解析记录」卡片，可以直接在面板里管理 DNSPod 上的记录，不用再登录 DNSPod 控制台。

配置路径：

```text
系统设置 -> 系统配置 -> DDNS 服务商 -> DNSPod 解析记录
```

用的就是上面填的 SecretId / SecretKey，不需要另外配置。密钥需要 DNSPod 的域名查询、记录查询和记录增删改权限。

能做什么：

- 选择账号下的任意域名（默认选 DDNS 里填的主域名），记录按完整子域名分组显示，支持搜索。
- 新增、修改、删除 **A、AAAA、CNAME** 记录，包括 TTL 和**解析线路**。线路列表按域名套餐实时从 DNSPod 读取，例如 `默认`、`电信`、`联通`、`移动`、`境外`、`教育网`；同一个子域名可以给不同线路各建一条记录，让不同运营商的用户解析到不同入口。
- NS、MX、TXT 等其他类型只显示，请到 DNSPod 控制台修改。

### 编辑 → 暂存 → 统一保存

新增、修改、删除都先放进暂存区，记录列表上会标出「待保存」「待删除」；点页面底部的保存（或暂存区里的「统一保存」）才逐条写入 DNSPod。

- 保存按暂存的顺序一条一条提交。某一条失败后，后面的不再尝试，失败那条和后面的都留在暂存区并显示原因；已经成功的会从暂存区移除，再次保存不会重复提交。
- 如果提示「结果不确定」，说明请求发出去了但没有收到 DNSPod 的明确答复（超时或网络中断），这条可能已经生效：先点「刷新」核对列表，再决定撤销还是重试。
- 修改或删除前，面板会重新读取这条记录；如果它在 DNSPod 控制台或别处被改过，会拒绝覆盖并提示刷新后重新编辑。
- 暂存区有内容时不能切换域名；一次最多暂存 50 条。

### 面板自己维护的记录是只读的

下面这些名字的记录由面板根据运行状态自动写入，在记录管理里显示为「面板管理」并注明归谁管，**不能在这里修改、删除，也不能新建同名记录或把别的记录改名成它们**（服务端同样会拒绝）：

| 来源 | 名字 |
| --- | --- |
| 主机 DDNS | 开启了 DDNS 的主机填写的 DDNS 域名 |
| 入口组 / 转发组 / 故障转移 | 开启了自动解析的组填写的域名（组暂时停用也算） |
| 规则专属域名 | 已发布的 `r<规则ID>.<后缀>`、等待删除的旧域名，以及后缀下整段 `r<数字>` 名字 |
| 落地池 | 落地池的直连域名 |

要改这些记录，请到对应的主机、入口组 / 转发组、规则或落地池里修改设置。保护不看 DDNS 当前是否启用：临时关掉 DDNS 期间手改的记录，重新启用后会被面板覆盖。

### 读取结果

- 记录会翻完所有分页再显示；翻页过程中记录数变化时会自动重读，持续对不上就报错，不会只显示一部分。
- 只有 DNSPod 明确返回 0 条时才显示「这个域名下还没有解析记录」；返回格式异常、网络失败、权限不足都会显示错误和重试按钮，不会显示成空列表。
- 面板日志只记录操作类型、数量和错误码，不记录记录值和密钥。

::: tip 关于按运营商线路给入口组分流
入口组 / 转发组的 DDNS 目前只写一条线路（DDNS 设置里的默认线路）。需要「电信解析到 A、联通解析到 B」时，可以在记录管理里给一个**不归面板管理**的子域名按线路分别建记录；这些记录不会随故障切换自动更新。
:::

## 自定义 Webhook {#webhook}

Webhook 适合你有自己的 DNS 更新接口，或使用暂未内置支持的服务商。

面板填写：

| 字段 | 说明 |
| --- | --- |
| 请求方法 | 支持 `POST`、`PUT`、`GET` |
| Webhook URL | 接收 DDNS 更新的接口地址 |
| 请求头 | 支持 JSON 或每行一个 Header |

Webhook URL 可以使用变量：

| 变量 | 含义 |
| --- | --- |
| `{{domain}}` | 要更新的完整域名 |
| `{{type}}` | 记录类型，例如 `A`、`AAAA`、`CNAME` |
| `{{value}}` | 要写入的记录值 |
| `{{ttl}}` | TTL |

示例：

```text
https://ddns.example.com/update?domain={{domain}}&type={{type}}&value={{value}}&ttl={{ttl}}
```

请求头 JSON 示例：

```json
{"Authorization":"Bearer your-token"}
```

## 主机 DDNS {#host-ddns}

配置路径：

```text
主机管理 -> 新增/编辑主机 -> DDNS 服务
```

开启后，Agent 上报的公网 IP 变化时，NEX 会自动更新该主机的 DDNS 域名。

记录类型：

| 选项 | 发什么 |
| --- | --- |
| IPv4 / A | 一条 A 记录 |
| IPv6 / AAAA | 一条 AAAA 记录 |
| 双栈 / A + AAAA | A 发 IPv4、AAAA 发 IPv6；哪一族这台机器暂时没有地址，就先不动那一族的记录 |

记录值：

| 选项 | 发什么 |
| --- | --- |
| 仅主 IP（默认） | 只发主 IP，也就是主机卡片上显示的那个地址（见 [主机管理 › 多个公网 IP 与主 IP](./hosts.md#multi-ip)） |
| 全部 IP | Agent 在网卡上检测到的这一族全部公网地址，各发一条同名记录，主 IP 排第一 |

「全部 IP」要 Agent 2.2.253 起才有地址列表；旧 Agent 没报列表时只发主 IP。各服务商的做法：

| 服务商 | 全部 IP | 说明 |
| --- | --- | --- |
| Cloudflare | 支持 | 每个地址一条记录，多出来的旧记录会删掉；记录的「代理」开关沿用已有记录 |
| 华为云 DNS | 支持 | 一个记录集里放全部地址 |
| 阿里云 DNS | 支持 | 同一主机记录、同一线路下每个地址一条；免费版对同名记录条数有上限，超过会报错 |
| 腾讯云 DNSPod | 支持 | 同上，按线路写；套餐对负载均衡条数有上限 |
| Webhook | 退回主 IP | 面板不知道接收端认不认多个值，主机 DDNS 一次只推一个 `value`（和原来一样）；双栈时 A、AAAA 各推一次 |

切换配置时：

- 从「全部 IP」改回「仅主 IP」，多出来的同名记录会一起删掉，只留主 IP 那一条（Webhook 除外）。
- 从双栈改回单栈，面板之前发过的另一族记录会删掉，免得双栈客户端去连一条不再更新的 AAAA。只删这套逻辑发过的；老版本留下的记录不动。Webhook 删不了，界面会提示手动清理。
- 老的「IPv4 / IPv6 + 仅主 IP」配置一个字节都不变：还是原来那一次更新，`lastDdnsValue` 还是那个地址。

如果服务商配置未启用，主机 DDNS 开关会不可用，需要先回到系统设置配置 DDNS 服务商。

## 入口组与转发组 {#group-ddns}

**入口组**适合多个入口机器共用一个域名，NEX 将全部成员的地址同步到同一条域名记录。

配置路径：

```text
链路管理 -> 更多 -> 入口组
```

记录类型要求：

| 类型 | 要求 |
| --- | --- |
| A | 成员机器需要有 IPv4 |
| AAAA | 成员机器需要有 IPv6 |
| CNAME | 成员机器需要配置 DDNS 域名 |

如果选择 CNAME，NEX 会把入口域名指向成员机器配置好的 DDNS 域名。这样成员 IP 变化时，通常只需要更新成员自己的 DDNS，入口域名记录无需重新写入。

### 双栈（IPv4 + IPv6）{#group-dual-stack}

A / AAAA 类型的入口组和故障转移组可以勾「同时发 IPv6（AAAA）」（AAAA 组是「同时发 IPv4（A）」）：

- 成员挑选、健康检测、故障切换、带宽排序**全都还按上面选的记录类型来**，另一族只是跟着同一批成员走。
- 选中的成员有另一族地址就发上去；没有的少一条；一条都没有时把另一族的记录清空。
- 故障切换时两族一起切。只切 A 不切 AAAA 的话，双栈客户端会优先走 IPv6，照样连到那台坏机器。
- 取消勾选时，面板发过的另一族记录会被删掉。
- CNAME 组没有「另一族」，不支持双栈。老的组默认不勾，行为不变。

## 故障切换建议 {#failover-tips}

- 不要把故障切换时间设置得太短，网络偶发抖动可能导致频繁切换。
- 重要业务建议开启链路测试和延迟观察，基于实测延迟判断入口健康状态。
- 恢复后是否切回，取决于你是否希望优先使用主入口，可在转发组配置中选择。
- 建议先用测试域名验证切换流程，确认正常后再切换生产域名。
- TTL 较大时，DNS 切换后客户端缓存未过期，实际生效会有延迟，建议在切换验证阶段临时调低 TTL。

## 域名来源优先级 {#domain-priority}

NEX 展示入口地址时，优先级如下：

1. 用户在主机或组内手动填写的域名或 IP。
2. 自动检测到的公网地址或 DDNS 地址。

建议重要业务手动设置清晰的域名，避免直接依赖可能变化的 IP。

## 排查 DDNS {#troubleshooting}

如果 DDNS 没有更新：

1. 确认系统设置中 DDNS 已启用，且服务商不是"不使用"。
2. 确认主域名、Zone ID、线路、密钥填写正确。
3. 确认 API 密钥有 DNS 记录查询和编辑权限。
4. 确认主机或入口组填写的域名属于对应主域名。
5. 查看系统日志和入口组事件记录。

常见错误：

| 现象 | 可能原因 |
| --- | --- |
| 提示域名不在主域名下 | 阿里云、腾讯云主域名填写错误 |
| Cloudflare 找不到 Zone | Token 没有 Zone:Read 权限，或 Zone ID 未填写且自动识别失败 |
| 权限不足 | API 密钥权限太小或绑定了错误域名 |
| AAAA 不更新 | 成员机器没有可用 IPv6 |
| CNAME 不更新 | 成员机器没有配置 DDNS 域名 |
| 切换后域名未生效 | DNS 缓存未过期，等待 TTL 时间后重试 |
