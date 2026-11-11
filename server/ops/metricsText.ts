/*
  Prometheus 文本格式（text/plain; version=0.0.4）的输出。只管「怎么写成文本」，不知道 NEX 有什么指标。

  格式上要守的几条（Prometheus 的解析器很严，错一处整份抓取作废）：
  · 每个指标族先 # HELP、再 # TYPE、再它的全部样本，同一个族的样本不能分开写两处；
  · 标签值里的反斜杠、双引号、换行要转义（\\、\"、\n）；HELP 里只转义反斜杠和换行；
  · 值是浮点数，非有限值写 NaN / +Inf / -Inf；
  · 整份以换行结尾。
  主机名、规则名是用户随便起的，引号、换行、反斜杠都可能有，所以转义不是摆设。
*/

export type MetricType = "gauge" | "counter";

export type MetricLabels = Record<string, string | number | null | undefined>;

export type MetricSample = { labels?: MetricLabels; value: number };

export type MetricFamily = {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
};

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 标签值的长度上限：名字是用户填的，一条超长的名字不该把每一行都撑到几 KB。 */
export const METRIC_LABEL_VALUE_MAX_CHARS = 120;

export function escapeMetricLabelValue(value: unknown): string {
  let text = String(value ?? "");
  if (text.length > METRIC_LABEL_VALUE_MAX_CHARS) text = `${text.slice(0, METRIC_LABEL_VALUE_MAX_CHARS - 1)}…`;
  return text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}

export function escapeMetricHelp(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function formatMetricValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  // -0 写成 0：两者在 Prometheus 里是同一个数，但 "-0" 看着像出错了。
  return Object.is(value, -0) ? "0" : String(value);
}

function renderLabels(labels: MetricLabels | undefined): string {
  if (!labels) return "";
  const parts: string[] = [];
  for (const name of Object.keys(labels)) {
    const value = labels[name];
    if (value === null || value === undefined) continue;
    if (!LABEL_NAME.test(name) || name.startsWith("__")) throw new Error(`指标标签名不合法：${name}`);
    parts.push(`${name}="${escapeMetricLabelValue(value)}"`);
  }
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

/**
 * 把一组指标族写成文本。没有样本的族整个不写（连 HELP / TYPE 也不写）；
 * 值不是数字的样本跳过 —— 「不知道」就是没有这条序列，不拿 0 或 NaN 顶。
 * 同名的族出现两次是写代码的人的错（Prometheus 会拒收整份），直接抛。
 */
export function renderMetricFamilies(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    if (!METRIC_NAME.test(family.name)) throw new Error(`指标名不合法：${family.name}`);
    if (seen.has(family.name)) throw new Error(`指标族重复：${family.name}`);
    seen.add(family.name);
    const body: string[] = [];
    const seriesSeen = new Set<string>();
    for (const sample of family.samples) {
      if (typeof sample.value !== "number" || Number.isNaN(sample.value)) continue;
      const labels = renderLabels(sample.labels);
      // 同一个族里标签完全相同的两行，Prometheus 也会拒收整份：只留第一行。
      if (seriesSeen.has(labels)) continue;
      seriesSeen.add(labels);
      body.push(`${family.name}${labels} ${formatMetricValue(sample.value)}`);
    }
    if (body.length === 0) continue;
    lines.push(`# HELP ${family.name} ${escapeMetricHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    lines.push(...body);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
