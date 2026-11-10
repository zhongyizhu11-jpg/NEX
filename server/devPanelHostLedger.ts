import { executeRaw, quoteDbIdentifier as q } from "./dbRuntime";
import { HOST_RATE_BUCKET_TABLE } from "./hostRateBuckets";
import { hostP95Period, P95_BUCKET_SECONDS } from "../shared/hostLedger";

/*
  开发面板的演示数据：给 seedHosts 那四台机器填上费用，主机管理 →「账本」才有东西可看。
  只在 FORWARDX_DEV_PANEL 下由 devPanel.ts 调用，正式库永远不会走到这里。

  四台各演示一种情况：季付（折成每月）、月付 + 95 计费（有一整段 5 分钟样本）、
  月付但按当前速度会超额、年付已过期。
*/

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function seedHostLedgerDemo(hostIds: number[]) {
  const [hk, jp, sg, us] = hostIds;
  const now = Date.now();
  const setHost = (id: number | undefined, values: Record<string, unknown>) => {
    if (!id) return Promise.resolve();
    const keys = Object.keys(values);
    return executeRaw(
      `UPDATE ${q("hosts")} SET ${keys.map((key) => `${q(key)} = ?`).join(", ")} WHERE ${q("id")} = ?`,
      [...keys.map((key) => values[key]), id],
    );
  };
  await setHost(hk, { costCents: 9000, costCurrency: "CNY", billingCycleMonths: 3 });
  await setHost(jp, { costCents: 500, costCurrency: "USD", billingCycleMonths: 1, billingDay: 1, bandwidthBilling: "p95", p95PriceCents: 80 });
  await setHost(sg, { costCents: 4500, costCurrency: "CNY", billingCycleMonths: 1 });
  await setHost(us, { costCents: 6000, costCurrency: "USD", billingCycleMonths: 12 });

  // 计数器从十天前起算，几台的「本周期」用量对得上演示的故事（港、日两台用得不多，新加坡那台会超）。
  const tenDaysAgo = Math.floor((now - 10 * DAY_MS) / 1000);
  const setCounter = (id: number | undefined, bytesIn: number, bytesOut: number) => id
    ? executeRaw(
      `UPDATE ${q("host_traffic_counters")} SET ${q("bytesIn")} = ?, ${q("bytesOut")} = ?, ${q("resetAt")} = ?, ${q("createdAt")} = ? WHERE ${q("hostId")} = ?`,
      [Math.round(bytesIn), Math.round(bytesOut), tenDaysAgo, tenDaysAgo, id],
    )
    : Promise.resolve();
  await setCounter(hk, 82 * GB, 96 * GB);
  await setCounter(jp, 128 * GB, 171 * GB);
  await setCounter(sg, 227.1 * GB, 248.8 * GB);

  // 这张表不在 MIGRATION_TABLES 里，开发面板重灌时 clearDevData 不会清它：这里先清，免得撞唯一键。
  await executeRaw(`DELETE FROM ${q(HOST_RATE_BUCKET_TABLE)}`);
  if (!jp) return;
  // 日本那台：本计费周期到现在每 5 分钟一个点，白天高晚上低，偶尔冲一下（会被 95 去掉）。
  const { startMs } = hostP95Period(1, now);
  const first = Math.ceil(startMs / 1000 / P95_BUCKET_SECONDS) * P95_BUCKET_SECONDS;
  const last = Math.floor(now / 1000 / P95_BUCKET_SECONDS) * P95_BUCKET_SECONDS - P95_BUCKET_SECONDS;
  const rows: Array<[number, number, number]> = [];
  for (let start = first, index = 0; start <= last; start += P95_BUCKET_SECONDS, index += 1) {
    const hourOfDay = ((start / 3600) + 8) % 24;
    const wave = 45 + 30 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
    const spike = index % 97 === 0 ? 260 : 0;
    const outMbps = Math.max(3, wave + spike + ((index * 37) % 11) - 5);
    const inMbps = outMbps * 0.35;
    rows.push([start, Math.round(inMbps * 1e6 / 8 * P95_BUCKET_SECONDS), Math.round(outMbps * 1e6 / 8 * P95_BUCKET_SECONDS)]);
  }
  const cols = ["hostId", "bucketStart", "bytesIn", "bytesOut", "coveredSeconds"];
  for (let offset = 0; offset < rows.length; offset += 400) {
    const batch = rows.slice(offset, offset + 400);
    await executeRaw(
      `INSERT INTO ${q(HOST_RATE_BUCKET_TABLE)} (${cols.map((col) => q(col)).join(", ")}) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      batch.flatMap(([start, bytesIn, bytesOut]) => [jp, start, bytesIn, bytesOut, P95_BUCKET_SECONDS]),
    );
  }
}
