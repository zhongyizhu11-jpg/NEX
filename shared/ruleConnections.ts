/*
  规则的「连接」页签：按需从入口机的 Agent 拉这条规则此刻的连接清单。

  Open-Box 的连接页能看每条连接走哪条线路；NEX 原来只有「连接数」一个数字（而且是累计
  新建数）。排障时要的是「此刻谁连着、连到哪、跑了多少」—— 这个只能现场去机器上看，所以
  做成按需任务：面板排一个任务，下一次心跳带下去，Agent 读 /proc/net/tcp（用户态转发）或
  nf_conntrack（DNAT、UDP）回一份清单，最多 200 行。

  Agent 2.2.237 起。
*/

export const RULE_CONNECTIONS_AGENT_VERSION = "2.2.237";
export const RULE_CONNECTIONS_MAX_ROWS = 200;

export type RuleConnectionRow = {
  protocol: "tcp" | "udp";
  /** 客户端地址 ip:port */
  peer: string;
  /** 本机这边 ip:port（DNAT 规则是转发前的目标地址） */
  local: string;
  /** 这条连接到目前为止的字节数（有 ss / conntrack 计数时才有） */
  bytesIn?: number;
  bytesOut?: number;
  /** TCP 的状态（ESTABLISHED 等）；conntrack 来的 UDP 没有 */
  state?: string;
};

export type RuleConnectionsSnapshot = {
  taskId: string;
  rows: RuleConnectionRow[];
  /** 全部有多少条（rows 可能截断） */
  total: number;
  truncated: boolean;
  /** 从哪里读的：proc / conntrack / ss */
  source: string;
  error?: string;
  at: number;
};
