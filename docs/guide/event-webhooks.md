# 接口文档与事件推送

想在 NEX 上面搭自动化（n8n、Home Assistant、自己写的脚本），会用到两样东西：

| 功能 | 做什么 | 在哪里 |
| --- | --- | --- |
| 接口文档（OpenAPI） | 面板全部接口的清单，能导入 Postman 或代码生成器 | 系统设置 → 进阶 → API 令牌 →「接口文档（OpenAPI）」 |
| 事件推送 | 主机上下线、线路切换、规则出错这类事发生时，推一条带签名的 JSON 给你的程序 | 系统设置 → 进阶 →「事件推送」 |

两样都只有管理员能配。事件推送**默认关闭**，关着的时候面板不做任何额外的事。

::: tip 和「Webhook 通知」不是一回事
系统设置 → Webhook 那一页，是把告警排成一条聊天消息发到 Discord / Slack，给人看的。
这里的事件推送是给程序用的：每件事一条固定结构的 JSON，带签名，接收方按 `type` 分支处理。
:::

## 接口文档（OpenAPI）

地址是 `<面板地址>/api/openapi.json`，OpenAPI 3.1 格式。登录后在设置里点「下载」，或者让脚本带着 API 令牌去取：

```bash
curl -H 'Authorization: Bearer nex_…' -o nex-openapi.json https://面板地址/api/openapi.json
```

- 文档是面板从自己的接口生成的，和你正在用的版本一致。升级后新加的接口自动出现。
- 每个接口写着：至少要什么身份（不用登录 / 登录用户 / 管理员）、API 令牌能不能调、要只读还是「完全」令牌、属于哪个令牌模块。
  令牌调不了的（改密码、令牌管理、备份迁移、事件推送配置等）也列着，标的是「API 令牌：不可用」。
- 有少数接口的入参带着自定义校验，JSON Schema 写不出来，描述里会注明「以接口返回的报错为准」。
- 返回值的结构没有写进文档（面板的接口没有声明返回类型），以实际返回为准。

导入 Postman：先下载文件，再在 Postman 里 Import 这个文件。在集合的 Authorization 里选 Bearer Token，填你的 API 令牌。

### 接口的调用方式

面板的接口是 tRPC，HTTP 上长这样（文档里写的就是这个样子，没有另包一层）：

| | 写法 |
| --- | --- |
| 查询 | `GET /api/trpc/<接口名>?input=<URL 编码的 {"json": 入参}>`，没有入参就不带 `input` |
| 修改 | `POST /api/trpc/<接口名>`，`Content-Type: application/json`，请求体 `{"json": 入参}` |
| 成功 | `{"result": {"data": {"json": 返回值}}}` |
| 失败 | 非 2xx，`{"error": {"json": {"message": "原因", "data": {"code": "BAD_REQUEST", "httpStatus": 400}}}}` |

返回值里的日期是 ISO 字符串，旁边的 `meta.values` 会标出哪些字段是日期（`{"0.createdAt": ["Date"]}`），不用管它也行。

```bash
curl -H 'Authorization: Bearer nex_…' --get 'https://面板地址/api/trpc/ops.events.recent' \
  --data-urlencode 'input={"json":{"limit":5}}'
```

## 事件推送

### 怎么开

1. 系统设置 → 进阶 → 事件推送 →「添加地址」。
2. 填接收地址（`http://` 或 `https://`）和签名密钥（至少 16 个字符，可以点「随机生成」），勾上要订阅的事件类别，保存。
   **密钥保存后不再显示**，保存前先填到接收方。
3. 点这一行的「测试」：面板发一条 `webhook.test` 事件过去，直接告诉你状态码和耗时。测试不看开关，可以先测通再打开。
4. 打开上面的「开启推送」。

最多配 10 个地址，每个地址各自订阅、各自启用 / 停用。点「编辑」能看到这个地址最近 20 次投递的结果（状态码、耗时、错误）；
这份记录只在内存里，面板重启后清空。

### 请求长什么样

每件事 POST 一次，请求体：

```json
{
  "id": "evt_1042",
  "type": "host.offline",
  "occurredAt": "2026-11-10T08:30:00.000Z",
  "data": {
    "level": "warn",
    "message": "港-1 断线",
    "hostId": 3,
    "hostName": "港-1",
    "userId": null,
    "userName": null,
    "ruleId": null,
    "detail": { "lastSeenAt": 1794299400 }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 事件编号。重试时不变，接收方按它去重 |
| `type` | 事件类型，见下面的清单 |
| `occurredAt` | 事件发生的时间（UTC） |
| `data.level` | `info` / `warn` / `crit` |
| `data.message` | 一句给人看的中文，和面板「监控 → 事件」里那句一样 |
| `data.hostId` / `hostName` | 相关的主机，没有是 `null` |
| `data.userId` / `userName` | 相关的用户（规则的主人、操作的管理员），没有是 `null` |
| `data.ruleId` | 相关的规则，没有是 `null` |
| `data.detail` | 每种事件自己的字段，见清单；没有就是 `{}` |

请求头：

| 头 | 说明 |
| --- | --- |
| `X-NEX-Timestamp` | 发出时的 Unix 秒 |
| `X-NEX-Signature` | `sha256=` 加 `HMAC-SHA256(密钥, 时间戳 + "." + 请求体)` 的十六进制 |
| `X-NEX-Event` | 同 `type`，不解析请求体就能分流 |
| `X-NEX-Delivery` | 同 `id` |

以后可能会给 `data` 或 `detail` 加字段，接收方请忽略不认识的字段。

### 验签

一定要用**收到的原始请求体**算，不能先解析成 JSON 再序列化回去（空格、字段顺序会变）。时间戳离现在超过 5 分钟的请求直接拒掉，
别人抓到一条旧请求重放就没用了。

Node：

```js
import crypto from "node:crypto";

function verifyNex(secret, headers, rawBody) {
  const ts = String(headers["x-nex-timestamp"] || "");
  const sig = String(headers["x-nex-signature"] || "");
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

Python：

```python
import hashlib, hmac, time

def verify_nex(secret: str, headers, raw_body: bytes) -> bool:
    ts = headers.get("X-NEX-Timestamp", "")
    sig = headers.get("X-NEX-Signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)
```

验过了回 2xx 就行，响应体面板不看。用 n8n 之类的工具时，要验签就得让它把原始请求体交给你（n8n 的 Webhook 节点有「Raw Body」选项）。

### 重试规则

| 情况 | 怎么办 |
| --- | --- |
| 2xx | 成功 |
| 连不上、5 秒没响应、408 / 425 / 429 / 5xx | 过一会儿再发：5 秒、30 秒、2 分钟、10 分钟后各一次，一共最多发 5 次 |
| 3xx 跳转 | 失败，不重试，**不跟随跳转**：请直接填最终地址 |
| 其他 4xx（比如验签没过回 401） | 失败，不重试 |

- 每次重发都重新签名（时间戳是重发那一刻的），`id` 不变。
- 同一个地址同一时刻只发一条，一个慢地址不会拖住别的地址；但重试的事件会排到后面，**顺序不保证**，要顺序请看 `occurredAt`。
- 待发的事件排在内存里，最多 500 条，满了丢最旧的（界面上会显示丢了几条，面板日志也会记）。面板重启时还没发出去的就没了 ——
  这是推送，不是账本，漏掉的可以用接口 `ops.events.list` 补查。
- 停用某个地址、关掉总开关、删掉地址后，排着队的也一并作废。

### 事件清单

类别就是 `type` 第一个点前面那段。订阅了一个类别，这一类以后新加的事件也会收到。

**主机（host）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `host.offline` | warn | 主机断线 | `lastSeenAt`：最后一次心跳（Unix 秒） |
| `host.online` | info | 主机上线 | 断线后恢复时有 `outageSeconds`（断了多久）、`offlineSince` |
| `host.rebooted` | warn | 机器重启了 | — |
| `host.agent_restarted` | info | Agent 进程重启 / 升级后重启 | 升级时有 `agentVersion` |
| `host.maintenance` | warn / info | 进入 / 结束维护 | — |
| `host.ip_changed` | warn | 自动换 IP 成功 | `provider`、`oldIp`、`newIp`、`ipRole`、`trigger`、`notes` |
| `host.ip_change_failed` | crit | 换 IP 失败或结果不确定 | `provider`、`trigger`、`uncertain` |
| `host.ip_blocked_suspected` | warn | 连续几轮连不上大陆探测目标 | `consecutiveFailures`、`threshold` |
| `host.resource_high` / `host.resource_recovered` | warn / info | CPU、内存、磁盘持续超阈值 / 回落 | `metric`、`value`、`threshold`、`peak`、`durationSeconds` |
| `host.oom_killed` | crit | 内存耗尽，内核杀了进程 | `delta`（这次几个）、`total`（开机以来） |
| `host.process_crashed` | warn | 服务崩溃后被自动重启 | `units`：崩溃的服务列表 |
| `host.packet_loss` | warn | 隧道探测丢包 | `tunnelId`、`lossPercent`、`probes` |
| `host.packet_loss_recovered` | info | 丢包回落 | `tunnelId`、`lossPercent`、`peak`、`durationSeconds` |
| `host.relay_switched` | warn / info | Agent 改走中转连面板（自动或手动） | `viaHostId`、`auto`；自动时有 `offlineMinutes`，手动时有 `previousViaHostId` |
| `host.relay_fallback` | warn | 经中转连不上，退回直连 | `via`、`error` |

**线路（route）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `route.switched` | info | 规则的线路组切了线 | `from`、`to`、`reason` |
| `route.precheck_failed` | warn | 计划切线，预检没过，没切 | `from`、`to`、`reason` |
| `route.unhealthy` | warn | 线路组里某条线路探测不通 | `path`、`pathKey`、`reason` |
| `route.recovered` | info | 那条线路又通了 | `path`、`pathKey`，对得上时有 `durationSeconds` |
| `route.group_switched` | info | 转发组 / 入口组自动切换 | `forwardGroupId`、`mode`（`failover` / `entry`） |

线路类事件的 `ruleId` 是那条规则，`userId` 是规则的主人。同一条规则同一件事 30 秒内只记一次。

**规则（rule）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `rule.error` | warn | 规则出错 / 停止运行（原因在 `message` 里） | — |
| `rule.recovered` | info | 出错的规则恢复运行 | — |
| `rule.traffic_surge` / `.recovered` | warn / info | 规则流量持续高出平时（流量异常检测）/ 回落 | `valueMbps`、`baselineMbps`、`thresholdMbps`；触发时有 `throttle`（自动限速的 `mbps`、`until`），回落时有 `peakMbps`、`durationSeconds` |
| `rule.ip_conn_surge` / `.recovered` | warn / info | 单个来源 IP 连接数持续超阈值 / 回落 | `ip`、`conns`、`threshold`；回落时有 `peak`、`durationSeconds` |

同一条规则同一个错误 5 分钟内只记一次。

**用户（user）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `user.quota_exhausted` | warn | 流量用完，转发已暂停 | — |
| `user.expired` | warn | 已到期，转发已暂停 | — |
| `user.expiring` | info | 三天内到期（每人每天最多一条） | `expiresAt`（Unix 秒） |
| `user.ip_limit_exceeded` | warn | 同时在线 IP 超过上限 | `count`、`limit`、`ips` |
| `user.traffic_surge` / `.recovered` | warn / info | 用户总流量持续高出平时 / 回落 | 同 `rule.traffic_surge` |

**登录与账号（account）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `account.login` | info | 管理员登录 | `ip`；通行密钥 / Google / Discord 登录时有 `method` |
| `account.login_failed` | warn | 同一 IP 连续登录失败 5 / 20 / 100 次 | `ip`、`count` |
| `account.login_new_device` | warn | 管理员账号在新设备或异地登录 | `ip`、`device`、`location` |
| `account.api_token_created` | warn / info | 新建了 API 令牌（「完全」令牌是 warn） | `tokenId`、`prefix`、`scope`、`modules`、`expiresAt` |
| `account.passkey_added` / `account.passkey_removed` | info | 添加 / 删除通行密钥 | — |
| `account.sessions_revoked` | info | 退出了其他设备 | — |
| `account.password_set` | info | 第三方登录的账号设了初始密码 | `ip` |
| `account.google_linked` / `account.google_registered` / `account.google_unlinked` | info | Google 登录绑定 / 注册 / 解绑 | `ip` |
| `account.discord_linked` / `account.discord_registered` / `account.discord_unlinked` | info | Discord 登录绑定 / 注册 / 解绑 | `ip` |

**安全（security）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `security.finding` | warn / crit | 主机安全巡检发现问题 | `findingId`、`fingerprint`、`kind`、`severity` |
| `security.ip_blocked` / `security.ip_unblocked` | info | 封禁 / 解封 IP | 封禁时有 `cidr`、`expiry` |
| `security.country_rule` | info | 主机的地区规则改了 | — |
| `security.panel_access` | info | 面板访问限制改了 | — |
| `security.firewall_error` | warn | 地区规则 / IP 封禁没能在主机上生效 | — |
| `security.api_rate_limited` | warn | 有人触发了接口限流 | `subject`、`key`、`path`、`limit`、`ip` |
| `security.google_login_toggled` / `security.discord_login_toggled` | info | 开关 Google / Discord 登录 | — |
| `security.discord_bot_disabled` | warn | Discord 机器人令牌失效，通知被自动关掉 | — |

**工单（ticket）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `ticket.created` | info | 用户新建工单 | `ticketId`、`title`、`priority`、`excerpt`（内容开头一段） |
| `ticket.replied` | info | 用户回复工单 | 同上 |

**面板运维（ops）**

| type | 级别 | 什么时候 | detail |
| --- | --- | --- | --- |
| `ops.maintenance` | warn / info | 开 / 关维护模式 | `enabled`、`message` |
| `ops.backup` | info / warn | 异地备份成功 / 失败 | `trigger`、`destination`；成功时有 `name`、`size`、`deleted` |
| `ops.restart_all` | info / warn | 发起「全部重启」/ 重启完成 | 发起时 `requestId`、`targetHostIds`、`skipped`；完成时 `requestId`、`results` |
| `ops.import_existing` | info | 从主机导入了现有转发 | `ruleIds` |
| `ops.import_switched` / `ops.import_stop_failed` | info / warn | 导入后停掉原来的服务 / 没停掉 | — |
| `ops.country_data` | warn | 地区 IP 段下载失败 | `country` |
| `ops.shop_sync` | info / warn | 商城回调开通 / 换套餐 / 停用了套餐，或没能处理 | `orderId`、`externalUserId`、`action`、`status`、`kind`、`planId`、`subscriptionId` |

**测试**

| type | 什么时候 |
| --- | --- |
| `webhook.test` | 在设置里点「测试」。只发给那一个地址，不重试 |

### 安全提示

- **接收地址可以填内网**（`192.168.x.x`、`localhost`、`.lan` 域名都行）：自建的 n8n、Home Assistant 多半在内网。
  代价是面板会从它所在的机器直接往这个地址发请求，所以只填你自己掌控的服务。为此：只有管理员能配、只能在网页上配
  （API 令牌碰不到这块设置）、不跟随跳转、每次改动都记进「监控 → 操作审计」（密钥打码）。
- 地址和密钥加密存在数据库里，跟着面板备份、迁移一起走；界面上密钥只显示末四位。
- 接收地址里如果带着令牌（比如 Home Assistant 的 webhook id 在路径里），它和密钥一样要保管好。用 `https://` 更稳妥。
- 事件里有主机名、用户名、登录 IP、工单内容开头这些信息，只订阅接收方真正要用的类别。
