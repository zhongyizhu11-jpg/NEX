# 商城对接（Xboard / V2Board / SSPanel）

用 Xboard、V2Board 或 SSPanel-UIM 卖套餐时，商城那边用户买了、续了、换了、退了，NEX 这边自动开通、续期、换套餐、停用，不用在两边手工对账。

- **方向只有一个：商城 → NEX。** 商城是账本的主人，NEX 只跟着走，不回写商城。两边都当主人，迟早会为「到底谁说了算」打架。
- **入口、端口、限速全由 NEX 的套餐决定。** 商城套餐在设置里映射到一个 NEX 套餐，开通时按这个套餐分端口段、给限速、流量、规则数和可用的主机 / 隧道 / 转发组 / 节点，和管理员手动分配套餐走的是同一套逻辑。
- **默认关。** 关着时商城的回调一律拒收，NEX 也不会主动去连商城。

::: warning 没有在真实商城上跑过
下面的插件和脚本是照着三个商城的源码写的（出处列在每一节末尾），NEX 这边的接口有完整的自动测试，但**没有接真实的 Xboard / V2Board / SSPanel 跑过**。第一次接请先拿一两个测试账号试，确认「最近同步」里是你想要的结果。
:::

## 开启

管理员进「设置 › 进阶 › 商城对接」：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 开启商城对接 | 关 | 关着时回调接口回「商城对接没有开启」 |
| 商城 | Xboard | 只影响界面上的叫法（SSPanel 叫「用户等级」）和这页给你的接法 |
| 按邮箱认领已有账号 | 关 | 见下面「账号怎么对上」 |
| 套餐映射 | 空 | 商城套餐 ID（SSPanel 填等级 `class`）→ NEX 套餐。没映射的商城套餐不开通，只记一条「没映射」 |

然后点「生成对接令牌」。这枚令牌是一枚 API 令牌，只勾了「商城对接」这一个模块：只能调回调接口，翻不了用户列表、改不了设置，也改不了对接本身的设置。它在「API 令牌与 MCP」里也能看到，泄露了就在那里撤销，再生成一枚。

卡片底下的「最近同步」是最近 20 次回调：成没成、开通 / 续期 / 换套餐 / 停用、为什么被忽略。商城收了钱 NEX 却没开出来（没映射、端口不够）时，事件时间线里还会记一条警告，照常转发到 Telegram / Webhook。

## 回调接口

```
POST https://你的面板/api/trpc/shopSync.inbound.push
Authorization: Bearer nex_对接令牌
Content-Type: application/json

{"json": { …下面的字段… }}
```

请求体外面要包一层 `{"json": …}`，这是 NEX 接口统一的格式。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `action` | 是 | `activate`（开通 / 续期 / 换套餐）或 `stop`（停用）。也认 `open` / `renew` / `change`，和 `activate` 是同一件事 |
| `orderId` | 是 | 幂等键，1–128 位字母、数字和 `_ . : @ -`。同一个订单号来几次都只处理一次 |
| `user.externalId` | 是 | 商城那边的用户 id。绑定只认它 |
| `user.email` | 否 | 第一次来时用来建账号 / 认领账号 |
| `shopPlanId` | 开通时必填 | 商城套餐 id（SSPanel 填等级） |
| `expiresAt` | 否 | 到期时间：秒、毫秒或 ISO 时间；`null` 表示永久。给了就照它对齐 |
| `durationDays` | 否 | 没给 `expiresAt` 时，续多少天（叠加在现在的到期时间上）。都没给就按 NEX 套餐的时长 |
| `occurredAt` | 强烈建议 | 这件事在商城发生的时间（秒）。判断乱序全靠它，不给就按 NEX 收到的时间算 |

`activate` 时 NEX 看自己这边的现状决定怎么做：

- 这个人还没有在生效的商城订阅 → **新开**一条（到期了的不拿来续，按新开处理）；
- 有、套餐一样 → **续期**：给了 `expiresAt` 就改成它，否则在原到期时间上加 `durationDays`；
- 有、套餐不一样 → **换套餐**：先开新的再停旧的，新的开不出来时旧的还在。

`stop` 停掉商城开的那一条。**只动商城开出来的那条订阅**：用户在 NEX 里自己买的、管理员手动给的都不碰。

返回（`result.data.json`）：

| 字段 | 说明 |
| --- | --- |
| `ok` | `true` = 已生效或已忽略，商城不用再发；`false` = 没映射或失败，修好后用**同一个订单号**重发就会重试 |
| `status` | `applied` 已生效 / `ignored` 已忽略（乱序、到期时间已过）/ `unmapped` 没映射 / `failed` 失败 / `processing` 同一订单正在处理 |
| `kind` | `opened` / `renewed` / `changed` / `stopped` / `noop` |
| `duplicate` | 这个订单号以前处理过，这次原样回上次的结果 |
| `message` | 给人看的一句说明 |
| `user` | NEX 用户 id；新建账号的那一次带 `username` 和 `initialPassword`（只这一次，NEX 不存明文） |
| `subscribeUrl` | 对接新建的账号、而且套餐带客户端订阅时，回一条订阅地址，商城可以直接展示给用户 |

参数不对、令牌不对、对接没开时回 HTTP 4xx，`error.json.message` 里是原因。

### 用 curl 试一下

```bash
curl -s https://你的面板/api/trpc/shopSync.inbound.push \
  -H 'Authorization: Bearer nex_对接令牌' \
  -H 'Content-Type: application/json' \
  --data '{"json":{"action":"activate","orderId":"test-1","user":{"externalId":"1","email":"test@example.com"},"shopPlanId":"1","durationDays":30,"occurredAt":'"$(date +%s)"'}}'
```

再发一次同样的命令，返回里 `duplicate` 是 `true`，到期时间不会再加 30 天。

## 几条规矩

**幂等**：订单号就是幂等键。已生效 / 已忽略的订单号再来，原样回上次的结果；没映射 / 失败的允许同一个订单号重试（「最近同步」里会显示第几次）。所以商城那边重试、补发都放心发。

**乱序**：NEX 给每个商城用户记两条时间，都是商城给的 `occurredAt`：最近一次生效的开通、最近一次生效的停用。

- 开通发生得**不晚于**最近一次停用 → 是停用之前的旧消息迟到了，忽略。先到「退款停用」、后到「开通」时就是这样。
- 停用发生得**早于**最近一次开通 → 是更早的停用迟到了，忽略，不会把之后才买的套餐停掉。
- 时间相同时停用说了算（宁可少开，不多开）。

所以 `occurredAt` 一定要传，而且同一个商城的所有回调用同一台机器的时钟。

**账号怎么对上**：绑定只认 `user.externalId`。

- 第一次来、NEX 里没有同邮箱账号：新建一个普通用户（用户名用邮箱，随机密码）。
- 第一次来、NEX 里已有同邮箱账号：默认**不接管**，记一条失败。很多商城注册不验证邮箱，接管就等于谁都能在商城拿别人的邮箱注册、改那个 NEX 账号的套餐。确认你的商城验证邮箱、又想把老用户接过来时，再打开「按邮箱认领已有账号」。
- 管理员账号永远不接管；一个 NEX 账号只能绑一个商城用户。
- 绑好之后商城里改邮箱不会换绑；用户在 NEX 里也改不了绑定。

**钱**：商城开出来的订阅在 NEX 的账本里是 0 元的「管理员分配」—— 钱是在商城收的。用户也不能在 NEX 里自己续它，续费得回商城。

**审计**：每次回调都进「监控 › 操作审计」（路径 `shopSync.inbound.push`，记着是哪枚令牌、哪个 IP），开通 / 换套餐 / 停用和失败另记进事件时间线。

## Xboard

Xboard 有插件系统，订单开通后会触发 `order.open.after` 钩子。推荐两样都装：

1. **插件**：订单一开通就通知 NEX，用户付完款马上能用；
2. **计划任务脚本**（见下面「通用对账脚本」）：每分钟对一遍账，补上插件管不到的 —— 后台封禁用户、手动改套餐、插件那一下没发出去。

Xboard 没有「退款」钩子（它的 `order.cancel.*` 是取消**未付款**的订单），停用只能靠对账脚本发现。

插件放在 Xboard 的 `plugins/NexSync/` 下，两个文件：

`plugins/NexSync/config.json`

```json
{
  "name": "NEX 同步",
  "code": "nex_sync",
  "version": "1.0.0",
  "description": "订单开通后通知 NEX 开通、续期、换套餐",
  "author": "your-name",
  "require": { "xboard": ">=1.0.0" },
  "config": {
    "nex_url": { "type": "string", "default": "", "label": "NEX 回调地址", "description": "NEX 设置 › 进阶 › 商城对接 里复制" },
    "nex_token": { "type": "string", "default": "", "label": "对接令牌", "description": "nex_ 开头" }
  }
}
```

`plugins/NexSync/Plugin.php`

```php
<?php

namespace Plugin\NexSync;

use App\Models\User;
use App\Services\Plugin\AbstractPlugin;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class Plugin extends AbstractPlugin
{
    public function boot(): void
    {
        $this->listen('order.open.after', function ($order) {
            try {
                // 4 = 流量重置包：不改套餐和到期时间，不用通知
                if ((int) $order->type === 4) {
                    return;
                }
                $user = User::find($order->user_id);
                if (!$user || !$user->plan_id) {
                    return;
                }
                $response = Http::timeout(5)
                    ->withToken($this->getConfig('nex_token'))
                    ->post($this->getConfig('nex_url'), ['json' => [
                        'action' => 'activate',
                        'orderId' => 'xb-' . $order->trade_no,
                        'user' => ['externalId' => (string) $user->id, 'email' => $user->email],
                        'shopPlanId' => (string) $user->plan_id,
                        // 开通后用户身上的到期时间就是结果；null = 一次性（永久）套餐
                        'expiresAt' => $user->expired_at,
                        'occurredAt' => time(),
                    ]]);
                $result = $response->json('result.data.json');
                if (!$response->ok() || empty($result['ok'])) {
                    Log::warning('NEX sync not applied: ' . $response->body());
                }
            } catch (\Throwable $e) {
                // 钩子里的异常会冒到支付回调里去：吞掉只记日志，漏掉的由对账脚本补上
                Log::warning('NEX sync failed: ' . $e->getMessage());
            }
        });
    }
}
```

然后在 Xboard 后台的插件管理里启用它，填好两项配置（菜单名以你的版本为准）。

这里用的都出自 Xboard 源码：插件结构、`listen()` / `getConfig()` 见 `docs/en/development/plugin-development-guide.md` 和 `app/Services/Plugin/AbstractPlugin.php`；`order.open.after` 在 `app/Services/OrderService.php` 的 `open()` 末尾触发，此时用户的 `plan_id`、`expired_at` 已经保存好；订单的 `trade_no`、`type`（1 新购 / 2 续费 / 3 升级 / 4 流量重置）见 `app/Models/Order.php`；用户表 `v2_user` 的字段见 `app/Models/User.php`。

## V2Board

V2Board 没有插件和钩子，想在订单开通那一刻通知 NEX，只能改它的源码（`app/Services/OrderService.php` 的 `open()`），升级时会被覆盖，不推荐。用下面的**通用对账脚本**每分钟对一遍账就够了：付款后最多一分钟 NEX 这边开通。

V2Board 和 Xboard 的用户表是同一张 `v2_user`（`email`、`plan_id`、`expired_at`、`banned`），出处是 V2Board 的 `database/install.sql`。注意 V2Board 里 `expired_at` 为 `NULL` 是一次性（永久）套餐，为 `0` 是没设过。

## SSPanel-UIM

SSPanel-UIM 没有套餐 id 落在用户身上：商品激活后（它的计划任务 `processTabpOrderActivation`）写的是用户的**等级** `class` 和等级到期时间 `class_expire`，到期后它自己的计划任务把 `class` 改回 0。所以在 NEX 的映射表里填的是**等级**：比如等级 1 → NEX 的「月付」，等级 2 → NEX 的「高级」。

SSPanel-UIM 也没有可以挂回调的钩子，用**通用对账脚本**，把 `SHOP` 改成 `sspanel`。字段出处：`src/Models/User.php`（`email`、`class`、`class_expire`、`is_banned`）和 `src/Services/Cron.php`。`class_expire` 是不带时区的 `Y-m-d H:i:s`，脚本用 PHP 的 `strtotime` 换算，请让跑脚本的 PHP 和 SSPanel 用同一个时区。

SSPanel 的其他商品类型（按流量的、充值的）不改等级，不会触发 NEX 这边任何变化。

## 通用对账脚本

一个 PHP 命令行脚本，放在商城那台机器上，用计划任务每分钟跑一次：

```bash
* * * * * php /opt/nex-shop-sync/nex-shop-sync.php >> /var/log/nex-shop-sync.log 2>&1
```

它读商城自己的数据库，算出每个用户「现在该有哪个套餐、到什么时候」，和上次推给 NEX 的比，**变了才推**：开了 / 续了 / 换了推 `activate`（带商城算好的到期时间），封禁了 / 没套餐了推 `stop`。到期不用推：NEX 这边的到期时间和商城一致，到点自己停。

第一次跑会把现有的付费用户全部推一遍，相当于一次导入。

```php
<?php
// nex-shop-sync.php：商城 → NEX 对账（每分钟跑一次）

const NEX_URL    = 'https://你的面板/api/trpc/shopSync.inbound.push';
const NEX_TOKEN  = 'nex_对接令牌';
const SHOP       = 'v2board';   // v2board（Xboard 也填这个，同一张 v2_user 表）或 sspanel
const DB_DSN     = 'mysql:host=127.0.0.1;dbname=v2board;charset=utf8mb4';
const DB_USER    = 'v2board';
const DB_PASS    = '数据库密码';
const STATE_FILE = __DIR__ . '/nex-shop-sync.state.json';

function nex_push(array $event): ?array
{
    $ch = curl_init(NEX_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . NEX_TOKEN],
        CURLOPT_POSTFIELDS => json_encode(['json' => $event], JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($body === false) {
        fwrite(STDERR, "连不上 NEX\n");
        return null;
    }
    $data = json_decode($body, true);
    if ($code !== 200) {
        fwrite(STDERR, "NEX 返回 {$code}：" . ($data['error']['json']['message'] ?? $body) . "\n");
        return null;
    }
    return $data['result']['data']['json'] ?? null;
}

/** 商城里每个用户现在的样子：active、plan（套餐 id / 等级）、expiresAt（秒，null = 永久）。 */
function shop_users(PDO $pdo): array
{
    $now = time();
    $users = [];
    if (SHOP === 'sspanel') {
        foreach ($pdo->query('SELECT id, email, class, class_expire, is_banned FROM user') as $row) {
            $expiresAt = strtotime((string) $row['class_expire']) ?: 0;
            $users[$row['id']] = [
                'email' => $row['email'],
                'active' => !$row['is_banned'] && (int) $row['class'] > 0 && $expiresAt > $now,
                'plan' => (string) $row['class'],
                'expiresAt' => $expiresAt,
            ];
        }
        return $users;
    }
    foreach ($pdo->query('SELECT id, email, plan_id, expired_at, banned FROM v2_user') as $row) {
        $expiresAt = $row['expired_at'] === null ? null : (int) $row['expired_at'];
        $users[$row['id']] = [
            'email' => $row['email'],
            'active' => !$row['banned'] && $row['plan_id'] !== null && ($expiresAt === null || $expiresAt > $now),
            'plan' => (string) $row['plan_id'],
            'expiresAt' => $expiresAt,
        ];
    }
    return $users;
}

$lock = fopen(STATE_FILE . '.lock', 'c');
if (!flock($lock, LOCK_EX | LOCK_NB)) {
    exit(0); // 上一轮还没跑完
}
$pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$state = is_file(STATE_FILE) ? (json_decode(file_get_contents(STATE_FILE), true) ?: []) : [];
// 订单号前缀：状态文件新建时随机生成一次。删掉状态文件重推时换一个前缀，
// 不会和 NEX 那边已经记过的订单号撞上（撞上会被当成重复回调，原样回旧结果）。
$prefix = $state['_prefix'] ?? ($state['_prefix'] = bin2hex(random_bytes(4)));

foreach (shop_users($pdo) as $id => $user) {
    $want = $user['active'] ? 'on:' . $user['plan'] . ':' . ($user['expiresAt'] ?? 'forever') : 'off';
    $saved = $state[$id] ?? null;
    if ($saved === null && !$user['active']) {
        continue; // 从没开通过的免费用户不用管
    }
    if ($saved !== null && $saved['key'] === $want && empty($saved['pending'])) {
        continue; // 没变
    }
    // 同一个变化重试时沿用同一个订单号：NEX 那边只记一行，不会越堆越多
    if (!empty($saved['pending']) && $saved['pending']['key'] === $want) {
        $orderId = $saved['pending']['orderId'];
    } else {
        $n = ($saved['n'] ?? 0) + 1;
        $orderId = "state-$prefix-$id-$n";
        $state[$id] = ['key' => $saved['key'] ?? 'off', 'n' => $n, 'pending' => ['key' => $want, 'orderId' => $orderId]];
    }
    $event = [
        'orderId' => $orderId,
        'user' => ['externalId' => (string) $id, 'email' => $user['email']],
        'occurredAt' => time(),
    ];
    if ($user['active']) {
        $event['action'] = 'activate';
        $event['shopPlanId'] = $user['plan'];
        $event['expiresAt'] = $user['expiresAt']; // null = 永久
    } else {
        $event['action'] = 'stop';
    }
    $result = nex_push($event);
    if ($result !== null && in_array($result['status'], ['applied', 'ignored'], true)) {
        $state[$id] = ['key' => $want, 'n' => $state[$id]['n']];
        if (!empty($result['user']['initialPassword'])) {
            // 新建的 NEX 账号：要告诉用户就在这里发邮件，别写进日志
        }
    } elseif ($result !== null) {
        echo date('c') . " 用户 {$id}：{$result['status']} {$result['message']}\n";
    }
}

file_put_contents(STATE_FILE, json_encode($state), LOCK_EX);
```

几点说明：

- 状态文件 `nex-shop-sync.state.json` 记着每个用户上次推成功的样子，删掉它等于全部重推一遍：推的都是绝对的到期时间，重推不会叠时长；订单号换了新前缀，也不会被当成重复回调吞掉。
- 没映射、失败的会每轮重试同一个订单号，直到你在 NEX 补好映射或腾出端口。
- 数据库连接按你的商城改（看商城自己的 `.env` 里的数据库配置）。商城用的是 SQLite 时，`DB_DSN` 写成 `sqlite:` 加数据库文件的完整路径，`DB_USER` / `DB_PASS` 留空字符串。
- 这个脚本只读商城的库，不往里写任何东西。

## 自己写回调

不是这三个商城，或者想在别的时机通知 NEX（比如退款），照上面「回调接口」自己发就行，记住三件事：每个订单一个不变的 `orderId`；带上 `occurredAt`；能给绝对的 `expiresAt` 就别用 `durationDays`（绝对时间重发、乱序都不会算错）。

## 没做的

- **不回写商城**：NEX 这边改了套餐、停了用户，商城不知道。账以商城为准，要改请在商城改。
- **不去拉商城的管理接口**：那要把商城的管理员登录凭据存在 NEX 里（能看全部用户和订单），泄露的代价比一枚只能开套餐的令牌大得多；三个商城的管理接口也各不相同、跟着版本变。对账脚本在商城本机读自己的库，效果一样，凭据不出商城那台机器。
- 迁移面板（备份恢复）时绑定和回调记录会跟着走；但映射表里的 NEX 套餐 id 如果在新面板上变了，需要在设置里重新选一下。
