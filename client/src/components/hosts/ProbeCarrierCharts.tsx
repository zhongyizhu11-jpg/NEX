import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

/*
  三网视图的折线图（单机三条线 / 双机两条线）。单独一个模块、由 ProbeCarrierView 懒加载：
  recharts 只在真的要画图时才下载（见 components/charts/lazyCharts.test.ts）。
*/

export type CarrierChartLine = { key: string; label: string; color: string; dashed?: boolean };
export type CarrierChartPoint = { t: number } & Record<string, number | null>;

function timeLabel(sec: number) {
  const date = new Date(sec * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 量程：按 P95 定顶，偶尔一个尖峰不会把其余的线压成一条贴底的直线（尖峰仍画出来，只是出框）。 */
function p95Max(data: CarrierChartPoint[], lines: CarrierChartLine[]) {
  const values = data.flatMap((point) => lines.map((line) => point[line.key])).filter((value): value is number => typeof value === "number" && value > 0).sort((a, b) => a - b);
  if (values.length === 0) return 100;
  const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
  return Math.max(10, Math.ceil((p95 * 1.2) / 10) * 10);
}

export default function ProbeCarrierChart({ data, lines, height = 220 }: { data: CarrierChartPoint[]; lines: CarrierChartLine[]; height?: number }) {
  const yMax = p95Max(data, lines);
  return (
    <div style={{ height }} className="w-full" data-testid="carrier-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--fx-stroke-weak)" />
          <XAxis dataKey="t" tickFormatter={timeLabel} tick={{ fontSize: 10 }} minTickGap={36} />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `${value}ms`} width={52} domain={[0, yMax]} allowDataOverflow allowDecimals={false} />
          <RTooltip
            labelFormatter={(value) => timeLabel(Number(value))}
            formatter={(value, name) => [value === null || value === undefined ? "无样本" : `${value} ms`, lines.find((line) => line.key === name)?.label || String(name)]}
          />
          <Legend formatter={(value) => lines.find((line) => line.key === value)?.label || value} wrapperStyle={{ fontSize: 11 }} />
          {lines.map((line) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              stroke={line.color}
              strokeWidth={1.6}
              strokeDasharray={line.dashed ? "5 3" : undefined}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
