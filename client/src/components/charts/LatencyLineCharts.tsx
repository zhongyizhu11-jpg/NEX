import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

/*
  隧道、组延迟弹窗里的曲线。单独一个文件、由页面 lazy 引入：recharts 有一百多 KB（gzip），
  以前跟着隧道页一起下载，现在点开延迟弹窗才取。外面的容器高度是固定的，加载时放占位，不跳版。
*/

export type TunnelLatencySeriesMeta = {
  key: string;
  dataKey: string;
  rawKey: string;
  timeoutKey: string;
  label: string;
  color: string;
};

export function TunnelLatencyLineChart({
  chartData,
  seriesMeta,
  yMax,
  yTicks,
  animate,
}: {
  chartData: any[];
  seriesMeta: TunnelLatencySeriesMeta[];
  yMax: number;
  yTicks: number[];
  animate: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={60} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}ms`} width={50} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
        <RTooltip
          cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
          offset={12}
          wrapperStyle={{ pointerEvents: "none" }}
          content={({ active, payload }: any) => {
            if (!active || !payload?.length) return null;
            const item = payload[0].payload;
            return (
              <div className="min-w-40 rounded-lg border border-border bg-card px-3 py-2 shadow-md">
                <p className="mb-2 text-xs text-muted-foreground">{item.fullLabel}</p>
                <div className="space-y-1">
                  {seriesMeta.map((meta) => {
                    const hasValue = item[meta.rawKey] !== undefined || item[meta.timeoutKey] !== undefined;
                    if (!hasValue) return null;
                    const timeout = !!item[meta.timeoutKey];
                    return (
                      <div key={meta.key} className="flex items-center justify-between gap-4 text-xs">
                        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: timeout ? "var(--color-destructive)" : meta.color }} />
                          <span className="truncate">{meta.label}</span>
                        </span>
                        <span className="text-right">
                          <span className={timeout ? "font-semibold text-destructive" : "font-semibold tabular-nums"}>
                            {timeout ? "超时" : `${Number(item[meta.rawKey] || 0)}ms`}
                          </span>
                          {Number(item[`${meta.key}ProbeCount`]) > 1 && Number(item[`${meta.key}ProbeSuccesses`]) < Number(item[`${meta.key}ProbeCount`]) ? (
                            <span className="block text-[10px] font-normal text-muted-foreground">
                              丢包 {Number(item[`${meta.key}ProbeCount`]) - Number(item[`${meta.key}ProbeSuccesses`])}/{Number(item[`${meta.key}ProbeCount`])}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }}
        />
        {seriesMeta.map((meta) => (
          <Line
            key={meta.key}
            type="monotone"
            dataKey={meta.dataKey}
            stroke={meta.color}
            strokeWidth={meta.key === "total" ? 1.8 : 1.35}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={(props: any) => props?.payload?.[meta.timeoutKey] ? (
              <circle cx={props.cx} cy={props.cy} r={3} fill="var(--color-destructive)" stroke="var(--color-background)" strokeWidth={1.5} />
            ) : (
              <circle cx={props.cx} cy={props.cy} r={0} fill="transparent" />
            )}
            activeDot={{ r: 4, fill: meta.color, stroke: "var(--color-background)", strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={animate}
            animationDuration={animate ? 500 : 0}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export type GroupLatencyPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
  probeCount?: number;
  probeSuccesses?: number;
  atMs?: number;
};

export function GroupLatencyAreaChart({
  chartData,
  yMax,
  yTicks,
  animate,
}: {
  chartData: GroupLatencyPoint[];
  yMax: number;
  yTicks: number[];
  animate: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="forwardGroupLatencyGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.38} />
            <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.35} />
        <XAxis dataKey="label" stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} width={42} domain={[0, yMax]} ticks={yTicks} tickFormatter={(value) => `${value}ms`} />
        <RTooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const item = payload[0].payload as GroupLatencyPoint;
            return (
              <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                <p className="font-medium">{item.fullLabel}</p>
                <p className={item.isTimeout ? "text-destructive" : "text-foreground"}>
                  {item.isTimeout ? "\u8d85\u65f6/\u4e0d\u53ef\u8fbe" : `${item.latency}ms`}
                </p>
                {Number(item.probeCount) > 1 && Number(item.probeSuccesses) < Number(item.probeCount) ? (
                  <p className="text-muted-foreground">
                    丢包 {Number(item.probeCount) - Number(item.probeSuccesses)}/{Number(item.probeCount)}（{(((Number(item.probeCount) - Number(item.probeSuccesses)) / Number(item.probeCount)) * 100).toFixed(0)}%）
                  </p>
                ) : null}
              </div>
            );
          }}
        />
        <Area type="monotone" dataKey="chartLatency" stroke="var(--color-chart-2)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="url(#forwardGroupLatencyGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} isAnimationActive={animate} animationDuration={animate ? 500 : 0} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
