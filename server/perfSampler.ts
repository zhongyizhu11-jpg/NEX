import fs from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { enableStatementFingerprints, takeDatabaseStatementStats } from "./dbStatementStats";

/*
  压测采样（只在设置了 FORWARDX_PERF_SAMPLE_FILE 时打开，平时什么也不做）。

  每隔 FORWARDX_PERF_SAMPLE_INTERVAL_MS（默认 5 秒）往文件里追加一行 JSON：
    - 进程 CPU（用户态 / 内核态，微秒增量）、RSS、堆；
    - 事件循环延迟（monitorEventLoopDelay 的 p50 / p99 / max，毫秒）和事件循环占用率；
    - 这段时间里数据库读 / 写 / 其它语句的条数和耗时，以及跑得最多的语句（按指纹归并）。
  monoUs 是单调时钟（和 --cpu-prof 生成的 .cpuprofile 里的时间同一个时钟），
  scripts/bench/heartbeat-load.mjs 用它把 CPU 剖析截到压测的时间窗口里。

  另外收到 SIGUSR2 时正常退出（process.exit），这样 node --cpu-prof 能把剖析文件写出来。
  压测脚本：scripts/bench/heartbeat-load.mjs。
*/

export function startPerfSamplerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const file = String(env.FORWARDX_PERF_SAMPLE_FILE || "").trim();
  if (!file) return false;
  const intervalMs = Math.max(1000, Number(env.FORWARDX_PERF_SAMPLE_INTERVAL_MS) || 5000);
  enableStatementFingerprints(true);
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let lastCpu = process.cpuUsage();
  let lastElu = performance.eventLoopUtilization();
  let lastAt = Date.now();
  const write = (line: Record<string, unknown>) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch {
      // 采样文件写不了不影响面板
    }
  };
  write({ type: "start", ts: Date.now(), monoUs: Number(process.hrtime.bigint() / 1000n), pid: process.pid });
  const timer = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const elu = performance.eventLoopUtilization(lastElu);
    const memory = process.memoryUsage();
    const ms = (nanoseconds: number) => Math.round((nanoseconds / 1e6) * 100) / 100;
    write({
      type: "sample",
      ts: now,
      monoUs: Number(process.hrtime.bigint() / 1000n),
      intervalMs: now - lastAt,
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      eventLoop: {
        p50: ms(histogram.percentile(50)),
        p99: ms(histogram.percentile(99)),
        max: ms(histogram.max),
        mean: ms(histogram.mean),
        utilization: Math.round(elu.utilization * 1000) / 1000,
      },
      db: takeDatabaseStatementStats(25),
    });
    histogram.reset();
    lastCpu = process.cpuUsage();
    lastElu = performance.eventLoopUtilization();
    lastAt = now;
  }, intervalMs);
  timer.unref?.();
  process.once("SIGUSR2", () => {
    write({ type: "stop", ts: Date.now(), monoUs: Number(process.hrtime.bigint() / 1000n) });
    process.exit(0);
  });
  console.log(`[PerfSampler] writing samples to ${file} every ${intervalMs}ms`);
  return true;
}
