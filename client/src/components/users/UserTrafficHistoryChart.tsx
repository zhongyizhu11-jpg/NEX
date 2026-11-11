import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";

import { formatBytes } from "@shared/formatBytes";

/*
  「流量历史」里每天上传 / 下载的柱状图。单独一个模块、由对话框懒加载，recharts 只在打开时才下载。
  入站 = 客户端发给目标的字节（上传），出站 = 目标回给客户端的（下载），和仪表盘「流量走势」同一口径。
*/
export default function UserTrafficHistoryChart({ days }: { days: Array<{ day: string; bytesIn: number; bytesOut: number }> }) {
  return (
    <div className="h-[220px] w-full" data-testid="user-traffic-history-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={days} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--fx-stroke-weak)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={(value: string) => value.slice(5)} tick={{ fontSize: 10 }} minTickGap={12} />
          <YAxis tickFormatter={(value: number) => formatBytes(value)} tick={{ fontSize: 10 }} width={64} />
          <RTooltip formatter={(value, name) => [formatBytes(Number(value)), name === "bytesIn" ? "上传（入站）" : "下载（出站）"]} />
          <Legend formatter={(value) => (value === "bytesIn" ? "上传（入站）" : "下载（出站）")} wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="bytesIn" stackId="traffic" fill="var(--fx-chart-1)" isAnimationActive={false} />
          <Bar dataKey="bytesOut" stackId="traffic" fill="var(--fx-chart-5)" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
