import { useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import { parseDatabaseHealth, type DatabaseHealth } from "@shared/databaseHealth";
import { Button } from "@/components/ui/button";
import { mobileAuth } from "@/lib/mobileAuth";

export const DATABASE_HEALTH_QUERY_KEY = "database-health";

/** 故障期间多久查一次恢复。正常时不轮询：业务请求一旦拿到 503，main.tsx 会马上触发一次检查。 */
export const DATABASE_HEALTH_RETRY_MS = 5_000;

const DATABASE_LABELS: Record<NonNullable<DatabaseHealth["databaseType"]>, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
};

function formatTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 「数据库暂时不可用」页（上游 v2.3.281）。只显示服务端白名单里的错误码和说明 ——
 * 没有登录框、没有安装向导入口，也不会出现数据库密码和连接串。
 */
export function DatabaseUnavailableView({ health, checking, onRetry }: {
  health: DatabaseHealth;
  checking: boolean;
  onRetry: () => void;
}) {
  const since = formatTime(health.unavailableSince);
  const checkedAt = formatTime(health.checkedAt);
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <section role="alert" aria-live="polite" className="w-full max-w-xl rounded-xl border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg bg-[var(--fx-down-soft)] p-2.5 text-[var(--fx-down-text)]" aria-hidden="true">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">数据库暂时不可用</h1>
            <p className="mt-1 text-sm text-muted-foreground">面板 Web 服务仍在运行，需要数据库的功能和后台任务已暂停，数据库恢复后自动继续。</p>
          </div>
        </div>

        <dl className="mt-5 divide-y rounded-lg border bg-muted/30 text-sm">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground">数据库</dt>
            <dd className="inline-flex items-center gap-1.5 font-medium"><Database className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{health.databaseType ? DATABASE_LABELS[health.databaseType] : "数据库"}</dd>
          </div>
          <div className="space-y-1.5 px-4 py-2.5">
            <dt className="text-muted-foreground">异常原因</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="break-words font-medium">{health.reason?.message || "数据库服务暂时无法访问"}</span>
              {health.reason?.code ? <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{health.reason.code}</code> : null}
            </dd>
          </div>
          <div className="space-y-1.5 px-4 py-2.5">
            <dt className="text-muted-foreground">处理建议</dt>
            <dd className="leading-6">{health.reason?.suggestion || "请联系管理员检查数据库服务和面板日志。"}</dd>
          </div>
          {since || checkedAt ? (
            <div className="grid gap-1 px-4 py-2.5 text-xs text-muted-foreground sm:grid-cols-2">
              {since ? <p><span>异常开始：</span><time dateTime={health.unavailableSince || undefined} className="tabular-nums">{since}</time></p> : null}
              {checkedAt ? <p><span>最近检查：</span><time dateTime={health.checkedAt || undefined} className="tabular-nums">{checkedAt}</time></p> : null}
            </div>
          ) : null}
        </dl>

        {health.restartRequired ? (
          <p className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--fx-warn)_40%,transparent)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
            连接类故障恢复后面板会自动重试初始化；如果是数据库结构、配置或存储错误，请按日志修正后重启面板。
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="button" onClick={onRetry} disabled={checking} className="sm:w-auto">
            <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden="true" />
            {checking ? "检查中…" : "重新检查"}
          </Button>
          <p className="text-xs text-muted-foreground">每 5 秒自动检查一次，恢复后回到原页面；不会清除你的登录状态。</p>
        </div>

        <p className="mt-5 border-t pt-4 text-xs leading-5 text-muted-foreground">
          管理员可以查看面板日志：本机部署用 journalctl -u forwardx-panel，Docker 部署用 docker logs forwardx-panel。这里只显示错误类型，不显示数据库密码和连接串。
        </p>
      </section>
    </main>
  );
}

async function fetchDatabaseHealth(panelUrl: string, signal: AbortSignal): Promise<DatabaseHealth | null> {
  const timeout = AbortSignal.timeout(5_000);
  const combined = typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
  const response = await fetch(`${panelUrl}/api/database-health`, { signal: combined, cache: "no-store", credentials: "include" });
  // 老面板没有这个接口：没有健康信息，照常走原来的启动流程。
  if (!response.ok) return null;
  return parseDatabaseHealth(await response.json().catch(() => null));
}

/**
 * 包在 SetupGate 外面：数据库不可用时整页换成故障页，恢复后自动回到原来的页面。
 *
 * 不在首屏等它：健康检查和页面自己的请求并行发出去，只有确认 unavailable 才挡住。
 * 原来上游的写法是先等这个接口回来再渲染页面，正常情况下首屏平白多一个来回。
 */
export default function DatabaseHealthGate({ children }: { children: ReactNode }) {
  useLocation(); // App 里改了面板地址之后重新读一遍。
  const queryClient = useQueryClient();
  const panelUrl = mobileAuth.isNative ? mobileAuth.getPanelUrl() : "";
  const health = useQuery<DatabaseHealth | null>({
    queryKey: [DATABASE_HEALTH_QUERY_KEY, panelUrl],
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    queryFn: ({ signal }) => fetchDatabaseHealth(panelUrl, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data?.state === "unavailable" ? DATABASE_HEALTH_RETRY_MS : false,
  });
  const state = health.data?.state;
  const previous = useRef(state);
  useEffect(() => {
    // 只在「故障 → 恢复」那一下把别的查询全部重取一遍（登录态、账号状态照常重新校验）；
    // 首次打开页面时健康检查返回 healthy 不触发，免得每次打开都把首屏数据再拉一遍。
    if (previous.current === "unavailable" && state && state !== "unavailable") {
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== DATABASE_HEALTH_QUERY_KEY });
    }
    previous.current = state;
  }, [state, queryClient]);

  if (state === "unavailable" && health.data) {
    return <DatabaseUnavailableView health={health.data} checking={health.isFetching} onRetry={() => { void health.refetch(); }} />;
  }
  return <>{children}</>;
}
