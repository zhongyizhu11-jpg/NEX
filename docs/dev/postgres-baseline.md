# PostgreSQL 基线（2026-11-24）

商用部署的推荐库是 PostgreSQL，但仓库里 290 个连真库的测试文件全按 SQLite 写。这次把共用的测试跑法接上了 PostgreSQL，在本机 PostgreSQL 16 上跑了一遍，看产品代码在 PostgreSQL 下到底有没有问题。

## 一、怎么跑

```sh
# 要一个能建库的 PostgreSQL（测试每次新建一个 nex_test_* 库，跑完删掉）
export FORWARDX_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/postgres
# 走 server/testing/runInDatabase.ts 的测试：
FORWARDX_TEST_DB_KIND=postgresql node --import tsx --test $(grep -rl "runInDatabase(" server --include=*.test.ts)
# 多实例租约、原版库迁移（这两个一直支持外部库）：
node --import tsx --test server/panelLease.external.test.ts server/forwardxMigration.external.test.ts
```

`runInDatabase` 在 PostgreSQL 上做了三件事让按 SQLite 写的测试脚本照样跑：驼峰列名自动加双引号（PostgreSQL 把裸标识符折成小写）；一次性库里把 int4 → bool 放宽成隐式转换（脚本里布尔列写的是 1 / 0）；setup 之后把每张表的自增序列拨到当前最大 id（脚本带 id 插行，序列不会跟着走）。脚本里另有 `failWrite` / `dropFailWrite`（两种库语法的「让这次写入失败」触发器）、`skipUnless(kind)`、`syncSequences()`。测试自己再起的子进程用 `FORWARDX_TEST_DB_CONFIG` 连同一个库。

## 二、结果

| 范围 | SQLite | PostgreSQL |
|---|---|---|
| 走共用跑法的 43 个文件，251 项 | 251 通过 | 250 通过，1 项按库跳过（读 SQLite 查询计划）；另有 1 项 SQLite 专用（触发器里调挂在 SQLite 句柄上的函数）按库跳过 |
| 多实例租约（抢 / 续 / 过期接手 / 并发只有一个成功 / 待办覆盖写与取走） | — | 通过 |
| 原版 ForwardX PostgreSQL 库迁到 NEX | — | 通过 |
| 并发不超售（5 个独立进程抢 2 份、4 个进程抢最后 1 份、4 个账号抢 1 席、同账号并发建规则） | 通过 | 通过（真正跨进程，走 PostgreSQL 的行锁） |

一开始失败的 102 项全部出在测试脚本自己写的 SQL 上（未加引号的驼峰列、布尔写 1 / 0、`EXPLAIN QUERY PLAN`、SQLite 触发器语法、`COUNT(*)` 在 PostgreSQL 回来是字符串），产品代码没有一处因为方言出错。产品代码里读裸 `COUNT(*)` 的地方（api_tokens、安全巡检、日报、指标采集）都已经 `Number()` 过。

## 三、找到并修掉的一处方言差异

`server/referralCommission.test.ts`（邀请返利）在 PostgreSQL 上每次随机有 2～3 项失败，SQLite 上稳定。原因在建表的默认值：PostgreSQL 上 epoch 列的「当前时刻」默认写的是 `EXTRACT(EPOCH FROM NOW())::INT`，numeric 转 INT 是四舍五入，半数情况下建行时刻比应用自己算的 `Math.floor(Date.now() / 1000)` 大 1 秒；SQLite 的 `unixepoch()`、MySQL 的 `UNIX_TIMESTAMP()` 都是取整。于是同一秒内注册又下单的用户会被判成「下单早于绑定邀请人」而不返利；凡是拿库里 createdAt 和应用算的「现在」比大小的地方都受影响。改成 `FLOOR(EXTRACT(EPOCH FROM NOW()))::INT`（server/dbSchema.ts），启动时把老库里还是旧写法的默认值一并改掉（`repairPostgresqlEpochDefaults`，按 information_schema 里的默认值文本判断，重启不重复做）。修完 13 项连跑三遍都过。

顺带看到的：套餐购买事务里 `Promise.all` 并发发了六条关联表查询到同一条连接（billingRepository.ts 522 行一带），pg 会提示 `client.query() 在上一条还没执行完时又被调用`，pg 9 要去掉这种用法；pg 8 会排队执行，结果没问题，只是在事务里并没有省时间。可以顺手改成顺序 await 或一条带 IN 的查询。

## 四、还没覆盖的

另外 244 个测试文件各自抄了一份「连 SQLite 跑脚本」，没走共用跑法，这次没在 PostgreSQL 上跑。改成共用跑法只是把 `runtime.connectDatabase({ type: "sqlite", ... })` 那一段删掉、换成 `runInDatabase(body, { setup })`，每个文件十来行，可以分批做；做一批就在 PostgreSQL 上跑一批。
