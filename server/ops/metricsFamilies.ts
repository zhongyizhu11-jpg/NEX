/*
  把一份快照（主机、规则、线路此刻的数，见 server/ops/metricsCollect.ts）变成 nex_ 开头的指标族。
  纯函数、不碰库：指标的名字、标签、单位和「什么时候不导出」全在这一个文件里，测试直接喂快照。

  ── 命名 ──
  照 Prometheus 的习惯用基本单位：时间是秒（_seconds）、比例是 0–1（_ratio）、流量是字节（_bytes）；
  累计值是 counter、名字以 _total 结尾，其余都是 gauge。面板界面上是毫秒和百分比，这里除过了。

  ── 「不知道」就不导出 ──
  没读到的数不拿 0 顶：离线主机没有 CPU / 内存序列，没探测过的规则没有延迟序列。
  累计字节是 0 的也不导出 —— 底下的批量查询失败时会按 0 返回，把 0 报出去 Prometheus 会当成计数器
  清零，等查询恢复、数字跳回去，rate() 就凭空多出一大截。序列缺一会儿没事，回来的数比之前大就不算清零；
  真清过零的（重置流量）回来的数比之前小，照常被认成清零。

  ── 规则太多时 ──
  每条规则是 8 条左右的序列。规则数超过上限（设置里可调）就不逐条导出，只留全站汇总；
  线路组单独数：规则超了、线路组没超，线路明细照样有。nex_metrics_detail 说明此刻是哪种。
*/
import type { MetricFamily, MetricLabels, MetricType } from "./metricsText";

export type MetricsHostSample = {
  id: number;
  name: string;
  online: boolean;
  /** 距上次心跳的秒数；从没心跳过是 null。 */
  heartbeatAgeSeconds: number | null;
  agentVersion: string;
  /** 0–100，和面板上一样；离线或没报是 null。 */
  cpuPct: number | null;
  memoryPct: number | null;
  diskPct: number | null;
  loadPct: number | null;
  tcpConnections: number | null;
  udpConnections: number | null;
  /** 累计字节（host_traffic_counters）。 */
  trafficIn: number | null;
  trafficOut: number | null;
};

export type MetricsRuleSample = {
  id: number;
  name: string;
  hostName: string;
  enabled: boolean;
  running: boolean;
  trafficIn: number | null;
  trafficOut: number | null;
  connectionsTotal: number | null;
  /** 字节/秒；90 秒内没有上报是 null。 */
  rateIn: number | null;
  rateOut: number | null;
  probeLatencyMs: number | null;
  /** 最近一次探测是不是超时；没探测过（或太旧）是 null。 */
  probeTimeout: boolean | null;
};

export type MetricsRoutePathSample = {
  key: string;
  name: string;
  score: number | null;
  /** 整条链路的延迟（入口段 + 各中转段），毫秒。 */
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  availabilityPct: number | null;
  active: boolean;
  down: boolean;
};

export type MetricsRouteSample = {
  ruleId: number;
  ruleName: string;
  hostName: string;
  paths: MetricsRoutePathSample[];
  /** 近 24 小时切了几次；没查到是 null。 */
  switches24h: number | null;
};

export type MetricsSnapshot = {
  panel: { version: string; databaseKind: string; databaseUp: boolean };
  /** null = 这一轮没读到（数据库不可用），整段不导出。 */
  hosts: MetricsHostSample[] | null;
  ruleCounts: { total: number; enabled: number; running: number } | null;
  /** null = 超过上限或没读到。 */
  rules: MetricsRuleSample[] | null;
  routes: MetricsRouteSample[] | null;
  /** 全站转发流量，面板启动以来只增不减（见 MonotonicTotal）。 */
  traffic: { in: number; out: number } | null;
  collectSeconds: number;
};

/**
 * 把一个「会被清零、会变小」的累计读数，变成只增不减的总数。
 *
 * 全站流量是所有用户的累计加起来的：重置一个用户的流量，总和就掉下去一块。Prometheus 看到 counter 变小
 * 会当成「清零后又涨到这么多」，rate() 上就是一根和全站累计一样高的尖刺。所以这里只把每一轮的**增量**
 * 往上加：读数变小的那一轮不加、从新读数重新起算。
 *
 * 从 0 起算而不是从当前读数起算：面板重启后这个数回到 0，Prometheus 认得这是一次清零、增量按 0 算；
 * 要是从当前读数起算，重启前后只要读数比之前小过，同样会被当成清零再涨回来。
 * 读数是 0 而之前不是 0：多半是这一轮查询失败（底下按 0 返回），当作没读到。
 */
export class MonotonicTotal {
  private previous: number | null = null;
  private total = 0;

  observe(reading: number | null | undefined): number | null {
    const current = typeof reading === "number" && Number.isFinite(reading) && reading >= 0 ? reading : null;
    if (current === null) return this.previous === null ? null : this.total;
    if (this.previous === null) {
      this.previous = current;
      return this.total;
    }
    if (current >= this.previous) {
      this.total += current - this.previous;
      this.previous = current;
    } else if (current > 0) {
      this.previous = current;
    }
    return this.total;
  }
}

function family(name: string, type: MetricType, help: string): MetricFamily {
  return { name, type, help, samples: [] };
}

function add(target: MetricFamily, labels: MetricLabels, value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target.samples.push({ labels, value });
}

const flag = (value: boolean) => (value ? 1 : 0);
const ratio = (pct: number | null) => (pct === null ? null : Math.max(0, Math.min(100, pct)) / 100);
const seconds = (ms: number | null) => (ms === null ? null : Math.max(0, ms) / 1000);
/** 累计值是 0 就当没有，见文件头。 */
const counter = (value: number | null) => (value !== null && value > 0 ? value : null);

export function buildMetricFamilies(snapshot: MetricsSnapshot): MetricFamily[] {
  const families: MetricFamily[] = [];
  const push = (item: MetricFamily) => {
    families.push(item);
    return item;
  };
  const single = (name: string, type: MetricType, help: string, value: number | null | undefined, labels: MetricLabels = {}) => {
    add(push(family(name, type, help)), labels, value);
  };

  // ── 面板 ──
  single("nex_panel_info", "gauge", "面板版本和数据库类型，值恒为 1", 1, {
    version: snapshot.panel.version,
    database: snapshot.panel.databaseKind,
  });
  single("nex_database_up", "gauge", "面板数据库是否正常（1 正常，0 不可用）", flag(snapshot.panel.databaseUp));
  if (snapshot.hosts) {
    single("nex_hosts", "gauge", "主机总数", snapshot.hosts.length);
    single("nex_hosts_online", "gauge", "在线主机数", snapshot.hosts.filter((host) => host.online).length);
  }
  if (snapshot.ruleCounts) {
    single("nex_rules", "gauge", "转发规则总数（转发组的一条规则算一条，不含待删除的）", snapshot.ruleCounts.total);
    single("nex_rules_enabled", "gauge", "启用的转发规则数", snapshot.ruleCounts.enabled);
    single("nex_rules_running", "gauge", "正在运行的转发规则数", snapshot.ruleCounts.running);
  }
  if (snapshot.traffic) {
    const traffic = push(family("nex_traffic_bytes_total", "counter", "全站转发流量累计字节，面板启动后从 0 起算、只增不减"));
    add(traffic, { direction: "in" }, snapshot.traffic.in);
    add(traffic, { direction: "out" }, snapshot.traffic.out);
  }
  const detail = push(family("nex_metrics_detail", "gauge", "这一类明细此刻是否逐条导出（0 = 超过上限或没读到，只有汇总）"));
  add(detail, { scope: "rule" }, flag(!!snapshot.rules));
  add(detail, { scope: "route" }, flag(!!snapshot.routes));
  single("nex_metrics_collect_duration_seconds", "gauge", "生成这份指标花的时间", snapshot.collectSeconds);

  // ── 主机 ──
  if (snapshot.hosts) {
    const online = push(family("nex_host_online", "gauge", "主机是否在线"));
    const heartbeat = push(family("nex_host_heartbeat_age_seconds", "gauge", "距上次心跳的秒数（生成指标那一刻算的）"));
    const cpu = push(family("nex_host_cpu_usage_ratio", "gauge", "CPU 使用率（0–1），离线主机不导出"));
    const memory = push(family("nex_host_memory_usage_ratio", "gauge", "内存使用率（0–1），离线主机不导出"));
    const disk = push(family("nex_host_disk_usage_ratio", "gauge", "磁盘使用率（0–1），离线主机不导出"));
    const load = push(family("nex_host_load_ratio", "gauge", "主机负载（0–1）：CPU 和带宽占用里高的那个，和线路调度用的是同一个数"));
    const connections = push(family("nex_host_connections", "gauge", "主机此刻的连接数，离线主机不导出"));
    const traffic = push(family("nex_host_traffic_bytes_total", "counter", "主机累计流量字节（重置主机流量后清零）"));
    const agent = push(family("nex_host_agent_info", "gauge", "主机上的 Agent 版本，值恒为 1"));
    for (const host of snapshot.hosts) {
      const labels = { host_id: host.id, host: host.name };
      add(online, labels, flag(host.online));
      add(heartbeat, labels, host.heartbeatAgeSeconds);
      add(cpu, labels, ratio(host.cpuPct));
      add(memory, labels, ratio(host.memoryPct));
      add(disk, labels, ratio(host.diskPct));
      add(load, labels, ratio(host.loadPct));
      add(connections, { ...labels, protocol: "tcp" }, host.tcpConnections);
      add(connections, { ...labels, protocol: "udp" }, host.udpConnections);
      add(traffic, { ...labels, direction: "in" }, counter(host.trafficIn));
      add(traffic, { ...labels, direction: "out" }, counter(host.trafficOut));
      if (host.agentVersion) add(agent, { ...labels, version: host.agentVersion }, 1);
    }
  }

  // ── 规则 ──
  if (snapshot.rules) {
    const enabled = push(family("nex_rule_enabled", "gauge", "规则是否启用"));
    const running = push(family("nex_rule_running", "gauge", "规则是否在运行"));
    const traffic = push(family("nex_rule_traffic_bytes_total", "counter", "规则累计流量字节（重置规则流量后清零；还没有流量的规则不导出）"));
    const connections = push(family("nex_rule_connections_total", "counter", "规则累计连接数"));
    const rate = push(family("nex_rule_rate_bytes_per_second", "gauge", "规则此刻的速率（字节/秒），90 秒内没有流量上报的不导出"));
    const latency = push(family("nex_rule_probe_latency_seconds", "gauge", "规则最近一次探测的延迟，超时或没探测过的不导出"));
    const timeout = push(family("nex_rule_probe_timeout", "gauge", "规则最近一次探测是否超时"));
    for (const rule of snapshot.rules) {
      const labels = { rule_id: rule.id, rule: rule.name, host: rule.hostName };
      add(enabled, labels, flag(rule.enabled));
      add(running, labels, flag(rule.running));
      add(traffic, { ...labels, direction: "in" }, counter(rule.trafficIn));
      add(traffic, { ...labels, direction: "out" }, counter(rule.trafficOut));
      add(connections, labels, counter(rule.connectionsTotal));
      add(rate, { ...labels, direction: "in" }, rule.rateIn);
      add(rate, { ...labels, direction: "out" }, rule.rateOut);
      if (rule.probeTimeout !== null) {
        add(timeout, labels, flag(rule.probeTimeout));
        if (!rule.probeTimeout) add(latency, labels, seconds(rule.probeLatencyMs));
      }
    }
  }

  // ── 线路组 ──
  if (snapshot.routes) {
    const score = push(family("nex_route_path_score", "gauge", "线路评分（0–100），还没探够样本的不导出"));
    const latency = push(family("nex_route_path_latency_seconds", "gauge", "线路整条链路的延迟（入口段加各中转段）"));
    const loss = push(family("nex_route_path_loss_ratio", "gauge", "线路丢包率（0–1）"));
    const jitter = push(family("nex_route_path_jitter_seconds", "gauge", "线路抖动"));
    const availability = push(family("nex_route_path_availability_ratio", "gauge", "线路可用率（0–1）"));
    const active = push(family("nex_route_path_active", "gauge", "这条线路此刻是否在用"));
    const down = push(family("nex_route_path_down", "gauge", "这条线路此刻是否异常（探不通、中转断了、节点离线 / 维护 / 熔断、被暂停）"));
    const switches = push(family("nex_route_switches_24h", "gauge", "规则近 24 小时的线路切换次数"));
    for (const route of snapshot.routes) {
      const ruleLabels = { rule_id: route.ruleId, rule: route.ruleName, host: route.hostName };
      add(switches, ruleLabels, route.switches24h);
      for (const path of route.paths) {
        const labels = { ...ruleLabels, path_key: path.key, path: path.name };
        add(score, labels, path.score);
        add(latency, labels, seconds(path.latencyMs));
        add(loss, labels, ratio(path.lossPct));
        add(jitter, labels, seconds(path.jitterMs));
        add(availability, labels, ratio(path.availabilityPct));
        add(active, labels, flag(path.active));
        add(down, labels, flag(path.down));
      }
    }
  }

  return families;
}
