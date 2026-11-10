# 指标导出（Prometheus / Grafana）

已经有 Prometheus 和 Grafana 的，可以把 NEX 接进去：面板在 `/metrics` 上按 Prometheus 文本格式给出主机、规则和线路组此刻的状态，再导入一份现成的 Grafana 仪表盘就能看。

- **默认关**。关着时 `/metrics` 回 404，不取任何数据。
- **只有管理员能开、能看口令**，每次开关、改上限、查看或重置口令都记进「监控 → 操作审计」。
- 只是让 Prometheus 来**拉**数据。不发告警、不往外推（没有 remote write），告警规则在你自己的 Prometheus / Alertmanager 里写。

## 打开

系统设置 → 进阶 → **指标导出**，打开开关。第一次打开时面板自动生成一个抓取口令（`nex_metrics_` 开头），下面多出三行：

| 项 | 说明 |
| --- | --- |
| 抓取口令 | 默认只显示末 4 位。眼睛图标显示完整口令，复制图标复制，旋转图标**重置**（旧口令立刻失效） |
| Prometheus 配置 | 一段可以直接抄进 `prometheus.yml` 的配置，点「复制」拿到的是带完整口令的 |
| 规则明细上限 | 规则多于这个数就不再逐条导出，见下面的[标签基数](#标签基数和上限) |

口令和别的密钥类设置一样，落库是加密的（密钥是面板的 `JWT_SECRET` / `jwt.secret`）。口令不能自己填 —— `/metrics` 一旦被猜中，全站的主机名、规则名、流量都看得到。

关掉再打开，口令不变，Prometheus 那边不用改。

## 配置 Prometheus

把设置页复制出来的那段加进 `prometheus.yml` 的 `scrape_configs`：

```yaml
scrape_configs:
  - job_name: nex
    scheme: https
    metrics_path: /metrics
    scrape_interval: 30s
    authorization:
      type: Bearer
      credentials: nex_metrics_xxxxxxxx   # 设置页里的抓取口令
    static_configs:
      - targets: ["panel.example.com"]    # 面板地址（不带 https://），非 443 / 80 端口要写上端口
```

不想把口令写在配置里，可以用 `credentials_file: /etc/prometheus/nex-token` 指向一个只有口令的文件。

要点：

- 口令只认 `Authorization: Bearer` 请求头，**不认地址里的参数**（地址会进访问日志）。
- `scrape_interval` 建议 30 秒到 1 分钟。面板把整份结果缓存 **10 秒**，抓得再勤，10 秒内也只取一次数据，不会把数据库压垮。
- 面板前面有 Nginx / Caddy 之类的反向代理时，确认 `/metrics` 这个路径转发到了面板，并且没有被去掉 `Authorization` 头。
- 开了「面板访问的地区限制」的，`/metrics` 也受它管（和网页同一套，内网地址永远放行）：Prometheus 在限制范围外时会被挡下。
- 用 `curl` 自测：
  ```bash
  curl -H "Authorization: Bearer nex_metrics_xxxxxxxx" https://panel.example.com/metrics
  ```
  返回 404 说明没开；401 说明口令不对或没带；200 就是指标正文。

## 导入 Grafana 仪表盘

仓库里有一份配套的仪表盘：`deploy/grafana/nex-overview.json`（在 GitHub 上打开这个文件，点 Raw 另存即可）。

1. Grafana → Dashboards → New → **Import**；
2. 上传这个文件（或把内容粘进去）→ Load → Import；
3. 顶上选**数据源**（你的 Prometheus）和**主机**（可多选，默认全部）；`Top N` 决定规则速率那张图画几条。

仪表盘分四组：

| 组 | 内容 |
| --- | --- |
| 总览 | 在线 / 总主机数、在跑 / 总规则数、数据库是否正常、面板版本、全站转发速率、主机在线 |
| 主机 | 每台的流量速率、CPU、内存、负载、距上次心跳 |
| 规则 | 规则速率 Top N、探测超时的规则、探测延迟 Top N |
| 线路组 | 每条路径的评分、延迟、丢包，近 24 小时切换次数，此刻异常的路径 |

## 指标一览

名字统一 `nex_` 开头，按 Prometheus 的习惯用基本单位：时间是**秒**、比例是 **0–1**、流量是**字节**。面板界面上的毫秒和百分比在这里都换算过了（界面上 38 ms 在这里是 `0.038`，62% 是 `0.62`）。

**没有数据就没有这条序列**，不拿 0 顶：离线主机没有 CPU；没探测过的规则没有延迟；没流量的规则没有累计流量。

### 面板

| 指标 | 类型 | 标签 | 含义 |
| --- | --- | --- | --- |
| `nex_panel_info` | gauge | `version` `database` | 面板版本和数据库类型，值恒为 1 |
| `nex_database_up` | gauge | | 数据库是否正常（1 / 0） |
| `nex_hosts` / `nex_hosts_online` | gauge | | 主机总数 / 在线数 |
| `nex_rules` / `nex_rules_enabled` / `nex_rules_running` | gauge | | 规则总数 / 启用数 / 在跑数（口径同规则列表：转发组算一条，中继规则不算） |
| `nex_traffic_bytes_total` | counter | `direction` | 全站转发流量累计字节（见下面的说明） |
| `nex_metrics_detail` | gauge | `scope`（`rule` / `route`） | 这一类明细此刻是否逐条导出；0 = 超过上限，只有汇总 |
| `nex_metrics_collect_duration_seconds` | gauge | | 生成这份指标花了多久 |

数据库不可用时，面板不去连库，只回 `nex_panel_info`、`nex_database_up 0` 这几项；主机、规则的序列这期间是**空的**。可以直接拿 `nex_database_up == 0` 写告警。

### 每台主机

标签：`host_id`、`host`（主机名）。

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `nex_host_online` | gauge | 是否在线 |
| `nex_host_heartbeat_age_seconds` | gauge | 距上次心跳多少秒（从没上线过的没有） |
| `nex_host_cpu_usage_ratio` / `nex_host_memory_usage_ratio` / `nex_host_disk_usage_ratio` | gauge | CPU / 内存 / 磁盘使用率，离线主机不导出 |
| `nex_host_load_ratio` | gauge | 负载：CPU 和带宽占用里高的那个，和线路调度扣分用的是同一个数 |
| `nex_host_connections` | gauge | 此刻连接数，`protocol` 区分 `tcp` / `udp` |
| `nex_host_traffic_bytes_total` | counter | 累计流量字节，`direction` 区分 `in` / `out`；重置主机流量后清零 |
| `nex_host_agent_info` | gauge | Agent 版本（`version` 标签），值恒为 1 |

### 每条规则

标签：`rule_id`、`rule`（规则名）、`host`（入口主机名）。

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `nex_rule_enabled` / `nex_rule_running` | gauge | 是否启用 / 在跑。转发组的规则只要有一台成员机在跑就算在跑 |
| `nex_rule_traffic_bytes_total` | counter | 累计流量字节（`direction`）；重置规则流量后清零 |
| `nex_rule_connections_total` | counter | 累计连接数 |
| `nex_rule_rate_bytes_per_second` | gauge | 此刻速率（`direction`）；90 秒内没有流量上报的不导出 |
| `nex_rule_probe_latency_seconds` | gauge | 最近一次探测的延迟；超时的不导出 |
| `nex_rule_probe_timeout` | gauge | 最近一次探测是否超时；超过 30 分钟没探测的不导出 |

### 每条线路组的每条路径

标签：`rule_id`、`rule`、`host`、`path_key`（路径的固定标识，改名不变）、`path`（路径名）。

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `nex_route_path_score` | gauge | 评分 0–100（还没探够样本的不导出） |
| `nex_route_path_latency_seconds` | gauge | 整条链路的延迟：入口段加各中转段 |
| `nex_route_path_loss_ratio` / `nex_route_path_jitter_seconds` / `nex_route_path_availability_ratio` | gauge | 丢包率 / 抖动 / 可用率 |
| `nex_route_path_active` | gauge | 此刻是否在用 |
| `nex_route_path_down` | gauge | 此刻是否异常：探不通、中转断了、节点离线 / 维护 / 熔断、被暂停 |
| `nex_route_switches_24h` | gauge | 这条规则近 24 小时切了几次线路（只有规则标签，没有路径标签） |

评分、延迟这些和线路详情里看到的是同一份数据（入口 Agent 随心跳报上来的），10 分钟没有新上报就不再导出。

### 累计值要注意的

- `_total` 结尾的是 counter，画图用 `rate()` / `increase()`，不要直接画原值。
- **重置流量会让 counter 清零**，Prometheus 的 `rate()` 认得这种清零，不会出现负数。
- `nex_traffic_bytes_total`（全站）不一样：它是**面板启动后从 0 起算、只增不减**的，有用户被重置流量时也不往回掉。所以它的原值不等于面板首页上的「累计流量」，只拿来算速率和区间增量。面板重启后它回到 0，Prometheus 同样认得。

## 标签基数和上限

Prometheus 的开销主要看「一共多少条序列」：

| 来源 | 每个多少条 |
| --- | --- |
| 每台主机 | 约 11 条 |
| 每条规则 | 约 9 条 |
| 每条线路组路径 | 7 条（每条线路组规则另加 1 条切换次数） |

所以 100 台主机、500 条规则、50 条线路组（每条 3 条路径）大约是 1100 + 4500 + 1100 ≈ 6700 条，对 Prometheus 来说很轻。

**规则明细上限**（默认 500，最大 2000）：规则数超过它时，`nex_rule_*` 整组不导出，只留 `nex_rules`、`nex_traffic_bytes_total` 这些汇总；线路组单独数，线路组规则没超过上限时线路明细照常给，也超了就一起收起。此刻是哪种看 `nex_metrics_detail`。填 0 = 永远只导出汇总。

另外几件会让序列变多的事：

- **改名会产生新序列**：标签里带主机名、规则名、路径名，改名后旧名字那条序列停在原处、新名字从头开始。仪表盘里按 `host_id` / `rule_id` 查不受影响。
- 名字超过 120 个字符的会截断。
- 删掉的主机和规则下一轮就不再导出，Prometheus 按自己的规则把它们当成过期。

## 查库开销

一轮取数大约二三十条查询，**和规则数、主机数无关**：主机、规则、流量、探测延迟、切换次数都是面板页面本来就在用的批量查询，评分、速率、负载直接读内存，没有「每条规则查一次」。再加上 10 秒的缓存，开着它对面板的负担可以忽略。
