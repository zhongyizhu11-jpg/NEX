import { getProxyNodeById } from "./repositories/proxySubscriptionRepository";

/*
  线路组的落地和订阅节点「凭据一不一样」（2026-11 用户要求：保存时提醒）。

  订阅里的节点是这条转发绑定的那个（forward_rules.proxyNodeId）：客户端拿它的协议、密码 / UUID 去连入口。
  线路切到另一个落地时，入口把流量原样转过去 —— 那个落地要认同一套凭据才连得上，不然切过去订阅就断了。

    · 线路的落地留空（= 规则自己的目标，也就是绑定的节点）、或者选的就是这个节点：没问题
    · 落地池（池节点）：池里每台成员的入站凭据逐字相同；选的池和绑定的节点凭据一样就没问题
    · 选了别的节点：比协议和凭据字段，不一样就提醒
    · 手填的地址（不是节点）：面板不知道那台上开的是什么，提醒「没法确认」

  只读凭据做比较，返回里不带任何凭据内容。看不到的节点（别人的、没分享给他的）按「没法确认」算。
*/

type NodeRow = {
  id: number;
  userId?: number | null;
  name?: string | null;
  protocol?: string | null;
  address?: string | null;
  port?: number | null;
  uuid?: string | null;
  password?: string | null;
  method?: string | null;
  flow?: string | null;
  transport?: string | null;
  path?: string | null;
  host?: string | null;
  tls?: boolean | number | null;
  sni?: string | null;
  realityPublicKey?: string | null;
  realityShortId?: string | null;
  nodePoolId?: number | null;
};

export type RouteLandingCredentialLine = {
  name?: string;
  dests: Array<{ dest?: { ip: string; port: number } | null; destNodeId?: number | null }>;
};

export type RouteLandingCredentialIssue = {
  line: string;
  landing: string;
  reason: "credential" | "unknown";
};

const CREDENTIAL_FIELDS = ["protocol", "uuid", "password", "method", "flow", "transport", "path", "host", "sni", "realityPublicKey", "realityShortId"] as const;

function text(value: unknown) {
  return String(value ?? "").trim();
}

/** 客户端连得上要一样的那几样：协议、UUID / 密码、加密方式、传输和 TLS / Reality 参数。地址端口不算（每个落地本来就不一样）。 */
export function sameNodeCredential(left: NodeRow, right: NodeRow) {
  if (!!left.tls !== !!right.tls) return false;
  return CREDENTIAL_FIELDS.every((field) => text(left[field]).toLowerCase() === text(right[field]).toLowerCase()
    || (field !== "protocol" && text(left[field]) === text(right[field])));
}

export function routeLandingCredentialIssues(input: {
  boundNode: NodeRow | null;
  lines: readonly RouteLandingCredentialLine[];
  nodesById: ReadonlyMap<number, NodeRow>;
}): RouteLandingCredentialIssue[] {
  const bound = input.boundNode;
  if (!bound) return [];
  const issues: RouteLandingCredentialIssue[] = [];
  const seen = new Set<string>();
  input.lines.forEach((line, lineIndex) => {
    const lineName = text(line.name) || (lineIndex === 0 ? "主线路" : `备用 ${lineIndex}`);
    for (const item of line.dests || []) {
      const nodeId = Number(item?.destNodeId || 0);
      let issue: RouteLandingCredentialIssue | null = null;
      if (nodeId > 0) {
        if (nodeId === Number(bound.id)) continue;
        const node = input.nodesById.get(nodeId);
        if (!node) issue = { line: lineName, landing: `节点 #${nodeId}`, reason: "unknown" };
        else if (!sameNodeCredential(node, bound)) issue = { line: lineName, landing: text(node.name) || `节点 #${nodeId}`, reason: "credential" };
      } else if (item?.dest && text(item.dest.ip)) {
        const sameAsBound = text(item.dest.ip).toLowerCase() === text(bound.address).toLowerCase() && Number(item.dest.port) === Number(bound.port);
        if (!sameAsBound) issue = { line: lineName, landing: `${text(item.dest.ip)}:${Number(item.dest.port)}`, reason: "unknown" };
      }
      if (!issue) continue;
      const key = `${issue.line}|${issue.landing}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  });
  return issues;
}

/** 保存前查一遍：绑定的节点、线路里选的节点都按这个人看得见的读（管理员都看得见）。 */
export async function checkRouteLandingCredentials(input: {
  user: { id: number; role?: string | null };
  proxyNodeId: number | null | undefined;
  lines: readonly RouteLandingCredentialLine[];
}) {
  const boundId = Number(input.proxyNodeId || 0);
  if (boundId <= 0) return [];
  const visible = (node: NodeRow | undefined) => !!node && (input.user.role === "admin" || Number(node.userId) === Number(input.user.id));
  const bound = await getProxyNodeById(boundId) as NodeRow | undefined;
  if (!visible(bound)) return [];
  const ids = Array.from(new Set(input.lines.flatMap((line) => (line.dests || []).map((item) => Number(item?.destNodeId || 0))).filter((id) => id > 0 && id !== boundId)));
  const nodesById = new Map<number, NodeRow>();
  for (const id of ids.slice(0, 64)) {
    const node = await getProxyNodeById(id) as NodeRow | undefined;
    if (visible(node)) nodesById.set(id, node as NodeRow);
  }
  return routeLandingCredentialIssues({ boundNode: bound as NodeRow, lines: input.lines, nodesById });
}
